// profiles.js — profile CRUD + the 13-question fixed wizard + AI-notes layer.

import { api } from './api.js';

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyProfile(name = '') {
  return {
    id: uid('prof'),
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dietType: null,
    dietTypeOther: null,
    restrictions: [],
    textureLikes: null,
    textureDislikes: [],
    vegTolerance: null,
    cuisineLikes: [],
    cuisineDislikes: [],
    adventurousness: null,
    spiceTolerance: null,
    macroGoals: [],
    leftoverBehavior: null,
    mealTimingNote: null,
    indulgenceAllowance: null,
    aiNotes: [],
  };
}

const CUISINE_OPTIONS = [
  'mediterranean', 'asian_fusion', 'mexican', 'italian', 'indian', 'american_comfort',
  'thai', 'japanese', 'korean', 'middle_eastern', 'vietnamese', 'greek', 'spanish',
  'caribbean', 'french',
];

const RESTRICTION_OPTIONS = ['nuts', 'shellfish', 'gluten', 'dairy', 'eggs', 'soy'];

export function renderProfiles(state, container, { saveState, toast }) {
  const profiles = state.profiles || [];
  let html = `<div class="card"><button class="btn" id="add-profile-btn">+ Add Profile</button></div>`;

  if (!profiles.length) {
    html += `<div class="empty-state">No profiles yet. Add yourself first, or import your starter JSON from Settings.</div>`;
  } else {
    for (const p of profiles) {
      html += `<div class="card">
        <h3>${escapeHtml(p.name || '(unnamed)')}</h3>
        <div class="meta">${escapeHtml(p.dietType || 'not set')} · texture: ${escapeHtml(p.textureLikes || '—')} · restrictions: ${p.restrictions.length}</div>
        <div style="margin-top:0.5rem; display:flex; gap:0.4rem;">
          <button class="btn secondary small edit-profile-btn" data-id="${p.id}">Edit</button>
          <button class="btn danger small delete-profile-btn" data-id="${p.id}">Delete</button>
        </div>
      </div>`;
    }
  }

  container.innerHTML = html;

  container.querySelector('#add-profile-btn').addEventListener('click', () => {
    openProfileEditor(state, container, emptyProfile(), { saveState, toast });
  });
  container.querySelectorAll('.edit-profile-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = profiles.find((x) => x.id === btn.dataset.id);
      openProfileEditor(state, container, p, { saveState, toast });
    });
  });
  container.querySelectorAll('.delete-profile-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this profile? This cannot be undone (it is not covered by Clear All).')) return;
      state.profiles = state.profiles.filter((x) => x.id !== btn.dataset.id);
      saveState();
      renderProfiles(state, container, { saveState, toast });
    });
  });
}

function chipRow(id, options, selected, multi) {
  const trailingLabel = multi ? 'None' : 'Not sure / skip';
  const nothingChosen = multi ? !selected.length : (selected === null || selected === undefined);
  return `<div class="choice-row" id="${id}">` +
    options.map((opt) => {
      const isSel = multi ? selected.includes(opt) : selected === opt;
      return `<button type="button" class="choice-chip ${isSel ? 'selected' : ''}" data-value="${opt}">${opt.replace(/_/g, ' ')}</button>`;
    }).join('') +
    `<button type="button" class="choice-chip not-sure-chip ${nothingChosen ? 'selected' : ''}" data-value="__skip">${trailingLabel}</button>` +
    `</div>`;
}

