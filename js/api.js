// api.js — calls your existing Cloudflare Worker, same contract as your other
// app's api.js: POST { model, max_tokens, messages, system? } -> raw Anthropic
// response. The Worker holds the real API key server-side; this file never
// sees it.
//
// SETUP: fill in your Worker's URL below before deploying.

const MODEL_SONNET = 'claude-sonnet-5';   // recipe writing, idea batches — needs real culinary judgment
const MODEL_HAIKU = 'claude-haiku-4-5-20251001';  // lightweight classification/extraction — cheap, plenty capable for these
const MODEL_RICH = 'claude-opus-4-8';      // the one genuinely open-ended conversational call (Special date-night chat)
const MODEL_FAST = MODEL_SONNET; // kept as an alias so send()'s default param doesn't need touching
const MAX_TOKENS = 1000;
const ENDPOINT = 'https://spring-rain-0f72.sstnicolaas.workers.dev'; // <-- confirm this is still current

function safeParseJSON(raw) {
  const clean = raw.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    // Truncation repair. The naive version of this only handled truncation
    // mid-VALUE (e.g. `"amount1": "unterminated`). It gave up completely on
    // truncation mid-KEY (e.g. `..., "sc` with no colon yet), which is just
    // as likely when a long recipe runs past the token budget. This version
    // repeatedly backs up to the last complete comma-separated element and
    // re-closes whatever's still open, trying again each time, so it
    // salvages everything generated before the cutoff instead of nothing.
    let text = clean;
    for (let attempt = 0; attempt < 60 && text.length > 10; attempt++) {
      const lastComma = text.lastIndexOf(',');
      if (lastComma === -1) break;
      text = text.slice(0, lastComma);

      const opens = (text.match(/\{/g) || []).length;
      const closes = (text.match(/\}/g) || []).length;
      const arrOpens = (text.match(/\[/g) || []).length;
      const arrCloses = (text.match(/\]/g) || []).length;
      let candidate = text;
      for (let i = 0; i < arrOpens - arrCloses; i++) candidate += ']';
      for (let i = 0; i < opens - closes; i++) candidate += '}';

      try {
        return JSON.parse(candidate);
      } catch {
        continue; // back up further and try again
      }
    }
    console.warn('[Mise] AI response could not be parsed as JSON, even after truncation-repair. Raw response follows \u2014 copy this if you need help debugging:');
    console.warn(raw);
    return null;
  }
}

