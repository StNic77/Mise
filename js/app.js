// app.js \u2014 thin bootstrapper. Loads state once, wires up tab navigation,
// and hands each tab's container to the module that owns it. No storage or
// business logic lives here \u2014 that's db.js / recipes.js / menu.js / etc.

import { db } from './db.js';
import { api } from './api.js';
import { renderProfiles } from './profiles.js';
import { renderRecipes } from './recipes.js';
import { renderCycleSetup, currentCycle } from './cycles.js';
import { generateMenu, swapNight, reverseMenuToGroceryLines, recentTitles, activeProfilesFor, assignRecipeToDay, buildRarityConstraintText } from './menu.js';
import { planMealSlot, renderSpecialChat } from './mealslots.js';
import { renderChecklist } from './checklist.js';
import { renderShoppingList, addItems } from './shoppinglist.js';
import { renderSettings } from './backup.js';

let state = null;

async function saveState() {
  await db.save(state);
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('visible'), 2600);
}

const TABS = {
  menu: { label: 'Menu', render: renderMenuTab },
  profiles: { label: 'Profiles', render: (c) => renderProfiles(state, c, { saveState, toast }) },
  recipes: { label: 'Recipes', render: (c) => renderRecipes(state, c, { saveState, toast }) },
  checklist: {
    label: 'Checklist',
    render: (c) => renderChecklist(state, c, {
      saveState, toast,
      onSendToShoppingList: (items) => { addItems(state, items, 'checklist'); saveState(); },
    }),
  },
  shopping: { label: 'Shopping', render: (c) => renderShoppingList(state, c, { saveState, toast }) },
  settings: {
    label: 'Settings',
    render: (c) => renderSettings(state, c, { saveState, toast, reloadApp: () => window.location.reload() }),
  },
};

function renderMenuTab(container) {
  renderCycleSetup(state, container, {
    saveState, toast,
    onNavigate: (tabKey) => switchTab(tabKey, container),
    onGetAiIdeas: (cycle) => renderIdeaPicker(container, cycle),
    onRequestRecipe: (cycle, request) => renderRequestedRecipe(container, cycle, request),
    onMenuReady: async (cycle) => {
      toast('Generating menu...');
      await generateMenu(state, cycle, { saveState, toast, aiEnabled: false });
      renderMenuResults(container, cycle);
    },
  });
}

