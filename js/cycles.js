// cycles.js — the Sun-dinner -> Sat-dinner weekly unit. Handles creating a new
// cycle, the day/slot toggles (who's present, Plan/Skip/Eating-out/Special per
// meal), and rendering that setup screen. Menu generation itself lives in menu.js.

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

// Groups the ordered cuisine list into tiers based on which adjacent pairs
// are tied. E.g. order=[A,B,C], tiedWithNext=[true,false] means A and B are
// tied (one tier together), C is its own tier below them.
function computeTiers(order, tiedWithNext) {
  if (!order.length) return [];
  const tiers = [];
  let current = [order[0]];
  for (let i = 0; i < order.length - 1; i++) {
    if (tiedWithNext[i]) {
      current.push(order[i + 1]);
    } else {
      tiers.push(current);
      current = [order[i + 1]];
    }
  }
  tiers.push(current);
  return tiers;
}

// Linear descending weight by TIER rank (not by raw item count): top tier
// gets the biggest share, bottom tier the smallest, normalized to sum to 1.
// A tier's share is then split equally among its (possibly several, if tied)
// members. Two tied cuisines therefore get identical weight.
function recomputeCuisineWeighting(cycle) {
  const order = cycle.cuisinePriorityOrder || [];
  const tied = cycle.cuisineTiedWithNext || [];
  const weighting = {};
  if (!order.length) { cycle.cuisineWeighting = weighting; return; }

  const tiers = computeTiers(order, tied);
  const k = tiers.length;
  const totalShares = (k * (k + 1)) / 2; // 1+2+...+k
  tiers.forEach((tierCuisines, tierIdx) => {
    const tierShare = (k - tierIdx) / totalShares; // top tier gets k, bottom gets 1
    const perItem = tierShare / tierCuisines.length;
    tierCuisines.forEach((c) => { weighting[c] = perItem; });
  });
  cycle.cuisineWeighting = weighting;
}

// Keeps cuisineTiedWithNext the right length (order.length - 1) whenever the
// order array changes \u2014 call this any time a cuisine is added or removed.
function ensureTiedArraySize(cycle) {
  const needed = Math.max(0, (cycle.cuisinePriorityOrder || []).length - 1);
  if (!cycle.cuisineTiedWithNext) cycle.cuisineTiedWithNext = [];
  while (cycle.cuisineTiedWithNext.length < needed) cycle.cuisineTiedWithNext.push(false);
  while (cycle.cuisineTiedWithNext.length > needed) cycle.cuisineTiedWithNext.pop();
}

// Up/down semantics: pressing the arrow the FIRST time ties the item to its
// neighbor (equal weight, no reordering). Pressing again, now that they're
// tied, fully swaps past the neighbor (untying them, now strictly ahead/behind).
function moveCuisineUp(cycle, i) {
  if (i <= 0) return;
  const tied = cycle.cuisineTiedWithNext;
  if (!tied[i - 1]) {
    tied[i - 1] = true; // first press: tie with the one above
  } else {
    const order = cycle.cuisinePriorityOrder;
    [order[i - 1], order[i]] = [order[i], order[i - 1]];
    tied[i - 1] = false; // second press: fully swap past, no longer tied
  }
}

