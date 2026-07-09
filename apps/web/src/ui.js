export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function esc(value) { return String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
export function status(value) { return `<span class="status ${esc(value)}">${esc(value || 'unknown')}</span>`; }
export function card(title, body, extra = '') { return `<article class="card ${extra}"><h3>${esc(title)}</h3>${body}</article>`; }
export function metric(label, value, hint = '') { return card(label, `<div class="metric">${esc(value)}</div><p class="muted">${esc(hint)}</p>`, 'soft'); }
export function code(value) { return `<pre class="code">${esc(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</pre>`; }
export function empty(title, action = '') { return `<div class="empty-state"><h3>${esc(title)}</h3>${action}</div>`; }
export function toast(message, type = 'ok') { const host = $('#toast-host'); const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = message; host.appendChild(el); setTimeout(() => el.remove(), 4200); }
export function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
export function bindClick(root, selector, handler) { $$(selector, root).forEach((el) => el.addEventListener('click', handler)); }
