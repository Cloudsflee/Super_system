import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CirclePause, CirclePlay, GitBranch, LoaderCircle, Plus, RefreshCw, RotateCcw,
  ShieldCheck, Square, XCircle
} from 'lucide-react';
import { ApiError, apiV2, formatTime, mutateV2, shortHash, useWorkbenchOnline, projectDeepLink } from '../../api';
import type { WorkspacePageProps } from '../../workspace';
import { queryClient, workspaceQueryKey } from '../../query';
import { ExecutionEvidencePanel, ExecutionOutcomePanel, ExecutionQualityPanel } from './ExecutionP7Panels';
import { DeliveryPage } from '../delivery';
import { actionLabel, errorCodeLabel, modeLabel, stageLabel, statusLabel } from '../../i18n';

type ContextPack = { id: string; status: string; pack_hash: string };

const STAGES = ['prepare', 'context', 'run', 'check', 'review', 'finalize', 'deliver'] as const;

export type RunnerProfile = { id: string; label: string; runner_type: string; status: string; revision: number };
type Execution = {
  id: string; project_id: string; status: string; current_stage: string; generation: number; revision: number;
  workflow_id?: string; workflow_revision: number; workflow_hash: string; context_pack_hash: string; runner_profile_id: string;
  task_count: number; dependency_edge_count: number; error_code: string; created_at: string; updated_at: string;
  handoff_manifest?: { delivery_ready?: boolean; receipts?: unknown[] };
};
type Attempt = { id: string; task_id: string; attempt_no: number; execution_mode: string; status: string; runner_profile_id: string; stdout_sha256: string; output_sha256: string; error_code: string; updated_at: string };
type Checkpoint = { id: string; generation: number; stage: string; stage_ordinal: number; checkpoint_sha256: string; checkpoint_token: string; workspace_sha256: string; pins_sha256: string; created_at: string };
type ExecutionEvent = { id: string; sequence: number; type: string; occurred_at: string; data?: { stage?: string; error_code?: string } };

