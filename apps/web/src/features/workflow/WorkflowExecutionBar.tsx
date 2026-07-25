import { useQuery } from '@tanstack/react-query';
import { GitBranch, Pause, Play, RotateCcw, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, json } from '../../api/client';
import type { ProjectBundle, RepositoryBranchCatalog, RepositoryConnection, RepositoryLineRecord, TaskExecutionRecord, Workflow, WorkflowExecutionList, WorkflowExecutionRecord, WorkflowExecutionSnapshot } from '../../api/types';
import { displayStatus } from '../../components/common/display-labels';
import { ToolbarMenu } from '../../components/common/ToolbarMenu';
import { Tooltip } from '../../components/common/Tooltip';
import { useUi } from '../../state/ui';

type Selection = { connection_id: string; base_ref: string };

export function WorkflowExecutionBar({ bundle, workflow, canWrite, onRefresh, onSnapshot }: { bundle: ProjectBundle; workflow: Workflow; canWrite: boolean; onRefresh: () => void; onSnapshot: (value: WorkflowExecutionSnapshot | null) => void }) {
  const [configuring, setConfiguring] = useState(false), [busy, setBusy] = useState('');
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const toast = useUi((state) => state.toast);
  const history = useQuery({
    queryKey: ['workflow-executions', workflow.id], queryFn: () => api<WorkflowExecutionList>(`/workflows/${workflow.id}/executions`),
    refetchInterval: (query) => ['running', 'paused'].includes(query.state.data?.current?.workflow_execution.status || '') ? 1_000 : 4_000
  });
  const connections = useQuery({ queryKey: ['repository-connections', bundle.project.id], queryFn: () => api<{ items: RepositoryConnection[] }>(`/projects/${bundle.project.id}/repository-connections`) });
  const repositoryWorkstreams = useMemo(() => repositoryStreams(bundle), [bundle]);
  useEffect(() => {
    const first = connections.data?.items?.[0];
    if (!first) return;
    setSelections((current) => Object.fromEntries(repositoryWorkstreams.map((item) => [item.id, current[item.id] || { connection_id: first.id, base_ref: first.default_branch || 'main' }])));
  }, [connections.data, repositoryWorkstreams]);
  const snapshot = history.data?.current, execution = snapshot?.workflow_execution;
  useEffect(() => onSnapshot(snapshot || null), [onSnapshot, snapshot]);
  const tasks = useMemo(() => latestTasks(snapshot?.task_executions || []), [snapshot?.task_executions]);

  async function start() {
    if (repositoryWorkstreams.some((item) => !selections[item.id]?.connection_id || !selections[item.id]?.base_ref)) return toast('请选择每条仓库执行线的代码仓库和分支', 'error');
    setBusy('start');
    try {
      await api(`/workflows/${workflow.id}/executions`, json('POST', {
        expected_workflow_revision: Number(workflow.workflow_revision || workflow.version || 1),
        repositories: repositoryWorkstreams.map((item) => ({ workstream_id: item.id, ...selections[item.id] }))
      }, { name: '启动工作流', feedback: 'foreground', idempotencyKey: `workflow-${workflow.id}-${crypto.randomUUID()}`, timeoutMs: 120_000 }));
      setConfiguring(false); await history.refetch(); onRefresh(); toast('工作流已启动');
    } catch (error) { toast((error as Error).message, 'error'); } finally { setBusy(''); }
  }

  async function control(action: 'pause' | 'resume' | 'cancel') {
    if (!execution) return;
    setBusy(action);
    try { await api(`/workflow-executions/${execution.id}/${action}`, json('POST', {}, `${actionLabel(action)}工作流`)); await history.refetch(); onRefresh(); }
    catch (error) { toast((error as Error).message, 'error'); } finally { setBusy(''); }
  }

  const lines = snapshot?.repository_lines || [];
  const openConfiguration = () => repositoryWorkstreams.length ? setConfiguring(true) : void start();
  return <section className="workflow-execution-band" aria-label="工作流执行" data-status={execution?.status || 'not_started'}>
    <div className="workflow-execution-row">
      <div className="workflow-execution-state">
        <span className={`execution-dot ${execution?.status || 'not_started'}`} aria-hidden="true" />
        <div><strong>{execution ? statusLabel(execution.status) : '尚未启动'}</strong><small>修订版 {execution?.workflow_revision || Number(workflow.workflow_revision || workflow.version || 1)}{execution ? ` · ${short(execution.id)}` : ''}</small></div>
      </div>
      {snapshot && <div className="workflow-frontier" aria-label={`可执行 ${snapshot.frontier.length}，等待中 ${snapshot.waiting_reasons.length}，已完成 ${tasks.filter((item) => item.status === 'completed').length}/${tasks.length}`}><span><strong>{snapshot.frontier.length}</strong><small>可执行</small></span><span><strong>{snapshot.waiting_reasons.length}</strong><small>等待中</small></span><span><strong>{tasks.filter((item) => item.status === 'completed').length}/{tasks.length}</strong><small>已完成</small></span></div>}
      {lines[0] && <RepositoryLine line={lines[0]} />}
      {lines.length > 1 && <RepositoryLinesMenu lines={lines.slice(1)} />}
      {lines.length > 0 && <RepositoryLinesMenu lines={lines} mobile />}
      <ExecutionActions execution={execution} canWrite={canWrite} busy={busy} onStart={openConfiguration} onControl={control} />
    </div>
    {configuring && <div className="workflow-line-config">
      {repositoryWorkstreams.map((stream) => <div key={stream.id} className="workflow-line-row"><span><GitBranch size={14} /><strong>{stream.title}</strong></span><label>代码仓库<select value={selections[stream.id]?.connection_id || ''} onChange={(event) => { const connection = connections.data?.items.find((item) => item.id === event.target.value); setSelections((current) => ({ ...current, [stream.id]: { connection_id: event.target.value, base_ref: connection?.default_branch || 'main' } })); }}>{connections.data?.items.map((item) => <option key={item.id} value={item.id}>{item.full_name || item.id}</option>)}</select></label><BranchSelect projectId={bundle.project.id} selection={selections[stream.id]} onChange={(base_ref) => setSelections((current) => ({ ...current, [stream.id]: { ...current[stream.id], base_ref } }))} /></div>)}
      <div className="workflow-line-submit"><button className="button secondary" onClick={() => setConfiguring(false)}>取消</button><button className="button primary" disabled={Boolean(busy) || connections.data?.items.length === 0} onClick={() => void start()}><Play size={15} />启动</button></div>
    </div>}
  </section>;
}

