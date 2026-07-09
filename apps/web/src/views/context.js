import { state } from '../state.js';
import { card, code, empty, esc, status } from '../ui.js';

export function contextView() {
  if (!state.project) return empty('请先选择 Project。');
  const packs = state.workspace?.context_packs || [];
  const known = state.lastContextPack || packs.at(-1);
  return `
    <div class="row" style="margin-bottom:14px"><button id="preview-context" class="primary">生成 Context Pack Preview</button>${known ? `<button id="confirm-context" class="secondary">确认并落盘</button>` : ''}</div>
    ${known ? `<div class="grid cols-3">
      ${card('质量自检', qualityRows(known))}
      ${card('Memory Manifest', manifestSummary(known))}
      ${card('充分性 Gate', sufficiencySummary(known))}
    </div>${card('Context Pack JSON', code(known.content_json), 'soft')}` : empty('尚未生成 Context Pack。')}`;
}

function qualityRows(ctx) {
  return Object.entries(ctx.quality_check || {}).filter(([k]) => k !== 'warnings').map(([k, v]) => `<div class="row between"><span>${esc(k)}</span>${status(v ? 'healthy' : 'failed')}</div>`).join('');
}
function manifestSummary(ctx) { return `<p>Included: ${ctx.memory_manifest?.included?.length || 0}</p><p>Excluded: ${ctx.memory_manifest?.excluded?.length || 0}</p><p>Warnings: ${ctx.memory_manifest?.warnings?.length || 0}</p>`; }
function sufficiencySummary(ctx) { const check = ctx.content_json?.sufficiency_check || ctx._sufficiency_check; return `${status(check?.status)}<p class="muted">缺失：${check?.missing_slots?.length || 0} · 冲突：${check?.conflicts?.length || 0}</p>`; }
