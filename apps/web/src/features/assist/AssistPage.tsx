import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Archive, FileText, GitBranch, LoaderCircle, MessageSquare, Pause, Play, Plus, RefreshCw, RotateCcw, Send, Square, Target, Trash2, Undo2 } from 'lucide-react';
import { ApiError, apiV2, mutateOfflineV2, mutateV2, shortHash } from '../../api';
import type { WorkspacePageProps } from '../../workspace';
import { FilesDrawer } from '../files';
import { AssistMarkdown } from './AssistMarkdown';
import { TurnTimeline } from './TurnTimeline';

type Message = { id: string; role: string; kind: string; content: string | null; sequence: number };
type Turn = { id: string; turn_no: number; status: string; revision: number; attempt: number; operation_id: string; error_code?: string | null; messages: Message[] };
type ReviewComment = { id: string; turn_id: string; kind: 'comment' | 'request_changes' | 'resolution'; content: string; relative_path: string; line_number: number | null; created_at: string };
type Reference = { id: string; reference_type: string; reference_id: string; reference_hash?: string | null; created_at: string };
type Goal = { id: string; revision: number; goal: Record<string, unknown>; goal_hash: string };
type Session = { id: string; project_id: string; scope: string; scope_id: string; title?: string; mode?: string; parent_session_id?: string | null; fork_source_turn_id?: string | null; context_pack_id: string; context_pack_hash: string; profile_id: string; provider_thread_id?: string | null; status: string; revision: number; archived_at?: string | null; deleted_at?: string | null; turns?: Turn[]; references?: Reference[]; goal?: Goal | null };
type Pack = { id: string; pack_hash: string; status?: string };
type Profile = { id: string; label: string; provider: string; status: string; revision: number };
type Workspace = { id: string; status: string; revision: number };
type Operation = { id?: string; operation_id: string; status: string; revision: number; error_code?: string | null };
type Replay = { events: Array<{ id: string; sequence: number; type: string; data: Record<string, unknown> }>; next_cursor: string | number; terminal?: boolean };
type TimelineEvent = { sequence?: number; type?: string; method?: string; data?: unknown };

const ACTIVE_OPERATIONS = new Set(['accepted', 'queued', 'running', 'paused']);
const ACTIVE_TURNS = new Set(['queued', 'running', 'awaiting_input']);