function ExecutionActions({ execution, canWrite, busy, onStart, onControl }: { execution?: WorkflowExecutionRecord; canWrite: boolean; busy: string; onStart: () => void; onControl: (action: 'pause' | 'resume' | 'cancel') => Promise<void> }) {
  if (!canWrite) return null;
  if (!execution) return <div className="workflow-execution-actions"><button className="button primary" disabled={busy === 'start'} onClick={onStart}><Play size={15} />启动工作流</button></div>;
  if (execution.status === 'running') return <div className="workflow-execution-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => void onControl('pause')}><Pause size={15} />暂停</button><button className="button secondary danger-subtle" disabled={Boolean(busy)} onClick={() => void onControl('cancel')}><Square size={14} />取消</button></div>;
  if (execution.status === 'paused') return <div className="workflow-execution-actions"><button className="button primary" disabled={Boolean(busy)} onClick={() => void onControl('resume')}><RotateCcw size={15} />继续</button><button className="button secondary" disabled={Boolean(busy)} onClick={() => void onControl('cancel')}><Square size={14} />取消</button></div>;
  const label = execution.status === 'completed' ? '再次运行' : '重新运行';
  return <div className="workflow-execution-actions"><button className="button secondary" disabled={busy === 'start'} onClick={onStart}><RotateCcw size={15} />{label}</button></div>;
}

