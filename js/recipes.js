// recipes.js — recipe library CRUD + the rules-based candidate-matching logic
// used by menu.js. No AI here; this is the deterministic half of menu generation.

import { currentCycle } from './cycles.js';

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

// Persists across re-renders of this tab (module-level, resets on page reload)
// so the filter stays put while you're adding/editing/assigning recipes.
let activeCuisineFilter = null;

// Does this recipe violate any active profile's restrictions?
// strict -> excluded outright. flexible -> allowed but flagged (caller can deprioritize).
export function checkRecipeAgainstProfiles(recipe, profiles) {
  const ingredientText = [
    ...(recipe.ingredients || []).map((i) => i.name),
    ...(recipe.sauce || []).map((s) => s.name),
  ].join(' ').toLowerCase();

  let hasFlexibleConflict = false;

  for (const profile of profiles) {
    for (const restriction of profile.restrictions || []) {
      const term = (restriction.item || '').toLowerCase().trim();
      if (!term) continue;
      if (ingredientText.includes(term)) {
        if (restriction.severity === 'strict') {
          return { allowed: false, reason: `${profile.name}: strict avoid "${restriction.item}"` };
        }
        hasFlexibleConflict = true;
      }
    }
    // Diet-type hard rules (vegetarian/vegan/pescatarian exclude whole protein categories)
    const protein = (recipe.tags?.protein || '').toLowerCase();
    if (profile.dietType === 'vegan' && ['pork', 'beef', 'chicken', 'fish', 'egg', 'dairy'].some(p => protein.includes(p))) {
      return { allowed: false, reason: `${profile.name}: vegan diet excludes ${protein}` };
    }
    if (profile.dietType === 'vegetarian' && ['pork', 'beef', 'chicken', 'fish'].some(p => protein.includes(p))) {
      return { allowed: false, reason: `${profile.name}: vegetarian diet excludes ${protein}` };
    }
    if (profile.dietType === 'pescatarian' && ['pork', 'beef', 'chicken'].some(p => protein.includes(p))) {
      return { allowed: false, reason: `${profile.name}: pescatarian diet excludes ${protein}` };
    }
    // Texture dislikes
    if ((profile.textureDislikes || []).includes(recipe.tags?.texture)) {
      hasFlexibleConflict = true;
    }
  }

  return { allowed: true, deprioritized: hasFlexibleConflict };
}

// Given the full library + active profiles, return the valid candidate pool
// (intersection of every active profile's constraints), sorted so
// less-recently-used and non-deprioritized recipes come first.
export function getCandidatePool(recipes, profiles, recentTitles = []) {
  const pool = recipes
    .map((r) => ({ recipe: r, check: checkRecipeAgainstProfiles(r, profiles) }))
    .filter((x) => x.check.allowed);

  return pool
    .sort((a, b) => {
      const aRecent = recentTitles.includes(a.recipe.title) ? 1 : 0;
      const bRecent = recentTitles.includes(b.recipe.title) ? 1 : 0;
      if (aRecent !== bRecent) return aRecent - bRecent;
      const aDep = a.check.deprioritized ? 1 : 0;
      const bDep = b.check.deprioritized ? 1 : 0;
      if (aDep !== bDep) return aDep - bDep;
      return (a.recipe.rejectedCount || 0) - (b.recipe.rejectedCount || 0);
    })
    .map((x) => x.recipe);
}

// Weighted pick honoring cuisine weighting where possible, falling back to
// whatever's available if the weighted cuisine has no candidates.
export function pickWeighted(candidates, cuisineWeighting) {
  if (!candidates.length) return null;
  if (!cuisineWeighting || !Object.keys(cuisineWeighting).length) {
    return candidates[0];
  }
  const weighted = candidates.filter((r) => cuisineWeighting[r.tags?.cuisine] > 0);
  const pool = weighted.length ? weighted : candidates;
  // simple weighted-random within the pool, weight = cuisine weight (default 0.1 for unlisted)
  const total = pool.reduce((sum, r) => sum + (cuisineWeighting[r.tags?.cuisine] || 0.1), 0);
  let roll = Math.random() * total;
  for (const r of pool) {
    roll -= (cuisineWeighting[r.tags?.cuisine] || 0.1);
    if (roll <= 0) return r;
  }
  return pool[0];
}

function emptyRecipeForm() {
  return {
    id: uid('rec'),
    title: '',
    createdAt: new Date().toISOString(),
    source: 'manual',
    tags: { cuisine: '', protein: '', texture: '', leftoverFriendly: false, eatFresh: false, batchable: false, vegHidden: false },
    totalTimeMinutes: null,
    reasonInRotation: '',
    ingredients: [],
    sauce: [],
    steps: [],
    closingNote: null,
    rejectedCount: 0,
  };
}

