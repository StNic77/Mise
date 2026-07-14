// backup.js \u2014 the real safety net. Full export/import of the entire app
// state, since local storage is the ONLY copy of this data (no server, no
// automatic sync). Export button lives on the main screen, not buried \u2014
// this is the thing that actually protects against a lost/reset phone.
//
// Also holds the deliberately-buried "wipe recipe library" nuclear option,
// which needs real friction since it destroys durable, effortful data \u2014
// unlike the shopping list's Clear All, which is meant to be easy.

import { db } from './db.js';

export function renderSettings(state, container, { saveState, toast, reloadApp }) {
  container.innerHTML = `
    <div class="card">
      <h3>Backup</h3>
      <div class="meta">This is the only copy of your data. Export it regularly \u2014
        especially before a phone change or OS update.</div>
      <button class="btn" id="export-backup-btn" style="margin-top:0.5rem;">Export full backup (.json)</button>
    </div>

    <div class="card">
      <h3>Restore</h3>
      <div class="meta">Replaces everything currently in the app with the contents of the file you pick.</div>
      <button class="btn secondary" id="import-backup-btn" style="margin-top:0.5rem;">Import backup (.json)</button>
      <input type="file" id="import-backup-input" accept="application/json" style="display:none;">
    </div>

    <div class="card">
      <h3>About</h3>
      <div class="meta">Mise \u2014 ${state.meta?.appBuild || 'dev'}</div>
    </div>

    <div class="card" style="border-color: var(--danger);">
      <h3 style="color: var(--danger);">Danger zone</h3>
      <div class="meta">Wiping the recipe library deletes every recipe permanently.
        This is NOT covered by the shopping list's Clear All \u2014 there is no undo.</div>
      <button class="btn danger" id="wipe-recipes-btn" style="margin-top:0.5rem;">Wipe recipe library</button>
    </div>
  `;

  container.querySelector('#export-backup-btn').addEventListener('click', () => {
    state.meta.lastExportedAt = new Date().toISOString();
    saveState();
    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mise-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Backup downloaded');
  });

  container.querySelector('#import-backup-btn').addEventListener('click', () => {
    container.querySelector('#import-backup-input').click();
  });
  container.querySelector('#import-backup-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('This replaces everything currently in the app. Continue?')) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await db.replaceAll(parsed);
      toast('Restored \u2014 reloading...');
      setTimeout(() => reloadApp(), 600);
    } catch (err) {
      toast('Could not read that file as a valid Mise backup');
    }
  });

  container.querySelector('#wipe-recipes-btn').addEventListener('click', () => {
    const confirmText = prompt('This permanently deletes every recipe in your library.\nType DELETE to confirm.');
    if (confirmText !== 'DELETE') { toast('Cancelled'); return; }
    state.recipes = [];
    saveState();
    toast('Recipe library wiped');
  });
}
