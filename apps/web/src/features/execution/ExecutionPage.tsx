import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CirclePause, CirclePlay, GitBranch, LoaderCircle, Plus, RefreshCw, RotateCcw,
  ShieldCheck, Square, XCircle
} from 'lucide-react';
import { ApiError, apiV2, formatTime, mutateV2, shortHash } from '../../api';
import type { WorkspacePageProps } from '../../workspace';
import { ExecutionEvidencePanel, ExecutionOutcomePanel, ExecutionQualityPanel } from './ExecutionP7Panels';
import { DeliveryPage } from '../delivery';

const STAGES = ['prepare', 'context', 'run', 'check', 'review', 'finalize', 'deliver'] as const;

type RunnerProfile = { id: string; label: string; runner_type: string; status: string; revision: number };
type Execution = {
  id: string; project_id: string; status: string; current_stage: string; generation: number; revision: number;
  workflow_id?: string; workflow_revision: number; workflow_hash: string; context_pack_hash: string; runner_profile_id: string;
  task_count: number; dependency_edge_count: number; error_code: string; created_at: string; updated_at: string;
  handoff_manifest?: { delivery_ready?: boolean; receipts?: unknown[] };
};
type Attempt = { id: string; task_id: string; attempt_no: number; execution_mode: string; status: string; runner_profile_id: string; stdout_sha256: string; output_sha256: string; error_code: string; updated_at: string };
type Checkpoint = { id: string; generation: number; stage: string; stage_ordinal: number; checkpoint_sha256: string; checkpoint_token: string; workspace_sha256: string; pins_sha256: string; created_at: string };
type ExecutionEvent = { id: string; sequence: number; type: string; occurred_at: string; data?: { stage?: string; error_code?: string } };

