// menu.js — generates the by-night dinner menu for a cycle, handles
// accept/swap per night, and reverses the finished menu into a Produce+Meat
// grocery needs list. Rules-based by default; occasionally offers an
// AI-generated slot (via api.js) for novelty.

import { api } from './api.js';
import { getCandidatePool, pickWeighted } from './recipes.js';

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

const NOVELTY_AI_CHANCE = 0.2; // ~1 in 5 dinner slots offers an AI suggestion instead of a library pick

export function recentTitles(state, beforeCycleId) {
  // last 2 cycles' dinner picks, for repeat-avoidance
  const cycles = state.cycles.slice(-3).filter((c) => c.id !== beforeCycleId);
  const titles = [];
  cycles.forEach((c) => c.days.forEach((d) => {
    const r = d.slots.dinner?.result;
    if (r?.recipeId) {
      const rec = state.recipes.find((x) => x.id === r.recipeId);
      if (rec) titles.push(rec.title);
    }
  }));
  return titles;
}

function activeProfilesFor(state, day) {
  return (state.profiles || []).filter((p) => day.activeProfileIds.includes(p.id));
}

export { activeProfilesFor };

// Assigns an already-fleshed-out full Recipe object to a day's dinner slot,
// saving it into the library if it isn't there yet (source: 'ai_generated').
// Used by the idea-picker flow \u2014 recipes get built as the user picks, not
// written by hand beforehand.
export function assignRecipeToDay(state, day, recipe, { saveState }) {
  if (!state.recipes.find((r) => r.id === recipe.id)) {
    state.recipes.push(recipe);
  }
  day.slots.dinner.result = { recipeId: recipe.id, servings: 2, notes: '' };
  saveState();
}

export async function generateMenu(state, cycle, { saveState, toast, aiEnabled }) {
  const recent = recentTitles(state, cycle.id);

  for (const day of cycle.days) {
    if (day.slots.dinner.state !== 'plan') continue;
    if (day.slots.dinner.result) continue; // already assigned, don't clobber
    if (!day.activeProfileIds.length) continue; // nobody's eating this night \u2014 nothing to generate for

    const profiles = activeProfilesFor(state, day);
    const pool = getCandidatePool(state.recipes, profiles, recent);

    const tryAi = aiEnabled && Math.random() < NOVELTY_AI_CHANCE;
    let assigned = false;

    if (tryAi) {
      toast(`Asking AI for a dinner idea (${day.dayOfWeek})...`);
      const suggestion = await api.getRecipeSuggestion({
        cuisineWeighting: cycle.cuisineWeighting,
        activeProfiles: profiles,
        recentTitles: recent,
      });
      if (suggestion && suggestion.title) {
        const tempRecipe = {
          id: `pending_${Math.random().toString(36).slice(2, 10)}`,
          createdAt: new Date().toISOString(),
          source: 'ai_generated',
          rejectedCount: 0,
          ...suggestion,
        };
        day.slots.dinner.result = { recipeId: tempRecipe.id, servings: 2, notes: '', pendingRecipe: tempRecipe };
        assigned = true;
      }
    }

    if (!assigned) {
      if (!pool.length) {
        // Deliberately do NOT set day.slots.dinner.result here. An earlier
        // version set a placeholder object as the "result" when nothing fit,
        // which made every later check ("is this night already assigned?")
        // treat the night as permanently done \u2014 even though nothing real
        // had been assigned. Leaving result null keeps the night open for a
        // future retry (regenerate, or the AI idea-picker).
        continue;
      }
      const pick = pickWeighted(pool, cycle.cuisineWeighting);
      day.slots.dinner.result = { recipeId: pick.id, servings: 2, notes: '' };
      recent.push(pick.title);
    }
  }

  saveState();
}

