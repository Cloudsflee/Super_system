import { state } from '../state.js';
import { card, metric, status } from '../ui.js';

export function dashboardView() {
  const counts = state.review || { projects: [], nodes: [], runs: [], assets: [], digests: [], traces: [], code_changes: [] };
  return `
    ${onboardingChecklist()}
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

function onboardingChecklist() {
  const github = state.githubStatus?.connected ? 'healthy' : 'needs_review';
  const codex = state.codexStatus?.docker?.healthy && state.codexStatus?.image?.built ? 'healthy' : 'degraded';
  const cc = state.ccSwitchStatus?.status === 'synced' ? 'healthy' : state.ccSwitchStatus?.status === 'degraded' ? 'degraded' : 'needs_review';
  return card('开局引导 · V1.1', `
    <div class="onboarding-checklist">
      ${checkItem('GitHub OAuth 绑定', github, '用于 PR / Review 链路；未绑定时仍可生成草稿。', 'github-oauth-start')}
      ${checkItem('Codex Docker 容器', codex, '每个 NodeRun 使用独立容器会话；不可用时自动降级。', 'codex-docker-build')}
      ${checkItem('cc-switch 配置同步', cc, '评估 farion1231/cc-switch 与 SaladDay/cc-switch-cli。', 'cc-switch-sync')}
    </div>
    <p class="muted">引导可跳过，但未完成项会持续显示；MockRunner 演示不受阻塞。</p>
  `, 'onboarding-card');
}

function checkItem(title, st, hint, actionId) {
  return `<div class="check-item"><div><div class="row"><b>${title}</b>${status(st)}</div><p class="muted">${hint}</p></div><button id="${actionId}" class="secondary">处理</button></div>`;
}
