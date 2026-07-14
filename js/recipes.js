// recipes.js — recipe library CRUD + the rules-based candidate-matching logic
// used by menu.js. No AI here; this is the deterministic half of menu generation.

import { currentCycle } from './cycles.js';
import { api } from './api.js';

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

// Persists across re-renders of this tab (module-level, resets on page reload)
// so the filter stays put while you're adding/editing/assigning recipes.
let activeCuisineFilter = null;
let recipeSearchTerm = '';

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

// --- Rarity ----------------------------------------------------------------
// Global (not per-profile) suggestion-frequency control for ingredients that
// are rare/expensive/hard to get \u2014 not limited to proteins (lamb, swordfish,
// saffron, truffle oil, whatever). Configured via the Recipes tab. This is a
// cost/availability control, not a taste rule, which is why it lives here
// rather than in Profile.restrictions.

// Scans every cycle ever created for the most recent date a recipe using
// this item was actually cooked, so "less than once a quarter" checks real
// history, not just the current week. Matches either the recipe's protein
// tag (exact) or the item appearing anywhere in its ingredient/sauce names
// (substring) \u2014 covers both "lamb" as a protein tag and "saffron" as a
// plain ingredient that would never be a protein tag.
export function itemLastUsedDate(state, item) {
  const key = item.toLowerCase().trim();
  let latest = null;
  (state.cycles || []).forEach((cyc) => {
    cyc.days.forEach((day) => {
      ['breakfast', 'lunch', 'dinner'].forEach((slotType) => {
        const result = day.slots?.[slotType]?.result;
        if (!result?.recipeId) return;
        const rec = (state.recipes || []).find((x) => x.id === result.recipeId);
        if (!rec) return;
        if (recipeMatchesRarityKey(rec, key)) {
          if (!latest || day.date > latest) latest = day.date;
        }
      });
    });
  });
  return latest;
}

export function daysSince(dateStr) {
  if (!dateStr) return Infinity; // never used = as far in the past as possible
  const [y, m, d] = dateStr.split('-').map(Number);
  const then = new Date(y, m - 1, d);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((now - then) / 86400000);
}

function recipeMatchesRarityKey(recipe, key) {
  const protein = (recipe.tags?.protein || '').toLowerCase().trim();
  if (protein === key) return true;
  const ingredientText = [
    ...(recipe.ingredients || []).map((i) => i.name),
    ...(recipe.sauce || []).map((s) => s.name),
  ].join(' ').toLowerCase();
  return ingredientText.includes(key);
}

// 'avoid' excludes outright (still fully assignable manually via Recipes).
// 'rare' deprioritizes while inside its window \u2014 doesn't exclude, so it can
// still surface as a last resort if nothing else fits. A recipe can match
// more than one rarity entry (e.g. a lamb dish that also uses saffron) \u2014
// any 'avoid' match excludes it outright; otherwise any 'rare' match still
// inside its window deprioritizes it.
export function checkRarityAllowed(recipe, state) {
  const rarity = state.rarity || {};
  const matchedKeys = Object.keys(rarity).filter((key) => recipeMatchesRarityKey(recipe, key.toLowerCase().trim()));
  if (!matchedKeys.length) return { allowed: true };

  for (const key of matchedKeys) {
    if (rarity[key].tier === 'avoid') {
      return { allowed: false, reason: `"${key}" is marked Avoid \u2014 assign it manually from the Recipes tab if you want it` };
    }
  }

  let deprioritized = false;
  let reason = null;
  for (const key of matchedKeys) {
    if (rarity[key].tier === 'rare') {
      const since = daysSince(itemLastUsedDate(state, key));
      const window = rarity[key].windowDays || 90;
      if (since < window) {
        deprioritized = true;
        reason = `"${key}" used ${since}d ago \u2014 inside its ${window}-day rare window`;
      }
    }
  }
  return { allowed: true, deprioritized, reason };
}

