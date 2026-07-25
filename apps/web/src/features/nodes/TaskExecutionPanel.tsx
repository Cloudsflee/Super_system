import { useQuery } from '@tanstack/react-query';
import { Check, Database, ExternalLink, GitCommitHorizontal, GitPullRequest, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, json } from '../../api/client';
import type { PullRequestIntentRecord, TaskExecutionDetails, TaskReadiness } from '../../api/types';
import { assetTypeLabel, checkStatusLabel, displayStatus, executorLabel, pullRequestStatusLabel } from '../../components/common/display-labels';
import { useUi } from '../../state/ui';

export function TaskExecutionPanel({ taskId, canWrite = true }: { taskId: string; canWrite?: boolean }) {
  const toast = useUi((state) => state.toast), [busy, setBusy] = useState('');
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const readiness = useQuery({ queryKey: ['task-readiness', taskId], queryFn: () => api<TaskReadiness>(`/tasks/${taskId}/readiness`), refetchInterval: 1_000 });
  const executionId = readiness.data?.task_execution_id || '';
  const details = useQuery({ queryKey: ['task-execution', executionId], queryFn: () => api<TaskExecutionDetails>(`/task-executions/${executionId}`), enabled: Boolean(executionId), refetchInterval: (query) => terminal(query.state.data?.task_execution.status) ? false : 1_000 });
  const value = details.data, execution = value?.task_execution;
  const candidates = useMemo(() => value?.outputs.filter((item) => item.asset?.status === 'candidate' && !item.bound) || [], [value?.outputs]);
  async function refresh() { await Promise.all([readiness.refetch(), details.refetch()]); }
  async function retry() { if (!execution) return; await act('retry', () => api(`/task-executions/${execution.id}/retry`, json('POST', {}, '重试任务执行'))); }
  async function decide(decision: 'approve' | 'reject') {
    if (!execution || !candidates.length) return;
    await act(decision, () => api(`/task-executions/${execution.id}/human-approve`, json('POST', { decision, expected_versions: candidates.map((item) => ({ version_id: item.version?.id, content_sha256: item.version?.content_sha256 })) }, decision === 'approve' ? '验收任务输出' : '退回任务输出')));
  }
  async function submitManual() {
    if (!execution || !value) return;
    const consumed = [...new Set(value.inputs.flatMap((item) => item.asset_versions || []).map((item) => item.version_id))];
    const outputs = value.contract.expected_outputs.map((slot) => ({ output_key: slot.key, asset_type: slot.asset_type, title: `${value.task.title} ${slot.key}`, summary: manualValues[slot.key] || '', payload: { payload_kind: 'text', media_type: 'text/plain; charset=utf-8', content: manualValues[slot.key] || '' }, evidence_refs: [], consumed_input_versions: consumed }));
    await act('manual', () => api(`/task-executions/${execution.id}/manual-submit`, json('POST', { outputs }, '提交人工确认点')));
  }
  async function approvePullRequest(action: 'create_pr' | 'merge_pr') {
    const intent = value?.pull_request_intent;
    if (!intent) return;
    await act(action, async () => {
      const approved = await api<{ intent: PullRequestIntentRecord }>(`/pull-request-intents/${intent.id}/approve`, json('POST', { action, expected_revision: intent.revision, expected_snapshot_hash: intent.snapshot_hash }, action === 'create_pr' ? '批准创建合并请求' : '批准合并请求'));
      return api(`/pull-request-intents/${intent.id}/execute`, json('POST', { action, expected_revision: approved.intent.revision, expected_snapshot_hash: approved.intent.snapshot_hash }, action === 'create_pr' ? '创建合并请求' : '合并代码变更'));
    });
  }
  async function act(name: string, operation: () => Promise<unknown>) { setBusy(name); try { await operation(); await refresh(); toast('人工确认点已更新'); } catch (error) { toast((error as Error).message, 'error'); } finally { setBusy(''); } }
  if (!executionId) return <section className="task-execution-panel empty"><header><Database size={17} /><div><strong>尚未启动</strong><small>工作流执行</small></div></header></section>;
  if (details.isLoading || !value || !execution) return <section className="task-execution-panel empty"><header><Database size={17} /><div><strong>正在读取任务执行</strong><small>{short(executionId)}</small></div></header></section>;
  const intent = value.pull_request_intent;
  return <section className="task-execution-panel">
    <header className="task-execution-heading"><span className={`execution-dot ${execution.status}`} /><div><strong>{displayStatus(execution.status)}</strong><small>{executorLabel(execution.executor)} · 第 {execution.attempt} 次尝试 · {short(execution.id)}</small></div>{execution.error_code && <code>{execution.error_code}</code>}{canWrite && execution.status === 'failed' && <button className="button secondary" disabled={Boolean(busy)} onClick={() => void retry()}><RotateCcw size={14} />重试</button>}</header>
    <div className="task-execution-snapshot"><SnapshotColumn title="固定输入" icon={<Database size={14} />} empty="无资产输入">{value.inputs.flatMap((input) => input.asset_versions || []).map((item) => <span key={item.version_id}><strong>{item.title || assetTypeLabel(item.asset_type)}</strong><code>{short(item.version_id)} · {short(item.content_sha256)}</code></span>)}</SnapshotColumn><SnapshotColumn title="输出载荷" icon={<ShieldCheck size={14} />} empty="等待输出">{value.outputs.map((item) => <ExecutionOutput key={`${item.asset_id}-${item.version_id}`} item={item} />)}</SnapshotColumn></div>
    {canWrite && execution.status === 'awaiting_human' && execution.executor === 'manual' && !value.outputs.length && <div className="task-manual-checkpoint">{value.contract.expected_outputs.map((slot) => <label key={slot.key}>{slot.key}<small>{assetTypeLabel(slot.asset_type)}</small><textarea value={manualValues[slot.key] || ''} onChange={(event) => setManualValues((current) => ({ ...current, [slot.key]: event.target.value }))} /></label>)}<button className="button primary" disabled={Boolean(busy) || value.contract.expected_outputs.some((slot) => !(manualValues[slot.key] || '').trim())} onClick={() => void submitManual()}><Check size={15} />提交并验收</button></div>}
    {canWrite && execution.status === 'awaiting_human' && candidates.length > 0 && <div className="task-checkpoint-actions"><span><ShieldCheck size={15} /><strong>{candidates.length} 项候选输出</strong><small>{candidates.map((item) => `${item.key}@${short(item.version?.id)}`).join(' · ')}</small></span><button className="button secondary danger" disabled={Boolean(busy)} onClick={() => void decide('reject')}><X size={14} />退回</button><button className="button primary" disabled={Boolean(busy)} onClick={() => void decide('approve')}><Check size={14} />验收</button></div>}
    {canWrite && execution.executor === 'repository_integrate' && intent && <PullRequestCheckpoint intent={intent} busy={busy} onApprove={approvePullRequest} />}
    {execution.readiness?.reasons?.length ? <div className="task-waiting-reasons">{execution.readiness.reasons.map((item, index) => <span key={`${item.code}-${index}`}>{reasonLabel(item.code)}</span>)}</div> : null}
  </section>;
}