// Fills in every field a Recipe needs, so a loosely-shaped JSON pasted from
// an outside chat conversation (e.g. a recipe photo turned into JSON) can't
// crash the app by being missing a field. Only `title` is truly required.
function normalizeImportedRecipe(raw) {
  return {
    id: uid('rec'),
    title: String(raw.title || '').trim(),
    createdAt: new Date().toISOString(),
    source: 'imported',
    tags: {
      cuisine: raw.tags?.cuisine || '',
      protein: raw.tags?.protein || '',
      texture: raw.tags?.texture || '',
      leftoverFriendly: !!raw.tags?.leftoverFriendly,
      eatFresh: !!raw.tags?.eatFresh,
      batchable: !!raw.tags?.batchable,
      vegHidden: !!raw.tags?.vegHidden,
    },
    totalTimeMinutes: Number(raw.totalTimeMinutes) || null,
    reasonInRotation: raw.reasonInRotation || '',
    ingredients: Array.isArray(raw.ingredients) ? raw.ingredients.map((i) => ({
      name: i.name || '', amount1: i.amount1 || '', amount2: i.amount2 || '', amount4: i.amount4 || '',
    })) : [],
    sauce: Array.isArray(raw.sauce) ? raw.sauce.map((s) => ({
      name: s.name || '', amount1: s.amount1 || '', scaleNote: s.scaleNote || null,
    })) : [],
    steps: Array.isArray(raw.steps) ? raw.steps.map((s) => ({
      text: (typeof s === 'string' ? s : s.text) || '', timeMinutes: s.timeMinutes ?? null,
    })) : [],
    closingNote: raw.closingNote || null,
    rejectedCount: 0,
  };
}

function openImportPanel(state, container, { saveState, toast }) {
  container.innerHTML = `
    <div class="card">
      <h3>Import Recipe(s) from JSON</h3>
      <div class="meta">Paste JSON here \u2014 from a recipe photo or text you had a separate Claude
        chat convert, or anything matching Mise's recipe shape. Accepts one recipe object, or
        <code>{"recipes": [...]}</code> for several at once. See DATA-MODEL.md for the exact shape,
        or just ask Claude: "turn this recipe into JSON for my Mise app" and paste a photo/text.</div>
      <textarea id="import-json-textarea" style="min-height:10rem;" placeholder='{"title": "...", "tags": {...}, "ingredients": [...], "steps": [...]}'></textarea>
      <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
        <button class="btn" id="do-import-btn">Import</button>
        <button class="btn secondary" id="cancel-import-btn">Cancel</button>
      </div>
    </div>
  `;

  container.querySelector('#cancel-import-btn').addEventListener('click', () => {
    renderRecipes(state, container, { saveState, toast });
  });

  container.querySelector('#do-import-btn').addEventListener('click', () => {
    const text = container.querySelector('#import-json-textarea').value.trim();
    if (!text) return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      toast('That\u2019s not valid JSON \u2014 check for a stray comma or missing bracket');
      return;
    }
    const rawList = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.recipes) ? parsed.recipes : [parsed]);
    const validList = rawList.filter((r) => r && typeof r === 'object' && r.title);
    if (!validList.length) {
      toast('No recipe with a title found in that JSON');
      return;
    }
    validList.forEach((raw) => {
      state.recipes.push(normalizeImportedRecipe(raw));
    });
    saveState();
    toast(`Imported ${validList.length} recipe(s)`);
    renderRecipes(state, container, { saveState, toast });
  });
}