export function swapNight(state, cycle, day, { saveState, toast }) {
  if (!day.activeProfileIds.length) {
    toast('No one is selected for this night \u2014 mark who\u2019s eating first.');
    return;
  }
  const profiles = activeProfilesFor(state, day);
  const recent = recentTitles(state, cycle.id);
  const currentTitle = day.slots.dinner.result?.recipeId
    ? state.recipes.find((r) => r.id === day.slots.dinner.result.recipeId)?.title
    : null;

  // log rejection of current pick before replacing
  if (currentTitle) {
    state.rejectedAiSuggestions = state.rejectedAiSuggestions || [];
    const rec = state.recipes.find((r) => r.title === currentTitle);
    if (rec) rec.rejectedCount = (rec.rejectedCount || 0) + 1;
  }
  if (currentTitle) recent.push(currentTitle);

  const pool = getCandidatePool(state.recipes, profiles, recent).filter(
    (r) => r.id !== day.slots.dinner.result?.recipeId
  );

  if (!pool.length) {
    toast('Nothing else fits this night\u2019s constraints \u2014 keeping current pick.');
    return;
  }
  const pick = pickWeighted(pool, cycle.cuisineWeighting);
  day.slots.dinner.result = { recipeId: pick.id, servings: 2, notes: '' };
  saveState();
}

// Reverses the finished menu into Produce + Meat lines. Tier-1 always-stocked
// staples are skipped by convention (a fixed keyword list, matching
// pantry-baseline.md's Tier 1) \u2014 everything else the menu calls for gets listed,
// no partial-stock judgement in-app (per design: "if I need it I'll grab it,
// if not I'll delete the line").
const ALWAYS_STOCKED_KEYWORDS = [
  'salt', 'pepper', 'cumin', 'paprika', 'chili flake', 'chili powder', 'onion powder',
  'garlic powder', 'turmeric', 'oil', 'vinegar', 'soy sauce', 'gochujang', 'olives',
  'capers', 'pasta', 'couscous', 'quinoa', 'egg', 'jasmine rice', 'sticky rice', 'rice',
];

function isAlwaysStocked(name) {
  const n = name.toLowerCase();
  return ALWAYS_STOCKED_KEYWORDS.some((k) => n.includes(k));
}

export function reverseMenuToGroceryLines(state, cycle) {
  // Keyed by normalized name so exact-match repeats (the same ingredient
  // string used by more than one recipe/night) collapse into one line
  // instead of showing up as separate rows. This is deliberately
  // conservative \u2014 only literal same-name matches merge here. Genuinely
  // related-but-differently-worded items (lemon juice + lemon zest + lemon
  // wedges all being "lemons") need real culinary judgment to consolidate
  // correctly, which is what the Shopping List's "Consolidate with AI"
  // button is for \u2014 this function intentionally doesn't guess at that.
  const grouped = new Map(); // normalizedName -> { name, quantities: Set<string>, nights: Set<string>, category }

  for (const day of cycle.days) {
    const slot = day.slots.dinner;
    if (slot.state !== 'plan' || !slot.result) continue;
    const recipe = slot.result.pendingRecipe || state.recipes.find((r) => r.id === slot.result.recipeId);
    if (!recipe) continue;
    const servingsKey = slot.result.servings === 1 ? 'amount1' : slot.result.servings >= 4 ? 'amount4' : 'amount2';
    [...(recipe.ingredients || []), ...(recipe.sauce || [])].forEach((ing) => {
      if (isAlwaysStocked(ing.name)) return;
      const isMeat = /pork|beef|chicken|fish|salmon|shrimp|tofu|egg|thigh|belly/i.test(ing.name)
        && !/egg\b/i.test(ing.name); // eggs already excluded as staple above, but keep this readable
      const quantity = ing[servingsKey] || ing.amount1 || '';
      const key = ing.name.trim().toLowerCase().replace(/\s+/g, ' ');

      if (!grouped.has(key)) {
        grouped.set(key, {
          name: ing.name.trim(),
          quantities: new Set(),
          nights: new Set(),
          category: isMeat ? 'meat_protein' : 'produce',
        });
      }
      const entry = grouped.get(key);
      if (quantity) entry.quantities.add(quantity);
      entry.nights.add(day.dayOfWeek);
    });
  }

  return [...grouped.values()].map((entry) => ({
    name: entry.name,
    quantity: [...entry.quantities].join(' + '),
    night: [...entry.nights].join(', '),
    category: entry.category,
  }));
}