export function ExecutionPage({ projectId, selectedProject, notify, navigate }: WorkspacePageProps) {
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

  const selectedProfile = useMemo(() => profiles.find((profile) => profile.id === profileId) || null, [profileId, profiles]);
  useEffect(() => { setSelectedId(''); setDetail(null); setAttempts([]); setCheckpoints([]); setEvents([]); }, [projectId]);

  const loadList = useCallback(async () => {
    if (!projectId) { setExecutions([]); setSelectedId(''); return; }
    const [executionResult, profileResult] = await Promise.all([
      apiV2<{ executions: Execution[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/executions`),
      apiV2<{ profiles: RunnerProfile[] }>('/api/v2/runners/profiles')
    ]);
    const rows = executionResult.data.executions || []; const runners = profileResult.data.profiles || [];
    setExecutions(rows); setProfiles(runners);
    setSelectedId((current) => rows.some((item) => item.id === current) ? current : rows[0]?.id || '');
    setProfileId((current) => runners.some((item) => item.id === current && item.status === 'ready') ? current : runners.find((item) => item.status === 'ready')?.id || '');
  }, [projectId]);

  const loadDetail = useCallback(async (id = selectedId) => {
    if (!id) { setDetail(null); setAttempts([]); setCheckpoints([]); setEvents([]); return; }
    const [executionResult, attemptResult, checkpointResult, eventResult] = await Promise.all([
      apiV2<{ execution: Execution }>(`/api/v2/executions/${encodeURIComponent(id)}`),
      apiV2<{ attempts: Attempt[] }>(`/api/v2/executions/${encodeURIComponent(id)}/attempts`),
      apiV2<{ checkpoints: Checkpoint[] }>(`/api/v2/executions/${encodeURIComponent(id)}/checkpoints`),
      apiV2<{ events: ExecutionEvent[] }>(`/api/v2/executions/${encodeURIComponent(id)}/events?cursor=0&limit=500`)
    ]);
    setDetail(executionResult.data.execution); setAttempts(attemptResult.data.attempts || []); setCheckpoints(checkpointResult.data.checkpoints || []);
    setEvents((current) => mergeEvents(current, eventResult.data.events || [], id === selectedId)); setFault('');
  }, [selectedId]);

  useEffect(() => { void loadList().catch((error) => handleFault(error, setFault, notify)); }, [loadList, notify]);
  useEffect(() => { setEvents([]); void loadDetail(selectedId).catch((error) => handleFault(error, setFault, notify)); }, [loadDetail, notify, selectedId]);
  useEffect(() => {
    if (!detail || !['queued', 'running', 'pause_requested'].includes(detail.status)) return;
    const timer = setInterval(() => void Promise.all([loadList(), loadDetail(detail.id)]).catch((error) => handleFault(error, setFault, notify)), 1500);
    return () => clearInterval(timer);
  }, [detail, loadDetail, loadList, notify]);

  const refresh = async () => { setBusy('refresh'); try { await loadList(); await loadDetail(); } catch (error) { handleFault(error, setFault, notify); } finally { setBusy(''); } };
  const createExecution = async () => {
    if (!projectId || !selectedProfile) return;
    setBusy('create');
    try {
      const result = await mutateV2<{ execution: Execution }>(`/api/v2/projects/${encodeURIComponent(projectId)}/executions`, { runner_profile_id: selectedProfile.id }, 'POST', selectedProject?.revision ?? 0);
      setSelectedId(result.data.execution.id); await loadList(); notify('Execution created');
    } catch (error) { handleFault(error, setFault, notify); } finally { setBusy(''); }
  };

  const mutateExecution = async (action: 'start' | 'pause' | 'resume' | 'cancel' | 'replan') => {
    if (!detail) return; setBusy(action);
    try {
      const result = await mutateV2<{ execution?: Execution }>(`/api/v2/executions/${encodeURIComponent(detail.id)}/${action}`, {}, 'POST', detail.revision);
      if (result.data.execution?.id && result.data.execution.id !== detail.id) setSelectedId(result.data.execution.id);
      await new Promise((resolve) => setTimeout(resolve, 25)); await Promise.all([loadList(), loadDetail(result.data.execution?.id || detail.id)]); notify(`Execution ${action} accepted`);
    } catch (error) { handleFault(error, setFault, notify); } finally { setBusy(''); }
  };

  const replay = async (checkpoint: Checkpoint) => {
    if (!detail) return; setBusy(`replay:${checkpoint.id}`);
    try {
      await mutateV2(`/api/v2/executions/${encodeURIComponent(detail.id)}/stages/${checkpoint.stage}/replay`, {
        generation: checkpoint.generation, checkpoint_token: checkpoint.checkpoint_token,
        workspace_hash: checkpoint.workspace_sha256, pins_hash: checkpoint.pins_sha256
      }, 'POST', detail.revision);
      await new Promise((resolve) => setTimeout(resolve, 25)); await Promise.all([loadList(), loadDetail(detail.id)]); notify(`${checkpoint.stage} replay accepted`);
    } catch (error) { handleFault(error, setFault, notify); } finally { setBusy(''); }
  };

  if (!projectId) return <div className="empty-state"><CirclePlay size={26} /><h2>No project selected</h2></div>;
  const activeStage = Math.max(0, STAGES.indexOf((detail?.current_stage || 'prepare') as typeof STAGES[number]));

  return <div className="page execution-page-p6">
    <div className="page-heading">
      <div><p className="eyebrow">Runner operations</p><h1>Execution</h1></div>
      <div className="execution-heading-actions"><button className="icon-button" title="Refresh Execution" aria-label="Refresh Execution" onClick={() => void refresh()}>{busy === 'refresh' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button><button className="button primary" disabled={!selectedProfile || Boolean(busy)} onClick={() => void createExecution()}>{busy === 'create' ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}New execution</button></div>
    </div>
    <div className="execution-commandbar">
      <label><span>Runner profile</span><select aria-label="Runner profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}><option value="">No ready profile</option>{profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={profile.status !== 'ready'}>{profile.label} · {profile.runner_type} · {profile.status}</option>)}</select></label>
      <div className="execution-controls">
        <button className="icon-button" title="Start Execution" aria-label="Start Execution" disabled={!detail || detail.status !== 'draft' || Boolean(busy)} onClick={() => void mutateExecution('start')}><CirclePlay size={16} /></button>
        <button className="icon-button" title="Pause Execution" aria-label="Pause Execution" disabled={!detail || !['queued', 'running'].includes(detail.status) || Boolean(busy)} onClick={() => void mutateExecution('pause')}><CirclePause size={16} /></button>
        <button className="icon-button" title="Resume Execution" aria-label="Resume Execution" disabled={!detail || !['paused', 'awaiting_approval'].includes(detail.status) || Boolean(busy)} onClick={() => void mutateExecution('resume')}><RotateCcw size={16} /></button>
        <button className="icon-button danger" title="Cancel Execution" aria-label="Cancel Execution" disabled={!detail || ['completed', 'failed', 'cancelled'].includes(detail.status) || Boolean(busy)} onClick={() => void mutateExecution('cancel')}><Square size={15} /></button>
        <button className="icon-button" title="Replan Execution" aria-label="Replan Execution" disabled={!detail || !['paused', 'failed', 'completed'].includes(detail.status) || Boolean(busy)} onClick={() => void mutateExecution('replan')}><GitBranch size={16} /></button>
        {detail?.status === 'awaiting_approval' && <button className="button" onClick={() => navigate('approvals')}><ShieldCheck size={15} />Approval</button>}
      </div>
    </div>
    {fault && <div className="execution-fault" role="alert"><XCircle size={16} /><span>{fault.replaceAll('_', ' ')}</span></div>}
    <div className="execution-stage-rail" aria-label="Execution stages">
      {STAGES.map((stage, index) => <div key={stage} className={detail && (detail.status === 'completed' || index < activeStage) ? 'complete' : index === activeStage && detail?.current_stage ? 'active' : ''}><span>{index + 1}</span><strong>{stage}</strong></div>)}
    </div>
    <div className="execution-view-tabs" role="tablist" aria-label="Execution views">{(['operations', 'evidence', 'quality', 'outcome', 'delivery'] as const).map((view) => <button role="tab" aria-selected={activeView === view} className={activeView === view ? 'active' : ''} key={view} onClick={() => setActiveView(view)}>{view[0].toUpperCase() + view.slice(1)}</button>)}</div>
    {activeView === 'operations' && <div className="execution-p6-layout">
      <section className="panel execution-list-panel"><div className="section-title"><div><h2>Executions</h2><span>{executions.length} revisions</span></div></div><div className="execution-list-p6">{executions.map((item) => <button key={item.id} className={item.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(item.id)}><span><strong>{item.current_stage || 'draft'} · generation {item.generation}</strong><small className="mono">{shortHash(item.id)} | r{item.revision}</small></span><Status value={item.status} /></button>)}{!executions.length && <div className="list-empty">No executions</div>}</div></section>
      <section className="panel execution-detail-panel"><div className="section-title"><div><h2>{detail ? `${detail.current_stage || 'draft'} stage` : 'Execution detail'}</h2><span>{detail ? `Workflow r${detail.workflow_revision} | ${detail.task_count} tasks | updated ${formatTime(detail.updated_at)}` : 'No active revision'}</span></div>{detail && <Status value={detail.status} />}</div>{detail ? <div className="execution-pin-grid"><span><small>Workflow</small><strong className="mono">{shortHash(detail.workflow_hash)}</strong></span><span><small>Context</small><strong className="mono">{shortHash(detail.context_pack_hash)}</strong></span><span><small>Generation</small><strong>{detail.generation}</strong></span><span><small>Delivery</small><strong>{detail.handoff_manifest?.delivery_ready ? 'ready' : 'pending'}</strong></span></div> : <div className="list-empty">No execution selected</div>}</section>
      <section className="panel execution-attempt-panel"><div className="section-title"><div><h2>Task attempts</h2><span>{attempts.length} immutable attempts</span></div></div><div className="attempt-table-p6"><div className="attempt-head"><span>Task</span><span>Mode</span><span>Attempt</span><span>Status</span><span>Receipt</span></div>{attempts.map((attempt) => <div className="attempt-row" key={attempt.id}><span><strong>{attempt.task_id}</strong><small>{attempt.error_code || formatTime(attempt.updated_at)}</small></span><span>{attempt.execution_mode}</span><span>#{attempt.attempt_no}</span><Status value={attempt.status} /><span className="mono">{shortHash(attempt.output_sha256 || attempt.stdout_sha256)}</span></div>)}{!attempts.length && <div className="list-empty">No task attempts</div>}</div></section>
      <section className="panel execution-checkpoint-panel"><div className="section-title"><div><h2>Checkpoints</h2><span>{checkpoints.length} replay boundaries</span></div></div><div className="checkpoint-list-p6">{checkpoints.map((checkpoint) => <div key={checkpoint.id}><span><strong>{checkpoint.stage} · g{checkpoint.generation}</strong><small className="mono">{shortHash(checkpoint.checkpoint_sha256)} | {formatTime(checkpoint.created_at)}</small></span><button className="icon-button" title={`Replay ${checkpoint.stage}`} aria-label={`Replay ${checkpoint.stage}`} disabled={!detail || !['paused', 'awaiting_approval', 'completed', 'failed', 'cancelled'].includes(detail.status) || Boolean(busy)} onClick={() => void replay(checkpoint)}>{busy === `replay:${checkpoint.id}` ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}</button></div>)}{!checkpoints.length && <div className="list-empty">No checkpoints</div>}</div></section>
      <section className="panel execution-event-panel"><div className="section-title"><div><h2>Event stream</h2><span>{events.length} contiguous events</span></div></div><div className="execution-event-list">{events.map((event) => <div key={`${event.id}:${event.sequence}`}><span>{event.sequence}</span><p><strong>{event.type}</strong><small>{event.data?.stage || event.data?.error_code || formatTime(event.occurred_at)}</small></p></div>)}{!events.length && <div className="list-empty">No events</div>}</div></section>
    </div>}
    {activeView === 'evidence' && detail && <ExecutionEvidencePanel execution={detail} notify={notify} navigate={navigate} />}
    {activeView === 'quality' && detail && <ExecutionQualityPanel execution={detail} notify={notify} />}
    {activeView === 'outcome' && detail && <ExecutionOutcomePanel execution={detail} notify={notify} />}
    {activeView === 'delivery' && <DeliveryPage projectId={projectId} selectedProject={selectedProject} notify={notify} navigate={navigate} selectProject={() => undefined} refreshProjects={async () => undefined} setupReady refreshSetup={async () => undefined} />}
    {activeView !== 'operations' && !detail && <div className="list-empty">No execution selected</div>}
  </div>;
}

function Status({ value }: { value: string }) { const tone = ['completed', 'succeeded', 'ready'].includes(value) ? 'positive' : ['queued', 'running', 'pause_requested', 'awaiting_approval', 'leased'].includes(value) ? 'working' : ['failed', 'cancelled', 'expired', 'external_result_unknown'].includes(value) ? 'negative' : 'neutral'; return <span className={`status ${tone}`}><span />{value.replaceAll('_', ' ')}</span>; }
function mergeEvents(current: ExecutionEvent[], incoming: ExecutionEvent[], sameExecution: boolean) { const values = sameExecution ? [...current, ...incoming] : incoming; return [...new Map(values.map((event) => [event.sequence, event])).values()].sort((left, right) => left.sequence - right.sequence); }
function handleFault(error: unknown, setFault: (value: string) => void, notify: WorkspacePageProps['notify']) { const code = error instanceof ApiError ? error.code : 'execution_request_failed'; setFault(code); notify(error instanceof Error ? error.message : 'Execution request failed', 'error'); }