export function ExecutionPage(props: WorkspacePageProps) {
  return <ExecutionWorkspace key={props.projectId} {...props} />;
}
function ExecutionWorkspace({ projectId, selectedProject, notify, navigate }: WorkspacePageProps) {
  const online = useWorkbenchOnline();
  const [queryId, setQueryId] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] || '').get('execution_id') || '');
  const currentSelection = useRef('');
  const listSequence = useRef(0); const detailSequence = useRef(0);
  const resultRef = useRef<HTMLDivElement>(null); const [resultMessage, setResultMessage] = useState('');
  const announcedLink = useRef('');
  useEffect(() => { const update = () => setQueryId(new URLSearchParams(window.location.hash.split('?')[1] || '').get('execution_id') || ''); window.addEventListener('hashchange', update); return () => { window.removeEventListener('hashchange', update); listSequence.current++; detailSequence.current++; }; }, []);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [profiles, setProfiles] = useState<RunnerProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<Execution | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [busy, setBusy] = useState('');
  const [fault, setFault] = useState('');
  const [activeView, setActiveView] = useState<'operations' | 'evidence' | 'quality' | 'outcome' | 'delivery'>('operations');

  currentSelection.current = selectedId;
  const selectedProfile = useMemo(() => profiles.find((profile) => profile.id === profileId) || null, [profileId, profiles]);
  useEffect(() => { setSelectedId(''); setDetail(null); setAttempts([]); setCheckpoints([]); setEvents([]); }, [projectId]);

  const loadList = useCallback(async () => {
    if (!projectId) { setExecutions([]); setSelectedId(''); return; }
    const sequence = ++listSequence.current;
    const [executionResult, profileResult] = await Promise.all([
      apiV2<{ executions: Execution[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/executions`),
      apiV2<{ profiles: RunnerProfile[] }>('/api/v2/runners/profiles')
    ]);
    if (sequence !== listSequence.current) return;
    const rows = executionResult.data.executions || []; const runners = profileResult.data.profiles || [];
    setExecutions(rows); setProfiles(runners);
    setSelectedId((current) => rows.some((item) => item.id === current) ? current : rows.some(item => item.id === queryId) ? queryId : rows[0]?.id || '');
    setProfileId((current) => runners.some((item) => item.id === current && item.status === 'ready') ? current : runners.find((item) => item.status === 'ready')?.id || '');
  }, [projectId, queryId]);
  useEffect(() => { if (queryId && executions.some(item => item.id === queryId)) setSelectedId(queryId); }, [queryId]);

  const loadDetail = useCallback(async (id = selectedId) => {
    if (!id) { setDetail(null); setAttempts([]); setCheckpoints([]); setEvents([]); return; }
    const sequence = ++detailSequence.current;
    const [executionResult, attemptResult, checkpointResult, eventResult] = await queryClient.fetchQuery({
      queryKey: workspaceQueryKey({ actorId: sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor', teamId: '', projectId }, 'execution', { id }),
      queryFn: ({ signal }) => Promise.all([
        apiV2<{ execution: Execution }>(`/api/v2/executions/${encodeURIComponent(id)}`, { signal }),
        apiV2<{ attempts: Attempt[] }>(`/api/v2/executions/${encodeURIComponent(id)}/attempts`, { signal }),
        apiV2<{ checkpoints: Checkpoint[] }>(`/api/v2/executions/${encodeURIComponent(id)}/checkpoints`, { signal }),
        apiV2<{ events: ExecutionEvent[] }>(`/api/v2/executions/${encodeURIComponent(id)}/events?cursor=0&limit=500`, { signal })
      ] as const)
    });
    if (sequence !== detailSequence.current || id !== currentSelection.current) return;
    if (executionResult.data.execution.project_id !== projectId) throw new Error('execution_project_mismatch');
    setExecutions(current => current.map(item => item.id === id ? executionResult.data.execution : item));
    setDetail(executionResult.data.execution); setAttempts(attemptResult.data.attempts || []); setCheckpoints(checkpointResult.data.checkpoints || []);
    setEvents((current) => mergeEvents(current, eventResult.data.events || [], id === selectedId)); setFault('');
  }, [selectedId, projectId]);

  useEffect(() => { void loadList().catch((error) => handleFault(error, setFault, notify)); }, [loadList, notify]);
  useEffect(() => { setEvents([]); setDetail(null); setAttempts([]); setCheckpoints([]); void loadDetail(selectedId).catch((error) => handleFault(error, setFault, notify)); }, [loadDetail, notify, selectedId]);
  useEffect(() => {
    if (!online || !detail || !['queued', 'running', 'pause_requested'].includes(detail.status)) return;
    const timer = setInterval(() => void loadDetail(detail.id).catch((error) => handleFault(error, setFault, notify)), 1500);
    return () => clearInterval(timer);
  }, [detail?.id, detail?.status, loadDetail, notify, online]);

  useEffect(() => queryClient.getQueryCache().subscribe(event => {
    if (!online || event.type !== 'updated' || event.action.type !== 'invalidate' || event.query.queryKey[3] !== projectId || event.query.queryKey[4] !== 'execution') return;
    void loadDetail().catch(error => handleFault(error, setFault, notify));
  }), [loadDetail, notify, online, projectId]);
  useEffect(() => { if (fault || resultMessage) resultRef.current?.focus(); }, [fault, resultMessage]);
  useEffect(() => {
    if (queryId && detail?.id === queryId && announcedLink.current !== queryId) {
      announcedLink.current = queryId;
      setResultMessage(`已选择执行 ${queryId} · ${statusLabel(detail.status)}`);
    }
  }, [detail?.id, queryId]);
  const refresh = async () => { setBusy('refresh'); try { await loadList(); await loadDetail(); } catch (error) { handleFault(error, setFault, notify); } finally { setBusy(''); } };
  const createExecution = async () => {
    if (!online || !projectId || !selectedProfile || selectedProfile.status !== 'ready') return;
    setBusy('create');
    try {
      const result = await mutateV2<{ execution: Execution }>(`/api/v2/projects/${encodeURIComponent(projectId)}/executions`, { runner_profile_id: selectedProfile.id }, 'POST', selectedProject?.revision ?? 0);
      setSelectedId(result.data.execution.id); await loadList(); setResultMessage('执行已创建'); notify('执行已创建');
    } catch (error) { handleFault(error, setFault, notify); } finally { setBusy(''); }
  };

  const mutateExecution = async (action: 'start' | 'pause' | 'resume' | 'cancel' | 'replan') => {
    if (!online || !detail) return; setBusy(action);
    try {
      const result = await mutateV2<{ execution?: Execution }>(`/api/v2/executions/${encodeURIComponent(detail.id)}/${action}`, {}, 'POST', detail.revision);
      if (result.data.execution?.id && result.data.execution.id !== detail.id) setSelectedId(result.data.execution.id);
      await new Promise((resolve) => setTimeout(resolve, 25)); await Promise.all([loadList(), loadDetail(result.data.execution?.id || detail.id)]); setResultMessage(`执行${actionLabel(action)}已接受`); notify(`执行${actionLabel(action)}已接受`);
    } catch (error) { handleFault(error, setFault, notify); } finally { setBusy(''); }
  };

  const replay = async (checkpoint: Checkpoint) => {
    if (!online || !detail) return; setBusy(`replay:${checkpoint.id}`);
    try {
      await mutateV2(`/api/v2/executions/${encodeURIComponent(detail.id)}/stages/${checkpoint.stage}/replay`, {
        generation: checkpoint.generation, checkpoint_token: checkpoint.checkpoint_token,
        workspace_hash: checkpoint.workspace_sha256, pins_hash: checkpoint.pins_sha256
      }, 'POST', detail.revision);
      await new Promise((resolve) => setTimeout(resolve, 25)); await Promise.all([loadList(), loadDetail(detail.id)]); setResultMessage(`${stageLabel(checkpoint.stage)}重放已接受`); notify(`${stageLabel(checkpoint.stage)}重放已接受`);
    } catch (error) { handleFault(error, setFault, notify); } finally { setBusy(''); }
  };

  if (!projectId) return <div className="empty-state"><CirclePlay size={26} /><h2>未选择项目</h2></div>;
  const activeStage = Math.max(0, STAGES.indexOf((detail?.current_stage || 'prepare') as typeof STAGES[number]));

  return <div className="page execution-page-p6">
    <div className="page-heading">
      <div><p className="eyebrow">Runner 操作</p><h1>执行</h1></div>
      <div className="execution-heading-actions"><button className="icon-button" title="刷新执行" aria-label="刷新执行" onClick={() => void refresh()}>{busy === 'refresh' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button><button className="button primary" disabled={!online || !selectedProfile || selectedProfile.status !== 'ready' || Boolean(busy)} onClick={() => void createExecution()}>{busy === 'create' ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}新建执行</button></div>
    </div>
    <div className="execution-commandbar">
      <label><span>Runner Profile</span><select aria-label="Runner Profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}><option value="">没有就绪的 Profile</option>{profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={profile.status !== 'ready'}>{profile.label} · {profile.runner_type} · {statusLabel(profile.status)}</option>)}</select></label>
      <div className="execution-controls">
        <button className="icon-button" title="开始执行" aria-label="开始执行" disabled={!online || !detail || detail.status !== 'draft' || Boolean(busy)} onClick={() => void mutateExecution('start')}><CirclePlay size={16} /></button>
        <button className="icon-button" title="暂停执行" aria-label="暂停执行" disabled={!online || !detail || !['queued', 'running'].includes(detail.status) || Boolean(busy)} onClick={() => void mutateExecution('pause')}><CirclePause size={16} /></button>
        <button className="icon-button" title="继续执行" aria-label="继续执行" disabled={!online || !detail || !['paused', 'awaiting_approval'].includes(detail.status) || Boolean(busy)} onClick={() => void mutateExecution('resume')}><RotateCcw size={16} /></button>
        <button className="icon-button danger" title="取消执行" aria-label="取消执行" disabled={!online || !detail || ['completed', 'failed', 'cancelled'].includes(detail.status) || Boolean(busy)} onClick={() => void mutateExecution('cancel')}><Square size={15} /></button>
        <button className="icon-button" title="重新规划执行" aria-label="重新规划执行" disabled={!online || !detail || !['paused', 'failed', 'completed'].includes(detail.status) || Boolean(busy)} onClick={() => void mutateExecution('replan')}><GitBranch size={16} /></button>
        {detail?.status === 'awaiting_approval' && <button className="button" onClick={() => navigate('approvals')}><ShieldCheck size={15} />审批</button>}
      </div>
    </div>
    {!online && <p role="status">恢复连接后可用</p>}
    {!profiles.some(profile => profile.status === 'ready') && <div role="status">没有就绪的 Runner Profile。<button className="button" onClick={() => navigate('runner')}>前往 Runner 设置</button></div>}
    <div ref={resultRef} tabIndex={-1} role={fault ? 'alert' : 'status'}>{resultMessage}</div>
    {fault && <div className="execution-fault" role="alert"><XCircle size={16} /><span>{errorCodeLabel(fault)}</span></div>}
    <div className="execution-stage-rail" aria-label="执行阶段">
      {STAGES.map((stage, index) => <div key={stage} className={detail && (detail.status === 'completed' || index < activeStage) ? 'complete' : index === activeStage && detail?.current_stage ? 'active' : ''}><span>{index + 1}</span><strong>{stageLabel(stage)}</strong></div>)}
    </div>
    <div className="execution-view-tabs" role="tablist" aria-label="执行视图">{(['operations', 'evidence', 'quality', 'outcome', 'delivery'] as const).map((view) => <button role="tab" aria-selected={activeView === view} className={activeView === view ? 'active' : ''} key={view} onClick={() => setActiveView(view)}>{{ operations: '操作', evidence: '证据', quality: '质量', outcome: '结果', delivery: '交付' }[view]}</button>)}</div>
    {activeView === 'operations' && <div className="execution-p6-layout">
      <section className="panel execution-list-panel"><div className="section-title"><div><h2>执行记录</h2><span>{executions.length} 个修订</span></div></div><div className="execution-list-p6">{executions.map((item) => <button key={item.id} className={item.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(item.id)}><span><strong>{stageLabel(item.current_stage || 'draft')} · 第 {item.generation} 代</strong><small className="mono">{shortHash(item.id)} | r{item.revision}</small></span><Status value={item.status} /></button>)}{!executions.length && <div className="list-empty">暂无执行记录</div>}</div></section>
      <section className="panel execution-detail-panel"><div className="section-title"><div><h2>{detail ? `${stageLabel(detail.current_stage || 'draft')}阶段` : '执行详情'}</h2><span>{detail ? `Workflow r${detail.workflow_revision} | ${detail.task_count} 个任务 | 更新于 ${formatTime(detail.updated_at)}` : '暂无活动修订'}</span></div>{detail && <Status value={detail.status} />}</div>{detail ? <div className="execution-pin-grid"><span><small>Workflow</small><strong className="mono">{shortHash(detail.workflow_hash)}</strong></span><span><small>上下文</small><strong className="mono">{shortHash(detail.context_pack_hash)}</strong></span><span><small>代数</small><strong>{detail.generation}</strong></span><span><small>交付</small><strong>{detail.handoff_manifest?.delivery_ready ? '就绪' : '待处理'}</strong></span></div> : <div className="list-empty">未选择执行</div>}</section>
      <section className="panel execution-attempt-panel"><div className="section-title"><div><h2>任务尝试</h2><span>{attempts.length} 次不可变尝试</span></div></div><div className="attempt-table-p6"><div className="attempt-head"><span>任务</span><span>模式</span><span>尝试</span><span>状态</span><span>回执</span></div>{attempts.map((attempt) => <div className="attempt-row" key={attempt.id}><span><strong>{attempt.task_id}</strong><small>{attempt.error_code ? errorCodeLabel(attempt.error_code) : formatTime(attempt.updated_at)}</small></span><span>{modeLabel(attempt.execution_mode)}</span><span>#{attempt.attempt_no}</span><Status value={attempt.status} /><span className="mono">{shortHash(attempt.output_sha256 || attempt.stdout_sha256)}</span></div>)}{!attempts.length && <div className="list-empty">暂无任务尝试</div>}</div></section>
      <section className="panel execution-checkpoint-panel"><div className="section-title"><div><h2>检查点</h2><span>{checkpoints.length} 个重放边界</span></div></div><div className="checkpoint-list-p6">{checkpoints.map((checkpoint) => <div key={checkpoint.id}><span><strong>{stageLabel(checkpoint.stage)} · 第 {checkpoint.generation} 代</strong><small className="mono">{shortHash(checkpoint.checkpoint_sha256)} | {formatTime(checkpoint.created_at)}</small></span><button className="icon-button" title={`重放${stageLabel(checkpoint.stage)}`} aria-label={`重放${stageLabel(checkpoint.stage)}`} disabled={!online || !detail || !['paused', 'awaiting_approval', 'completed', 'failed', 'cancelled'].includes(detail.status) || Boolean(busy)} onClick={() => void replay(checkpoint)}>{busy === `replay:${checkpoint.id}` ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}</button></div>)}{!checkpoints.length && <div className="list-empty">暂无检查点</div>}</div></section>
      <section className="panel execution-event-panel"><div className="section-title"><div><h2>事件流</h2><span>{events.length} 个连续事件</span></div></div><div className="execution-event-list">{events.map((event) => <div key={`${event.id}:${event.sequence}`}><span>{event.sequence}</span><p><strong>{event.type}</strong><small>{stageLabel(event.data?.stage || '') || event.data?.error_code || formatTime(event.occurred_at)}</small></p></div>)}{!events.length && <div className="list-empty">暂无事件</div>}</div></section>
    </div>}
    {activeView === 'evidence' && detail && <ExecutionEvidencePanel execution={detail} notify={notify} navigate={navigate} />}
    {activeView === 'quality' && detail && <ExecutionQualityPanel execution={detail} notify={notify} />}
    {activeView === 'outcome' && detail && <ExecutionOutcomePanel execution={detail} notify={notify} />}
    {activeView === 'delivery' && <DeliveryPage projectId={projectId} selectedProject={selectedProject} notify={notify} navigate={navigate} selectProject={() => undefined} refreshProjects={async () => undefined} setupReady refreshSetup={async () => undefined} />}
    {activeView !== 'operations' && !detail && <div className="list-empty">未选择执行</div>}
  </div>;
}

function Status({ value }: { value: string }) { const tone = ['completed', 'succeeded', 'ready'].includes(value) ? 'positive' : ['queued', 'running', 'pause_requested', 'awaiting_approval', 'leased'].includes(value) ? 'working' : ['failed', 'cancelled', 'expired', 'external_result_unknown'].includes(value) ? 'negative' : 'neutral'; return <span className={`status ${tone}`}><span />{statusLabel(value)}</span>; }
function mergeEvents(current: ExecutionEvent[], incoming: ExecutionEvent[], sameExecution: boolean) { const values = sameExecution ? [...current, ...incoming] : incoming; return [...new Map(values.map((event) => [event.sequence, event])).values()].sort((left, right) => left.sequence - right.sequence); }
function handleFault(error: unknown, setFault: (value: string) => void, notify: WorkspacePageProps['notify']) { const code = error instanceof ApiError ? error.code : 'execution_request_failed'; setFault(code); notify(error instanceof Error ? error.message : '执行请求失败', 'error'); }

export type ExecutionLaunchState = { phase: 'idle' | 'creating' | 'starting' | 'draft'; execution?: { id: string; revision: number; status?: string } };
export function ExecutionLauncher({ projectId, projectRevision, confirmed, saved, dirty, runners, packs, online, busy, navigate, navigateProject, onResult, onError }: {
  projectId: string; projectRevision: number; confirmed: boolean; saved: boolean; dirty: boolean;
  runners: RunnerProfile[]; packs: ContextPack[]; online: boolean; busy: boolean;
  navigate: WorkspacePageProps['navigate']; navigateProject: WorkspacePageProps['navigateProject'];
  onResult: (message: string, data?: Record<string, unknown>) => void; onError: (error: unknown) => void;
}) {
  const [state, setState] = useState<ExecutionLaunchState>({ phase: 'idle' });
  const [runnerId, setRunnerId] = useState(''); const [packId, setPackId] = useState('');
  const startKey = useRef(''); const createKey = useRef(''); const creatingInput = useRef<{ runner_profile_id: string; context_pack_id: string; revision: number } | null>(null);
  const runner = runners.find(item => item.id === runnerId && item.status === 'ready') || (!runnerId ? runners.find(item => item.status === 'ready') : undefined);
  const pack = packs.find(item => item.id === packId && item.status === 'sealed') || (!packId ? packs.find(item => item.status === 'sealed') : undefined);
  const reasons = [!online && '恢复连接后可用', !confirmed && '请先确认 Brief', !saved && '请先保存 Workflow', dirty && '请先保存或放弃本地修改', !pack && '请先生成 Context Pack', !runner && '需要就绪的 Runner Profile'].filter(Boolean);
  const open = (id: string) => { window.location.hash = projectDeepLink(projectId, 'execution', { execution_id: id }); };
  const start = async (execution: NonNullable<ExecutionLaunchState['execution']>, retry = false) => {
    setState({ phase: 'starting', execution });
    try {
      if (retry) {
        const current = (await apiV2<{ execution: typeof execution }>(`/api/v2/executions/${encodeURIComponent(execution.id)}`)).data.execution;
        if (current.status && current.status !== 'draft') { onResult('执行状态已恢复'); open(execution.id); return; }
        execution = current;
      }
      startKey.current ||= crypto.randomUUID();
      const result = await mutateV2<Record<string, unknown>>(`/api/v2/executions/${encodeURIComponent(execution.id)}/start`, {}, 'POST', { expectedRevision: execution.revision, idempotencyKey: startKey.current });
      onResult('执行已创建并启动', result.data); open(execution.id);
    } catch (error) { setState({ phase: 'draft', execution }); onError(error); }
  };
  const launch = async () => {
    if (reasons.length || !runner || !pack || state.phase !== 'idle') return;
    setState({ phase: 'creating' });
    try {
      // Reuse the create request after an unknown network result to avoid a
      // second Draft Execution. Its pins and revision remain the original ones.
      createKey.current ||= crypto.randomUUID();
      creatingInput.current ||= { runner_profile_id: runner.id, context_pack_id: pack.id, revision: projectRevision };
      const { revision, ...input } = creatingInput.current;
      const result = await mutateV2<{ execution: NonNullable<ExecutionLaunchState['execution']> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/executions`, input, 'POST', { expectedRevision: revision, idempotencyKey: createKey.current });
      if (!result.data.execution?.id || !Number.isInteger(result.data.execution.revision)) throw new Error('execution_receipt_invalid');
      await start(result.data.execution);
    } catch (error) { setState({ phase: 'idle' }); onError(error); }
  };
  return <section className="execution-launcher"><h3>开始执行</h3>
    <label><span>Runner Profile</span><select aria-label="Runner Profile" value={runnerId || runner?.id || ''} onChange={event => setRunnerId(event.target.value)} disabled={state.phase !== 'idle'}><option value="">选择就绪的 Profile</option>{runners.map(item => <option key={item.id} value={item.id} disabled={item.status !== 'ready'}>{item.label} · {item.status}</option>)}</select></label>
    <label><span>Context Pack</span><select aria-label="Context Pack" value={packId || pack?.id || ''} onChange={event => setPackId(event.target.value)} disabled={state.phase !== 'idle'}><option value="">选择已封存的 Pack</option>{packs.filter(item => item.status === 'sealed').map(item => <option key={item.id} value={item.id}>{item.pack_hash || item.id}</option>)}</select></label>
    {reasons.length > 0 && <ul className="prerequisite-note">{reasons.map(reason => <li key={String(reason)}>{reason}</li>)}</ul>}
    {!runner && <button className="button" onClick={() => navigate('runner')}>前往 Runner 设置</button>}
    {!pack && <button className="button" onClick={() => navigateProject ? navigateProject(projectId, 'context') : navigate('context')}>前往上下文</button>}
    <button className="button primary" disabled={busy || state.phase !== 'idle' || reasons.length > 0} onClick={() => void launch()}>创建并开始执行</button>
    {['creating', 'starting'].includes(state.phase) && <p role="status">{state.phase === 'creating' ? '正在创建执行' : '正在启动执行'}</p>}
    {state.phase === 'draft' && state.execution && <div role="alert"><p>Draft Execution {state.execution.id} 已保留。</p><button className="button" disabled={!online || busy} onClick={() => void start(state.execution!, true)}>重新启动</button><button className="button" onClick={() => open(state.execution!.id)}>查看 Draft Execution</button></div>}
  </section>;
}
