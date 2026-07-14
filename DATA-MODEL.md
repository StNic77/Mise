# Mise — Data Model

This is the schema every screen reads and writes. Nothing here touches stores, pricing,
or flyers — that stays entirely in chat, by design. Everything below lives in IndexedDB
on-device, except where marked "ships in repo" (generic, no personal data).

Schema has a `_v` (version) field at the top level for migration purposes — see
`db.js` notes at the bottom.

---

## Top-level app state

```json
{
  "_v": 1,
  "meta": {
    "appBuild": "mise-1.0.0",
    "lastExportedAt": "2026-07-13T18:00:00Z"
  },
  "profiles": [ /* Profile[] */ ],
  "recipes": [ /* Recipe[] */ ],
  "cycles": [ /* Cycle[] */ ],
  "checklist": { /* ChecklistState */ },
  "shoppingList": [ /* ShoppingListItem[] */ ],
  "rejectedAiSuggestions": [ /* RejectedSuggestion[] */ ],
  "mealSlotHistory": [ /* MealSlotResult[] (breakfast/lunch/special one-offs) */ ]
}
```

---

## Profile

Built via the 13-question wizard and/or the AI conversation layer. Fully editable
anytime; any field can be `null`/unset ("skip / not sure yet").

```json
{
  "id": "prof_abc123",
  "name": "Sophie",
  "createdAt": "2026-07-01T00:00:00Z",
  "updatedAt": "2026-07-10T00:00:00Z",

  "dietType": "picky_limited",
  // enum: "omnivore" | "pescatarian" | "vegetarian" | "vegan" |
  //       "mostly_plant_based" | "picky_limited" | "other" | null
  "dietTypeOther": null,

  "restrictions": [
    { "item": "shellfish", "severity": "strict" },
    { "item": "grapefruit", "severity": "strict", "source": "ai_note" }
  ],
  // severity: "strict" | "flexible"
  // source: "checklist" | "ai_note" — free-text/AI-conversation entries flagged distinctly
  // strict = hard filter (never surface a candidate); flexible = soft deprioritize only

  "textureLikes": "crispy",
  // enum: "crispy" | "soft_tender" | "no_preference" | null
  "textureDislikes": ["mushy", "flaky"],
  // enum values: "mushy" | "chewy" | "slimy" | "flaky"

  "vegTolerance": "hidden_only",
  // enum: "loves_it" | "fine_if_cooked_well" | "hidden_only" | "avoids" | null

  "cuisineLikes": ["asian_fusion", "american_comfort"],
  "cuisineDislikes": [],
  // free-growing string set — NOT a hardcoded enum. Any string typed into
  // "Other" during the wizard becomes a valid tag going forward, and this
  // same set doubles as the weighting palette in menu generation.

  "adventurousness": "tried_and_true",
  // enum: "loves_new" | "occasionally_open" | "tried_and_true" | null

  "spiceTolerance": "mild",
  // enum: "loves_hot" | "medium" | "mild" | "none" | null

  "macroGoals": [],
  // free-growing set, e.g. "high_protein" | "lower_carb" | "lower_calorie" | "none"

  "leftoverBehavior": "prefers_fresh",
  // enum: "happy_with_leftovers" | "prefers_fresh" | "depends" | null

  "mealTimingNote": "Brunch (eggs/yogurt/bagel) holds her most days, reduces lunch pressure.",
  // free text, null if not applicable

  "indulgenceAllowance": "Hotdogs or KD occasionally, as a deliberate allowance.",
  // free text, null if none

  "aiNotes": [
    { "text": "Won't eat fish, picks at it and wastes it.", "addedAt": "2026-07-05T00:00:00Z" }
  ]
  // free-form notes captured via the AI conversation layer, distinct from the
  // fixed questionnaire fields above — this is where "no cilantro" etc. lives
}
```

**Matching rule (used by `recipes.js` / `menu.js`):** for any given night, the candidate
pool is the **intersection** of every active profile's constraints — never a union.
A `strict` restriction excludes a recipe outright; a `flexible` one deprioritizes but
doesn't zero out the pool. If the intersected pool is empty, the generator must
surface an explicit message ("nothing fits — here's the closest option") rather than
silently repeating or failing.

---

## Recipe

