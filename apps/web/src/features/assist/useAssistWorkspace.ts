import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiV2, mutateV2, useWorkbenchOnline } from '../../api';
import type { AssistPageContext, WorkspacePageProps } from '../../workspace';
import type { Approval, Operation, Pack, Profile, Reference, Replay, Session, TerminalSummary, TimelineEvent, Workspace } from './types';

export const ACTIVE_TURNS = new Set(['queued', 'running', 'awaiting_input']);
const ACTIVE_OPERATIONS = new Set(['accepted', 'queued', 'running', 'paused']);
const TERMINAL_RUNNING = new Set(['ready', 'running']);

export function useAssistWorkspace(props: WorkspacePageProps) {
  const { projectId, notify, assistContext, assistAttachRequest, openTerminal } = props;
  const browserOnline = useWorkbenchOnline();
  const online = props.online !== false && browserOnline;
  const [serviceAvailable, setServiceAvailable] = useState(true);
  const canMutate = online && serviceAvailable;
  const [error, setError] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [bundle, setBundle] = useState<Session | null>(null);
  const currentBundle = useRef<Session | null>(null);
  currentBundle.current = bundle;
  const [packId, setPackId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [scope, setScope] = useState<'project' | 'workflow' | 'workstream' | 'task'>('project');
  const [scopeId, setScopeId] = useState('');
  const [busy, setBusy] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null);
  const [cursor, setCursor] = useState<string | number>(0);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [streamState, setStreamState] = useState<'connected' | 'reconnecting' | 'partial'>('connected');
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [terminalResult, setTerminalResult] = useState<TerminalSummary | null>(null);
  const currentScope = useRef({ projectId, selectedId });
  currentScope.current = { projectId, selectedId };
  const handledAttachment = useRef('');
  const mutationInFlight = useRef(false);

  const loadSessions = useCallback(async () => {
    if (!projectId) return;
    const result = await apiV2<{ sessions: Session[] }>(`/api/v2/assist/sessions?project_id=${encodeURIComponent(projectId)}&include_deleted=true`);
    if (currentScope.current.projectId !== projectId) return;
    const rows = result.data.sessions || [];
    setSessions(rows);
    setSelectedId((current) => {
      const remembered = sessionStorage.getItem(`aiws:v3:assist-session:${projectId}`) || '';
      return rows.some((row) => row.id === current) ? current
        : rows.some((row) => row.id === remembered && !row.deleted_at) ? remembered
          : rows.find((row) => row.status === 'active' && !row.deleted_at)?.id || rows.find((row) => !row.deleted_at)?.id || '';
    });
  }, [projectId]);

  const loadPrerequisites = useCallback(async () => {
    if (!projectId) return;
    const [packResult, profileResult, workspaceResult] = await Promise.all([
      apiV2<{ packs: Pack[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/context/packs`),
      apiV2<{ profiles: Profile[] }>('/api/v2/profiles'),
      apiV2<{ workspaces: Workspace[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/repository-workspaces`)
    ]);
    if (currentScope.current.projectId !== projectId) return;
    const nextPacks = (packResult.data.packs || []).filter((pack) => !pack.status || pack.status === 'sealed');
    const nextProfiles = (profileResult.data.profiles || []).filter((profile) => profile.provider === 'codex' && profile.lifecycle_status !== 'disabled');
    const nextWorkspaces = workspaceResult.data.workspaces || [];
    setPacks(nextPacks); setProfiles(nextProfiles); setWorkspaces(nextWorkspaces);
    setPackId((current) => nextPacks.some((pack) => pack.id === current) ? current : nextPacks[0]?.id || '');
    setProfileId((current) => nextProfiles.some((profile) => profile.id === current) ? current : nextProfiles.find((profile) => profile.status === 'available')?.id || nextProfiles[0]?.id || '');
    setWorkspaceId((current) => nextWorkspaces.some((workspace) => workspace.id === current) ? current : nextWorkspaces.find((workspace) => ['ready', 'released'].includes(workspace.status))?.id || '');
  }, [projectId]);

  const loadBundle = useCallback(async () => {
    if (!projectId || !selectedId) return null;
    const result = await apiV2<Session>(`/api/v2/assist/sessions/${encodeURIComponent(selectedId)}`);
    if (currentScope.current.projectId !== projectId || currentScope.current.selectedId !== selectedId) return null;
    if (result.data.project_id !== projectId) throw new Error('Assist session project mismatch');
    setBundle(result.data);
    return result.data;
  }, [projectId, selectedId]);

  const loadRelated = useCallback(async () => {
    if (!projectId || !selectedId) return;
    const [terminalResponse, approvalResponse] = await Promise.all([
      apiV2<{ terminals: TerminalSummary[] }>(`/api/v2/terminals?project_id=${encodeURIComponent(projectId)}`),
      apiV2<{ approvals: Approval[] }>(`/api/v2/approvals?project_id=${encodeURIComponent(projectId)}`)
    ]);
    if (currentScope.current.projectId !== projectId || currentScope.current.selectedId !== selectedId) return;
    const terminals = (terminalResponse.data.terminals || []).filter((row) => row.assist_session_id === selectedId);
    terminals.sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')));
    setTerminalResult(terminals[0] || null);
    setApprovals(approvalResponse.data.approvals || []);
  }, [projectId, selectedId]);

  const refresh = useCallback(async () => {
    await Promise.all([loadSessions(), loadPrerequisites(), loadBundle()]);
    setServiceAvailable(true); setError('');
  }, [loadSessions, loadPrerequisites, loadBundle]);

  const handleError = useCallback(async (failure: unknown, fallback: string) => {
    const text = failure instanceof Error ? failure.message : fallback;
    setError(text);
    if (failure instanceof TypeError || failure instanceof ApiError && failure.code === 'network_error') setServiceAvailable(false);
    if (failure instanceof ApiError && failure.code === 'revision_conflict') await refresh().catch(() => undefined);
    notify(text, 'error');
  }, [notify, refresh]);

  useEffect(() => {
    setScopeId(projectId); setSelectedId(''); setBundle(null); setSessions([]); setPacks([]); setProfiles([]); setWorkspaces([]);
    setTerminalResult(null); setApprovals([]); setTimelineEvents([]); setCursor(0); setOperation(null); setError('');
  }, [projectId]);

  useEffect(() => {
    if (projectId && online) void Promise.all([loadSessions(), loadPrerequisites()]).then(() => setServiceAvailable(true)).catch((failure) => {
      if (currentScope.current.projectId === projectId) { setError(failure instanceof Error ? failure.message : 'Assist 加载失败'); if (failure instanceof TypeError || failure instanceof ApiError && failure.code === 'network_error') setServiceAvailable(false); }
    });
  }, [projectId, online, loadSessions, loadPrerequisites]);

  useEffect(() => {
    setBundle(null); setTerminalResult(null); setCursor(0); setTimelineEvents([]);
  }, [projectId, selectedId]);

  useEffect(() => {
    if (!selectedId || !online) return;
    sessionStorage.setItem(`aiws:v3:assist-session:${projectId}`, selectedId);
    void loadBundle().catch((failure) => void handleError(failure, 'Assist 会话加载失败'));
    void loadRelated().catch(() => undefined);
  }, [selectedId, projectId, online, loadBundle, loadRelated]);

  useEffect(() => {
    if (!operation || !online || !ACTIVE_OPERATIONS.has(operation.status)) return;
    const timer = setInterval(() => void apiV2<Operation>(`/api/v2/operations/${encodeURIComponent(operation.operation_id || operation.id || '')}`).then((result) => {
      setOperation(result.data); if (!ACTIVE_OPERATIONS.has(result.data.status)) void refresh().catch(() => undefined);
    }).catch(() => setStreamState('reconnecting')), 500);
    return () => clearInterval(timer);
  }, [operation, online, refresh]);

  useEffect(() => {
    if (!selectedId || !online) return;
    let disposed = false;
    const poll = async () => {
      try {
        const result = await apiV2<Replay>(`/api/v2/assist/sessions/${encodeURIComponent(selectedId)}/events?cursor=${encodeURIComponent(String(cursor))}&limit=200`);
        if (disposed) return;
        const replay = result.data;
        if (replay.events?.length) {
          setCursor(replay.next_cursor);
          setTimelineEvents((current) => [...new Map([...current, ...replay.events].map((event) => [event.sequence, event])).values()].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0)));
        }
        if (replay.events?.length || currentBundle.current?.turns?.some((turn) => ACTIVE_TURNS.has(turn.status))) await loadBundle();
        setServiceAvailable(true);
        setStreamState(replay.events?.some((event) => event.type.includes('message')) ? 'partial' : 'connected');
        await loadRelated().catch(() => undefined);
      } catch (failure) { if (!disposed) { setStreamState('reconnecting'); if (failure instanceof TypeError || failure instanceof ApiError && failure.code === 'network_error') setServiceAvailable(false); } }
    };
    void poll(); const timer = setInterval(() => void poll(), 1200);
    return () => { disposed = true; clearInterval(timer); };
  }, [selectedId, online, cursor, loadBundle, loadRelated]);

  const createSession = async () => {
    if (!projectId || !canMutate || mutationInFlight.current) return;
    if (!packId || !profiles.some((profile) => profile.id === profileId && profile.status === 'available')) return notify('Assist 需要已封存的 Context Pack 和可用的 Provider Profile。', 'error');
    mutationInFlight.current = true; setBusy('session');
    try {
      const result = await mutateV2<{ session: Session }>('/api/v2/assist/sessions', { project_id: projectId, scope, scope_id: scopeId || projectId, context_pack_id: packId, profile_id: profileId, ...(workspaceId ? { repository_workspace_id: workspaceId } : {}) }, 'POST', 0);
      if (currentScope.current.projectId !== projectId) return;
      await loadSessions(); setSelectedId(result.data.session.id); sessionStorage.setItem(`aiws:v3:assist-session:${projectId}`, result.data.session.id); notify('Assist 会话已创建');
    } catch (failure) { await handleError(failure, 'Assist 会话创建失败'); }
    finally { mutationInFlight.current = false; setBusy(''); }
  };

  const addReference = async (context: AssistPageContext, session: Session) => {
    if (!canMutate || context.projectId !== projectId || session.project_id !== projectId || !context.resourceType || !context.resourceId) throw new Error('Assist reference context is invalid or offline');
    const existing = session.references?.find((reference) => matchesReference(reference, context));
    if (existing) return session;
    await mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/references`, {
      reference_type: context.resourceType, reference_id: context.resourceId,
      ...(context.revision != null ? { reference_revision: context.revision } : {}),
      ...(context.contentHash ? { reference_hash: context.contentHash } : {}),
      metadata: { source: 'workspace-context' }
    }, 'POST', session.revision);
    return await loadBundle();
  };

  const addContextReference = async () => {
    if (!canMutate || !bundle || !assistContext || mutationInFlight.current) return;
    mutationInFlight.current = true; setBusy('context-reference');
    try {
      const attached = await addReference(assistContext, bundle);
      if (!attached) return;
      if (!attached.references?.some((reference) => matchesReference(reference, assistContext))) throw new Error('Assist reference was not persisted');
      notify(`${assistContext.label || '当前页面'} 已附加`);
    }
    catch (failure) { await handleError(failure, '当前上下文附加失败'); }
    finally { mutationInFlight.current = false; setBusy(''); }
  };

  useEffect(() => {
    if (!assistAttachRequest || !bundle || !assistContext?.resourceId || !canMutate) return;
    const token = `${projectId}:${bundle.id}:${assistAttachRequest}`;
    if (handledAttachment.current === token) return;
    handledAttachment.current = token;
    void addContextReference();
  }, [assistAttachRequest, assistContext, bundle?.id, canMutate]);

  const sendTurn = async (text: string, session: Session = bundle!) => {
    if (!session || !canMutate || !text.trim()) return;
    const result = await mutateV2<Operation & { operation?: Operation }>(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/turns`, {
      message: text.trim(), goal: session.goal?.goal || {}, references: session.references?.map((reference) => reference.id) || []
    }, 'POST', session.revision);
    setOperation(result.data.operation || result.data); await loadBundle();
  };

  const requestTerminal = async (command = '') => {
    if (!bundle || bundle.status !== 'active' || !canMutate || mutationInFlight.current) return;
    const workspace = workspaces.find((item) => item.id === workspaceId && ['ready', 'released'].includes(item.status)) || workspaces.find((item) => ['ready', 'released'].includes(item.status));
    if (!workspace) { notify('请先准备可用的 Workspace。', 'error'); return; }
    mutationInFlight.current = true; setBusy('terminal');
    try {
      const caps = await apiV2<import('../../types').TerminalCapabilities>('/api/v2/terminals/capabilities');
      const runtime = caps.data.default_runtime;
      if (!caps.data[runtime]?.available) throw new Error('Terminal runtime 不可用');
      const turn = [...(bundle.turns || [])].reverse()[0];
      const result = await mutateV2<{ approval: Approval }>('/api/v2/approvals', {
        project_id: projectId, action: 'terminal.open', ...(turn ? { assist_turn_id: turn.id } : {}),
        request: { workspace_id: workspace.id, runtime, cwd: '', cols: 120, rows: 32, assist_session_id: bundle.id, ...(command.trim() ? { command: command.trim().slice(0, 2000) } : {}) }, ttl_seconds: 3600
      }, 'POST', workspace.revision);
      openTerminal?.({ workspaceId: workspace.id, runtime, cwd: '', command: command.trim(), assistSessionId: bundle.id, approvalId: result.data.approval.id });
      notify('Terminal 审批请求已提交');
    } catch (failure) { await handleError(failure, 'Terminal 审批请求失败'); }
    finally { mutationInFlight.current = false; setBusy(''); }
  };

  const analyzeTerminal = async () => {
    if (!bundle || bundle.status !== 'active' || !terminalResult || TERMINAL_RUNNING.has(terminalResult.status) || !canMutate || mutationInFlight.current) return;
    mutationInFlight.current = true; setBusy('terminal-analysis');
    try {
      const result = await apiV2<TerminalSummary>(`/api/v2/terminals/${encodeURIComponent(terminalResult.id)}`);
      const terminal = result.data;
      if (terminal.assist_session_id !== bundle.id || !terminal.operation_id || TERMINAL_RUNNING.has(terminal.status)) throw new Error('Terminal result association is stale');
      const session = await addReference({ route: 'terminals', projectId, resourceType: 'operation', resourceId: terminal.operation_id, contentHash: terminal.output_sha256 || null }, bundle);
      if (!session) return;
      // Result metadata only: raw host output is never copied into a new prompt/envelope.
      await sendTurn(`请分析 Terminal 结果引用 ${terminal.operation_id}：runtime=${terminal.runtime}; status=${terminal.status}; exit_code=${terminal.exit_code ?? 'null'}; output_hash=${terminal.output_sha256 || 'null'}。请说明结果和下一步。`, session);
      notify('Terminal 结果已引用并提交给 Assist');
    } catch (failure) { await handleError(failure, 'Terminal 结果分析失败'); }
    finally { mutationInFlight.current = false; setBusy(''); }
  };

  const pendingApprovals = useMemo(() => approvals.filter((approval) => approval.status === 'pending' && (
    approval.request.assist_session_id === selectedId || bundle?.turns?.some((turn) => turn.id === approval.assist_turn_id)
  )), [approvals, bundle?.turns, selectedId]);
  const contextReference = [...(bundle?.references || [])].reverse().find((reference) => reference.reference_type === assistContext?.resourceType && reference.reference_id === assistContext?.resourceId);
  const contextReferenceStale = Boolean(contextReference && assistContext && !matchesReference(contextReference, assistContext));
  const terminalCommandSummary = String(approvals.find((approval) => approval.id === terminalResult?.approval_id)?.request.command || '').slice(0, 160);

  return { sessions, packs, profiles, workspaces, selectedId, setSelectedId, bundle: bundle?.project_id === projectId && bundle.id === selectedId ? bundle : null, packId, setPackId, profileId, setProfileId,
    workspaceId, scope, setScope, scopeId, setScopeId, busy, setBusy, operation, setOperation, timelineEvents, streamState,
    terminalResult, terminalCommandSummary, pendingApprovals, contextReference, contextReferenceStale, canMutate, online, error,
    refresh, loadSessions, loadBundle, handleError, createSession, addContextReference, sendTurn, requestTerminal, analyzeTerminal };
}

function matchesReference(reference: Reference, context: AssistPageContext) {
  return reference.reference_type === context.resourceType && reference.reference_id === context.resourceId
    && (reference.reference_revision ?? null) === (context.revision ?? null) && (reference.reference_hash || null) === (context.contentHash || null);
}
