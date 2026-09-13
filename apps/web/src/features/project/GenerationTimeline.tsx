import { useState } from 'react';
import { statusLabel, errorCodeLabel } from '../../i18n';
import { normalizeWorkflowNodes } from './WorkflowCanvas';
import type { Generation, Workflow } from './workflowTypes';

export function GenerationTimeline({ generations, workflow, online, busy, dirty, acceptanceCount, onAction }: {
  generations: Generation[]; workflow: Workflow | null; online: boolean; busy: boolean; dirty: boolean; acceptanceCount: number;
  onAction: (action: 'critic' | 'retry' | 'cancel' | 'apply', generation: Generation) => void;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  return <section className="panel generation-timeline"><div className="section-title"><div><h2>生成与服务端 Critic</h2><span>{generations.length} 次尝试</span></div></div>
    <p className="prerequisite-note">queued → running → critic_pending → proposed / completed / rejected / failed / cancelled</p>
    {!online && <p role="status">恢复连接后可用</p>}
    <ol>{generations.map(generation => {
      const proposal = generation.proposal;
      const stale = Boolean(proposal && proposal.base_workflow_revision !== workflow?.current_revision);
      const candidate = proposal?.candidate || generation.candidate || {};
      const before = normalizeWorkflowNodes(workflow?.current?.graph); const after = normalizeWorkflowNodes(candidate);
      return <li key={generation.id} className="generation-item"><div role="status"><strong>{statusLabel(generation.phase)}</strong><small>{generation.phase} · {generation.id} · r{generation.revision} · 尝试 {generation.attempt || 1}</small></div>
        <div className="form-actions">
          {generation.phase === 'critic_pending' && <button className="button" disabled={!online || busy} onClick={() => onAction('critic', generation)}>执行 Critic</button>}
          {['failed', 'rejected', 'cancelled'].includes(generation.phase) && <button className="button" disabled={!online || busy} onClick={() => onAction('retry', generation)}>重试生成</button>}
          {['queued', 'running'].includes(generation.phase) && <button className="button" disabled={!online || busy} onClick={() => onAction('cancel', generation)}>取消生成</button>}
          {generation.phase === 'proposed' && <><button className="button" aria-expanded={opened === generation.id} onClick={() => setOpened(opened === generation.id ? null : generation.id)}>查看提案</button><button className="button primary" disabled={!online || busy || dirty || !proposal || stale} onClick={() => onAction('apply', generation)}>应用提案</button></>}
        </div>
        {generation.error_code && <p role="alert">{errorCodeLabel(generation.error_code)} ({generation.error_code})</p>}
        {generation.critic?.issues?.length ? <ul className="critic-issues" data-testid={`critic-issues-${generation.id}`}>{generation.critic.issues.map((issue, index) => <li key={index}>{issue.message || errorCodeLabel(issue.code || '')} {issue.code} {issue.node_id} {issue.severity}</li>)}</ul> : null}
        {generation.phase === 'proposed' && (stale || dirty) && <p role="alert">{stale ? '提案基准修订已过期，请重新加载后生成新提案。' : '请先保存或放弃本地草稿修改。'}</p>}
        {opened === generation.id && proposal && <div className="proposal-diff" data-testid={`proposal-diff-${generation.id}`}>
          <h3>提案差异</h3><p>来源生成 r{generation.revision} · 基准 Workflow r{proposal.base_workflow_revision} · 当前 r{workflow?.current_revision || 0}</p>
          <p>candidate hash：<code>{proposal.candidate_sha256 || generation.candidate_sha256 || '尚无哈希'}</code></p>
          <p>Critic：{generation.critic?.status || '尚无回执'} · {generation.critic?.issues?.length ?? 0} 条 issue</p>
          <p>图谱节点：{before.length} → {after.length}；Brief 验收条目：{acceptanceCount}</p>
          <ul>{after.filter(node => node.kind !== 'workstream').map(node => <li key={node.id}>{node.title}：验收检查 {JSON.stringify((node.contract as { acceptance?: string[] } | undefined)?.acceptance || [])}</li>)}</ul>
          {generation.critic?.coverage && <pre tabIndex={0} aria-label="Critic 覆盖回执">{JSON.stringify(generation.critic.coverage, null, 2)}</pre>}
          <pre tabIndex={0} role="region" aria-label="Workflow 提案 JSON">{JSON.stringify(candidate, null, 2)}</pre>
        </div>}
      </li>;
    })}</ol>
    {!generations.length && <p className="list-empty">暂无生成尝试</p>}
  </section>;
}
