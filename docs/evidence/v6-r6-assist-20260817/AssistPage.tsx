import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, MessageSquare, Pause, Play, Plus, RefreshCw, RotateCcw, Send, Square } from 'lucide-react';
import { ApiError, api, mutate, shortHash } from '../../api';
import type { ContextPack, Project } from '../../types';

type Props = {
  projectId: string;
  selectedProject?: Project;
  notify: (text: string, tone?: 'ok' | 'error') => void;
};
type Message = { id: string; role: string; content: string };
type Snapshot = { id: string; attempt: number; revision: number; status: string; input_hash: string; output_cas_hash: string; error_code?: string | null };
type Turn = { id: string; turn_no: number; status: string; revision: number; attempt: number; operation_id?: string; messages: Message[]; snapshots: Snapshot[] };
type Session = {
  id: string; project_id: string; scope: string; scope_id: string; status: string; revision: number;
  compatibility: 'legacy_compat' | 'native_v6'; context_pack_id?: string | null; context_pack_hash?: string;
  snapshot: { brief_revision?: number | null; workflow_revision?: number | null }; turns?: Turn[];
};
type Receipt = { operation_id: string; status: string; resource_id: string; cursor: number; revision: number };
type Operation = { id: string; status: string; revision: number; error_code?: string | null };
type Replay = { events: Array<{ cursor: number; type: string; data: Record<string, unknown> }>; cursor: number };
type CursorAck = { cursor: number; revision: number };

const ACTIVE = new Set(['pending', 'queued', 'running']);
const projectReady = (project?: Project) => !project || (project.status === 'active' && Boolean(project.confirmed_brief_revision || project.brief_head?.confirmed_revision));