export function renderRecipes(state, container, { saveState, toast }) {
  const recipes = state.recipes || [];

  const cuisines = [...new Set(recipes.map((r) => r.tags?.cuisine).filter(Boolean))].sort();
  if (activeCuisineFilter && !cuisines.includes(activeCuisineFilter)) activeCuisineFilter = null;

  let html = `<div class="card">
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn" id="add-recipe-btn">+ Add Recipe</button>
      <button class="btn secondary" id="import-recipe-btn">Import Recipe (JSON)</button>
    </div>
  </div>`;

  if (cuisines.length) {
    html += `<div class="card">
      <h3>Filter by cooking style</h3>
      <div class="choice-row" id="cuisine-filter-row">
        <button type="button" class="choice-chip filter-chip ${!activeCuisineFilter ? 'selected' : ''}" data-cuisine="">All (${recipes.length})</button>
        ${cuisines.map((c) => {
          const count = recipes.filter((r) => r.tags?.cuisine === c).length;
          return `<button type="button" class="choice-chip filter-chip ${activeCuisineFilter === c ? 'selected' : ''}" data-cuisine="${c}">${c.replace(/_/g, ' ')} (${count})</button>`;
        }).join('')}
      </div>
    </div>`;
  }

  const visibleRecipes = activeCuisineFilter ? recipes.filter((r) => r.tags?.cuisine === activeCuisineFilter) : recipes;

  if (!recipes.length) {
    html += `<div class="empty-state">No recipes yet. Add one, or import your starter JSON from Settings.</div>`;
  } else if (!visibleRecipes.length) {
    html += `<div class="empty-state">No recipes tagged "${escapeHtml(activeCuisineFilter.replace(/_/g, ' '))}" yet.</div>`;
  } else {
    for (const r of visibleRecipes) {
      html += `<div class="card" data-recipe-id="${r.id}">
        <h3>${escapeHtml(r.title)} ${r.source === 'ai_generated' ? '<span class="meta">(AI)</span>' : ''}${r.source === 'imported' ? '<span class="meta">(Imported)</span>' : ''}</h3>
        <div class="meta">${escapeHtml(r.tags?.cuisine || '—')} · ${escapeHtml(r.tags?.protein || '—')} · ${escapeHtml(r.tags?.texture || '—')} · ${r.totalTimeMinutes ? r.totalTimeMinutes + ' min' : ''}</div>
        <div style="margin-top:0.5rem; display:flex; gap:0.4rem; flex-wrap:wrap;">
          <button class="btn secondary small view-recipe-btn" data-id="${r.id}">View</button>
          <button class="btn secondary small assign-recipe-btn" data-id="${r.id}">Assign to a meal</button>
          <button class="btn secondary small edit-recipe-btn" data-id="${r.id}">Edit</button>
          <button class="btn danger small delete-recipe-btn" data-id="${r.id}">Delete</button>
        </div>
      </div>`;
    }
  }

  container.innerHTML = html;

  container.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      activeCuisineFilter = chip.dataset.cuisine || null;
      renderRecipes(state, container, { saveState, toast });
    });
  });

  container.querySelector('#add-recipe-btn').addEventListener('click', () => {
    openRecipeEditor(state, container, emptyRecipeForm(), { saveState, toast });
  });
  container.querySelectorAll('.view-recipe-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const recipe = recipes.find((r) => r.id === btn.dataset.id);
      renderRecipeView(state, container, recipe, { saveState, toast });
    });
  });
  container.querySelectorAll('.assign-recipe-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const recipe = recipes.find((r) => r.id === btn.dataset.id);
      openAssignPanel(state, container, recipe, { saveState, toast });
    });
  });
  container.querySelector('#import-recipe-btn').addEventListener('click', () => {
    openImportPanel(state, container, { saveState, toast });
  });
  container.querySelectorAll('.edit-recipe-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const recipe = recipes.find((r) => r.id === btn.dataset.id);
      openRecipeEditor(state, container, recipe, { saveState, toast });
    });
  });
  container.querySelectorAll('.delete-recipe-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this recipe?')) return;
      state.recipes = state.recipes.filter((r) => r.id !== btn.dataset.id);
      saveState();
      renderRecipes(state, container, { saveState, toast });
    });
  });
}

