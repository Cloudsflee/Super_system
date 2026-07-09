import { state } from '../state.js';
import { card, code, esc, status } from '../ui.js';

export function runnerView() {
  const runs = state.workspace?.runs || state.review?.runs || [];
  return `
    <div class="card stack" style="margin-bottom:14px">
      <h3>Runner Control</h3>
      <div class="grid cols-3">
        <label>Runner<select id="runner-kind"><option value="mock">MockRunner（稳定演示）</option><option value="codex_docker">Codex Docker（每次新容器/新对话）</option><option value="codex">CodexRunner（真实 CLI，可 partial）</option></select></label>
        <label class="choice-card"><input id="runner-live" type="checkbox" /><span><b>Codex live</b><small>取消勾选则 Codex 走可追溯 partial/mock 降级</small></span></label>
        <label class="choice-card"><input id="runner-mock-write" type="checkbox" checked /><span><b>写入演示文件</b><small>用于真实 Git diff/commit 证据</small></span></label>
      </div>
      <div class="row"><button id="start-run" class="primary">启动 NodeRun</button><button id="load-run-trace" class="secondary">刷新 Trace</button><button id="cancel-run" class="danger">取消选中 Run</button></div>
    </div>
    <div class="grid cols-2">
      ${card('Runner Console', runs.length ? runs.slice(-6).map(runCard).join('<div class="divider"></div>') : '<p class="muted">暂无运行</p>')}
      ${card('Trace Timeline', `<div class="timeline">${(state.runTrace || state.review?.traces || []).slice(-30).map((event) => `<div class="event"><b>${esc(event.event_type)}</b><p class="muted">${esc(event.summary)}</p></div>`).join('')}</div>`)}
    </div>
    ${state.selectedRun ? card('NodeRun Result', code(state.selectedRun), 'soft') : ''}`;
}

function runCard(run) {
  return `<div class="row between"><button class="ghost select-run" data-run-id="${run.id}">${esc(run.id)}</button>${status(run.status)}</div><p class="muted">${esc(run.runner || '')} · ${esc(run.summary || '')}</p>`;
}
