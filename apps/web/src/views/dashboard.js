import { state } from '../state.js';
import { card, metric, status } from '../ui.js';

export function dashboardView() {
  const counts = state.review || { projects: [], nodes: [], runs: [], assets: [], digests: [], traces: [], code_changes: [] };
  return `
    <div class="grid cols-4">
      ${metric('Projects', counts.projects.length, '本地工作空间')}
      ${metric('Nodes', counts.nodes.length, '5 类节点闭环')}
      ${metric('Runs', counts.runs.length, 'Mock/Codex NodeRun')}
      ${metric('Assets', counts.assets.length, '候选 / 确认资产')}
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      ${card('依赖状态', `<div class="stack">
        <div class="row between"><span>DB</span>${status(state.health?.db?.healthy ? 'healthy' : 'unknown')}</div>
        <div class="row between"><span>Git</span>${status(state.health?.git?.healthy ? 'healthy' : 'degraded')}</div>
        <div class="row between"><span>Codex CLI</span>${status(state.health?.codex?.healthy ? 'healthy' : 'degraded')}</div>
        <div class="row between"><span>Docker</span>${status(state.health?.docker?.healthy ? 'healthy' : 'degraded')}</div>
      </div>`)}
      ${card('V1 闭环进度', `<div class="stack">
        <div>Project → Workflow → Node Contract</div>
        <div>Context Pack → Memory Manifest → Runner</div>
        <div>Trace → Asset Candidate → Digest</div>
        <div>Git diff / branch / commit / PR 草稿</div>
      </div>`)}
    </div>`;
}