function openProfileEditor(state, container, profile, { saveState, toast }) {
  const isNew = !state.profiles.find((p) => p.id === profile.id);

  container.innerHTML = `
    <div class="card">
      <h3>${isNew ? 'New Profile' : 'Edit Profile'}</h3>
      <div class="field"><label>Name</label><input type="text" id="f-name" value="${escapeAttr(profile.name)}"></div>

      <div class="field"><label>1. Which best describes how they eat?</label>
        ${chipRow('f-diettype', ['omnivore', 'pescatarian', 'vegetarian', 'vegan', 'mostly_plant_based', 'picky_limited'], profile.dietType, false)}
      </div>

      <div class="field"><label>2. Any common allergies or restrictions?</label>
        ${chipRow('f-restrictions', RESTRICTION_OPTIONS, profile.restrictions.map(r => r.item), true)}
      </div>
      <div class="field"><label>3. If any selected above — how strict?</label>
        ${chipRow('f-severity', ['strict', 'flexible'], profile.restrictions[0]?.severity || null, false)}
      </div>

      <div class="field"><label>4. What wins them over on protein?</label>
        ${chipRow('f-texturelikes', ['crispy', 'soft_tender', 'no_preference'], profile.textureLikes, false)}
      </div>
      <div class="field"><label>5. Any textures that turn them off?</label>
        ${chipRow('f-texturedislikes', ['mushy', 'chewy', 'slimy', 'flaky'], profile.textureDislikes, true)}
      </div>

      <div class="field"><label>6. How do they feel about vegetables?</label>
        ${chipRow('f-veg', ['loves_it', 'fine_if_cooked_well', 'hidden_only', 'avoids'], profile.vegTolerance, false)}
      </div>

      <div class="field"><label>7. Cuisines they enjoy (this also drives menu weighting)</label>
        ${chipRow('f-cuisine', CUISINE_OPTIONS, profile.cuisineLikes, true)}
        <input type="text" id="f-cuisine-other" placeholder="Other cuisine, comma separated" style="margin-top:0.4rem;">
      </div>

      <div class="field"><label>8. How adventurous are they with new dishes?</label>
        ${chipRow('f-adventurous', ['loves_new', 'occasionally_open', 'tried_and_true'], profile.adventurousness, false)}
      </div>

      <div class="field"><label>9. Spice tolerance?</label>
        ${chipRow('f-spice', ['loves_hot', 'medium', 'mild', 'none'], profile.spiceTolerance, false)}
      </div>

      <div class="field"><label>10. Any dietary goals?</label>
        ${chipRow('f-macro', ['high_protein', 'lower_carb', 'lower_calorie', 'no_specific_goal'], profile.macroGoals, true)}
      </div>

      <div class="field"><label>11. Leftovers or fresh each time?</label>
        ${chipRow('f-leftover', ['happy_with_leftovers', 'prefers_fresh', 'depends'], profile.leftoverBehavior, false)}
      </div>

      <div class="field"><label>12. Does an earlier meal reduce dinner appetite?</label>
        <textarea id="f-timing" placeholder="e.g. brunch holds her most days">${escapeHtml(profile.mealTimingNote || '')}</textarea>
      </div>

      <div class="field"><label>13. Any comfort-food indulgence worth allowing occasionally?</label>
        <textarea id="f-indulgence" placeholder="e.g. hotdogs/KD sometimes, as a deliberate allowance">${escapeHtml(profile.indulgenceAllowance || '')}</textarea>
      </div>

      <div class="field">
        <label>AI-assisted notes (idiosyncratic things — "no cilantro," "avoids grapefruit," etc.)</label>
        <div id="ai-notes-list">${(profile.aiNotes || []).map((n, i) => `<div class="revival-item"><span>${escapeHtml(n.text)}</span><button class="btn danger small remove-note-btn" data-idx="${i}">Remove</button></div>`).join('')}</div>
        <textarea id="f-newnote" placeholder="Type a free-text note, e.g. 'she doesn't do cilantro'"></textarea>
        <button class="btn secondary small" id="add-note-btn" style="margin-top:0.4rem;">Add note (AI-assisted)</button>
      </div>

      <div style="display:flex; gap:0.5rem; margin-top:1rem;">
        <button class="btn" id="save-profile-btn">Save Profile</button>
        <button class="btn secondary" id="cancel-profile-btn">Cancel</button>
      </div>
    </div>
  `;

  // chip toggling: single-select chip-rows clear siblings, multi-select just toggle
  const singleSelectIds = ['f-diettype', 'f-severity', 'f-texturelikes', 'f-veg', 'f-adventurous', 'f-spice', 'f-leftover'];
  container.querySelectorAll('.choice-row').forEach((row) => {
    const isSingle = singleSelectIds.includes(row.id);
    row.querySelectorAll('.choice-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (chip.dataset.value === '__skip') {
          row.querySelectorAll('.choice-chip').forEach((c) => c.classList.remove('selected'));
          chip.classList.add('selected'); // now visibly stays selected, instead of clearing itself too
          return;
        }
        if (isSingle) {
          row.querySelectorAll('.choice-chip').forEach((c) => c.classList.remove('selected'));
          chip.classList.add('selected');
        } else {
          chip.classList.toggle('selected');
          // picking a real option contradicts "None" \u2014 clear it if it was set
          const skipChip = row.querySelector('.not-sure-chip');
          if (skipChip) skipChip.classList.remove('selected');
        }
      });
    });
  });

  container.querySelector('#cancel-profile-btn').addEventListener('click', () => {
    renderProfiles(state, container, { saveState, toast });
  });

  container.querySelector('#add-note-btn').addEventListener('click', async () => {
    const text = container.querySelector('#f-newnote').value.trim();
    if (!text) return;
    const btn = container.querySelector('#add-note-btn');
    btn.textContent = 'Thinking...';
    btn.disabled = true;
    const result = await api.getProfileNote({ freeText: text });
    profile.aiNotes = profile.aiNotes || [];
    profile.aiNotes.push({ text: result.noteText || text, addedAt: new Date().toISOString() });
    if (result.isAvoidance && result.item) {
      profile.restrictions.push({ item: result.item, severity: result.severity || 'flexible', source: 'ai_note' });
    }
    saveState();
    openProfileEditor(state, container, profile, { saveState, toast }); // re-render with new note
  });

  function getSelected(rowId, multi) {
    const row = container.querySelector(`#${rowId}`);
    const chips = [...row.querySelectorAll('.choice-chip.selected')]
      .map((c) => c.dataset.value)
      .filter((v) => v !== '__skip');
    return multi ? chips : (chips[0] || null);
  }

  container.querySelector('#save-profile-btn').addEventListener('click', () => {
    profile.name = container.querySelector('#f-name').value.trim() || 'Unnamed';
    profile.dietType = getSelected('f-diettype', false);
    const restrictionItems = getSelected('f-restrictions', true);
    const severity = getSelected('f-severity', false) || 'flexible';
    const existingAiRestrictions = (profile.restrictions || []).filter(r => r.source === 'ai_note');
    profile.restrictions = [
      ...restrictionItems.map((item) => ({ item, severity, source: 'checklist' })),
      ...existingAiRestrictions,
    ];
    profile.textureLikes = getSelected('f-texturelikes', false);
    profile.textureDislikes = getSelected('f-texturedislikes', true);
    profile.vegTolerance = getSelected('f-veg', false);
    const otherCuisines = container.querySelector('#f-cuisine-other').value.split(',').map(s => s.trim().toLowerCase().replace(/ /g, '_')).filter(Boolean);
    profile.cuisineLikes = [...getSelected('f-cuisine', true), ...otherCuisines];
    profile.adventurousness = getSelected('f-adventurous', false);
    profile.spiceTolerance = getSelected('f-spice', false);
    profile.macroGoals = getSelected('f-macro', true);
    profile.leftoverBehavior = getSelected('f-leftover', false);
    profile.mealTimingNote = container.querySelector('#f-timing').value.trim() || null;
    profile.indulgenceAllowance = container.querySelector('#f-indulgence').value.trim() || null;
    profile.updatedAt = new Date().toISOString();

    if (isNew) state.profiles.push(profile);
    saveState();
    toast('Profile saved');
    renderProfiles(state, container, { saveState, toast });
  });
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