// A clean, readable display of a recipe \u2014 distinct from the edit form.
function renderRecipeView(state, container, recipe, { saveState, toast }) {
  container.innerHTML = `
    <div class="card">
      <button class="btn secondary small" id="back-to-list-btn">\u2190 Back to Recipes</button>
    </div>
    <div class="card">
      <h3>${escapeHtml(recipe.title)}</h3>
      <div class="meta">${escapeHtml(recipe.tags?.cuisine || '\u2014')} \u00b7 ${escapeHtml(recipe.tags?.protein || '\u2014')} \u00b7 ${escapeHtml(recipe.tags?.texture || '\u2014')}${recipe.totalTimeMinutes ? ` \u00b7 ${recipe.totalTimeMinutes} min` : ''}</div>
      ${recipe.reasonInRotation ? `<div style="margin-top:0.5rem; font-style:italic;">${escapeHtml(recipe.reasonInRotation)}</div>` : ''}
      ${['leftoverFriendly', 'eatFresh', 'batchable', 'vegHidden'].filter((k) => recipe.tags?.[k]).length ? `
        <div class="meta" style="margin-top:0.4rem;">${['leftoverFriendly', 'eatFresh', 'batchable', 'vegHidden'].filter((k) => recipe.tags?.[k]).map((k) => `[${k}]`).join(' ')}</div>
      ` : ''}
    </div>

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0;">Ingredients</h3>
        <div class="choice-row" id="serving-toggle">
          <button type="button" class="choice-chip serving-chip selected" data-servings="1">1</button>
          <button type="button" class="choice-chip serving-chip" data-servings="2">2</button>
          <button type="button" class="choice-chip serving-chip" data-servings="4">4</button>
        </div>
      </div>
      <div id="ingredients-list" style="margin-top:0.6rem;">
        ${(recipe.ingredients || []).map((i) => `
          <div class="checklist-row ing-row" data-a1="${escapeAttr(i.amount1)}" data-a2="${escapeAttr(i.amount2)}" data-a4="${escapeAttr(i.amount4)}">
            <span>${escapeHtml(i.name)}</span>
            <span class="meta ing-amount">${escapeHtml(i.amount1 || '')}</span>
          </div>
        `).join('') || '<div class="meta">No ingredients listed.</div>'}
      </div>
    </div>

    ${(recipe.sauce || []).length ? `
      <div class="card">
        <h3>Sauce / Glaze</h3>
        ${recipe.sauce.map((s) => `
          <div class="checklist-row">
            <span>${escapeHtml(s.name)}</span>
            <span class="meta">${escapeHtml(s.amount1 || '')}${s.scaleNote ? ` \u2014 ${escapeHtml(s.scaleNote)}` : ''}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${(recipe.steps || []).length ? `
      <div class="card">
        <h3>Steps</h3>
        <ol style="padding-left:1.2rem; margin:0;">
          ${recipe.steps.map((s) => `<li style="margin-bottom:0.6rem;">${escapeHtml(s.text)}${s.timeMinutes ? ` <span class="meta">(${s.timeMinutes} min)</span>` : ''}</li>`).join('')}
        </ol>
      </div>
    ` : ''}

    ${recipe.closingNote ? `<div class="card"><div class="meta">${escapeHtml(recipe.closingNote)}</div></div>` : ''}
  `;

  container.querySelector('#back-to-list-btn').addEventListener('click', () => {
    renderRecipes(state, container, { saveState, toast });
  });

  container.querySelectorAll('.serving-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      container.querySelectorAll('.serving-chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
      const servings = chip.dataset.servings;
      const key = servings === '1' ? 'a1' : servings === '2' ? 'a2' : 'a4';
      container.querySelectorAll('.ing-row').forEach((row) => {
        row.querySelector('.ing-amount').textContent = row.dataset[key] || '';
      });
    });
  });
}

