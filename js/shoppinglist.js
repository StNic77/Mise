// shoppinglist.js \u2014 full CRUD shopping list. Three entry paths (menu export,
// checklist send, chat-JSON import, manual add), persists indefinitely,
// Clear All is the deliberate reset. App never touches store/pricing logic \u2014
// price is an optional freeform field the user fills in themselves, usually
// after pasting chat's priced JSON back in.

import { api } from './api.js';

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

const CATEGORY_LABELS = {
  produce: 'Produce',
  meat_protein: 'Meat & Protein',
  dairy_eggs: 'Dairy & Eggs',
  bread_bakery: 'Bread & Bakery',
  canned_dry: 'Canned & Dry',
  baking: 'Baking',
  frozen: 'Frozen',
  beverages: 'Beverages',
  household: 'Household',
  personal_care: 'Personal Care',
  other: 'Other',
};

export function addItems(state, items, source) {
  state.shoppingList = state.shoppingList || [];
  items.forEach((item) => {
    state.shoppingList.push({
      id: uid('sli'),
      name: item.name,
      category: item.category || 'other',
      quantity: item.quantity || '',
      source,
      purchased: false,
      price: item.price ?? null,
      addedAt: new Date().toISOString(),
    });
  });
}

export function renderShoppingList(state, container, { saveState, toast }) {
  const list = state.shoppingList || [];
  const byCategory = {};
  list.forEach((item) => {
    byCategory[item.category] = byCategory[item.category] || [];
    byCategory[item.category].push(item);
  });

  const purchasedCount = list.filter((i) => i.purchased).length;
  const unpurchasedCount = list.length - purchasedCount;

  let html = `<div class="card">
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn secondary small" id="manual-add-btn">+ Add item</button>
      <button class="btn secondary small" id="export-md-btn">Export .md</button>
      <button class="btn secondary small" id="import-json-btn">Import chat JSON</button>
      ${unpurchasedCount > 1 ? `<button class="btn small" id="consolidate-btn">Consolidate with AI</button>` : ''}
      ${purchasedCount ? `<button class="btn small" id="regenerate-btn">Regenerate list (remove ${purchasedCount} checked-off)</button>` : ''}
      <button class="btn danger small" id="clear-all-btn">Clear All</button>
    </div>
    ${unpurchasedCount > 1 ? `<div class="meta" style="margin-top:0.4rem;">Consolidate merges related items (e.g. lemon juice + zest + wedges \u2192 "2 lemons") using real cooking judgment, not just text matching. Only touches unpurchased items \u2014 checked-off items are left alone.</div>` : ''}
    <input type="file" id="import-file-input" accept="application/json" style="display:none;">
  </div>`;

  if (!list.length) {
    html += `<div class="empty-state">Nothing on the list yet. Generate a menu, run the checklist, or add something manually.</div>`;
  }

  for (const [cat, label] of Object.entries(CATEGORY_LABELS)) {
    const items = byCategory[cat];
    if (!items || !items.length) continue;
    html += `<div class="card">
      <h3>${label}</h3>
      ${items.map((item) => `
        <div class="shopping-item ${item.purchased ? 'purchased' : ''}" data-id="${item.id}">
          <label class="shopping-item-tap">
            <input type="checkbox" class="purchased-toggle" data-id="${item.id}" ${item.purchased ? 'checked' : ''}>
            <span class="item-name">${escapeHtml(item.name)}</span>
            <span class="item-qty meta">${escapeHtml(item.quantity || '')}</span>
          </label>
          <div class="item-actions">
            <input type="text" class="price-input" data-id="${item.id}" placeholder="$" value="${item.price != null ? escapeHtml(String(item.price)) : ''}">
            <button class="btn secondary small edit-item-btn" data-id="${item.id}">Edit</button>
            <button class="btn danger small delete-item-btn" data-id="${item.id}">Delete</button>
          </div>
        </div>
        ${item.note ? `<div class="meta" style="margin:-0.3rem 0 0.4rem 1.8rem;">${escapeHtml(item.note)}</div>` : ''}
      `).join('')}
    </div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll('.purchased-toggle').forEach((cb) => {
    cb.addEventListener('change', () => {
      const item = list.find((i) => i.id === cb.dataset.id);
      item.purchased = cb.checked;
      cb.closest('.shopping-item').classList.toggle('purchased', cb.checked);
      saveState();
    });
  });

  container.querySelectorAll('.price-input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const item = list.find((i) => i.id === inp.dataset.id);
      const v = inp.value.trim();
      item.price = v === '' ? null : v;
      saveState();
    });
  });

  container.querySelectorAll('.delete-item-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.shoppingList = state.shoppingList.filter((i) => i.id !== btn.dataset.id);
      saveState();
      renderShoppingList(state, container, { saveState, toast });
    });
  });

  container.querySelectorAll('.edit-item-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = list.find((i) => i.id === btn.dataset.id);
      const newName = prompt('Item name', item.name);
      if (newName === null) return;
      const newQty = prompt('Quantity', item.quantity || '');
      item.name = newName.trim() || item.name;
      item.quantity = (newQty || '').trim();
      saveState();
      renderShoppingList(state, container, { saveState, toast });
    });
  });

  container.querySelector('#manual-add-btn').addEventListener('click', () => {
    const name = prompt('Item name');
    if (!name) return;
    const qty = prompt('Quantity (optional)') || '';
    const cat = prompt('Category (produce, meat_protein, dairy_eggs, bread_bakery, canned_dry, frozen, beverages, household, personal_care, other)', 'other') || 'other';
    addItems(state, [{ name, quantity: qty, category: CATEGORY_LABELS[cat] ? cat : 'other' }], 'manual');
    saveState();
    renderShoppingList(state, container, { saveState, toast });
  });

  const consolidateBtn = container.querySelector('#consolidate-btn');
  if (consolidateBtn) {
    consolidateBtn.addEventListener('click', async () => {
      const unpurchased = state.shoppingList.filter((i) => !i.purchased);
      consolidateBtn.textContent = 'Consolidating...';
      consolidateBtn.disabled = true;

      const result = await api.getConsolidatedGroceryList({
        items: unpurchased.map((i) => ({ name: i.name, quantity: i.quantity, category: i.category })),
      });

      if (!result || !result.consolidated?.length) {
        toast('Could not consolidate \u2014 check the console for details, or try again');
        consolidateBtn.textContent = 'Consolidate with AI';
        consolidateBtn.disabled = false;
        return;
      }

      const before = unpurchased.length;
      // Keep purchased items exactly as they are; replace only the unpurchased set.
      const purchasedItems = state.shoppingList.filter((i) => i.purchased);
      const newUnpurchased = result.consolidated.map((c) => ({
        id: uid('sli'),
        name: c.name,
        category: c.category || 'other',
        quantity: c.quantity || '',
        source: 'consolidated',
        purchased: false,
        price: null,
        addedAt: new Date().toISOString(),
        note: c.note || null,
      }));
      state.shoppingList = [...purchasedItems, ...newUnpurchased];
      saveState();
      toast(`Consolidated ${before} item(s) into ${newUnpurchased.length}`);
      renderShoppingList(state, container, { saveState, toast });
    });
  }

  const regenerateBtn = container.querySelector('#regenerate-btn');
  if (regenerateBtn) {
    regenerateBtn.addEventListener('click', () => {
      const before = state.shoppingList.length;
      state.shoppingList = state.shoppingList.filter((i) => !i.purchased);
      const removed = before - state.shoppingList.length;
      saveState();
      toast(`Removed ${removed} checked-off item(s) \u2014 list is now just what's left to get`);
      renderShoppingList(state, container, { saveState, toast });
    });
  }

  container.querySelector('#clear-all-btn').addEventListener('click', () => {
    if (!confirm('Clear the entire shopping list, plus dropped-checklist and rejected-suggestion lists? This cannot be undone.')) return;
    state.shoppingList = [];
    state.checklist.droppedItems = [];
    state.rejectedAiSuggestions = [];
    saveState();
    toast('Cleared');
    renderShoppingList(state, container, { saveState, toast });
  });

  container.querySelector('#export-md-btn').addEventListener('click', () => {
    const md = exportAsMarkdown(state);
    downloadFile(`mise-grocery-list-${new Date().toISOString().slice(0, 10)}.md`, md);
  });

  container.querySelector('#import-json-btn').addEventListener('click', () => {
    container.querySelector('#import-file-input').click();
  });
  container.querySelector('#import-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : parsed.items || [];
      addItems(state, items.map((i) => ({
        name: i.name, quantity: i.quantity, category: i.category || 'other', price: i.price ?? null,
      })), 'chat_import');
      saveState();
      toast(`Imported ${items.length} item(s) from chat`);
      renderShoppingList(state, container, { saveState, toast });
    } catch (err) {
      toast('Could not read that file \u2014 expected a JSON array or {items: [...]}');
    }
  });
}

export function exportAsMarkdown(state) {
  const list = state.shoppingList || [];
  const byCategory = {};
  list.forEach((item) => {
    byCategory[item.category] = byCategory[item.category] || [];
    byCategory[item.category].push(item);
  });

  let md = `GROCERY NEEDS \u2014 ${new Date().toISOString().slice(0, 10)}\n\n`;
  for (const [cat, label] of Object.entries(CATEGORY_LABELS)) {
    const items = byCategory[cat];
    if (!items || !items.length) continue;
    md += `${label.toUpperCase()}\n`;
    items.forEach((item) => {
      md += `- ${item.name}${item.quantity ? ` \u2014 ${item.quantity}` : ''}\n`;
    });
    md += `\n`;
  }
  md += `NOTES\n- \n`;
  return md;
}

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