export function AssistPage({ projectId, selectedProject, notify }: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [packs, setPacks] = useState<ContextPack[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [bundle, setBundle] = useState<Session | null>(null);
  const [packId, setPackId] = useState('');
  const [scope, setScope] = useState('project');
  const [scopeId, setScopeId] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null);
  const [cursor, setCursor] = useState(0);
  const cursorRevision = useRef(0);
  const ackedCursor = useRef(0);
  const [replayFallback, setReplayFallback] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [mobileTab, setMobileTab] = useState<'sessions' | 'turns'>('turns');

  const loadSessions = useCallback(async () => {
    if (!projectId) { setSessions([]); return; }
    const rows = await api<Session[]>(`/api/v1/assist/sessions?project_id=${projectId}`);
    setSessions(rows);
    setSelectedId((current) => rows.some((row) => row.id === current) ? current : rows[0]?.id || '');
  }, [projectId]);
  const loadPacks = useCallback(async () => {
    if (!projectId) return setPacks([]);
    const rows = await api<ContextPack[]>(`/api/v1/projects/${projectId}/context/packs`);
    setPacks(rows);
    setPackId((current) => rows.some((pack) => pack.id === current) ? current : rows[0]?.id || '');
  }, [projectId]);
  const loadBundle = useCallback(async () => {
    if (!selectedId) return setBundle(null);
    setBundle(await api<Session>(`/api/v1/assist/sessions/${selectedId}`));
  }, [selectedId]);
  const refresh = useCallback(async () => { await Promise.all([loadSessions(), loadPacks(), loadBundle()]); }, [loadBundle, loadPacks, loadSessions]);

  useEffect(() => { setScopeId(projectId); void Promise.all([loadSessions(), loadPacks()]); }, [loadPacks, loadSessions, projectId]);
  useEffect(() => { void loadBundle(); setCursor(0); cursorRevision.current = 0; ackedCursor.current = 0; setReplayFallback(false); }, [loadBundle]);
  useEffect(() => {
    const onOnline = () => { setOffline(false); void refresh(); };
    const onOffline = () => setOffline(true);
    addEventListener('online', onOnline); addEventListener('offline', onOffline);
    return () => { removeEventListener('online', onOnline); removeEventListener('offline', onOffline); };
  }, [refresh]);
  useEffect(() => {
    if (!operation || !ACTIVE.has(operation.status)) return;
    const timer = setInterval(() => void api<Operation>(`/api/v1/operations/${operation.id}`).then((next) => {
      setOperation(next);
      if (!ACTIVE.has(next.status)) void refresh();
    }).catch(() => setOffline(true)), 350);
    return () => clearInterval(timer);
  }, [operation, refresh]);
  useEffect(() => {
    if (!selectedId || offline || typeof EventSource === 'undefined') { setReplayFallback(true); return; }
    const stream = new EventSource(`/api/v1/assist/sessions/${selectedId}/events?after=${cursor}`);
    const receive = (event: MessageEvent) => {
      const next = Number(event.lastEventId || 0);
      if (next > 0) setCursor((current) => Math.max(current, next));
      void loadBundle();
    };
    const eventTypes = ['assist.session.created', 'assist.session.cancel', 'assist.session.interrupt', 'assist.session.resume', 'assist.session.complete', 'assist.turn.queued', 'assist.turn.running', 'assist.turn.completed', 'assist.turn.failed', 'assist.turn.cancelled', 'assist.turn.retry', 'assist.message', 'assist.goal', 'assist.plan'];
    for (const type of eventTypes) stream.addEventListener(type, receive as EventListener);
    stream.onopen = () => setReplayFallback(false);
    stream.onerror = () => setReplayFallback(true);
    return () => stream.close();
  }, [loadBundle, offline, selectedId]);
  useEffect(() => {
    if (!selectedId || cursor <= ackedCursor.current) return;
    const acknowledge = async () => {
      try {
        const ack = await mutate<CursorAck>(`/api/v1/assist/sessions/${selectedId}/events/cursor`, { consumer_id: 'web', cursor, expected_revision: cursorRevision.current }, 'PUT');
        cursorRevision.current = ack.revision; ackedCursor.current = ack.cursor;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'revision_conflict') return;
        cursorRevision.current = Number(error.details.current_revision || 0);
        await refresh().catch(() => undefined);
        const ack = await mutate<CursorAck>(`/api/v1/assist/sessions/${selectedId}/events/cursor`, { consumer_id: 'web', cursor, expected_revision: cursorRevision.current }, 'PUT').catch(() => null);
        if (ack) { cursorRevision.current = ack.revision; ackedCursor.current = ack.cursor; }
      }
    };
    const timer = setTimeout(() => void acknowledge(), 80);
    return () => clearTimeout(timer);
  }, [cursor, refresh, selectedId]);
  useEffect(() => {
    if (!selectedId || offline || !replayFallback) return;
    const timer = setInterval(() => void api<Replay>(`/api/v1/assist/sessions/${selectedId}/events?after=${cursor}`).then((replay) => {
      if (replay.events.length) { setCursor(replay.cursor); void loadBundle(); }
    }).catch(() => setOffline(true)), 1500);
    return () => clearInterval(timer);
  }, [cursor, loadBundle, offline, replayFallback, selectedId]);

  const handleError = async (error: unknown, fallback: string) => {
    if (error instanceof ApiError && error.code === 'revision_conflict') await refresh().catch(() => undefined);
    notify(error instanceof Error ? error.message : fallback, 'error');
  };
  const createSession = async () => {
    if (!packId) return notify('Create a Context Pack before starting native Assist.', 'error');
    setBusy('session');
    try {
      const created = await mutate<Session>('/api/v1/assist/sessions', { project_id: projectId, scope, scope_id: scopeId || projectId, context_pack_id: packId, mode: 'native', expected_revision: 0 });
      await loadSessions(); setSelectedId(created.id); setMobileTab('turns'); notify('Assist session created');
    } catch (error) { await handleError(error, 'Assist session failed'); } finally { setBusy(''); }
  };
  const sendTurn = async (event: FormEvent) => {
    event.preventDefault();
    if (!bundle || !message.trim()) return;
    setBusy('turn');
    try {
      const receipt = await mutate<Receipt>(`/api/v1/assist/sessions/${bundle.id}/turns`, { message, expected_revision: bundle.revision, goal: {}, plan: [] });
      setOperation({ id: receipt.operation_id, status: receipt.status, revision: receipt.revision }); setMessage(''); await loadBundle();
    } catch (error) { await handleError(error, 'Assist turn failed'); } finally { setBusy(''); }
  };
  const transition = async (action: 'interrupt' | 'resume' | 'cancel') => {
    if (!bundle) return;
    setBusy(action);
    try { await mutate(`/api/v1/assist/sessions/${bundle.id}/${action}`, { expected_revision: bundle.revision }); await refresh(); }
    catch (error) { await handleError(error, 'Assist state change failed'); } finally { setBusy(''); }
  };
  const retry = async (turn: Turn) => {
    setBusy(`retry:${turn.id}`);
    try {
      const receipt = await mutate<Receipt>(`/api/v1/assist/turns/${turn.id}/retry`, { expected_revision: turn.revision });
      setOperation({ id: receipt.operation_id, status: receipt.status, revision: receipt.revision }); await loadBundle();
    } catch (error) { await handleError(error, 'Assist retry failed'); } finally { setBusy(''); }
  };
  const cancelTurn = async (turn: Turn) => {
    setBusy(`cancel:${turn.id}`);
    try {
      const receipt = await mutate<Receipt>(`/api/v1/assist/turns/${turn.id}/cancel`, { expected_revision: turn.revision });
      setOperation({ id: receipt.operation_id, status: receipt.status, revision: receipt.revision }); await loadBundle();
    } catch (error) { await handleError(error, 'Assist cancel failed'); } finally { setBusy(''); }
  };
  const selectedPack = useMemo(() => packs.find((pack) => pack.id === packId), [packId, packs]);

  if (!projectId) return <div className="empty-state"><MessageSquare size={28} /><h2>Select a project to open Assist</h2></div>;
  return <div className="page assist-page">
    <div className="page-heading"><div><p className="eyebrow">Project Assist</p><h1>Assist Center</h1></div><div className="assist-heading-actions"><span className={offline ? 'assist-connection offline' : 'assist-connection'}>{offline ? 'offline' : 'connected'}</span><button className="icon-button" title="Refresh Assist" aria-label="Refresh Assist" onClick={() => void refresh()}><RefreshCw size={16} /></button></div></div>
    <div className="assist-mobile-tabs" role="tablist"><button className={mobileTab === 'sessions' ? 'active' : ''} onClick={() => setMobileTab('sessions')}>Sessions</button><button className={mobileTab === 'turns' ? 'active' : ''} onClick={() => setMobileTab('turns')}>Timeline</button></div>
    <div className="assist-layout">
      <aside className={`panel assist-sessions ${mobileTab === 'sessions' ? 'mobile-active' : ''}`}>
        <div className="section-title"><div><h2>Sessions</h2><span>{sessions.length} scopes</span></div></div>
        <div className="assist-session-create"><label><span>Scope</span><select value={scope} onChange={(event) => { setScope(event.target.value); setScopeId(event.target.value === 'project' ? projectId : ''); }}><option value="project">Project</option><option value="workflow">Workflow</option><option value="workstream">Workstream</option><option value="task">Task</option></select></label>{scope !== 'project' && <label><span>Target</span><input value={scopeId} onChange={(event) => setScopeId(event.target.value)} /></label>}<label><span>Context Pack</span><select value={packId} onChange={(event) => setPackId(event.target.value)}><option value="">No Pack</option>{packs.map((pack) => <option key={pack.id} value={pack.id}>{shortHash(pack.pack_hash)}</option>)}</select></label><button className="button primary" disabled={busy === 'session' || !packId || !projectReady(selectedProject)} onClick={() => void createSession()}>{busy === 'session' ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}New session</button></div>
        <div className="assist-session-list">{sessions.map((session) => <button key={session.id} className={session.id === selectedId ? 'assist-session selected' : 'assist-session'} onClick={() => { setSelectedId(session.id); setMobileTab('turns'); }}><span><strong>{session.scope}</strong><small>{session.compatibility === 'native_v6' ? `Pack ${shortHash(session.context_pack_hash)}` : 'Legacy compatibility'}</small></span><Status value={session.status} /></button>)}{!sessions.length && <div className="list-empty">No sessions</div>}</div>
      </aside>
      <section className={`panel assist-workspace ${mobileTab === 'turns' ? 'mobile-active' : ''}`}>
        {bundle ? <><div className="section-title"><div><h2>{bundle.scope} scope</h2><span>Session r{bundle.revision} · Pack {shortHash(bundle.context_pack_hash || selectedPack?.pack_hash)}</span></div><div className="assist-actions"><button className="icon-button" title="Pause Assist" aria-label="Pause Assist" disabled={bundle.status !== 'active'} onClick={() => void transition('interrupt')}><Pause size={15} /></button><button className="icon-button" title="Resume Assist" aria-label="Resume Assist" disabled={bundle.status !== 'paused'} onClick={() => void transition('resume')}><Play size={15} /></button><button className="icon-button" title="Cancel Assist" aria-label="Cancel Assist" disabled={['completed', 'cancelled'].includes(bundle.status)} onClick={() => void transition('cancel')}><Square size={15} /></button></div></div>
          {operation && <div className="assist-operation" role="status"><Status value={operation.status} /><span>{operation.error_code || `Operation ${shortHash(operation.id)}`}</span></div>}
          <div className="assist-turns">{bundle.turns?.map((turn) => <article className="assist-turn" key={turn.id}><header><span>Turn {turn.turn_no} · attempt {turn.attempt} · r{turn.revision}</span><Status value={turn.status} /></header><div className="assist-snapshot-track">{turn.snapshots.map((snapshot) => <span key={snapshot.id} title={`revision ${snapshot.revision}`}>{snapshot.status}</span>)}</div>{turn.messages.map((item) => <div className={`assist-message ${item.role}`} key={item.id}><span>{item.role}</span><p>{item.content}</p></div>)}<footer>{['failed', 'cancelled', 'completed'].includes(turn.status) && <button className="icon-button" title="Retry turn" aria-label="Retry turn" disabled={busy === `retry:${turn.id}`} onClick={() => void retry(turn)}><RotateCcw size={15} /></button>}{['queued', 'running'].includes(turn.status) && <button className="icon-button" title="Cancel turn" aria-label="Cancel turn" disabled={busy === `cancel:${turn.id}`} onClick={() => void cancelTurn(turn)}><Square size={15} /></button>}</footer></article>)}{!bundle.turns?.length && <div className="list-empty">No turns yet</div>}</div>
          <form className="assist-composer" onSubmit={(event) => void sendTurn(event)}><div className="assist-compose-row"><textarea rows={3} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Message Assist" required /><button className="button primary" disabled={busy === 'turn' || bundle.status !== 'active' || bundle.compatibility !== 'native_v6'}>{busy === 'turn' ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}Send</button></div></form>
        </> : <div className="empty-state"><MessageSquare size={24} /><h2>Select an Assist session</h2></div>}
      </section>
    </div>
  </div>;
}

function Status({ value }: { value: string }) {
  const tone = ['active', 'completed'].includes(value) ? 'positive' : ['running', 'queued', 'pending'].includes(value) ? 'working' : ['failed'].includes(value) ? 'negative' : 'neutral';
  return <span className={`status ${tone}`}><span />{value.replaceAll('_', ' ')}</span>;
}