```json
{
  "id": "rec_xyz789",
  "title": "Crispy Pork Mince, Thai-style, over Rice",
  "createdAt": "2026-07-01T00:00:00Z",
  "source": "manual",
  // "manual" | "ai_generated" — ai_generated ones came from a graduated novelty slot

  "tags": {
    "cuisine": "asian_fusion",       // free-growing string, matches Profile.cuisineLikes
    "protein": "pork",               // free-growing string
    "texture": "crispy",             // free-growing string, matches Profile.textureLikes
    "leftoverFriendly": true,
    "eatFresh": false,
    "batchable": true,
    "vegHidden": false
  },

  "totalTimeMinutes": 20,
  "reasonInRotation": "The ground-pork answer when belly or shoulder isn't available.",

  "ingredients": [
    { "name": "ground pork", "amount1": "175 g", "amount2": "350 g", "amount4": "700 g" },
    { "name": "jasmine rice (dry)", "amount1": "1/2 cup", "amount2": "1 cup", "amount4": "2 cups" },
    { "name": "garlic, minced", "amount1": "2 cloves", "amount2": "3 cloves", "amount4": "5 cloves" },
    { "name": "green onion, sliced", "amount1": "1", "amount2": "2", "amount4": "4" },
    { "name": "egg (fried, optional)", "amount1": "1", "amount2": "2", "amount4": "4" }
  ],
  // NOTE: this structured ingredient list is what restriction-matching runs
  // against (substring match on `name`) — see Profile.restrictions above.

  "sauce": [
    { "name": "soy sauce", "amount1": "1 tbsp", "scaleNote": "scale x2 for 4 servings" },
    { "name": "fish sauce", "amount1": "1 tbsp" },
    { "name": "rice vinegar", "amount1": "1 tsp" },
    { "name": "sugar", "amount1": "1 tsp" },
    { "name": "chili flake", "amount1": "to taste" }
  ],

  "steps": [
    { "text": "Rice on.", "timeMinutes": null },
    { "text": "Crisp the pork — hot pan, thin film of oil, spread flat, leave it 3 minutes before touching.", "timeMinutes": 8 },
    { "text": "Garlic in at the end, off direct heat if it's catching.", "timeMinutes": 0.5 },
    { "text": "Sauce around the edge of the pan — it'll hiss and reduce in under a minute.", "timeMinutes": 1 },
    { "text": "Plate over jasmine rice, green onion over, fried egg on top if wanted.", "timeMinutes": null }
  ],

  "closingNote": null,

  "rejectedCount": 0
  // increments if this specific recipe gets swapped away during menu generation —
  // cheap signal for "maybe don't keep resurfacing this one"
}
```

---

## Cycle (the Sun-dinner → Sat-dinner weekly unit)

```json
{
  "id": "cyc_2026w28",
  "startDate": "2026-07-12",
  "endDate": "2026-07-18",
  "cuisinePriorityOrder": ["mediterranean", "mexican"],
  // order the user tapped cuisines in \u2014 first tapped gets the heaviest weight.
  // Reorderable via up/down in the UI. cuisineWeighting (below) is DERIVED
  // from this order, not edited directly.
  "cuisineWeighting": { "mediterranean": 0.67, "mexican": 0.33 },
  // derived from cuisinePriorityOrder via linear-descending rank share
  // (rank 0 gets n/(sum 1..n), last gets 1/(sum 1..n)). Recomputed any time
  // the priority order changes \u2014 never hand-edited.

  "days": [ /* Day[] — 7 entries, Sun through Sat */ ]
}
```

**Failed generation attempts must never poison a slot.** If menu generation finds
no recipe fits a night's constraints, `day.slots.dinner.result` stays `null` \u2014
it does NOT get a placeholder object recorded as if it were a real assignment.
(An earlier version did this and it caused a real bug: a placeholder object is
still truthy, so every later "is this night already assigned?" check treated a
failed attempt as permanently done, silently blocking retries and the AI
idea-picker from ever touching that night again.) The Cycle setup screen shows
a "Clear N failed attempt(s)" button whenever any slot still holds one of these
old-style poisoned placeholders (recipeId === null), to recover from data saved
before this fix.

## Day

```json
{
  "date": "2026-07-16",
  "dayOfWeek": "thu",
  "activeProfileIds": ["prof_abc123"],

  "slots": {
    "breakfast": { "state": "skip", "result": null },
    "lunch":     { "state": "skip", "result": null },
    "dinner":    { "state": "plan", "result": { "recipeId": "rec_xyz789", "servings": 2, "notes": "batch extra rice for Fri" } }
  }
  // slot.state enum: "plan" | "skip" | "eating_out" | "special"
  // slot.result shape depends on state:
  //   plan    -> { recipeId, servings, notes }
  //   special -> { transcriptSummary, savedAsRecipeId: null|string }
  //   skip / eating_out -> null
}
```

---

## ChecklistState (Standing Checklist — staples/household only)

```json
{
  "categories": {
    "dairy_eggs": [
      { "label": "Eggs", "mark": "plus" },
      { "label": "Milk", "mark": "minus" }
    ],
    "bread_bakery": [ /* ... */ ],
    "canned_dry": [ /* ... */ ],
    "frozen": [ /* ... */ ],
    "beverages": [ /* ... */ ],
    "household": [ /* ... */ ],
    "personal_care": [ /* ... */ ]
  },
  // mark enum: "plus" | "minus" | "dropped"

  "droppedItems": [
    { "label": "Sparkling water", "droppedAt": "2026-06-01T00:00:00Z" }
  ]
  // visible, grayed-out, revivable list — never buried in settings
}
```