function moveCuisineDown(cycle, i) {
  const order = cycle.cuisinePriorityOrder;
  if (i >= order.length - 1) return;
  const tied = cycle.cuisineTiedWithNext;
  if (!tied[i]) {
    tied[i] = true; // first press: tie with the one below
  } else {
    [order[i], order[i + 1]] = [order[i + 1], order[i]];
    tied[i] = false; // second press: fully swap past, no longer tied
  }
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function mostRecentSunday(fromDate = new Date()) {
  const d = new Date(fromDate);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

export function formatDate(d) {
  // Deliberately NOT toISOString() \u2014 that converts to UTC, which shifts the
  // calendar day backward/forward depending on local timezone and time of day
  // (the exact bug that showed Monday's date as if it were Sunday). Build the
  // string from local date parts instead.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Parses a 'YYYY-MM-DD' string as LOCAL midnight, not UTC \u2014 new Date(str) would
// parse it as UTC, which is the exact bug that once shifted a date backward/
// forward depending on timezone. Always use this for date-string \u2192 Date.
function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const MAX_CYCLE_DAYS = 62; // sane cap \u2014 a very long accidental range shouldn't silently generate hundreds of day-cards

export function newCycle(startDateStr, endDateStr) {
  const start = startDateStr ? parseLocalDate(startDateStr) : mostRecentSunday();
  let end;
  if (endDateStr) {
    end = parseLocalDate(endDateStr);
  } else {
    end = new Date(start);
    end.setDate(end.getDate() + 6); // default: a standard 7-day week
  }

  const days = [];
  const cursor = new Date(start);
  let guard = 0;
  while (cursor <= end && guard < MAX_CYCLE_DAYS) {
    days.push({
      date: formatDate(cursor),
      dayOfWeek: DAY_NAMES[cursor.getDay()], // actual day-of-week, not loop index \u2014 correct for any start day
      activeProfileIds: [],
      slots: {
        breakfast: { state: 'skip', result: null },
        lunch: { state: 'skip', result: null },
        dinner: { state: 'plan', result: null },
      },
    });
    cursor.setDate(cursor.getDate() + 1);
    guard++;
  }

  return {
    id: uid('cyc'),
    startDate: formatDate(start),
    endDate: formatDate(days.length ? parseLocalDate(days[days.length - 1].date) : end),
    cuisineWeighting: {},
    cuisinePriorityOrder: [],
    cuisineTiedWithNext: [],
    onHandNote: '',
    days,
  };
}

export function currentCycle(state) {
  if (!state.cycles.length) return null;
  return state.cycles[state.cycles.length - 1];
}

function allCuisineTags(state) {
  const set = new Set();
  (state.recipes || []).forEach((r) => { if (r.tags?.cuisine) set.add(r.tags.cuisine); });
  (state.profiles || []).forEach((p) => (p.cuisineLikes || []).forEach((c) => set.add(c)));
  return [...set];
}

export function renderCycleSetup(state, container, { saveState, toast, onMenuReady, onNavigate, onGetAiIdeas }) {
  if (!state.profiles.length) {
    renderGettingStarted(state, container, { onNavigate });
    return;
  }

  let cycle = currentCycle(state);
  const today = formatDate(new Date());
  const isStale = cycle && (cycle.endDate < today);

  if (!cycle || isStale) {
    renderNewCycleChooser(state, container, { saveState, toast, onMenuReady, onNavigate, onGetAiIdeas });
    return;
  }

  const cuisines = allCuisineTags(state);

  let html = `<div class="card">
    <h3>Planning period: ${cycle.startDate} → ${cycle.endDate}</h3>
    <div class="meta">${cycle.days.length} day${cycle.days.length === 1 ? '' : 's'}.</div>
    <button class="btn secondary small" id="start-new-period-btn" style="margin-top:0.5rem;">Start a different planning period</button>
  </div>`;

  cycle.cuisinePriorityOrder = cycle.cuisinePriorityOrder || [];
  ensureTiedArraySize(cycle);
  recomputeCuisineWeighting(cycle); // keep weighting in sync even if it's stale from before this feature existed

  const cuisineTiers = computeTiers(cycle.cuisinePriorityOrder, cycle.cuisineTiedWithNext);
  // map each cuisine to its tier's rank (1-based) and percent, so tied items show identically
  const tierRankOf = {};
  const tierPercentOf = {};
  cuisineTiers.forEach((tierCuisines, tierIdx) => {
    tierCuisines.forEach((c) => {
      tierRankOf[c] = tierIdx + 1;
      tierPercentOf[c] = Math.round((cycle.cuisineWeighting[c] || 0) * 100);
    });
  });

  html += `<div class="card">
    <h3>Cuisine weighting for this period</h3>
    <div class="meta">Tap cuisines in the order you want them prioritized \u2014 first tapped gets the heaviest weight. Use the arrows to reorder: the first press ties two cuisines to equal weight, press again to fully swap past. Leave all off for an even mix.</div>
    <div class="choice-row" id="cuisine-weight-row">
      ${cuisines.length ? cuisines.map((c) => {
        const active = cycle.cuisinePriorityOrder.includes(c);
        return `<button type="button" class="choice-chip weight-chip ${active ? 'selected' : ''}" data-cuisine="${c}">${c.replace(/_/g, ' ')}</button>`;
      }).join('') : '<span class="meta">Add recipes or profile cuisine-likes first — this list grows from your data.</span>'}
    </div>
    ${cycle.cuisinePriorityOrder.length ? `
      <div id="cuisine-priority-list" style="margin-top:0.6rem;">
        ${cycle.cuisinePriorityOrder.map((c, i) => `
          <div class="checklist-row" data-cuisine="${c}">
            <span>${tierRankOf[c]}. ${c.replace(/_/g, ' ')} <span class="meta">(${tierPercentOf[c]}%${cuisineTiers[tierRankOf[c] - 1].length > 1 ? ' \u2014 tied' : ''})</span></span>
            <div style="display:flex; gap:0.3rem;">
              <button type="button" class="btn secondary small priority-up-btn" data-idx="${i}" ${i === 0 ? 'disabled' : ''}>\u2191</button>
              <button type="button" class="btn secondary small priority-down-btn" data-idx="${i}" ${i === cycle.cuisinePriorityOrder.length - 1 ? 'disabled' : ''}>\u2193</button>
            </div>
          </div>
        `).join('')}
      </div>
    ` : ''}
  </div>`;

  cycle.onHandNote = cycle.onHandNote || '';
  html += `<div class="card">
    <h3>What's on hand?</h3>
    <div class="meta">Optional. Type it in your own words \u2014 "leftover rotisserie chicken, some lettuce, tortillas, tomatoes." The AI will lean on this for a couple of ideas where it fits naturally, but won't limit the whole list to just these items.</div>
    <textarea id="on-hand-note" placeholder="e.g. leftover rotisserie chicken, half a bag of spinach, a block of feta...">${escapeHtml(cycle.onHandNote)}</textarea>
  </div>`;

  html += `<div class="card">
    <h3>No recipes yet, or want fresh ideas?</h3>
    <div class="meta">Get a batch of AI-suggested dishes matching the weighting above, pick which ones you like, and assign them to nights. Full recipes get written and saved as you pick.</div>
    <button class="btn" id="get-ai-ideas-btn" style="margin-top:0.5rem;">Get AI dish ideas for this period</button>
  </div>`;

  for (const day of cycle.days) {
    html += `<div class="card day-card" data-date="${day.date}">
      <h3>${day.dayOfWeek.toUpperCase()} <span class="meta">${day.date}</span></h3>

      <div class="field">
        <label>Who's present</label>
        <div class="choice-row profile-present-row" data-date="${day.date}">
          ${(state.profiles || []).map((p) => {
            const active = day.activeProfileIds.includes(p.id);
            return `<button type="button" class="choice-chip ${active ? 'selected' : ''}" data-profile-id="${p.id}">${escapeHtml(p.name)}</button>`;
          }).join('') || '<span class="meta">No profiles yet — add one in the Profiles tab.</span>'}
        </div>
      </div>

      ${['breakfast', 'lunch', 'dinner'].map((slotType) => `
        <div class="field">
          <label>${slotType[0].toUpperCase() + slotType.slice(1)}</label>
          <div class="choice-row slot-row" data-date="${day.date}" data-slot="${slotType}">
            ${['plan', 'skip', 'eating_out', 'special'].map((s) => {
              const label = { plan: 'Plan', skip: 'Skip', eating_out: 'Eating out', special: 'Special' }[s];
              const active = day.slots[slotType].state === s;
              return `<button type="button" class="choice-chip slot-chip ${active ? 'selected' : ''}" data-value="${s}">${label}</button>`;
            }).join('')}
          </div>
          ${day.slots[slotType].result ? `<div class="meta slot-result">${describeSlotResult(day.slots[slotType], state)}</div>` : ''}
        </div>
      `).join('')}
    </div>`;
  }

  const poisonedCount = cycle.days.filter((d) => d.slots.dinner.result && d.slots.dinner.result.recipeId === null).length;
  const assignedCount = cycle.days.filter((d) => d.slots.dinner.result && d.slots.dinner.result.recipeId).length;

  html += `<div class="card">
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn" id="generate-menu-btn">Generate Menu</button>
      ${poisonedCount ? `<button class="btn secondary" id="clear-failed-btn">Clear ${poisonedCount} failed attempt(s)</button>` : ''}
      ${assignedCount ? `<button class="btn danger" id="reset-menu-btn">Reset this period's menu (${assignedCount} night${assignedCount === 1 ? '' : 's'})</button>` : ''}
    </div>
    <div class="meta" style="margin-top:0.4rem;">Reset clears every night's assigned dinner (recipes stay in your library) so you can start over \u2014 who's present and cuisine weighting stay as-is.</div>
  </div>`;

  container.innerHTML = html;

  container.querySelector('#start-new-period-btn').addEventListener('click', () => {
    renderNewCycleChooser(state, container, { saveState, toast, onMenuReady, onNavigate, onGetAiIdeas });
  });

  const clearFailedBtn = container.querySelector('#clear-failed-btn');
  if (clearFailedBtn) {
    clearFailedBtn.addEventListener('click', () => {
      let cleared = 0;
      cycle.days.forEach((d) => {
        if (d.slots.dinner.result && d.slots.dinner.result.recipeId === null) {
          d.slots.dinner.result = null;
          cleared++;
        }
      });
      saveState();
      toast(`Cleared ${cleared} failed attempt(s) \u2014 those nights are open again`);
      renderCycleSetup(state, container, { saveState, toast, onMenuReady, onNavigate, onGetAiIdeas });
    });
  }

  const resetMenuBtn = container.querySelector('#reset-menu-btn');
  if (resetMenuBtn) {
    resetMenuBtn.addEventListener('click', () => {
      if (!confirm(`Clear all ${assignedCount} assigned dinner(s) for this period? Recipes stay in your library \u2014 only the night-by-night assignment is removed.`)) return;
      let reset = 0;
      cycle.days.forEach((d) => {
        if (d.slots.dinner.result) {
          d.slots.dinner.result = null;
          reset++;
        }
      });
      saveState();
      toast(`Reset ${reset} night(s) \u2014 ready to regenerate`);
      renderCycleSetup(state, container, { saveState, toast, onMenuReady, onNavigate, onGetAiIdeas });
    });
  }

  // cuisine weighting chips — tapping adds to the priority order (or removes
  // if already present); tier-based weighting derived from order + ties.
  container.querySelectorAll('.weight-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const c = chip.dataset.cuisine;
      const idx = cycle.cuisinePriorityOrder.indexOf(c);
      if (idx === -1) {
        cycle.cuisinePriorityOrder.push(c); // new pick starts as its own tier at the bottom
      } else {
        cycle.cuisinePriorityOrder.splice(idx, 1);
        if (cycle.cuisineTiedWithNext.length) cycle.cuisineTiedWithNext.splice(Math.max(0, idx - 1), 1);
      }
      ensureTiedArraySize(cycle);
      recomputeCuisineWeighting(cycle);
      saveState();
      renderCycleSetup(state, container, { saveState, toast, onMenuReady, onNavigate, onGetAiIdeas });
    });
  });

  container.querySelectorAll('.priority-up-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.idx);
      moveCuisineUp(cycle, i);
      recomputeCuisineWeighting(cycle);
      saveState();
      renderCycleSetup(state, container, { saveState, toast, onMenuReady, onNavigate, onGetAiIdeas });
    });
  });

  container.querySelectorAll('.priority-down-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.idx);
      moveCuisineDown(cycle, i);
      recomputeCuisineWeighting(cycle);
      saveState();
      renderCycleSetup(state, container, { saveState, toast, onMenuReady, onNavigate, onGetAiIdeas });
    });
  });

  // profile-present chips, per day
  container.querySelectorAll('.profile-present-row').forEach((row) => {
    row.querySelectorAll('.choice-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
        const date = row.dataset.date;
        const day = cycle.days.find((d) => d.date === date);
        day.activeProfileIds = [...row.querySelectorAll('.choice-chip.selected')].map((c) => c.dataset.profileId);
        saveState();
      });
    });
  });

  // slot state chips, per day per slot
  container.querySelectorAll('.slot-row').forEach((row) => {
    row.querySelectorAll('.slot-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        row.querySelectorAll('.slot-chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        const date = row.dataset.date;
        const slotType = row.dataset.slot;
        const day = cycle.days.find((d) => d.date === date);
        day.slots[slotType].state = chip.dataset.value;
        if (chip.dataset.value !== 'plan') day.slots[slotType].result = null;
        saveState();
      });
    });
  });

  container.querySelector('#generate-menu-btn').addEventListener('click', () => {
    onMenuReady(cycle);
  });

  const onHandInput = container.querySelector('#on-hand-note');
  if (onHandInput) {
    onHandInput.addEventListener('change', () => {
      cycle.onHandNote = onHandInput.value.trim();
      saveState();
    });
  }

  const aiIdeasBtn = container.querySelector('#get-ai-ideas-btn');
  if (aiIdeasBtn && onGetAiIdeas) {
    aiIdeasBtn.addEventListener('click', () => onGetAiIdeas(cycle));
  }
}

function describeSlotResult(slot, state) {
  if (slot.result?.recipeId) {
    const r = state.recipes.find((x) => x.id === slot.result.recipeId);
    return r ? `→ ${escapeHtml(r.title)}` : '';
  }
  if (slot.result?.transcriptSummary) return `→ ${escapeHtml(slot.result.transcriptSummary)}`;
  return '';
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderNewCycleChooser(state, container, { saveState, toast, onMenuReady, onNavigate, onGetAiIdeas }) {
  const today = formatDate(new Date());

  container.innerHTML = `
    <div class="card">
      <h3>Start a new planning period</h3>
      <div class="meta">Pick a start date and how long this stretch should run \u2014 a single day, a standard week, a month, or any custom range.</div>
      <div class="field"><label>Start date</label><input type="date" id="new-cycle-start" value="${today}"></div>
      <div class="field">
        <label>Length</label>
        <div class="choice-row" id="cycle-length-row">
          <button type="button" class="choice-chip length-chip" data-length="day">1 day</button>
          <button type="button" class="choice-chip length-chip selected" data-length="week">1 week</button>
          <button type="button" class="choice-chip length-chip" data-length="month">1 month</button>
          <button type="button" class="choice-chip length-chip" data-length="custom">Custom end date</button>
        </div>
      </div>
      <div class="field" id="custom-end-field" style="display:none;">
        <label>End date</label>
        <input type="date" id="new-cycle-end" value="${today}">
      </div>
      <button class="btn" id="start-cycle-btn" style="margin-top:0.5rem;">Start this period</button>
    </div>
  `;

  container.querySelectorAll('.length-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      container.querySelectorAll('.length-chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
      container.querySelector('#custom-end-field').style.display = chip.dataset.length === 'custom' ? 'block' : 'none';
    });
  });

  container.querySelector('#start-cycle-btn').addEventListener('click', () => {
    const startVal = container.querySelector('#new-cycle-start').value;
    if (!startVal) { toast('Pick a start date'); return; }
    const start = parseLocalDate(startVal);
    const lengthChip = container.querySelector('.length-chip.selected');
    const length = lengthChip ? lengthChip.dataset.length : 'week';

    let end;
    if (length === 'day') {
      end = new Date(start);
    } else if (length === 'week') {
      end = new Date(start);
      end.setDate(end.getDate() + 6);
    } else if (length === 'month') {
      end = new Date(start);
      end.setMonth(end.getMonth() + 1);
      end.setDate(end.getDate() - 1);
    } else {
      const endVal = container.querySelector('#new-cycle-end').value;
      if (!endVal) { toast('Pick an end date'); return; }
      end = parseLocalDate(endVal);
    }

    if (end < start) { toast('End date must be on or after the start date'); return; }
    const spanDays = Math.round((end - start) / 86400000) + 1;
    if (spanDays > MAX_CYCLE_DAYS) { toast(`That's a long stretch (${MAX_CYCLE_DAYS}-day cap) \u2014 pick a shorter range`); return; }

    const cycle = newCycle(formatDate(start), formatDate(end));
    state.cycles.push(cycle);
    saveState();
    toast(`Started a ${spanDays}-day planning period`);
    renderCycleSetup(state, container, { saveState, toast, onMenuReady, onNavigate, onGetAiIdeas });
  });
}

function renderGettingStarted(state, container, { onNavigate }) {
  container.innerHTML = `
    <div class="card">
      <h3>Let's get set up</h3>
      <div class="meta">Menu generation needs at least one profile (who's eating) before there's anything to plan around. Recipes can come later \u2014 once you're set up here, you can either add recipes by hand or get AI dish ideas right from the weekly menu screen.</div>
    </div>
    <div class="card">
      <h3>Add a profile</h3>
      <div class="meta">Start with yourself \u2014 diet type, texture, cuisine leanings. Add anyone else (kids, partner) later, anytime.</div>
      <button class="btn" id="goto-profiles-btn" style="margin-top:0.5rem;">Go to Profiles</button>
    </div>
  `;
  container.querySelector('#goto-profiles-btn').addEventListener('click', () => onNavigate('profiles'));
}
