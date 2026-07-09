import { $, $$, toast } from './ui.js';

export const viewOrder = ['dashboard', 'wizard', 'workflow', 'node', 'context', 'runner', 'assets', 'git', 'tools', 'review'];

export function syncActiveNav(view) {
  $$('#nav button').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
}

export async function withBusy(label, fn) {
  setBusy(label);
  try { return await fn(); }
  catch (error) { toast(error.message, 'error'); return null; }
  finally { clearBusy(); }
}

export function setBusy(label = '正在处理...') {
  const overlay = $('#busy-overlay');
  if (!overlay) return;
  overlay.querySelector('span').textContent = label;
  overlay.classList.add('show');
}

export function clearBusy() { $('#busy-overlay')?.classList.remove('show'); }
export function toggleShortcuts() { $('#shortcut-panel')?.classList.toggle('show'); }

export function bindShortcuts({ setView, openAssist, refresh }) {
  document.addEventListener('keydown', (event) => {
    if (isTyping(event)) return;
    if (event.key === '?') { event.preventDefault(); toggleShortcuts(); }
    if (event.key.toLowerCase() === 'a') { event.preventDefault(); openAssist(); }
    if (event.key.toLowerCase() === 'r') { event.preventDefault(); refresh(); }
    const number = Number(event.key);
    if (number >= 1 && number <= viewOrder.length) { event.preventDefault(); setView(viewOrder[number - 1]); }
  });
}

function isTyping(event) { return ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName); }
