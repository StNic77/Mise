// checklist.js — the Standing Checklist (staples/household only, never
// produce/meat). +/-/x marking, with a visible grayed-out "revive" list for
// anything x'd out by mistake.

const CATEGORY_LABELS = {
  dairy_eggs: 'Dairy & Eggs',
  bread_bakery: 'Bread & Bakery',
  canned_dry: 'Canned & Dry',
  baking: 'Baking',
  frozen: 'Frozen',
  beverages: 'Beverages',
  household: 'Household',
  personal_care: 'Personal Care',
};

export function renderChecklist(state, container, { saveState, toast, onSendToShoppingList }) {
  const checklist = state.checklist;
  let html = '';

  for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
    const items = checklist.categories[key] || [];
    html += `<div class="card">
      <h3>${label}</h3>
      <div class="checklist-items" data-category="${key}">
        ${items.map((item, idx) => `
          <div class="checklist-row">
            <span>${escapeHtml(item.label)}</span>
            <div class="choice-row mark-row" data-category="${key}" data-idx="${idx}">
              <button type="button" class="choice-chip mark-chip ${item.mark === 'plus' ? 'selected' : ''}" data-mark="plus">+</button>
              <button type="button" class="choice-chip mark-chip ${item.mark === 'minus' ? 'selected' : ''}" data-mark="minus">\u2014</button>
              <button type="button" class="choice-chip mark-chip danger ${item.mark === 'dropped' ? 'selected' : ''}" data-mark="dropped">\u2715</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div style="margin-top:0.5rem; display:flex; gap:0.4rem;">
        <input type="text" class="add-item-input" data-category="${key}" placeholder="Add item to this category">
        <button class="btn secondary small add-item-btn" data-category="${key}">Add</button>
      </div>
    </div>`;
  }

  if (checklist.droppedItems.length) {
    html += `<div class="card">
      <h3>Previously dropped <span class="meta">(tap to revive)</span></h3>
      <div id="dropped-list">
        ${checklist.droppedItems.map((d, idx) => `
          <div class="revival-item">
            <span>${escapeHtml(d.label)}</span>
            <button class="btn secondary small revive-btn" data-idx="${idx}">Revive</button>
          </div>
        `).join('')}
      </div>
    </div>`;
  }

  html += `<div class="card">
    <button class="btn" id="send-checklist-btn">Add + items to shopping list</button>
  </div>`;

  container.innerHTML = html;

  container.querySelectorAll('.mark-row').forEach((row) => {
    row.querySelectorAll('.mark-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const category = row.dataset.category;
        const idx = Number(row.dataset.idx);
        const item = checklist.categories[category][idx];
        const mark = chip.dataset.mark;

        if (mark === 'dropped') {
          checklist.droppedItems.push({ label: item.label, droppedAt: new Date().toISOString() });
          checklist.categories[category].splice(idx, 1);
        } else {
          item.mark = mark;
        }
        saveState();
        renderChecklist(state, container, { saveState, toast, onSendToShoppingList });
      });
    });
  });

  container.querySelectorAll('.add-item-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const category = btn.dataset.category;
      const input = container.querySelector(`.add-item-input[data-category="${category}"]`);
      const label = input.value.trim();
      if (!label) return;
      checklist.categories[category].push({ label, mark: 'plus' });
      saveState();
      renderChecklist(state, container, { saveState, toast, onSendToShoppingList });
    });
  });

  container.querySelectorAll('.revive-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const dropped = checklist.droppedItems[idx];
      // revive into the first category by default \u2014 user can re-sort by re-adding elsewhere if needed
      const firstCategory = Object.keys(checklist.categories)[0];
      checklist.categories[firstCategory].push({ label: dropped.label, mark: 'minus' });
      checklist.droppedItems.splice(idx, 1);
      saveState();
      toast(`Revived "${dropped.label}"`);
      renderChecklist(state, container, { saveState, toast, onSendToShoppingList });
    });
  });

  container.querySelector('#send-checklist-btn').addEventListener('click', () => {
    const toAdd = [];
    for (const [key, items] of Object.entries(checklist.categories)) {
      items.forEach((item) => {
        if (item.mark === 'plus') toAdd.push({ name: item.label, category: key });
      });
    }
    onSendToShoppingList(toAdd);
    toast(`Added ${toAdd.length} item(s) to shopping list`);
  });
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