---

## ShoppingListItem

```json
{
  "id": "sli_001",
  "name": "Ground pork",
  "category": "meat_protein",
  "quantity": "700 g",
  "source": "menu_export",
  // "menu_export" | "checklist" | "chat_import" | "manual" | "consolidated"
  "purchased": false,
  "price": null,
  "note": null,
  // optional \u2014 set by AI consolidation to briefly explain an approximate
  // merged quantity, e.g. "covers juice, zest, and wedges across 3 recipes"
  "addedAt": "2026-07-13T09:00:00Z"
}
```

**Menu-derived lines are grouped by exact ingredient name** before hitting the shopping
list (case/whitespace-insensitive) \u2014 the same ingredient string used by more than one
recipe/night collapses into one line with combined quantities, rather than repeating.
This is deliberately conservative: only literal same-name matches merge automatically.

**Consolidate with AI** (Shopping List tab, shown when 2+ unpurchased items exist) goes
further \u2014 it uses real culinary judgment to merge genuinely-related-but-differently-
worded items (e.g. "lemon juice" + "lemon zest" + "lemon wedges" \u2192 "2 lemons"). This
can't be done with string matching since it requires knowing how much juice is in a
lemon, not just recognizing repeated text. Only runs on demand, only touches unpurchased
items \u2014 anything already checked off is left alone.

**Clear All** wipes `shoppingList`, `checklist.droppedItems`, and `rejectedAiSuggestions`
in one action — a full, deliberate weekly reset, distinct from the buried
Settings-only "wipe recipe library" nuclear option.

---

## RejectedSuggestion (AI novelty-slot rejections)

```json
{
  "id": "rej_001",
  "cuisine": "french",
  "summary": "Coq au vin — rejected, too heavy/rich for a weeknight",
  "rejectedAt": "2026-07-10T00:00:00Z"
}
```

---

## MealSlotResult (breakfast / lunch / "Special" one-offs — never part of the tagged library unless explicitly saved)

```json
{
  "id": "msr_001",
  "date": "2026-07-19",
  "slotType": "brunch",
  "activeProfileIds": ["prof_abc123"],
  "transcript": "AI suggested a scrambled egg + smoked salmon bagel...",
  "savedAsRecipeId": null
}
```

---

## Export / Import (backup mechanism)

The always-visible export button dumps the **entire top-level app state** as one
`.json` file. Import reads the same shape back in wholesale. This is also how the
one-time starter data gets loaded on first run, and how chat's priced grocery JSON
gets appended (import only touches `shoppingList`, appending new `ShoppingListItem`
rows — never replaces the rest of app state).

## Recipe import (external chat \u2192 app)

The Recipes tab has an **"Import Recipe (JSON)"** button that accepts pasted JSON \u2014
this is the bridge for turning a recipe photo, a recipe from a book, or any recipe
text into a real card without retyping it by hand. The conversion happens in a
*separate* Claude conversation (not an in-app AI call) \u2014 share the photo/text there
and ask Claude to format it as JSON matching this shape, then paste the result into
the Import panel.

**Only `title` is required** \u2014 every other field has a safe default if omitted.
Accepts either one recipe object, or `{"recipes": [...]}` for several at once.

```json
{
  "title": "string",
  "tags": {
    "cuisine": "string, e.g. mediterranean, asian_fusion, mexican \u2014 free text, not a fixed list",
    "protein": "string, e.g. pork, chicken, tofu",
    "texture": "string, e.g. crispy, soft_tender",
    "leftoverFriendly": true,
    "eatFresh": false,
    "batchable": false,
    "vegHidden": false
  },
  "totalTimeMinutes": 30,
  "reasonInRotation": "one line, optional",
  "ingredients": [
    { "name": "string", "amount1": "1-serving amount", "amount2": "2-serving amount", "amount4": "4-serving amount" }
  ],
  "sauce": [
    { "name": "string", "amount1": "string", "scaleNote": "string or omit" }
  ],
  "steps": [
    { "text": "string", "timeMinutes": 5 }
  ],
  "closingNote": "optional string or omit"
}
```

Imported recipes are tagged `source: "imported"` (distinct from `"manual"` and
`"ai_generated"`) so the Recipes tab can show where each card came from.

## Migration note (`db.js`)

Every schema change bumps top-level `_v`. On load, `db.js` checks the stored `_v`
against the current code's expected version and runs any needed migration functions
in sequence before the rest of the app touches the data. No manual cache-bump
choreography required for this part — it's automatic based on the stored version
number, separate from the service-worker cache versioning (which handles code
delivery, not data shape).