export function AssistPage({ projectId, selectedProject, notify, navigate }: WorkspacePageProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [bundle, setBundle] = useState<Session | null>(null);
  const [packId, setPackId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [scope, setScope] = useState<'project' | 'workflow' | 'workstream' | 'task'>('project');
  const [scopeId, setScopeId] = useState('');
  const [message, setMessage] = useState('');
  const [goalText, setGoalText] = useState('');
  const [composerMode, setComposerMode] = useState<'turn' | 'steer'>('turn');
  const [reviewTurnId, setReviewTurnId] = useState('');
  const [reviewText, setReviewText] = useState('');
  const [reviewPath, setReviewPath] = useState('');
  const [reviewLine, setReviewLine] = useState('');
  const [reviewComments, setReviewComments] = useState<ReviewComment[]>([]);
  const [busy, setBusy] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null);
  const [cursor, setCursor] = useState<string | number>(0);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [streamState, setStreamState] = useState<'connected' | 'reconnecting' | 'partial'>('connected');
  const [filesOpen, setFilesOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<'sessions' | 'turns'>('turns');
  const offlineScope = useMemo(() => ({
    actorId: sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor',
    teamId: String((selectedProject as typeof selectedProject & { team_id?: string } | undefined)?.team_id || 'default-team'),
    projectId
  }), [projectId, selectedProject]);

  const loadSessions = useCallback(async () => {
    if (!projectId) { setSessions([]); setSelectedId(''); return; }
    const result = await apiV2<{ sessions: Session[] }>(`/api/v2/assist/sessions?project_id=${encodeURIComponent(projectId)}&include_deleted=true`); const rows = result.data.sessions || []; setSessions(rows); setSelectedId((current) => rows.some((row) => row.id === current) ? current : rows[0]?.id || '');
  }, [projectId]);
  const loadPrerequisites = useCallback(async () => {
    if (!projectId) { setPacks([]); setProfiles([]); setWorkspaces([]); return; }
    const [packResult, profileResult, workspaceResult] = await Promise.all([
      apiV2<{ packs: Pack[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/context/packs`),
      apiV2<{ profiles: Profile[] }>('/api/v2/profiles'),
      apiV2<{ workspaces: Workspace[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/repository-workspaces`)
    ]);
    const nextPacks = packResult.data.packs || []; const nextProfiles = (profileResult.data.profiles || []).filter((profile) => profile.provider === 'codex'); const nextWorkspaces = workspaceResult.data.workspaces || [];
    setPacks(nextPacks); setProfiles(nextProfiles); setWorkspaces(nextWorkspaces); setPackId((current) => nextPacks.some((pack) => pack.id === current) ? current : nextPacks[0]?.id || ''); setProfileId((current) => nextProfiles.some((profile) => profile.id === current) ? current : nextProfiles.find((profile) => profile.status === 'available')?.id || nextProfiles[0]?.id || ''); setWorkspaceId((current) => nextWorkspaces.some((workspace) => workspace.id === current) ? current : nextWorkspaces.find((workspace) => ['ready', 'released'].includes(workspace.status))?.id || '');
  }, [projectId]);
  const loadBundle = useCallback(async () => {
    if (!selectedId) { setBundle(null); return; }
    const result = await apiV2<Session>(`/api/v2/assist/sessions/${encodeURIComponent(selectedId)}`); setBundle(result.data); const objective = result.data.goal?.goal?.objective; setGoalText(typeof objective === 'string' ? objective : '');
  }, [selectedId]);
  const refresh = useCallback(async () => { await Promise.all([loadSessions(), loadPrerequisites(), loadBundle()]); }, [loadBundle, loadPrerequisites, loadSessions]);

  useEffect(() => { setScopeId(projectId); setSelectedId(''); setBundle(null); setTimelineEvents([]); setCursor(0); void Promise.all([loadSessions(), loadPrerequisites()]); }, [loadPrerequisites, loadSessions, projectId]);
  useEffect(() => { setFilesOpen(false); setReviewTurnId(''); }, [projectId]);
  useEffect(() => { setCursor(0); setTimelineEvents([]); void loadBundle(); }, [loadBundle]);
  useEffect(() => {
    if (!operation || !ACTIVE_OPERATIONS.has(operation.status)) return;
    const timer = setInterval(() => void apiV2<Operation>(`/api/v2/operations/${encodeURIComponent(operation.operation_id || operation.id || '')}`).then((result) => { setOperation(result.data); if (!ACTIVE_OPERATIONS.has(result.data.status)) void refresh(); }).catch(() => setStreamState('reconnecting')), 500);
    return () => clearInterval(timer);
  }, [operation, refresh]);
  useEffect(() => {
    if (!selectedId) return;
    const poll = async () => {
      try {
        const result = await apiV2<Replay>(`/api/v2/assist/sessions/${encodeURIComponent(selectedId)}/events?cursor=${encodeURIComponent(String(cursor))}&limit=200`); const replay = result.data;
        if (replay.events?.length) {
          setCursor(replay.next_cursor);
          setTimelineEvents((current) => [...new Map([...current, ...replay.events].map((event) => [event.sequence, event])).values()].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0)));
          setStreamState(replay.events.some((event) => event.type.includes('message')) ? 'partial' : 'connected');
          await loadBundle();
        }
        else setStreamState('connected');
      } catch { setStreamState('reconnecting'); }
    };
    const timer = setInterval(() => void poll(), 1200); void poll(); return () => clearInterval(timer);
  }, [cursor, loadBundle, selectedId]);
  useEffect(() => {
    if (!reviewTurnId) { setReviewComments([]); return; }
    void apiV2<{ comments: ReviewComment[] }>(`/api/v2/assist/turns/${encodeURIComponent(reviewTurnId)}/review-comments`).then((result) => setReviewComments(result.data.comments || [])).catch((error) => void handleError(error, 'Review comments failed'));
  }, [reviewTurnId]);

  const handleError = async (error: unknown, fallback: string) => { if (error instanceof ApiError && error.code === 'revision_conflict') await refresh().catch(() => undefined); notify(error instanceof Error ? error.message : fallback, 'error'); };
  const createSession = async () => {
    if (!packId || !profileId) return notify('Assist requires a sealed Context Pack and available provider profile.', 'error'); setBusy('session');
    try {
      const result = await mutateV2<{ session: Session }>('/api/v2/assist/sessions', { project_id: projectId, scope, scope_id: scopeId || projectId, context_pack_id: packId, profile_id: profileId, ...(workspaceId ? { repository_workspace_id: workspaceId } : {}) }, 'POST', 0);
      await loadSessions(); setSelectedId(result.data.session.id); setMobileTab('turns'); notify('Assist session created');
    } catch (error) { await handleError(error, 'Assist session failed'); } finally { setBusy(''); }
  };
  const submitMessage = async (event: FormEvent) => {
    event.preventDefault(); if (!bundle || !message.trim()) return; setBusy('message');
    try {
      const latest = [...(bundle.turns || [])].reverse().find((turn) => ACTIVE_TURNS.has(turn.status));
      if (composerMode === 'steer' && latest) await mutateV2(`/api/v2/assist/turns/${encodeURIComponent(latest.id)}/steer`, { message: message.trim() }, 'POST', latest.revision);
      else { const result = await mutateV2<Operation>(`/api/v2/assist/sessions/${encodeURIComponent(bundle.id)}/turns`, { message: normalizeAssistMessage(message), goal: goalText.trim() ? { objective: goalText.trim() } : {}, references: bundle.references?.map((reference) => reference.id) || [] }, 'POST', bundle.revision); setOperation(result.data); }
      setMessage(''); await loadBundle();
    } catch (error) { await handleError(error, 'Assist message failed'); } finally { setBusy(''); }
  };
  const transition = async (action: 'pause' | 'resume' | 'cancel') => { if (!bundle) return; setBusy(action); try { await mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(bundle.id)}/${action}`, {}, 'POST', bundle.revision); await refresh(); } catch (error) { await handleError(error, 'Assist state change failed'); } finally { setBusy(''); } };
  const mutateTurn = async (turn: Turn, action: 'retry' | 'cancel' | 'interrupt') => { setBusy(`${action}:${turn.id}`); try { const result = await mutateV2<Operation | { turn: Turn; operation: Operation }>(`/api/v2/assist/turns/${encodeURIComponent(turn.id)}/${action}`, {}, 'POST', turn.revision); const receipt = result.data as Operation & { operation?: Operation }; setOperation(receipt.operation || receipt); await loadBundle(); } catch (error) { await handleError(error, `Assist ${action} failed`); } finally { setBusy(''); } };
  const saveGoal = async () => { if (!bundle) return; setBusy('goal'); try { const result = await mutateOfflineV2(`/api/v2/assist/sessions/${encodeURIComponent(bundle.id)}/goal`, { goal: { objective: goalText.trim() } }, 'PATCH', { command: 'assist.goal.update', scope: offlineScope, aggregateKey: `assist:${bundle.id}:goal`, expectedRevision: bundle.revision }); if (!('queued' in result)) await loadBundle(); notify('queued' in result ? 'Assist goal saved offline' : 'Assist goal updated'); } catch (error) { await handleError(error, 'Goal update failed'); } finally { setBusy(''); } };
  const addPackReference = async () => { if (!bundle) return; setBusy('reference'); try { await mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(bundle.id)}/references`, { reference_type: 'context_pack', reference_id: bundle.context_pack_id, reference_hash: bundle.context_pack_hash, metadata: { source: 'assist' } }, 'POST', bundle.revision); await loadBundle(); notify('Reference added'); } catch (error) { await handleError(error, 'Reference failed'); } finally { setBusy(''); } };
  const submitReview = async (kind: 'comment' | 'request_changes') => { const turn = bundle?.turns?.find((item) => item.id === reviewTurnId); if (!turn || !reviewText.trim()) return; setBusy(`review:${kind}`); try { const route = kind === 'request_changes' ? 'request-changes' : 'review-comments'; await mutateV2(`/api/v2/assist/turns/${encodeURIComponent(turn.id)}/${route}`, { content: reviewText.trim(), ...(reviewPath.trim() ? { relative_path: reviewPath.trim() } : {}), ...(reviewLine.trim() ? { line_number: Number(reviewLine) } : {}) }, 'POST', turn.revision); const result = await apiV2<{ comments: ReviewComment[] }>(`/api/v2/assist/turns/${encodeURIComponent(turn.id)}/review-comments`); setReviewComments(result.data.comments || []); setReviewText(''); setReviewPath(''); setReviewLine(''); notify(kind === 'request_changes' ? 'Changes requested' : 'Review comment recorded'); } catch (error) { await handleError(error, 'Assist review failed'); } finally { setBusy(''); } };
  const mutateSessionLifecycle = async (action: 'archive' | 'restore' | 'delete' | 'restore-deleted') => { if (!bundle) return; setBusy(`session:${action}`); try { await mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(bundle.id)}/${action}`, {}, 'POST', bundle.revision); await refresh(); notify(`Assist session ${action}`); } catch (error) { await handleError(error, 'Assist session lifecycle failed'); } finally { setBusy(''); } };
  const forkSession = async (mode: 'fork' | 'side-threads') => { if (!bundle) return; setBusy(`session:${mode}`); try { const result = await mutateV2<{ session: Session }>(`/api/v2/assist/sessions/${encodeURIComponent(bundle.id)}/${mode}`, { title: mode === 'fork' ? `Fork of ${bundle.scope}` : `Side thread of ${bundle.scope}` }, 'POST', bundle.revision); const created = result.data.session; await refresh(); setSelectedId(created.id); notify(mode === 'fork' ? 'Assist fork created' : 'Side thread created'); } catch (error) { await handleError(error, 'Assist fork failed'); } finally { setBusy(''); } };

  const availableProfile = profiles.find((profile) => profile.id === profileId);
  const latestActiveTurn = useMemo(() => [...(bundle?.turns || [])].reverse().find((turn) => ACTIVE_TURNS.has(turn.status)), [bundle?.turns]);
  if (!projectId) return <div className="empty-state"><MessageSquare size={28} /><h2>Select a project to open Assist</h2></div>;
  return <div className="page assist-page">
    <div className="page-heading"><div><p className="eyebrow">Project Assist</p><h1>Assist</h1></div><div className="assist-heading-actions"><span className={`assist-connection ${streamState === 'reconnecting' ? 'offline' : ''}`}>{streamState}</span><button className="button" onClick={() => setFilesOpen(true)}><FileText size={15} />Files</button><button className="icon-button" title="Refresh Assist" aria-label="Refresh Assist" onClick={() => void refresh()}><RefreshCw size={16} /></button></div></div>
    {availableProfile?.status !== 'available' && <div className="state-banner error" role="alert"><span>Provider unavailable</span><button className="button" onClick={() => navigate('identity')}>Open Identity</button></div>}
    <div className="assist-mobile-tabs" role="tablist"><button className={mobileTab === 'sessions' ? 'active' : ''} onClick={() => setMobileTab('sessions')}>Sessions</button><button className={mobileTab === 'turns' ? 'active' : ''} onClick={() => setMobileTab('turns')}>Timeline</button></div>
    {bundle && <div className="assist-lifecycle-actions"><button className="icon-button" title="Fork session" aria-label="Fork session" onClick={() => void forkSession('fork')}><GitBranch size={15} /></button><button className="icon-button" title="Create side thread" aria-label="Create side thread" onClick={() => void forkSession('side-threads')}><Plus size={15} /></button>{bundle.status === 'archived' && <button className="icon-button" title="Restore session" aria-label="Restore session" onClick={() => void mutateSessionLifecycle('restore')}><Undo2 size={15} /></button>}{bundle.status !== 'archived' && !bundle.deleted_at && <button className="icon-button" title="Archive session" aria-label="Archive session" onClick={() => void mutateSessionLifecycle('archive')}><Archive size={15} /></button>}{bundle.deleted_at && <button className="icon-button" title="Restore deleted session" aria-label="Restore deleted session" onClick={() => void mutateSessionLifecycle('restore-deleted')}><Undo2 size={15} /></button>}{!bundle.deleted_at && <button className="icon-button danger" title="Delete session" aria-label="Delete session" onClick={() => void mutateSessionLifecycle('delete')}><Trash2 size={15} /></button>}</div>}
    <div className="assist-layout">
      <aside className={`panel assist-sessions ${mobileTab === 'sessions' ? 'mobile-active' : ''}`}><div className="section-title"><div><h2>Sessions</h2><span>{sessions.length} scopes</span></div></div><div className="assist-session-create"><label><span>Scope</span><select value={scope} onChange={(event) => { const value = event.target.value as typeof scope; setScope(value); setScopeId(value === 'project' ? projectId : ''); }}><option value="project">Project</option><option value="workflow">Workflow</option><option value="workstream">Workstream</option><option value="task">Task</option></select></label>{scope !== 'project' && <label><span>Target</span><input value={scopeId} onChange={(event) => setScopeId(event.target.value)} required /></label>}<label><span>Context Pack</span><select value={packId} onChange={(event) => setPackId(event.target.value)}><option value="">No pack</option>{packs.map((pack) => <option key={pack.id} value={pack.id}>{shortHash(pack.pack_hash)}</option>)}</select></label><label><span>Provider</span><select value={profileId} onChange={(event) => setProfileId(event.target.value)}><option value="">No provider</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label} · {profile.status}</option>)}</select></label><button className="button primary" disabled={busy === 'session' || !packId || !profileId || selectedProject?.status === 'archived'} onClick={() => void createSession()}>{busy === 'session' ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}New session</button></div><div className="assist-session-list">{sessions.map((session) => <button key={session.id} className={`${session.id === selectedId ? 'assist-session selected' : 'assist-session'}${session.parent_session_id ? ' child' : ''}`} onClick={() => { setSelectedId(session.id); setMobileTab('turns'); }}><span><strong>{session.title || session.scope}</strong><small>{session.parent_session_id ? `${session.mode || 'fork'} of ${shortHash(session.parent_session_id)}` : `Pack ${shortHash(session.context_pack_hash)}`}</small></span><Status value={session.status} /></button>)}{!sessions.length && <div className="list-empty">No sessions</div>}</div></aside>
      <section className={`panel assist-workspace ${mobileTab === 'turns' ? 'mobile-active' : ''}`}>{bundle ? <><div className="section-title"><div><h2>{bundle.scope} scope</h2><span>Session r{bundle.revision} · Pack {shortHash(bundle.context_pack_hash)}</span></div><div className="assist-actions"><button className="icon-button" title="Pause Assist" aria-label="Pause Assist" disabled={bundle.status !== 'active'} onClick={() => void transition('pause')}><Pause size={15} /></button><button className="icon-button" title="Resume Assist" aria-label="Resume Assist" disabled={bundle.status !== 'paused'} onClick={() => void transition('resume')}><Play size={15} /></button><button className="icon-button" title="Cancel Assist" aria-label="Cancel Assist" disabled={['completed', 'cancelled'].includes(bundle.status)} onClick={() => void transition('cancel')}><Square size={15} /></button></div></div>
        <div className="assist-goal-row"><label><Target size={15} /><input value={goalText} onChange={(event) => setGoalText(event.target.value)} placeholder="Session goal" /></label><button className="icon-button" title="Save goal" aria-label="Save goal" disabled={busy === 'goal'} onClick={() => void saveGoal()}><Target size={15} /></button><button className="button" disabled={busy === 'reference' || Boolean(bundle.references?.some((reference) => reference.reference_id === bundle.context_pack_id))} onClick={() => void addPackReference()}><Plus size={14} />Reference</button></div>
        {operation && <div className="assist-operation" role="status"><Status value={operation.status} /><span>{operation.error_code || `Operation ${shortHash(operation.operation_id || operation.id)}`}</span></div>}
        {latestActiveTurn?.status === 'awaiting_input' && <div className="state-banner conflict"><span>Awaiting input or approval</span><button className="button" onClick={() => navigate('approvals')}>Open Approval Center</button></div>}
        <div className="assist-turns">{bundle.turns?.map((turn) => <article className="assist-turn" key={turn.id}><header><span>Turn {turn.turn_no} · attempt {turn.attempt} · r{turn.revision}</span><Status value={turn.status} /></header>{turn.messages.map((item) => <div className={`assist-message ${item.role}`} key={item.id}><span>{item.role.replaceAll('_', ' ')}</span>{item.content ? <AssistMarkdown>{item.content}</AssistMarkdown> : <p>{item.kind === 'reasoning_summary' ? 'Summary unavailable' : 'Pending'}</p>}</div>)}{turn.error_code && <div className="state-banner error"><span>{turn.error_code}</span></div>}<footer><button className="icon-button" title="Review turn" aria-label={`Review turn ${turn.turn_no}`} onClick={() => setReviewTurnId(turn.id)}><MessageSquare size={15} /></button>{['failed', 'cancelled', 'completed'].includes(turn.status) && <button className="icon-button" title="Retry turn" aria-label={`Retry turn ${turn.turn_no}`} onClick={() => void mutateTurn(turn, 'retry')}><RotateCcw size={15} /></button>}{['queued', 'running', 'awaiting_input'].includes(turn.status) && <><button className="icon-button" title="Interrupt turn" aria-label={`Interrupt turn ${turn.turn_no}`} onClick={() => void mutateTurn(turn, 'interrupt')}><Pause size={15} /></button><button className="icon-button" title="Cancel turn" aria-label={`Cancel turn ${turn.turn_no}`} onClick={() => void mutateTurn(turn, 'cancel')}><Square size={15} /></button></>}</footer></article>)}{!bundle.turns?.length && <div className="list-empty">No turns yet</div>}</div>
        <section className="assist-runtime-timeline"><div className="section-title"><div><h3>Runtime timeline</h3><span>{timelineEvents.length} events</span></div></div><TurnTimeline events={timelineEvents} /></section>
        {reviewTurnId && <section className="assist-review-panel"><div className="section-title"><div><h3>Turn review</h3><span>{reviewComments.length} immutable comments</span></div><button className="icon-button" title="Close turn review" aria-label="Close turn review" onClick={() => setReviewTurnId('')}><Square size={14} /></button></div><div className="assist-review-list">{reviewComments.map((comment) => <div key={comment.id}><Status value={comment.kind} /><span><strong>{comment.content}</strong><small>{comment.relative_path || 'turn'}{comment.line_number ? `:${comment.line_number}` : ''}</small></span></div>)}{!reviewComments.length && <div className="list-empty">No review comments</div>}</div><div className="two-column"><label><span>File path</span><input aria-label="Review file path" value={reviewPath} onChange={(event) => setReviewPath(event.target.value)} maxLength={1024} /></label><label><span>Line</span><input aria-label="Review line" type="number" min="1" value={reviewLine} onChange={(event) => setReviewLine(event.target.value)} /></label></div><textarea aria-label="Turn review comment" rows={3} value={reviewText} onChange={(event) => setReviewText(event.target.value)} /><div className="assist-review-actions"><button className="button" disabled={!reviewText.trim() || Boolean(busy)} onClick={() => void submitReview('comment')}><MessageSquare size={14} />Comment</button><button className="button" disabled={!reviewText.trim() || Boolean(busy)} onClick={() => void submitReview('request_changes')}><Target size={14} />Request changes</button></div></section>}
        <form className="assist-composer" onSubmit={(event) => void submitMessage(event)}><div className="segmented" role="group" aria-label="Composer mode"><button type="button" className={composerMode === 'turn' ? 'active' : ''} onClick={() => setComposerMode('turn')}>New turn</button><button type="button" className={composerMode === 'steer' ? 'active' : ''} disabled={!latestActiveTurn} onClick={() => setComposerMode('steer')}>Follow-up</button></div><div className="assist-compose-row"><textarea rows={3} value={message} onChange={(event) => setMessage(event.target.value)} onPaste={(event) => { const text = event.clipboardData.getData('text'); if (text.length > 12_000) { event.preventDefault(); setMessage((current) => `${current}${current ? '\n\n' : ''}${normalizePastedText(text)}`); } }} placeholder="Message Assist" required /><button className="button primary" disabled={busy === 'message' || bundle.status !== 'active'}>{busy === 'message' ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}Send</button></div></form>
      </> : <div className="empty-state"><MessageSquare size={24} /><h2>Select an Assist session</h2></div>}</section>
    </div><FilesDrawer open={filesOpen} projectId={projectId} sessionId={bundle?.id} notify={notify} onClose={() => setFilesOpen(false)} />
  </div>;
}

function Status({ value }: { value: string }) { const tone = ['active', 'completed', 'succeeded', 'approved'].includes(value) ? 'positive' : ['running', 'queued', 'pending', 'awaiting_input', 'accepted', 'paused'].includes(value) ? 'working' : ['failed', 'cancelled', 'expired'].includes(value) ? 'negative' : 'neutral'; return <span className={`status ${tone}`}><span />{value.replaceAll('_', ' ')}</span>; }

export function normalizeAssistMessage(value: string) {
  const text = String(value || '').trim();
  if (text.length <= 262_144) return text;
  const marker = '\n\n[pasted content truncated at the protocol limit]';
  return `${text.slice(0, 262_144 - marker.length)}${marker}`;
}

export function normalizePastedText(value: string) {
  const text = String(value || '');
  if (text.length <= 12_000) return text;
  return normalizeAssistMessage(`\`\`\`text\n${text}\n\`\`\``);
}

