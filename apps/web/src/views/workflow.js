import { state } from '../state.js';
import { card, empty, esc, status } from '../ui.js';

export function workflowView() {
  if (!state.project) return empty('请先创建或选择一个 Project。');
  const wf = state.project.workflows?.[0];
  const nodes = state.project.nodes || [];
  return `
    <div class="row" style="margin-bottom:14px">
      <button id="recommend-workflow" class="primary">推荐工作流</button>
      ${wf ? `<button id="confirm-workflow" class="secondary">确认工作流</button>` : ''}
    </div>
    ${wf ? card('推荐理由', `<b>${esc(wf.title)}</b><div class="divider"></div>${(wf.recommended_reason || []).map((r) => `<p>• ${esc(r)}</p>`).join('')}`) : ''}
    <div class="workflow-canvas" style="margin-top:16px"><div class="flow-row">
      ${nodes.map((node) => `<div class="flow-node" data-node-id="${node.id}"><div class="node-type">${esc(node.type)}</div><h3>${esc(node.title)}</h3><p class="muted">${esc(node.goal).slice(0, 90)}...</p>${status(node.status)}</div>`).join('')}
    </div></div>`;
}