async function renderRequestedRecipe(container, cycle, request) {
  container.innerHTML = `<div class="card"><div class="meta">Writing a recipe for "${escapeHtml(request)}"...</div></div>`;

  const openDays = cycle.days.filter((d) => d.slots.dinner.state === 'plan' && !d.slots.dinner.result && d.activeProfileIds.length > 0);
  const profileIds = new Set();
  openDays.forEach((d) => d.activeProfileIds.forEach((id) => profileIds.add(id)));
  const profiles = state.profiles.filter((p) => profileIds.has(p.id));

  const detail = await api.getRequestedRecipe({ request, activeProfiles: profiles });

  if (!detail || !detail.title) {
    container.innerHTML = `<div class="card">
      <div class="meta">Couldn't write that recipe \u2014 check js/api.js's ENDPOINT and the console, then try again.</div>
      <button class="btn secondary small" id="back-btn" style="margin-top:0.5rem;">Back</button>
    </div>`;
    container.querySelector('#back-btn').addEventListener('click', () => renderMenuTab(container));
    return;
  }

  const fullRecipe = {
    id: `rec_${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    source: 'ai_generated',
    rejectedCount: 0,
    ...detail,
  };

  container.innerHTML = `<div class="card">
    <button class="btn secondary small" id="back-to-setup-btn">\u2190 Back to setup</button>
  </div>
  <div class="card">
    <h3>${escapeHtml(fullRecipe.title)}</h3>
    <div class="meta">${escapeHtml(fullRecipe.tags?.cuisine || '')} \u00b7 ${escapeHtml(fullRecipe.tags?.protein || '')} \u00b7 ${escapeHtml(fullRecipe.tags?.texture || '')}${fullRecipe.totalTimeMinutes ? ` \u00b7 ${fullRecipe.totalTimeMinutes} min` : ''}</div>
    <div class="meta" style="margin-top:0.4rem;">${(fullRecipe.ingredients || []).length} ingredients \u00b7 ${(fullRecipe.steps || []).length} steps</div>
    <div style="display:flex; gap:0.4rem; margin-top:0.6rem; align-items:center; flex-wrap:wrap;">
      <select id="request-day-select">
        <option value="">Assign to...</option>
        ${openDays.map((d) => `<option value="${d.date}">${d.dayOfWeek.toUpperCase()} ${d.date}</option>`).join('')}
      </select>
      <button class="btn small" id="request-assign-btn">Assign</button>
      <button class="btn secondary small" id="request-save-btn">Just save to Recipes</button>
    </div>
    <div class="meta" id="request-status" style="margin-top:0.4rem;"></div>
  </div>`;

  container.querySelector('#back-to-setup-btn').addEventListener('click', () => renderMenuTab(container));

  container.querySelector('#request-save-btn').addEventListener('click', () => {
    state.recipes.push(fullRecipe);
    saveState();
    toast(`"${fullRecipe.title}" saved to your recipe library`);
    renderMenuTab(container);
  });

  container.querySelector('#request-assign-btn').addEventListener('click', () => {
    const date = container.querySelector('#request-day-select').value;
    if (!date) { toast('Pick a night first, or use "Just save to Recipes"'); return; }
    const day = cycle.days.find((d) => d.date === date);
    assignRecipeToDay(state, day, fullRecipe, { saveState });
    toast(`"${fullRecipe.title}" assigned to ${day.dayOfWeek.toUpperCase()}`);
    renderMenuTab(container);
  });
}

async function renderIdeaPicker(container, cycle) {
  const slotTypes = ['breakfast', 'lunch', 'dinner'];
  const openByType = {};
  slotTypes.forEach((st) => {
    openByType[st] = cycle.days.filter((d) => d.slots[st].state === 'plan' && !d.slots[st].result && d.activeProfileIds.length > 0);
  });
  const totalOpen = slotTypes.reduce((sum, st) => sum + openByType[st].length, 0);

  if (!totalOpen) {
    toast('No open meals to fill \u2014 every breakfast/lunch/dinner slot is either already assigned, not set to Plan, or has nobody selected as present.');
    return;
  }

  container.innerHTML = `<div class="card"><div class="meta">Asking AI for dish ideas...</div></div>`;

  const allIdeas = [];
  for (const st of slotTypes) {
    const openDays = openByType[st];
    if (!openDays.length) continue;

    const profileIds = new Set();
    openDays.forEach((d) => d.activeProfileIds.forEach((id) => profileIds.add(id)));
    const profiles = state.profiles.filter((p) => profileIds.has(p.id));
    const count = Math.min(openDays.length + (st === 'dinner' ? 4 : 2), 12);

    const result = await api.getRecipeIdeaBatch({
      cuisineWeighting: cycle.cuisineWeighting,
      activeProfiles: profiles,
      count,
      recentTitles: recentTitles(state, cycle.id),
      rarityConstraints: buildRarityConstraintText(state),
      onHandNote: cycle.onHandNote,
      mealType: st,
    });

    if (result?.ideas?.length) {
      result.ideas.forEach((idea) => allIdeas.push({ ...idea, mealType: st }));
    }
  }

  if (!allIdeas.length) {
    container.innerHTML = `<div class="card">
      <div class="meta">Couldn't reach the AI assistant, or it didn't return usable ideas. Check js/api.js's ENDPOINT is set, then try again \u2014 or add recipes manually in the Recipes tab.</div>
      <button class="btn secondary small" id="back-btn" style="margin-top:0.5rem;">Back</button>
    </div>`;
    container.querySelector('#back-btn').addEventListener('click', () => renderMenuTab(container));
    return;
  }

  renderIdeaList(container, cycle, allIdeas, openByType);
}

function renderIdeaList(container, cycle, ideas, openByType) {
  let html = `<div class="card">
    <button class="btn secondary small" id="back-to-setup-btn">\u2190 Back to setup</button>
    <div class="meta" style="margin-top:0.4rem;">Pick an idea, then either assign it to a specific day, drop it on a random open slot of the same meal type, or just send it to your recipe library to use later. Full recipe gets written and saved once you pick any of the three.</div>
  </div>`;

  html += `<div class="card">
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn" id="bulk-random-btn">Assign to random slots (fills all open meals)</button>
      <button class="btn secondary" id="bulk-saveall-btn">Save all remaining to Recipes</button>
    </div>
    <div id="bulk-status" class="meta" style="margin-top:0.4rem;"></div>
  </div>`;

  ideas.forEach((idea, i) => {
    const openDays = openByType[idea.mealType] || [];
    html += `<div class="card idea-card" data-idx="${i}">
      <h3>${escapeHtml(idea.title)} <span class="meta">(${idea.mealType.toUpperCase()})</span></h3>
      <div class="meta">${escapeHtml(idea.cuisine || '')} \u00b7 ${escapeHtml(idea.protein || '')} \u00b7 ${escapeHtml(idea.texture || '')}</div>
      <div style="margin-top:0.3rem;">${escapeHtml(idea.oneLiner || '')}</div>
      <div style="display:flex; gap:0.4rem; margin-top:0.5rem; align-items:center; flex-wrap:wrap;">
        <select class="day-select" data-idx="${i}" data-mealtype="${idea.mealType}">
          <option value="">Assign to...</option>
          ${openDays.map((d) => `<option value="${d.date}">${d.dayOfWeek.toUpperCase()} ${d.date}</option>`).join('')}
        </select>
        <button class="btn small assign-idea-btn" data-idx="${i}">Assign</button>
        <button class="btn secondary small random-idea-btn" data-idx="${i}">Random ${idea.mealType === 'dinner' ? 'night' : 'day'}</button>
        <button class="btn secondary small save-only-btn" data-idx="${i}">Send to Recipes</button>
      </div>
    </div>`;
  });

  html += `<div class="card"><button class="btn secondary" id="done-picking-btn">Done \u2014 back to menu</button></div>`;

  container.innerHTML = html;

  container.querySelector('#back-to-setup-btn').addEventListener('click', () => renderMenuTab(container));
  container.querySelector('#done-picking-btn').addEventListener('click', () => renderMenuTab(container));

  // Shared commit path for all three actions. date === null means "save to
  // library only, don't assign to any night" (the Send-to-Recipes case).
  // Returns { ok, recipe } rather than just true/false so bulk callers can
  // count successes/failures instead of guessing from toasts alone.
  async function commitIdea(idx, date, btn, busyLabel) {
    const idea = ideas[idx];
    const day = date ? cycle.days.find((d) => d.date === date) : null;
    const profiles = day ? activeProfilesFor(state, day) : [];
    const card = btn.closest('.idea-card');

    const originalLabel = btn.textContent;
    btn.textContent = busyLabel;
    btn.disabled = true;
    const existingError = card.querySelector('.idea-error');
    if (existingError) existingError.remove();

    let detail;
    try {
      detail = await api.getRecipeDetail({ idea, activeProfiles: profiles });
    } catch (e) {
      detail = null;
      console.error('getRecipeDetail threw', e);
    }

    if (!detail || !detail.title) {
      const errLine = document.createElement('div');
      errLine.className = 'meta idea-error';
      errLine.style.color = 'var(--danger)';
      errLine.textContent = 'Could not write this recipe (AI call failed or returned nothing usable). Try again, or check js/api.js\u2019s ENDPOINT and the browser console for the real error.';
      card.appendChild(errLine);
      btn.textContent = originalLabel;
      btn.disabled = false;
      return { ok: false, recipe: null };
    }

    const fullRecipe = {
      id: `rec_${Math.random().toString(36).slice(2, 10)}`,
      createdAt: new Date().toISOString(),
      source: 'ai_generated',
      rejectedCount: 0,
      ...detail,
    };

    if (day) {
      assignRecipeToDay(state, day, fullRecipe, { saveState }, idea.mealType);
      container.querySelectorAll(`.day-select[data-mealtype="${idea.mealType}"]`).forEach((sel) => {
        const opt = sel.querySelector(`option[value="${date}"]`);
        if (opt) opt.remove();
      });
    } else {
      if (!state.recipes.find((r) => r.id === fullRecipe.id)) state.recipes.push(fullRecipe);
      saveState();
    }

    card.remove();
    toast(day ? `"${fullRecipe.title}" assigned to ${idea.mealType} on ${day.dayOfWeek.toUpperCase()}` : `"${fullRecipe.title}" saved to your recipe library`);
    return { ok: true, recipe: fullRecipe };
  }

  function anyOpenNightsLeft() {
    return container.querySelectorAll('.day-select option[value]:not([value=""])').length > 0;
  }

  container.querySelectorAll('.assign-idea-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.idx);
      const select = container.querySelector(`.day-select[data-idx="${idx}"]`);
      const date = select.value;
      if (!date) { toast('Pick a night first, or use Random night / Send to Recipes'); return; }
      const result = await commitIdea(idx, date, btn, 'Writing recipe...');
      if (result.ok && !anyOpenNightsLeft()) toast('All open slots assigned \u2014 nice.');
    });
  });

  container.querySelectorAll('.random-idea-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.idx);
      const select = container.querySelector(`.day-select[data-idx="${idx}"]`);
      const options = [...select.querySelectorAll('option')].filter((o) => o.value);
      if (!options.length) { toast('No open slots left for this meal type \u2014 try Send to Recipes instead'); return; }
      const pick = options[Math.floor(Math.random() * options.length)];
      const result = await commitIdea(idx, pick.value, btn, 'Writing recipe...');
      if (result.ok && !anyOpenNightsLeft()) toast('All open slots assigned \u2014 nice.');
    });
  });

  container.querySelectorAll('.save-only-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.idx);
      await commitIdea(idx, null, btn, 'Saving...');
    });
  });

  // --- Bulk actions -------------------------------------------------------
  const bulkStatus = container.querySelector('#bulk-status');

  container.querySelector('#bulk-random-btn').addEventListener('click', async () => {
    let assigned = 0, failed = 0;
    const failedIdx = new Set();
    while (anyOpenNightsLeft()) {
      const cards = [...container.querySelectorAll('.idea-card')].filter((c) => !failedIdx.has(Number(c.dataset.idx)));
      if (!cards.length) break;
      const card = cards[0]; // process in order shown; still "random" in which NIGHT it lands on
      const idx = Number(card.dataset.idx);
      const select = card.querySelector('.day-select');
      const options = [...select.querySelectorAll('option')].filter((o) => o.value);
      if (!options.length) break;
      const pick = options[Math.floor(Math.random() * options.length)];
      const btn = card.querySelector('.random-idea-btn');
      bulkStatus.textContent = `Assigning "${ideas[idx].title}" to ${pick.textContent}...`;
      const result = await commitIdea(idx, pick.value, btn, 'Writing recipe...');
      if (result.ok) assigned++; else { failed++; failedIdx.add(idx); }
    }
    bulkStatus.textContent = `Done: ${assigned} slot(s) assigned${failed ? `, ${failed} idea(s) failed to write \u2014 see the red note on each affected card` : ''}.`;
  });

  container.querySelector('#bulk-saveall-btn').addEventListener('click', async () => {
    let saved = 0, failed = 0;
    const idxList = [...container.querySelectorAll('.idea-card')].map((c) => Number(c.dataset.idx));
    for (const idx of idxList) {
      const card = container.querySelector(`.idea-card[data-idx="${idx}"]`);
      if (!card) continue; // already removed by a bulk-random pass or manual action
      const btn = card.querySelector('.save-only-btn');
      bulkStatus.textContent = `Saving "${ideas[idx].title}"...`;
      const result = await commitIdea(idx, null, btn, 'Saving...');
      if (result.ok) saved++; else failed++;
    }
    bulkStatus.textContent = `Done: ${saved} recipe(s) saved to your library${failed ? `, ${failed} failed` : ''}.`;
  });
}

function renderMenuResults(container, cycle) {
  let html = `<div class="card"><button class="btn secondary small" id="back-to-setup-btn">\u2190 Back to setup</button></div>`;

  for (const day of cycle.days) {
    html += `<div class="card">
      <h3>${day.dayOfWeek.toUpperCase()} <span class="meta">${day.date}</span></h3>
      ${['breakfast', 'lunch', 'dinner'].map((slotType) => {
        const slot = day.slots[slotType];
        if (slot.state === 'skip') return '';
        if (slot.state === 'eating_out') return `<div class="meta">${slotType}: eating out</div>`;
        if (slot.state === 'special') {
          return `<div class="field">
            <div class="meta">${slotType} (special): ${slot.result ? escapeHtml(slot.result.transcriptSummary) : 'not planned yet'}</div>
            <button class="btn secondary small open-special-btn" data-date="${day.date}" data-slot="${slotType}">${slot.result ? 'Re-open conversation' : 'Start conversation'}</button>
          </div>`;
        }
        // plan
        if (slotType === 'dinner') {
          if (!day.activeProfileIds.length && !slot.result) {
            return `<div class="field"><div class="meta">Dinner: no one selected for this night \u2014 go back to setup and mark who's eating to include it.</div></div>`;
          }
          const recipe = slot.result?.pendingRecipe || state.recipes.find((r) => r.id === slot.result?.recipeId);
          return `<div class="field">
            <div class="meta">Dinner: ${recipe ? escapeHtml(recipe.title) + (recipe.source === 'ai_generated' ? ' (AI \u2014 not yet saved)' : '') : slot.result?.notes || 'unassigned'}</div>
            <div style="display:flex; gap:0.4rem; margin-top:0.3rem; flex-wrap:wrap;">
              <button class="btn secondary small swap-btn" data-date="${day.date}">Swap this night</button>
              ${recipe && recipe.source === 'ai_generated' && !state.recipes.find((r) => r.id === recipe.id) ? `<button class="btn secondary small save-ai-btn" data-date="${day.date}">Save to library</button>` : ''}
              ${slot.result ? `<button class="btn danger small clear-slot-btn" data-date="${day.date}" data-slot="dinner">Clear</button>` : ''}
            </div>
          </div>`;
        }
        return `<div class="field">
          <div class="meta">${slotType}: ${(() => {
            if (!slot.result) return 'not planned yet';
            if (slot.result.recipeId) {
              const r = state.recipes.find((x) => x.id === slot.result.recipeId);
              return r ? escapeHtml(r.title) : 'unassigned';
            }
            return escapeHtml(slot.result.transcriptSummary || '');
          })()}</div>
          <div style="display:flex; gap:0.4rem; margin-top:0.3rem; flex-wrap:wrap;">
            <button class="btn secondary small plan-slot-btn" data-date="${day.date}" data-slot="${slotType}">${slot.result ? 'Re-plan' : 'Get ideas'}</button>
            ${slot.result ? `<button class="btn danger small clear-slot-btn" data-date="${day.date}" data-slot="${slotType}">Clear</button>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  html += `<div class="card">
    <button class="btn" id="send-to-shopping-btn">Add menu ingredients to shopping list</button>
  </div>`;

  container.innerHTML = html;

  container.querySelector('#back-to-setup-btn').addEventListener('click', () => renderMenuTab(container));

  container.querySelectorAll('.swap-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const day = cycle.days.find((d) => d.date === btn.dataset.date);
      swapNight(state, cycle, day, { saveState, toast });
      renderMenuResults(container, cycle);
    });
  });

  container.querySelectorAll('.clear-slot-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const day = cycle.days.find((d) => d.date === btn.dataset.date);
      const slotType = btn.dataset.slot;
      day.slots[slotType].result = null;
      saveState();
      toast(`Cleared ${slotType} on ${day.dayOfWeek.toUpperCase()}`);
      renderMenuResults(container, cycle);
    });
  });

  container.querySelectorAll('.save-ai-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const day = cycle.days.find((d) => d.date === btn.dataset.date);
      const pending = day.slots.dinner.result.pendingRecipe;
      state.recipes.push(pending);
      day.slots.dinner.result.recipeId = pending.id;
      delete day.slots.dinner.result.pendingRecipe;
      saveState();
      toast('Saved to recipe library');
      renderMenuResults(container, cycle);
    });
  });

  container.querySelectorAll('.plan-slot-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const day = cycle.days.find((d) => d.date === btn.dataset.date);
      await planMealSlot(state, day, btn.dataset.slot, { saveState, toast });
      renderMenuResults(container, cycle);
    });
  });

  container.querySelectorAll('.open-special-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const day = cycle.days.find((d) => d.date === btn.dataset.date);
      renderSpecialChat(day, btn.dataset.slot, container, {
        saveState, toast,
        onClose: () => renderMenuResults(container, cycle),
      });
    });
  });

  container.querySelector('#send-to-shopping-btn').addEventListener('click', () => {
    const lines = reverseMenuToGroceryLines(state, cycle);
    addItems(state, lines.map((l) => ({ name: l.name, quantity: l.quantity, category: l.category })), 'menu_export');
    saveState();
    toast(`Added ${lines.length} ingredient(s) to shopping list`);
  });
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTabBar(activeTab, container) {
  const bar = document.getElementById('tab-bar');
  bar.innerHTML = Object.entries(TABS).map(([key, tab]) =>
    `<button class="tab-btn ${key === activeTab ? 'active' : ''}" data-tab="${key}">${tab.label}</button>`
  ).join('');
  bar.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab, container));
  });
}

function switchTab(tabKey, container) {
  renderTabBar(tabKey, container);
  container.innerHTML = '';
  TABS[tabKey].render(container);
}

async function boot() {
  state = await db.load();

  document.getElementById('build-stamp').textContent = window.MISE_BUILD || state.meta?.appBuild || 'dev';

  const container = document.getElementById('tab-content');
  switchTab('menu', container);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.error('SW registration failed', e));
  }
}

boot();
