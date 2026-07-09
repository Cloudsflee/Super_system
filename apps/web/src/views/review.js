import { state } from '../state.js';
import { card, esc, status } from '../ui.js';

export function reviewView() {
  const r = state.review || { projects: [], nodes: [], runs: [], traces: [], assets: [], decisions: [], digests: [], code_changes: [], change_proposals: [], agent_sessions: [], submissions: [] };
  return `
    <div class="grid cols-3">
      ${card('项目目标', r.projects.slice(-3).map((p) => `<b>${esc(p.title)}</b><p>${esc(p.goal)}</p>`).join('<div class="divider"></div>'))}
      ${card('节点状态', r.nodes.slice(-10).map((n) => `<div class="row between"><span>${esc(n.title)}</span>${status(n.status)}</div>`).join(''))}
      ${card('连续性证据', `<p>Digest: ${r.digests.length}</p><p>Confirmed Assets: ${r.assets.filter((a) => a.status === 'confirmed').length}</p><p>Decision Records: ${r.decisions.length}</p><p>Context / Trace events: ${r.traces.length}</p><p>Change Proposals: ${r.change_proposals?.length || 0}</p>`)}
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      ${card('Trace Timeline', `<div class="timeline">${r.traces.slice(-60).map((e) => `<div class="event"><b>${esc(e.event_type)}</b><p class="muted">${esc(e.summary)}</p></div>`).join('')}</div>`)}
      ${card('Git / PR', r.code_changes.map((c) => `<div class="row between"><span>${esc(c.id)}</span>${status(c.status)}</div><p>${esc(c.pr_url || c.commit_message || '')}</p>`).join('<div class="divider"></div>'))}
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      ${card('层级 Codex 会话', (r.agent_sessions || []).map((s) => `<div class="row between"><span>${esc(s.title)}</span>${status(s.status)}</div><p class="muted">${esc(s.scope_type)} · parent: ${esc(s.parent_session_id || 'top')}</p>`).join('<div class="divider"></div>') || '<p class="muted">暂无会话</p>')}
      ${card('变更审批 / SubSubmission', `${(r.change_proposals || []).map((p) => `<div class="row between"><span>${esc(p.title)}</span>${status(p.status)}</div>`).join('') || '<p class="muted">暂无审批</p>'}<div class="divider"></div>${(r.submissions || []).map((s) => `<p><b>${esc(s.title)}</b> · ${esc(s.summary)}</p>`).join('') || '<p class="muted">暂无 SubSubmission</p>'}`)}
    </div>`;
}