// Lets you assign an existing library recipe directly to a day/meal in the
// CURRENT cycle, bypassing menu generation entirely.
function openAssignPanel(state, container, recipe, { saveState, toast }) {
  const cycle = currentCycle(state);
  if (!cycle) {
    toast('No active week yet \u2014 set one up in the Menu tab first');
    return;
  }

  container.innerHTML = `
    <div class="card">
      <button class="btn secondary small" id="back-to-list-btn">\u2190 Back to Recipes</button>
    </div>
    <div class="card">
      <h3>Assign "${escapeHtml(recipe.title)}"</h3>
      <div class="meta">Assigning sets that meal to Plan and puts this recipe there \u2014 overwrites anything already assigned to that slot.</div>
      <div class="field">
        <label>Day</label>
        <select id="assign-day-select">
          ${cycle.days.map((d) => `<option value="${d.date}">${d.dayOfWeek.toUpperCase()} ${d.date}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Meal</label>
        <select id="assign-slot-select">
          <option value="dinner">Dinner</option>
          <option value="lunch">Lunch</option>
          <option value="breakfast">Breakfast</option>
        </select>
      </div>
      <button class="btn" id="confirm-assign-btn" style="margin-top:0.5rem;">Assign</button>
    </div>
  `;

  container.querySelector('#back-to-list-btn').addEventListener('click', () => {
    renderRecipes(state, container, { saveState, toast });
  });

  container.querySelector('#confirm-assign-btn').addEventListener('click', () => {
    const date = container.querySelector('#assign-day-select').value;
    const slotType = container.querySelector('#assign-slot-select').value;
    const day = cycle.days.find((d) => d.date === date);
    day.slots[slotType].state = 'plan';
    day.slots[slotType].result = { recipeId: recipe.id, servings: 2, notes: '' };
    saveState();
    toast(`"${recipe.title}" assigned to ${slotType} on ${day.dayOfWeek.toUpperCase()}`);
    renderRecipes(state, container, { saveState, toast });
  });
}

function openRecipeEditor(state, container, recipe, { saveState, toast }) {
  const isNew = !state.recipes.find((r) => r.id === recipe.id);
  container.innerHTML = `
    <div class="card">
      <h3>${isNew ? 'New Recipe' : 'Edit Recipe'}</h3>
      <div class="field"><label>Title</label><input type="text" id="f-title" value="${escapeAttr(recipe.title)}"></div>
      <div class="field"><label>Cuisine</label><input type="text" id="f-cuisine" value="${escapeAttr(recipe.tags?.cuisine)}" placeholder="e.g. mediterranean, asian_fusion, mexican..."></div>
      <div class="field"><label>Protein</label><input type="text" id="f-protein" value="${escapeAttr(recipe.tags?.protein)}" placeholder="e.g. pork, chicken, beef, tofu..."></div>
      <div class="field"><label>Texture</label><input type="text" id="f-texture" value="${escapeAttr(recipe.tags?.texture)}" placeholder="e.g. crispy, soft_tender..."></div>
      <div class="field"><label>Total time (minutes)</label><input type="number" id="f-time" value="${recipe.totalTimeMinutes || ''}"></div>
      <div class="field"><label>Reason in rotation (one line)</label><input type="text" id="f-reason" value="${escapeAttr(recipe.reasonInRotation)}"></div>
      <div class="field">
        <label>Flags</label>
        <div class="choice-row">
          ${['leftoverFriendly', 'eatFresh', 'batchable', 'vegHidden'].map((k) =>
            `<button type="button" class="choice-chip flag-chip ${recipe.tags?.[k] ? 'selected' : ''}" data-flag="${k}">${k}</button>`
          ).join('')}
        </div>
      </div>
      <div class="field">
        <label>Ingredients (one per line: name | 1-serving | 2-serving | 4-serving)</label>
        <textarea id="f-ingredients">${(recipe.ingredients || []).map(i => `${i.name} | ${i.amount1 || ''} | ${i.amount2 || ''} | ${i.amount4 || ''}`).join('\n')}</textarea>
      </div>
      <div class="field">
        <label>Sauce / glaze (optional, same format)</label>
        <textarea id="f-sauce">${(recipe.sauce || []).map(i => `${i.name} | ${i.amount1 || ''}`).join('\n')}</textarea>
      </div>
      <div class="field">
        <label>Steps (one per line)</label>
        <textarea id="f-steps">${(recipe.steps || []).map(s => s.text).join('\n')}</textarea>
      </div>
      <div class="field"><label>Closing note (optional)</label><textarea id="f-closing">${escapeHtml(recipe.closingNote || '')}</textarea></div>
      <div style="display:flex; gap:0.5rem;">
        <button class="btn" id="save-recipe-btn">Save</button>
        <button class="btn secondary" id="cancel-recipe-btn">Cancel</button>
      </div>
    </div>
  `;

  container.querySelectorAll('.flag-chip').forEach((chip) => {
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
  });

  container.querySelector('#cancel-recipe-btn').addEventListener('click', () => {
    renderRecipes(state, container, { saveState, toast });
  });

  container.querySelector('#save-recipe-btn').addEventListener('click', () => {
    const flags = {};
    container.querySelectorAll('.flag-chip').forEach((chip) => {
      flags[chip.dataset.flag] = chip.classList.contains('selected');
    });
    recipe.title = container.querySelector('#f-title').value.trim();
    if (!recipe.title) { toast('Title is required'); return; }
    recipe.tags = {
      cuisine: container.querySelector('#f-cuisine').value.trim(),
      protein: container.querySelector('#f-protein').value.trim(),
      texture: container.querySelector('#f-texture').value.trim(),
      ...flags,
    };
    recipe.totalTimeMinutes = Number(container.querySelector('#f-time').value) || null;
    recipe.reasonInRotation = container.querySelector('#f-reason').value.trim();
    recipe.ingredients = container.querySelector('#f-ingredients').value.split('\n').filter(Boolean).map((line) => {
      const [name, amount1, amount2, amount4] = line.split('|').map((s) => (s || '').trim());
      return { name, amount1, amount2, amount4 };
    });
    recipe.sauce = container.querySelector('#f-sauce').value.split('\n').filter(Boolean).map((line) => {
      const [name, amount1] = line.split('|').map((s) => (s || '').trim());
      return { name, amount1 };
    });
    recipe.steps = container.querySelector('#f-steps').value.split('\n').filter(Boolean).map((text) => ({ text: text.trim(), timeMinutes: null }));
    recipe.closingNote = container.querySelector('#f-closing').value.trim() || null;

    if (isNew) state.recipes.push(recipe);
    saveState();
    toast('Recipe saved');
    renderRecipes(state, container, { saveState, toast });
  });
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