// Given full app state + active profiles, return the valid candidate pool
// (intersection of every active profile's constraints, plus rarity rules),
// sorted so less-recently-used and non-deprioritized recipes come first.
// Takes `state` rather than just a recipes array because the rarity check
// needs to scan cycle history for "when was this last used."
export function getCandidatePool(state, profiles, recentTitles = []) {
  const pool = (state.recipes || [])
    .map((r) => {
      const profileCheck = checkRecipeAgainstProfiles(r, profiles);
      if (!profileCheck.allowed) return { recipe: r, check: profileCheck };
      const rarityCheck = checkRarityAllowed(r, state);
      if (!rarityCheck.allowed) return { recipe: r, check: { allowed: false, reason: rarityCheck.reason } };
      return {
        recipe: r,
        check: {
          allowed: true,
          // merge both signals \u2014 a recipe can be deprioritized for texture
          // reasons AND for rarity reasons at once
          deprioritized: !!(profileCheck.deprioritized || rarityCheck.deprioritized),
        },
      };
    })
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

// Share-safe shape: strips fields that are meaningless (or mildly private,
// like exact createdAt timestamps) to a recipient \u2014 id, createdAt, source,
// and rejectedCount are all this app's own internal bookkeeping, not part of
// the recipe itself. The importer already assigns a fresh id/createdAt/
// source on the way in (see normalizeImportedRecipe), so none of this is lost.
function toShareSafeRecipe(r) {
  return {
    title: r.title,
    tags: r.tags,
    totalTimeMinutes: r.totalTimeMinutes,
    reasonInRotation: r.reasonInRotation,
    ingredients: r.ingredients,
    sauce: r.sauce,
    steps: r.steps,
    closingNote: r.closingNote,
  };
}

function downloadRecipesJson(recipes) {
  const payload = { recipes: recipes.map(toShareSafeRecipe) };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mise-recipes-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function openImportPanel(state, container, { saveState, toast }) {
  container.innerHTML = `
    <div class="card">
      <h3>Import Recipe(s) from JSON</h3>
      <div class="meta">Pick a file exported from another Mise (via "Export Recipes"), or paste JSON
        directly \u2014 from a recipe photo or text you had a separate Claude chat convert, or anything
        matching Mise's recipe shape. Accepts one recipe object, or <code>{"recipes": [...]}</code>
        for several at once. See DATA-MODEL.md for the exact shape, or just ask Claude: "turn this
        recipe into JSON for my Mise app" and paste a photo/text.</div>
      <button class="btn secondary small" id="import-file-pick-btn" style="margin-bottom:0.6rem;">Choose file...</button>
      <input type="file" id="import-recipe-file-input" accept="application/json" style="display:none;">
      <div class="meta" style="margin:0.4rem 0;">\u2014 or paste JSON \u2014</div>
      <textarea id="import-json-textarea" style="min-height:10rem;" placeholder='{"title": "...", "tags": {...}, "ingredients": [...], "steps": [...]}'></textarea>
      <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
        <button class="btn" id="do-import-btn">Import pasted JSON</button>
        <button class="btn secondary" id="cancel-import-btn">Cancel</button>
      </div>
    </div>
  `;

  container.querySelector('#cancel-import-btn').addEventListener('click', () => {
    renderRecipes(state, container, { saveState, toast });
  });

  function importFromRawText(text) {
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
  }

  container.querySelector('#do-import-btn').addEventListener('click', () => {
    importFromRawText(container.querySelector('#import-json-textarea').value.trim());
  });

  container.querySelector('#import-file-pick-btn').addEventListener('click', () => {
    container.querySelector('#import-recipe-file-input').click();
  });
  container.querySelector('#import-recipe-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    importFromRawText(text.trim());
  });
}

export function renderRecipes(state, container, { saveState, toast }) {
  const recipes = state.recipes || [];

  const cuisines = [...new Set(recipes.map((r) => r.tags?.cuisine).filter(Boolean))].sort();
  if (activeCuisineFilter && !cuisines.includes(activeCuisineFilter)) activeCuisineFilter = null;

  let html = `<div class="card">
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn" id="add-recipe-btn">+ Add Recipe</button>
      <button class="btn secondary" id="import-recipe-btn">Import Recipe(s) (JSON)</button>
      <button class="btn secondary" id="export-recipes-btn">Export Recipes (JSON)</button>
    </div>
    <div class="meta" style="margin-top:0.4rem;">Export saves a share-safe file \u2014 recipes only, no profiles or meal history \u2014 you can hand to anyone to import into their own Mise.</div>
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

  html += `<div class="card">
    <h3>Search</h3>
    <div class="meta">Matches title, protein, or any ingredient \u2014 try "lemon", "gochujang", "sirloin".</div>
    <input type="text" id="recipe-search-input" placeholder="e.g. chicken, lemon, gochujang..." value="${escapeAttr(recipeSearchTerm)}">
  </div>`;

  const detectedProteins = recipes.map((r) => r.tags?.protein?.toLowerCase().trim()).filter(Boolean);
  const manuallyAdded = Object.keys(state.rarity || {});
  const rarityItems = [...new Set([...detectedProteins, ...manuallyAdded])].sort();

  html += `<div class="card">
    <details>
      <summary style="cursor:pointer; font-weight:600; font-size:1.05rem;">Rarity</summary>
      <div class="meta" style="margin-top:0.4rem;">For any ingredient that's rare, expensive, or hard to get \u2014 not a taste preference, a shopping-reality control. Not limited to proteins. "Rare" still gets suggested once it's been long enough since you last cooked it; "Avoid" never auto-suggests but you can always assign it manually.</div>
      ${rarityItems.length ? rarityItems.map((p) => {
        const rarity = (state.rarity || {})[p];
        const tier = rarity?.tier || 'none';
        const window = rarity?.windowDays || 90;
        return `<div class="checklist-row" data-item="${p}" style="flex-wrap:wrap;">
          <span>${escapeHtml(p)}</span>
          <div style="display:flex; gap:0.3rem; align-items:center; flex-wrap:wrap;">
            <div class="choice-row rarity-row" data-item="${p}">
              <button type="button" class="choice-chip rarity-chip ${tier === 'none' ? 'selected' : ''}" data-tier="none">No restriction</button>
              <button type="button" class="choice-chip rarity-chip ${tier === 'rare' ? 'selected' : ''}" data-tier="rare">Rare</button>
              <button type="button" class="choice-chip rarity-chip ${tier === 'avoid' ? 'selected' : ''}" data-tier="avoid">Avoid</button>
            </div>
            ${tier === 'rare' ? `<input type="number" class="rarity-window-input" data-item="${p}" value="${window}" min="7" max="365" style="width:4.5rem; padding:0.3rem;"> days` : ''}
            <button class="btn danger small remove-rarity-item-btn" data-item="${p}">Remove</button>
          </div>
        </div>`;
      }).join('') : '<div class="meta">No items yet.</div>'}
      <div style="display:flex; gap:0.4rem; margin-top:0.6rem;">
        <input type="text" id="add-rarity-item-input" placeholder="Add any ingredient, e.g. saffron, truffle oil, lamb..." style="flex:1;">
        <button class="btn secondary small" id="add-rarity-item-btn">Add</button>
      </div>
    </details>
  </div>`;

  function recipeMatchesSearch(r, term) {
    if (!term) return true;
    const t = term.toLowerCase();
    if ((r.title || '').toLowerCase().includes(t)) return true;
    if ((r.tags?.protein || '').toLowerCase().includes(t)) return true;
    const ingredientNames = [
      ...(r.ingredients || []).map((i) => i.name),
      ...(r.sauce || []).map((s) => s.name),
    ].join(' ').toLowerCase();
    return ingredientNames.includes(t);
  }

  const visibleRecipes = recipes
    .filter((r) => !activeCuisineFilter || r.tags?.cuisine === activeCuisineFilter)
    .filter((r) => recipeMatchesSearch(r, recipeSearchTerm));


  if (!recipes.length) {
    html += `<div class="empty-state">No recipes yet. Add one, or import your starter JSON from Settings.</div>`;
  } else if (!visibleRecipes.length) {
    const filterDescriptions = [];
    if (activeCuisineFilter) filterDescriptions.push(`cuisine "${activeCuisineFilter.replace(/_/g, ' ')}"`);
    if (recipeSearchTerm) filterDescriptions.push(`"${recipeSearchTerm}"`);
    html += `<div class="empty-state">No recipes match ${filterDescriptions.join(' and ')}.</div>`;
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

  const recipeSearchInput = container.querySelector('#recipe-search-input');
  if (recipeSearchInput) {
    recipeSearchInput.addEventListener('input', () => {
      recipeSearchTerm = recipeSearchInput.value;
      renderRecipes(state, container, { saveState, toast });
      const newInput = container.querySelector('#recipe-search-input');
      if (newInput) {
        newInput.focus();
        newInput.setSelectionRange(newInput.value.length, newInput.value.length);
      }
    });
  }

  state.rarity = state.rarity || {};
  container.querySelectorAll('.rarity-row').forEach((row) => {
    row.querySelectorAll('.rarity-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const item = row.dataset.item;
        const tier = chip.dataset.tier;
        if (tier === 'none') {
          delete state.rarity[item];
        } else if (tier === 'avoid') {
          state.rarity[item] = { tier: 'avoid' };
        } else {
          const existingWindow = state.rarity[item]?.windowDays || 90;
          state.rarity[item] = { tier: 'rare', windowDays: existingWindow };
        }
        saveState();
        renderRecipes(state, container, { saveState, toast });
      });
    });
  });
  container.querySelectorAll('.rarity-window-input').forEach((input) => {
    input.addEventListener('change', () => {
      const item = input.dataset.item;
      const days = Math.max(7, Math.min(365, Number(input.value) || 90));
      if (state.rarity[item]?.tier === 'rare') {
        state.rarity[item].windowDays = days;
        saveState();
        toast(`"${item}" rare window set to ${days} days`);
      }
    });
  });
  container.querySelectorAll('.remove-rarity-item-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.dataset.item;
      delete state.rarity[item];
      saveState();
      toast(`Removed "${item}" from the rarity list`);
      renderRecipes(state, container, { saveState, toast });
    });
  });
  const addRarityBtn = container.querySelector('#add-rarity-item-btn');
  if (addRarityBtn) {
    addRarityBtn.addEventListener('click', () => {
      const input = container.querySelector('#add-rarity-item-input');
      const item = input.value.trim().toLowerCase();
      if (!item) return;
      if (!state.rarity[item]) {
        state.rarity[item] = { tier: 'rare', windowDays: 90 };
      }
      saveState();
      toast(`"${item}" added to the rarity list`);
      renderRecipes(state, container, { saveState, toast });
    });
  }

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
  container.querySelector('#export-recipes-btn').addEventListener('click', () => {
    if (!recipes.length) { toast('No recipes to export yet'); return; }
    downloadRecipesJson(recipes);
    toast(`Exported ${recipes.length} recipe(s)`);
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
      <div style="margin-top:0.6rem; display:flex; gap:0.4rem; align-items:center; flex-wrap:wrap;">
        <input type="text" id="substitute-protein-input" placeholder="e.g. ground beef, chicken thighs..." style="flex:1; min-width:10rem;">
        <button class="btn secondary small" id="substitute-protein-btn">Substitute Protein</button>
      </div>
      <div class="meta" id="substitute-status" style="margin-top:0.3rem;"></div>
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

  container.querySelector('#substitute-protein-btn').addEventListener('click', async () => {
    const newProtein = container.querySelector('#substitute-protein-input').value.trim();
    if (!newProtein) { toast('Type a protein to substitute in'); return; }

    const btn = container.querySelector('#substitute-protein-btn');
    const statusEl = container.querySelector('#substitute-status');
    btn.textContent = 'Rewriting recipe...';
    btn.disabled = true;
    statusEl.textContent = '';

    const detail = await api.getProteinSubstitution({ recipe, newProtein });

    if (!detail || !detail.title) {
      statusEl.textContent = 'Could not rewrite this recipe \u2014 check js/api.js\u2019s ENDPOINT and the console, then try again.';
      statusEl.style.color = 'var(--danger)';
      btn.textContent = 'Substitute Protein';
      btn.disabled = false;
      return;
    }

    // Overwrite in place \u2014 same id, same createdAt/source/rejectedCount, everything
    // else replaced with the rewritten version.
    Object.assign(recipe, {
      title: detail.title,
      tags: detail.tags || recipe.tags,
      totalTimeMinutes: detail.totalTimeMinutes ?? recipe.totalTimeMinutes,
      reasonInRotation: detail.reasonInRotation ?? recipe.reasonInRotation,
      ingredients: detail.ingredients || [],
      sauce: detail.sauce || [],
      steps: detail.steps || [],
      closingNote: detail.closingNote ?? null,
    });
    saveState();
    toast(`Recipe updated: "${detail.title}"`);
    renderRecipeView(state, container, recipe, { saveState, toast });
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
      cuisine: container.querySelector('#f-cuisine').value.trim().toLowerCase(),
      protein: container.querySelector('#f-protein').value.trim().toLowerCase(),
      texture: container.querySelector('#f-texture').value.trim().toLowerCase(),
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