function RepositoryLine({ line, menu = false }: { line: RepositoryLineRecord; menu?: boolean }) {
  const sha = line.merged_sha || line.head_sha || line.base_sha;
  const label = `${line.branch} · ${sha || '待绑定'} · ${displayStatus(line.status)}`;
  if (menu) return <div className="repository-line-menuitem" role="menuitem" tabIndex={-1} aria-label={label}><GitBranch size={13} /><span>{line.branch}</span><code>{sha || '待绑定'}</code><i className={`status ${line.status}`}>{displayStatus(line.status)}</i></div>;
  return <Tooltip label={label}><div className="repository-line-summary" tabIndex={0} aria-label={label}><GitBranch size={13} /><span>{line.branch}</span><code>{short(sha)}</code><i className={`status ${line.status}`}>{displayStatus(line.status)}</i></div></Tooltip>;
}

function RepositoryLinesMenu({ lines, mobile = false }: { lines: RepositoryLineRecord[]; mobile?: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuLabel = mobile ? '全部仓库线' : '其余仓库线';
  return <div className={`repository-lines-menu${mobile ? ' mobile' : ''}`}>
    <button ref={triggerRef} type="button" aria-haspopup="menu" aria-expanded={open} aria-label={mobile ? `查看全部仓库线，共 ${lines.length} 条` : `查看其余 ${lines.length} 条仓库线`} onClick={() => setOpen((value) => !value)}>{mobile ? `${lines.length} 条` : `+${lines.length} 条仓库线`}</button>
    <ToolbarMenu open={open} label={menuLabel} triggerRef={triggerRef} onClose={() => setOpen(false)}>{lines.map((line) => <RepositoryLine key={line.id} line={line} menu />)}</ToolbarMenu>
  </div>;
}

function BranchSelect({ projectId, selection, onChange }: { projectId: string; selection?: Selection; onChange: (value: string) => void }) {
  const query = useQuery({ queryKey: ['repository-branches', projectId, selection?.connection_id], queryFn: () => api<RepositoryBranchCatalog>(`/projects/${projectId}/repository-branches?connection_id=${selection?.connection_id}`), enabled: Boolean(selection?.connection_id) });
  useEffect(() => { if (query.data && !query.data.branches.some((item) => item.name === selection?.base_ref)) onChange(query.data.default_branch); }, [onChange, query.data, selection?.base_ref]);
  return <label>基准分支<select value={selection?.base_ref || ''} onChange={(event) => onChange(event.target.value)}>{query.data?.branches.map((item) => <option key={item.full_ref} value={item.name}>{item.name} · {short(item.sha)}</option>) || <option value={selection?.base_ref || 'main'}>{selection?.base_ref || 'main'}</option>}</select></label>;
}

function repositoryStreams(bundle: ProjectBundle) { const tasks = bundle.nodes.filter((item) => item.role === 'task' && ['code', 'test', 'integration', 'deploy'].includes(item.task_kind || '')); const ids = new Set(tasks.map((item) => item.parent_node_id)); return bundle.nodes.filter((item) => item.role === 'workstream' && ids.has(item.id)); }
function latestTasks(items: TaskExecutionRecord[]) { const map = new Map<string, TaskExecutionRecord>(); for (const item of items) if (!map.has(item.task_id) || Number(map.get(item.task_id)?.attempt) < item.attempt) map.set(item.task_id, item); return [...map.values()]; }
function statusLabel(value: string) { return ({ running: '任务流程运行中', paused: '任务流程已暂停', completed: '任务流程已完成', cancelled: '任务流程已取消', failed: '任务流程失败' } as Record<string, string>)[value] || '任务流程状态未知'; }
function actionLabel(value: string) { return ({ pause: '暂停', resume: '继续', cancel: '取消' } as Record<string, string>)[value] || '控制'; }
function short(value?: string | null) { return value ? value.slice(0, 10) : '待绑定'; }
