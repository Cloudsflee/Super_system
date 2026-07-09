import { state } from '../state.js';
import { card, empty, esc, status } from '../ui.js';

export function workflowView() {
  if (!state.project) return empty('请先创建或选择一个 Project。');
  const wf = state.project.workflows?.[0];
  const nodes = state.project.nodes || [];
  const selected = nodes.find((node) => node.id === state.selectedWorkflowNodeId) || nodes[0];
  const vp = state.workflowViewport || { x: 0, y: 0, scale: 1 };
  return `
    <div class="row" style="margin-bottom:14px">
      <button id="recommend-workflow" class="primary">推荐工作流</button>
      ${wf ? `<button id="confirm-workflow" class="secondary">确认工作流</button>` : ''}
      <button id="workflow-zoom-in" class="secondary">＋</button>
      <button id="workflow-zoom-out" class="secondary">－</button>
      <button id="workflow-reset" class="ghost">重置画布</button>
    </div>
    ${wf ? card('推荐理由', `<b>${esc(wf.title)}</b><div class="divider"></div>${(wf.recommended_reason || []).map((r) => `<p>• ${esc(r)}</p>`).join('')}`) : ''}
    <div class="workflow-layout" style="margin-top:16px">
      <div id="workflow-canvas" class="workflow-canvas v11-canvas" data-x="${vp.x}" data-y="${vp.y}" data-scale="${vp.scale}">
        <svg class="workflow-edges" width="1200" height="520">${edges(nodes)}</svg>
        <div id="workflow-stage" class="workflow-stage" style="transform: translate(${vp.x}px, ${vp.y}px) scale(${vp.scale})">
          ${nodes.map((node) => canvasNode(node)).join('')}
        </div>
      </div>
      ${selected ? inspector(selected) : empty('尚未生成节点。')}
    </div>`;
}

function canvasNode(node) {
  const pos = node.position || { x: 80 + (node.order_index || 0) * 220, y: node.order_index % 2 ? 240 : 80 };
  const selected = node.id === state.selectedWorkflowNodeId ? ' selected' : '';
  return `<button class="flow-node canvas-node${selected}" data-node-id="${node.id}" style="left:${pos.x}px;top:${pos.y}px"><div class="node-type">${esc(node.type)}</div><h3>${esc(node.title)}</h3><p class="muted">${esc(node.goal).slice(0, 86)}...</p>${status(node.status)}</button>`;
}

function edges(nodes) {
  return nodes.slice(1).map((node, index) => {
    const a = nodes[index].position || { x: 80 + index * 220, y: index % 2 ? 240 : 80 };
    const b = node.position || { x: 80 + node.order_index * 220, y: node.order_index % 2 ? 240 : 80 };
    return `<path d="M${a.x + 190} ${a.y + 70} C${a.x + 245} ${a.y + 70}, ${b.x - 55} ${b.y + 70}, ${b.x} ${b.y + 70}" />`;
  }).join('');
}

function inspector(node) {
  return card('节点 Inspector', `<div class="node-type">${esc(node.type)}</div><h3>${esc(node.title)}</h3><p>${esc(node.goal)}</p>${status(node.status)}<div class="divider"></div><div class="stack"><button id="workflow-enter-node" class="primary">进入 Node Workspace</button><button id="workflow-node-proposal" class="secondary">生成本质变更说明</button></div>`, 'workflow-inspector');
}