function PullRequestCheckpoint({ intent, busy, onApprove }: { intent: PullRequestIntentRecord; busy: string; onApprove: (action: 'create_pr' | 'merge_pr') => Promise<void> }) { const create = intent.status === 'proposed', merge = ['draft_open', 'ready'].includes(intent.status); return <div className="pull-request-checkpoint"><span><GitPullRequest size={16} /><strong>{intent.pr_number ? `合并请求 #${intent.pr_number}` : `${intent.head_ref} -> ${intent.base_ref}`}</strong><small>{pullRequestStatusLabel(intent.status)} · {checkStatusLabel(intent.checks_status)} · 已批准 {intent.approvals.length}/2</small></span>{intent.pr_url && <a href={intent.pr_url} target="_blank" rel="noreferrer">打开合并请求</a>}{create && <button className="button primary" disabled={Boolean(busy)} onClick={() => void onApprove('create_pr')}><GitPullRequest size={14} />批准创建</button>}{merge && <button className="button primary" disabled={Boolean(busy)} onClick={() => void onApprove('merge_pr')}><GitCommitHorizontal size={14} />批准合并</button>}</div>; }
function SnapshotColumn({ title, icon, empty, children }: { title: string; icon: React.ReactNode; empty: string; children: React.ReactNode }) { const items = Array.isArray(children) ? children : [children]; return <div><h3>{icon}{title}</h3>{items.some(Boolean) ? children : <span>{empty}</span>}</div>; }
function ExecutionOutput({ item }: { item: TaskExecutionDetails['outputs'][number] }) {
  const metadata = item.version?.manifest?.metadata || {}, prUrl = text(metadata.pull_request_url), prNumber = text(metadata.pull_request_number), branch = text(metadata.branch);
  const hash = [item.version?.content_sha256, item.version?.repository_sha].filter(Boolean).join(' · ');
  return <span className="task-execution-output"><strong>{item.asset?.title || item.key} · {displayStatus(item.asset?.status)}</strong>{item.asset?.summary && <small>{item.asset.summary}</small>}{branch && <small>{branch}</small>}{hash && <code aria-label={`内容标识 ${hash}`}>{hash}</code>}{prUrl && <a href={prUrl} target="_blank" rel="noreferrer">合并请求{prNumber ? ` #${prNumber}` : ''}<ExternalLink size={11} /></a>}</span>;
}
function terminal(value?: string) { return ['completed', 'failed', 'cancelled', 'superseded'].includes(value || ''); }
function reasonLabel(value: string) { return ({ manual_input_required: '等待人工输入', pull_request_create_approval_required: '等待批准创建合并请求', pull_request_merge_approval_required: '等待批准合并代码', task_dependency_waiting: '等待上游任务', required_input_missing: '必需输入缺失' } as Record<string, string>)[value] || '等待执行条件'; }
function short(value?: string | null) { return value ? value.slice(0, 12) : '待绑定'; }
function text(value: unknown) { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }
