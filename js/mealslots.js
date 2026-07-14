// mealslots.js — the "Plan" button on breakfast/lunch (single-shot AI idea) and
// the "Special" conversational flow (open chat via api.js). Neither of these
// touches the rules-based recipe engine; both are always AI, on-demand,
// never a permanent library entry unless the user explicitly saves it.

import { api } from './api.js';

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function planMealSlot(state, day, slotType, { saveState, toast }) {
  const profiles = (state.profiles || []).filter((p) => day.activeProfileIds.includes(p.id));
  toast(`Asking AI for ${slotType} ideas...`);
  const result = await api.getMealSlotIdea({ slotType, activeProfiles: profiles, note: '' });

  if (!result || !result.ideas?.length) {
    toast('Could not reach the AI assistant \u2014 try again, or plan this one manually.');
    return null;
  }

  const summary = result.ideas.map((i) => i.title).join(' / ');
  day.slots[slotType].result = { transcriptSummary: summary, savedAsRecipeId: null };

  state.mealSlotHistory = state.mealSlotHistory || [];
  state.mealSlotHistory.push({
    id: uid('msr'),
    date: day.date,
    slotType,
    activeProfileIds: day.activeProfileIds,
    transcript: JSON.stringify(result.ideas),
    savedAsRecipeId: null,
  });
  saveState();
  return result.ideas;
}

// Renders the open "Special" conversation as a simple chat thread.
// This keeps its own local message history (not persisted mid-conversation \u2014
// only the final summary/decision gets written back into the day's slot).
export function renderSpecialChat(day, slotType, container, { saveState, toast, onClose }) {
  const messages = []; // { role, content }

  function renderThread() {
    container.innerHTML = `
      <div class="card">
        <h3>Special / Date Night \u2014 ${slotType}, ${day.date}</h3>
        <div class="meta">Talk it through: what's on hand, what you're willing to buy, who it's for, how fancy.</div>
        <div id="chat-thread" class="chat-thread">
          ${messages.map((m) => `<div class="chat-bubble ${m.role}">${escapeHtml(m.content)}</div>`).join('')}
        </div>
        <textarea id="chat-input" placeholder="Type here..."></textarea>
        <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
          <button class="btn" id="chat-send-btn">Send</button>
          <button class="btn secondary" id="chat-done-btn">Done \u2014 save summary</button>
          <button class="btn secondary" id="chat-cancel-btn">Cancel</button>
        </div>
      </div>
    `;

    container.querySelector('#chat-send-btn').addEventListener('click', async () => {
      const input = container.querySelector('#chat-input');
      const text = input.value.trim();
      if (!text) return;
      messages.push({ role: 'user', content: text });
      renderThread();
      const reply = await api.getDateNightReply({ messages });
      messages.push({ role: 'assistant', content: reply });
      renderThread();
    });

    container.querySelector('#chat-done-btn').addEventListener('click', () => {
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
      day.slots[slotType].result = {
        transcriptSummary: lastAssistant ? lastAssistant.content.slice(0, 140) : 'Special meal planned',
        savedAsRecipeId: null,
      };
      saveState();
      toast('Saved');
      onClose();
    });

    container.querySelector('#chat-cancel-btn').addEventListener('click', () => onClose());
  }

  renderThread();
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
