// db.js — the one place storage logic lives.
// Whole app state is stored as a single JSON blob under one IndexedDB key.
// This keeps reads/writes simple (one document, not many small records) and
// makes export/import trivial (it's just this same shape).

const DB_NAME = 'mise-db';
const DB_STORE = 'state';
const STATE_KEY = 'app-state';
const CURRENT_SCHEMA_VERSION = 6;

function emptyState() {
  return {
    _v: CURRENT_SCHEMA_VERSION,
    meta: {
      appBuild: 'mise-0.1.0',
      lastExportedAt: null,
    },
    profiles: [],
    recipes: [],
    cycles: [],
    checklist: {
      categories: {
        dairy_eggs: [
          { label: 'Eggs', mark: 'minus' },
          { label: 'Milk', mark: 'minus' },
          { label: 'Yogurt', mark: 'minus' },
          { label: 'Cheese', mark: 'minus' },
          { label: 'Butter / margarine', mark: 'minus' },
        ],
        bread_bakery: [
          { label: 'Sandwich bread', mark: 'minus' },
          { label: 'Breakfast bread (bagels, muffins)', mark: 'minus' },
          { label: 'Tortilla / flatbread', mark: 'minus' },
        ],
        canned_dry: [
          { label: 'Rice', mark: 'minus' },
          { label: 'Pasta / couscous / quinoa', mark: 'minus' },
          { label: 'Canned tomatoes', mark: 'minus' },
          { label: 'Stock / broth', mark: 'minus' },
          { label: 'Cooking oil', mark: 'minus' },
          { label: 'Vinegar', mark: 'minus' },
          { label: 'Soy sauce', mark: 'minus' },
          { label: 'Chili paste / fermented sauce', mark: 'minus' },
          { label: 'Condiments', mark: 'minus' },
          { label: 'Canned fish', mark: 'minus' },
        ],
        baking: [
          { label: 'Flour', mark: 'minus' },
          { label: 'Sugar', mark: 'minus' },
          { label: 'Brown sugar', mark: 'minus' },
          { label: 'Baking powder', mark: 'minus' },
          { label: 'Baking soda', mark: 'minus' },
          { label: 'Yeast', mark: 'minus' },
          { label: 'Chocolate chips', mark: 'minus' },
          { label: 'Vanilla extract', mark: 'minus' },
        ],
        frozen: [
          { label: 'Frozen vegetables', mark: 'minus' },
          { label: 'Frozen fruit', mark: 'minus' },
          { label: 'Frozen convenience / fallback', mark: 'minus' },
        ],
        beverages: [
          { label: 'Coffee', mark: 'minus' },
          { label: 'Sparkling / still water', mark: 'minus' },
          { label: 'Juice', mark: 'minus' },
        ],
        household: [
          { label: 'Toilet paper', mark: 'minus' },
          { label: 'Paper towel', mark: 'minus' },
          { label: 'Dish soap', mark: 'minus' },
          { label: 'Dishwasher detergent', mark: 'minus' },
          { label: 'Laundry detergent', mark: 'minus' },
          { label: 'Garbage bags', mark: 'minus' },
          { label: 'Cleaning spray', mark: 'minus' },
          { label: 'Foil / wrap / storage bags', mark: 'minus' },
        ],
        personal_care: [
          { label: 'Bar / body soap', mark: 'minus' },
          { label: 'Shampoo / conditioner', mark: 'minus' },
          { label: 'Toothpaste', mark: 'minus' },
          { label: 'Deodorant', mark: 'minus' },
          { label: 'Razors / shave', mark: 'minus' },
          { label: 'Floss / oral care', mark: 'minus' },
        ],
      },
      droppedItems: [],
    },
    shoppingList: [],
    rejectedAiSuggestions: [],
    rarity: {},
    // { "lamb": { tier: "rare", windowDays: 90 }, "swordfish": { tier: "avoid" } }
    // keys are lowercase protein tag strings. tier: "rare" | "avoid".
    // "rare" only blocks auto-generation while last-used is inside windowDays;
    // "avoid" always blocks auto-generation. Neither blocks manual assignment
    // via the Recipes tab \u2014 this is a suggestion-frequency control, not a diet rule.
    mealSlotHistory: [],
  };
}

