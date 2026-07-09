import { currentContract, currentNode } from '../state.js';
import { card, code, empty, esc, status } from '../ui.js';

export function nodeView() {
  const node = currentNode();
  if (!node) return empty('请先在 Workflow 中生成/选择节点。');
  const contract = currentContract();
  return `
    <div class="grid cols-2">
      ${card('节点目标', `<div class="node-type">${esc(node.type)}</div><h3>${esc(node.title)}</h3><p>${esc(node.goal)}</p>${status(node.status)}<div class="divider"></div><button id="select-node-workspace" class="secondary">加载 Node Workspace</button>`)}
      ${card('Node Contract 编辑器', contract ? contractEditor(contract) : '<p class="muted">暂无契约</p>')}
    </div>
    ${contract ? card('Contract JSON', code(contract), 'soft') : ''}`;
}

function contractEditor(contract) {
  return `<div class="stack">
    <label>节点目标</label><textarea id="contract-goal" rows="3">${esc(contract.node_goal)}</textarea>
    <label>验收标准（每行一条）</label><textarea id="contract-criteria" rows="5">${esc((contract.acceptance_criteria || []).join('\n'))}</textarea>
    <label>允许工具（逗号分隔）</label><input id="contract-tools" value="${esc((contract.allowed_tools || []).join(', '))}" />
    <div class="row"><button id="contract-assist" class="secondary">字段级 Assist</button><button id="confirm-contract" class="primary">保存并确认新版本</button></div>
  </div>`;
}