export const api = {
  // Low-level send, matches the other app's contract exactly.
  async send({ system, messages, maxTokens = MAX_TOKENS, model = MODEL_FAST }) {
    const body = { model, max_tokens: maxTokens, messages };
    if (system) body.system = system;

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error ${response.status}`);
    }

    const data = await response.json();

    // Defensive: the Worker currently returns HTTP 200 even when the
    // underlying Anthropic call itself failed (rate limit, overloaded, bad
    // request, etc.), since it doesn't pass the upstream status code
    // through. That means response.ok is true here even on a real failure,
    // and Anthropic's error body has no `content` array \u2014 checking for it
    // explicitly turns a cryptic "Cannot read properties of undefined
    // (reading 'filter')" crash into a real, readable error message.
    if (!data || !Array.isArray(data.content)) {
      const message = data?.error?.message || 'Unexpected response shape from the Worker \u2014 check the console for the raw response.';
      console.error('[Mise] Unexpected API response (no content array):', data);
      throw new Error(message);
    }

    return data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  },

  // ---------------------------------------------------------------------
  // getRecipeSuggestion — the AI-novelty menu slot.
  // Returns a full Recipe-shaped object (matching DATA-MODEL.md) or null
  // if the call/parse failed — caller must fall back to a rules-based pick.
  // ---------------------------------------------------------------------
  async getRecipeSuggestion({ cuisineWeighting, activeProfiles, recentTitles, rarityConstraints, onHandNote }) {
    const system = `You are a recipe suggestion service inside a personal meal-planning app called Mise.
Return ONLY valid JSON. No preamble, no explanation, no markdown fences.
Suggest ONE dinner recipe that fits the constraints given. It should feel like a genuine
new idea, not a copy of something already in recent rotation.
Respect every profile's restrictions as hard constraints — never include an ingredient
listed as a strict avoid for any active profile.
${rarityConstraints ? `\n${rarityConstraints}\nTreat any item marked AVOID or inside its rare window as off-limits for this suggestion.` : ''}
${onHandNote ? `\nThe user mentioned having this on hand: "${onHandNote}". If it fits naturally, feel free to build this suggestion around it \u2014 but don't force it if it doesn't fit the cuisine/profile constraints.` : ''}`;

    const profileText = (activeProfiles || [])
      .map((p) => {
        const restr = (p.restrictions || [])
          .filter((r) => r.severity === 'strict')
          .map((r) => r.item)
          .join(', ') || 'none';
        return `- ${p.name}: diet=${p.dietType || 'unspecified'}, strict avoids=[${restr}], texture likes=${p.textureLikes || 'no preference'}, spice=${p.spiceTolerance || 'unspecified'}`;
      })
      .join('\n') || '- (no specific profile constraints active)';

    const messages = [{
      role: 'user',
      content: `Cuisine weighting for this week: ${JSON.stringify(cuisineWeighting || {})}.
Active profiles tonight:
${profileText}
Recently cooked (avoid repeating): ${(recentTitles || []).join(', ') || 'none'}.

Return JSON matching this shape exactly:
{
  "title": "string",
  "tags": { "cuisine": "string", "protein": "string", "texture": "string", "leftoverFriendly": true, "eatFresh": false, "batchable": false, "vegHidden": false },
  "totalTimeMinutes": number,
  "reasonInRotation": "string, one line",
  "ingredients": [ { "name": "string", "amount1": "string", "amount2": "string", "amount4": "string" } ],
  "sauce": [ { "name": "string", "amount1": "string", "scaleNote": "string or null" } ],
  "steps": [ { "text": "string", "timeMinutes": number or null } ],
  "closingNote": "string or null"
}`,
    }];

    try {
      const raw = await this.send({ system, messages, maxTokens: 1600, model: MODEL_FAST });
      return safeParseJSON(raw);
    } catch (e) {
      console.error('getRecipeSuggestion failed', e);
      return null;
    }
  },

  // ---------------------------------------------------------------------
  // getMealSlotIdea — single-shot breakfast/lunch suggestion for a
  // "Plan" toggle on a non-dinner slot. Not saved to the library unless
  // the user explicitly asks to.
  // ---------------------------------------------------------------------
  async getMealSlotIdea({ slotType, activeProfiles, note }) {
    const system = `You are a meal idea assistant inside a personal meal-planning app called Mise.
Return ONLY valid JSON. No preamble, no markdown fences.
Suggest 2-3 short ${slotType} ideas suited to the people described. Keep each idea to
1-2 sentences — this is a quick suggestion, not a full recipe card.`;

    const profileText = (activeProfiles || [])
      .map((p) => `- ${p.name}: diet=${p.dietType || 'unspecified'}, texture likes=${p.textureLikes || 'no preference'}`)
      .join('\n') || '- (no specific profile constraints)';

    const messages = [{
      role: 'user',
      content: `Meal type: ${slotType}.
Who's eating:
${profileText}
Extra context from the user: ${note || 'none'}.

Return JSON:
{ "ideas": [ { "title": "string", "description": "string" } ] }`,
    }];

    try {
      const raw = await this.send({ system, messages, maxTokens: 400, model: MODEL_HAIKU });
      return safeParseJSON(raw);
    } catch (e) {
      console.error('getMealSlotIdea failed', e);
      return null;
    }
  },

  // ---------------------------------------------------------------------
  // getDateNightReply — open conversational turn for "Special" slots.
  // messages = full running transcript (role/content pairs) for this session.
  // Returns plain text (not structured JSON) — this is a real conversation.
  // ---------------------------------------------------------------------
  async getDateNightReply({ messages }) {
    const system = `You are helping plan a one-off special / date-night dinner inside a personal
meal-planning app called Mise. This is a real conversation, not a structured lookup.
Ask about what's on hand, what they're willing to buy, who it's for, how fancy, any
theme — but don't interrogate; respond naturally and offer concrete dish ideas once
you have enough to work with. Keep responses conversational and concise.`;

    try {
      return await this.send({ system, messages, maxTokens: 500, model: MODEL_RICH });
    } catch (e) {
      console.error('getDateNightReply failed', e);
      return "I couldn't reach the AI assistant just now — the Worker call failed. You can keep planning manually, or try again in a moment.";
    }
  },

  // ---------------------------------------------------------------------
  // getProfileNote — turns a free-text note ("won't eat cilantro") into a
  // structured restriction/AI-note entry for a Profile. Falls back to
  // storing the raw text as a note if parsing fails.
  // ---------------------------------------------------------------------
  async getProfileNote({ freeText }) {
    const system = `You are helping build an eating profile inside a personal meal-planning app.
Return ONLY valid JSON, no preamble, no markdown fences.
Read the free-text note and decide if it describes a food to avoid (extract the
food item name) or is just general context worth keeping as a note.`;

    const messages = [{
      role: 'user',
      content: `Free text from the user about this person's eating: "${freeText}"

Return JSON:
{
  "isAvoidance": true or false,
  "item": "string or null — the specific food/ingredient to avoid, if isAvoidance",
  "severity": "strict" or "flexible" or null,
  "noteText": "string — a clean one-line summary to store as a note either way"
}`,
    }];

    try {
      const raw = await this.send({ system, messages, maxTokens: 200, model: MODEL_HAIKU });
      return safeParseJSON(raw) || { isAvoidance: false, item: null, severity: null, noteText: freeText };
    } catch (e) {
      console.error('getProfileNote failed', e);
      return { isAvoidance: false, item: null, severity: null, noteText: freeText };
    }
  },

  // ---------------------------------------------------------------------
  // getRecipeIdeaBatch — lightweight, cheap: N short dish ideas (no full
  // ingredients/steps yet) matching this week's weighting/profiles. Used to
  // let the user browse and pick before paying for full detail on each.
  // ---------------------------------------------------------------------
  async getRecipeIdeaBatch({ cuisineWeighting, activeProfiles, count = 8, recentTitles, rarityConstraints, onHandNote, mealType = 'dinner' }) {
    const mealGuidance = {
      breakfast: 'Suggest genuinely BREAKFAST-appropriate ideas \u2014 quick morning food (eggs, oatmeal, yogurt bowls, toast, pancakes, breakfast burritos, etc.), not dinner-style mains scaled down. Keep prep realistically quick for a morning.',
      lunch: 'Suggest genuinely LUNCH-appropriate ideas \u2014 lighter, often portable or quick midday food (salads, sandwiches, grain bowls, soups, wraps, leftovers-friendly dishes), not a full dinner-style main course.',
      dinner: 'Suggest dinner ideas \u2014 the main meal of the day, can be more involved than breakfast/lunch.',
    }[mealType] || 'Suggest dinner ideas.';

    const system = `You are a ${mealType} idea generator inside a personal meal-planning app called Mise.
Return ONLY valid JSON. No preamble, no explanation, no markdown fences.
Suggest ${count} distinct ${mealType} ideas fitting the cuisine weighting and profile constraints given.
${mealGuidance}
Keep each idea short — title + one line — this is a browsing list, not a full recipe.
Respect every profile's strict avoids as hard constraints. Vary proteins and textures across
the set rather than repeating the same protein in every idea.
${rarityConstraints ? `\n${rarityConstraints}\nTreat any item marked AVOID or inside its rare window as off-limits \u2014 don't include it in any idea.` : ''}
${onHandNote ? `\nThe user mentioned having this on hand: "${onHandNote}". Use it as inspiration for ONE OR TWO of the ${count} ideas where it fits naturally \u2014 do NOT restrict the whole batch to only these items. The rest of the ideas should still be a broad, varied mix as usual.` : ''}`;

    const profileText = (activeProfiles || [])
      .map((p) => {
        const restr = (p.restrictions || []).filter((r) => r.severity === 'strict').map((r) => r.item).join(', ') || 'none';
        return `- ${p.name}: diet=${p.dietType || 'unspecified'}, strict avoids=[${restr}], texture likes=${p.textureLikes || 'no preference'}`;
      })
      .join('\n') || '- (no specific profile constraints active)';

    const messages = [{
      role: 'user',
      content: `Cuisine weighting for this period: ${JSON.stringify(cuisineWeighting || {})}.
Active profiles across this period's open ${mealType} slots:
${profileText}
Recently cooked (avoid repeating): ${(recentTitles || []).join(', ') || 'none'}.

Return JSON:
{ "ideas": [ { "title": "string", "cuisine": "string", "protein": "string", "texture": "string", "oneLiner": "string" } ] }`,
    }];

    try {
      const raw = await this.send({ system, messages, maxTokens: 900, model: MODEL_FAST });
      return safeParseJSON(raw);
    } catch (e) {
      console.error('getRecipeIdeaBatch failed', e);
      return null;
    }
  },

  // ---------------------------------------------------------------------
  // getRecipeDetail — elaborates ONE chosen idea into a full Recipe-shaped
  // object (ingredients, sauce, steps). Only called for ideas the user
  // actually picks, not the whole batch — keeps cost proportional to use.
  // ---------------------------------------------------------------------
  async getRecipeDetail({ idea, activeProfiles }) {
    const system = `You are a recipe-writing service inside a personal meal-planning app called Mise.
Return ONLY valid JSON. No preamble, no explanation, no markdown fences.
Write a full, cookable recipe for the given dish idea. Respect every profile's strict
avoids as hard constraints — never include a strict-avoid ingredient.
Keep it tight: at most 8 main ingredients and 4 sauce/glaze ingredients, at most 6 steps.
This is a weeknight home-cook card, not a restaurant tasting menu — concise beats exhaustive.`;

    const profileText = (activeProfiles || [])
      .map((p) => `- ${p.name}: strict avoids=[${(p.restrictions || []).filter(r => r.severity === 'strict').map(r => r.item).join(', ') || 'none'}]`)
      .join('\n') || '- (none)';

    const messages = [{
      role: 'user',
      content: `Dish idea to write up: "${idea.title}" (${idea.oneLiner || ''}).
Cuisine: ${idea.cuisine}. Protein: ${idea.protein}. Texture: ${idea.texture}.
Profiles to respect:
${profileText}

Return JSON matching this shape exactly:
{
  "title": "string",
  "tags": { "cuisine": "string", "protein": "string", "texture": "string", "leftoverFriendly": true, "eatFresh": false, "batchable": false, "vegHidden": false },
  "totalTimeMinutes": number,
  "reasonInRotation": "string, one line",
  "ingredients": [ { "name": "string", "amount1": "string", "amount2": "string", "amount4": "string" } ],
  "sauce": [ { "name": "string", "amount1": "string", "scaleNote": "string or null" } ],
  "steps": [ { "text": "string", "timeMinutes": number or null } ],
  "closingNote": "string or null"
}`,
    }];

    try {
      const raw = await this.send({ system, messages, maxTokens: 1600, model: MODEL_FAST });
      const parsed = safeParseJSON(raw);
      if (parsed && !parsed.title) {
        console.warn('[Mise] getRecipeDetail: JSON parsed fine but has no "title" field \u2014 the AI likely didn\u2019t follow the requested shape. Parsed result:', parsed);
      }
      return parsed;
    } catch (e) {
      console.error('getRecipeDetail failed', e);
      return null;
    }
  },

  // ---------------------------------------------------------------------
  // getConsolidatedGroceryList — real culinary judgment, not string
  // matching: merges related ingredient lines into realistic combined
  // grocery items (e.g. "3 tbsp lemon juice" + "1 tsp lemon zest" + "2 lemon
  // wedges" across different recipes -> "2 lemons"). Deliberately NOT done
  // with rules/regex — knowing how much juice is in a lemon, or that
  // "ground pork" and "pork mince" are the same thing, takes actual
  // knowledge, not pattern matching. Only called on demand (Consolidate
  // button), never automatically, so it never silently rewrites the list.
  // ---------------------------------------------------------------------
  async getConsolidatedGroceryList({ items }) {
    const system = `You are a grocery list consolidation service inside a personal meal-planning app called Mise.
Return ONLY valid JSON. No preamble, no explanation, no markdown fences.
The input is a list of grocery items pulled straight from recipe ingredient lists — the same
underlying grocery item is often listed multiple times under different names or forms
(e.g. "fresh lemon juice", "lemon zest", and "lemon wedges" are all really just "lemons";
"garlic cloves, minced" and "garlic, minced" are the same thing; "ground pork" and "pork mince"
are the same thing).
Your job: merge these into a realistic, buyable grocery list — estimate a sensible total
quantity of the base item using real cooking knowledge (e.g. juice + zest + a few wedges from
across several recipes might realistically need 2-3 whole lemons, not a fraction of one).
When quantities are vague or in incompatible units, use your best practical judgment and say
so briefly in a "note" field rather than inventing false precision.
Never merge items that are only superficially similar but actually different foods (e.g. don't
merge "lime" with "lemon", or "green onion" with "yellow onion").
Preserve the original category (produce vs meat_protein vs other) from the input items.`;

    const messages = [{
      role: 'user',
      content: `Grocery items to consolidate:
${JSON.stringify(items, null, 2)}

Return JSON:
{
  "consolidated": [
    { "name": "string — the buyable grocery item", "quantity": "string, e.g. '2 lemons'", "category": "produce" or "meat_protein" or "other", "note": "string or null — brief note if the estimate is approximate, e.g. 'covers juice, zest, and wedges across 3 recipes'" }
  ]
}`,
    }];

    try {
      const raw = await this.send({ system, messages, maxTokens: 1200, model: MODEL_FAST });
      const parsed = safeParseJSON(raw);
      if (parsed && !Array.isArray(parsed.consolidated)) {
        console.warn('[Mise] getConsolidatedGroceryList: JSON parsed but has no "consolidated" array. Parsed result:', parsed);
        return null;
      }
      return parsed;
    } catch (e) {
      console.error('getConsolidatedGroceryList failed', e);
      return null;
    }
  },

  // ---------------------------------------------------------------------
  // getProteinSubstitution — rewrites an existing recipe with a different
  // primary protein, keeping the same dish concept/cuisine/style. Used by
  // the Recipes tab's "Substitute Protein" button. Overwrites the recipe
  // in place (same id) — caller is responsible for actually replacing it
  // in state.recipes once this returns.
  // ---------------------------------------------------------------------
  async getProteinSubstitution({ recipe, newProtein }) {
    const system = `You are helping substitute the primary protein in an existing recipe, inside a
personal meal-planning app called Mise.
Return ONLY valid JSON. No preamble, no explanation, no markdown fences.
Keep the same dish concept, cuisine, and cooking style — just swap the protein and adjust
ingredients, quantities, and steps as needed for the new protein. Update the title to reflect
the new protein. Keep it realistic and cookable, not a totally different dish.`;

    const messages = [{
      role: 'user',
      content: `Original recipe:
${JSON.stringify(recipe, null, 2)}

Substitute the primary protein (currently "${recipe.tags?.protein || 'unspecified'}") with: "${newProtein}".

Return JSON matching this shape exactly:
{
  "title": "string",
  "tags": { "cuisine": "string", "protein": "string", "texture": "string", "leftoverFriendly": true, "eatFresh": false, "batchable": false, "vegHidden": false },
  "totalTimeMinutes": number,
  "reasonInRotation": "string, one line",
  "ingredients": [ { "name": "string", "amount1": "string", "amount2": "string", "amount4": "string" } ],
  "sauce": [ { "name": "string", "amount1": "string", "scaleNote": "string or null" } ],
  "steps": [ { "text": "string", "timeMinutes": number or null } ],
  "closingNote": "string or null"
}`,
    }];

    try {
      const raw = await this.send({ system, messages, maxTokens: 1600, model: MODEL_FAST });
      const parsed = safeParseJSON(raw);
      if (parsed && !parsed.title) {
        console.warn('[Mise] getProteinSubstitution: JSON parsed fine but has no "title" field. Parsed result:', parsed);
      }
      return parsed;
    } catch (e) {
      console.error('getProteinSubstitution failed', e);
      return null;
    }
  },

  // ---------------------------------------------------------------------
  // getRequestedRecipe — the user names a specific dish ("lasagna," "a good
  // tikka masala") and gets a full recipe back, same shape as everything
  // else. Used by the "Want a recipe for something specific?" card on the
  // cycle setup screen.
  // ---------------------------------------------------------------------
  async getRequestedRecipe({ request, activeProfiles }) {
    const system = `You are a recipe-writing service inside a personal meal-planning app called Mise.
Return ONLY valid JSON. No preamble, no explanation, no markdown fences.
Write a full, cookable recipe for exactly what the user asked for. Interpret loosely-worded
requests reasonably (e.g. "a good tikka masala" -> a genuinely good tikka masala recipe).
Keep it realistic for a home cook, not a restaurant tasting menu.
Respect every profile's restrictions as hard constraints \u2014 never include an ingredient
listed as a strict avoid for any active profile, even if it would normally be essential to
the dish (substitute or omit it, and mention the swap in reasonInRotation or closingNote).`;

    const profileText = (activeProfiles || [])
      .map((p) => {
        const restr = (p.restrictions || []).filter((r) => r.severity === 'strict').map((r) => r.item).join(', ') || 'none';
        return `- ${p.name}: strict avoids=[${restr}]`;
      })
      .join('\n') || '- (no specific profile constraints active)';

    const messages = [{
      role: 'user',
      content: `The user wants a recipe for: "${request}"
Profiles to respect:
${profileText}

Return JSON matching this shape exactly:
{
  "title": "string",
  "tags": { "cuisine": "string", "protein": "string", "texture": "string", "leftoverFriendly": true, "eatFresh": false, "batchable": false, "vegHidden": false },
  "totalTimeMinutes": number,
  "reasonInRotation": "string, one line",
  "ingredients": [ { "name": "string", "amount1": "string", "amount2": "string", "amount4": "string" } ],
  "sauce": [ { "name": "string", "amount1": "string", "scaleNote": "string or null" } ],
  "steps": [ { "text": "string", "timeMinutes": number or null } ],
  "closingNote": "string or null"
}`,
    }];

    try {
      const raw = await this.send({ system, messages, maxTokens: 1600, model: MODEL_FAST });
      const parsed = safeParseJSON(raw);
      if (parsed && !parsed.title) {
        console.warn('[Mise] getRequestedRecipe: JSON parsed fine but has no "title" field. Parsed result:', parsed);
      }
      return parsed;
    } catch (e) {
      console.error('getRequestedRecipe failed', e);
      return null;
    }
  },
};