// Migration functions run in sequence, each bringing the state from version N
// to N+1. Add a new function here whenever the schema changes, and bump
// CURRENT_SCHEMA_VERSION above. This is what prevents "the app updated and
// now my recipes look broken."
const migrations = {
  1: (state) => {
    // v2: split "Baking" out of the vague Canned & Dry catch-all line into
    // its own real category, since it was invisible/unusable buried as one
    // line ("Flour / sugar / baking") before.
    if (!state.checklist.categories.baking) {
      state.checklist.categories.baking = [
        { label: 'Flour', mark: 'minus' },
        { label: 'Sugar', mark: 'minus' },
        { label: 'Brown sugar', mark: 'minus' },
        { label: 'Baking powder', mark: 'minus' },
        { label: 'Baking soda', mark: 'minus' },
        { label: 'Yeast', mark: 'minus' },
        { label: 'Chocolate chips', mark: 'minus' },
        { label: 'Vanilla extract', mark: 'minus' },
      ];
    }
    // remove the old catch-all line from canned_dry if it's still there
    state.checklist.categories.canned_dry = (state.checklist.categories.canned_dry || [])
      .filter((item) => item.label !== 'Flour / sugar / baking');
    state._v = 2;
    return state;
  },
  2: (state) => {
    // v3: protein rarity settings \u2014 didn't exist before, default to empty
    // (no rarity restrictions) so nothing changes behavior for existing users
    // until they actually configure something.
    if (!state.proteinRarity) state.proteinRarity = {};
    state._v = 3;
    return state;
  },
  3: (state) => {
    // v4: generalized "protein rarity" into a general-purpose "rarity" list
    // covering any ingredient, not just proteins (saffron, truffle oil,
    // whatever). Carries over any existing protein rarity settings under the
    // new field name.
    if (!state.rarity) {
      state.rarity = state.proteinRarity || {};
    }
    delete state.proteinRarity;
    state._v = 4;
    return state;
  },
  4: (state) => {
    // v5: normalize every recipe's cuisine/protein/texture tags to
    // lowercase+trimmed. The manual recipe editor used to save these
    // as-typed (no case normalization), so "Mediterranean" and
    // "mediterranean" could both exist as distinct tags depending on
    // capitalization at save time \u2014 this collapses any such duplicates
    // retroactively. Going forward the editor normalizes on save, so this
    // shouldn't recur.
    (state.recipes || []).forEach((r) => {
      if (r.tags) {
        if (r.tags.cuisine) r.tags.cuisine = r.tags.cuisine.trim().toLowerCase();
        if (r.tags.protein) r.tags.protein = r.tags.protein.trim().toLowerCase();
        if (r.tags.texture) r.tags.texture = r.tags.texture.trim().toLowerCase();
      }
    });
    state._v = 5;
    return state;
  },
  5: (state) => {
    // v6: the v5 migration normalized recipe tags but missed
    // Profile.cuisineLikes / cuisineDislikes \u2014 those are plain free-text
    // string arrays (from the wizard's "Other cuisine" field, saved as-typed
    // before that field's lowercasing existed), so "Mediterranean" and
    // "mediterranean" could both exist there and show up as two separate
    // chips in the cuisine-weighting picker. Normalize + dedupe both arrays
    // on every profile, retroactively.
    (state.profiles || []).forEach((p) => {
      if (Array.isArray(p.cuisineLikes)) {
        p.cuisineLikes = [...new Set(p.cuisineLikes.map((c) => String(c).trim().toLowerCase()))];
      }
      if (Array.isArray(p.cuisineDislikes)) {
        p.cuisineDislikes = [...new Set(p.cuisineDislikes.map((c) => String(c).trim().toLowerCase()))];
      }
    });
    state._v = 6;
    return state;
  },
};

function migrate(state) {
  let v = state._v || 1;
  while (migrations[v]) {
    state = migrations[v](state);
    v = state._v;
  }
  state._v = CURRENT_SCHEMA_VERSION;
  return state;
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  async load() {
    try {
      const conn = await openDB();
      const state = await new Promise((resolve, reject) => {
        const tx = conn.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(STATE_KEY);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (!state) return emptyState();
      return migrate(state);
    } catch (e) {
      console.error('DB load failed, starting fresh', e);
      return emptyState();
    }
  },

  async save(state) {
    const conn = await openDB();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(state, STATE_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },

  // Used by Settings -> Import backup: validates minimally, migrates, overwrites.
  async replaceAll(newState) {
    if (!newState || typeof newState !== 'object' || !Array.isArray(newState.profiles)) {
      throw new Error('Invalid backup file \u2014 missing expected shape');
    }
    const migrated = migrate(newState);
    return this.save(migrated);
  },

  emptyState,
};