/** Small dependency-free GFM renderer; links are allow-listed and all output is React text. */
function MarkdownContent({ content }: { content: string }) {
  const lines = String(content || '').split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let code: string[] = [];
  let inCode = false;
  lines.forEach((line, index) => {
    if (line.trim().startsWith('```')) {
      if (inCode) { blocks.push(<pre className="assist-markdown-code" key={`code-${index}`}>{code.join('\n')}</pre>); code = []; }
      inCode = !inCode;
      return;
    }
    if (inCode) { code.push(line); return; }
    if (!line.trim()) { blocks.push(<br key={`br-${index}`} />); return; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { blocks.push(<strong className={`assist-markdown-h${heading[1].length}`} key={index}>{inlineMarkdown(heading[2])}</strong>); return; }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    blocks.push(bullet ? <span className="assist-markdown-line" key={index}>• {inlineMarkdown(bullet[1])}</span> : <span className="assist-markdown-line" key={index}>{inlineMarkdown(line)}</span>);
  });
  if (inCode && code.length) blocks.push(<pre className="assist-markdown-code" key="code-tail">{code.join('\n')}</pre>);
  return <div className="assist-markdown">{blocks}</div>;
}

function inlineMarkdown(value: string): ReactNode[] {
  const result: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index || 0;
    if (index > cursor) result.push(value.slice(cursor, index));
    const token = match[0];
    if (token.startsWith('**')) result.push(<strong key={`${index}-b`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) result.push(<code key={`${index}-c`}>{token.slice(1, -1)}</code>);
    else { const parts = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/); if (parts) result.push(<a key={`${index}-a`} href={parts[2]} target="_blank" rel="noreferrer">{parts[1]}</a>); }
    cursor = index + token.length;
  }
  if (cursor < value.length) result.push(value.slice(cursor));
  return result;
}
