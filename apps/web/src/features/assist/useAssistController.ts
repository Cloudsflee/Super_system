import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, json } from '../../api/client';
import { keys } from '../../api/queries';
import type { AssistAttachment, AssistClarificationPolicy, AssistConfiguration, AssistGoal, AssistOperation, AssistScopeBreadcrumbItem, AssistScopeType, AssistV3Session, AssistV3Turn, TerminalSession } from '../../api/types';
import { describeAssistSurface, executeAssistOperation } from '../../components/assist/semantic-actions';
import { useUi } from '../../state/ui';
import { activeTurn, assistKeys, useAssistConfigurations, useAssistEvents, useAssistGoal, useAssistModels, useAssistOperations, useAssistSession, useAssistSessions, useCodexProfiles, useTerminalCapabilities } from './assist-api';
import type { ReviewTarget } from './DiffReviewPanel';
import type { AssistCommand } from './composer-support';
import { publishSelectionAsk } from '../../components/common/selection-ask';
import { reasoningEffortLabel } from '../../components/common/display-labels';

type FollowUp = 'queue' | 'steer' | 'interrupt';
type TerminalRuntime = 'linux_container' | 'windows_bridge' | 'host_dev';

export function useAssistController({ projectId, scopeType, scopeId, scopeBreadcrumb = [], enabled, route }: { projectId?: string; scopeType?: AssistScopeType; scopeId?: string; scopeBreadcrumb?: AssistScopeBreadcrumbItem[]; enabled: boolean; route: string }) {
  const [search, setSearch] = useState(''), [archived, setArchived] = useState(false), [selectedId, setSelectedId] = useState<string>();
  const [planNext, setPlanNext] = useState(false), [profileId, setProfileId] = useState(''), [configurationId, setConfigurationId] = useState('');
  const [model, setModelState] = useState(''), [reasoning, setReasoning] = useState(''), [prompt, setPrompt] = useState('');
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const pendingTasks = useRef(0);
  const pendingSelectionId = useRef<string | null>(null);
  const [operationReferenceId, setOperationReferenceId] = useState<string | null>(null);
  const [view, setView] = useState<'chat' | 'review' | 'terminal'>('chat'), [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [terminal, setTerminal] = useState<TerminalSession | null>(null), [terminalRolledBack, setTerminalRolledBack] = useState(false), [terminalSelectorOpen, setTerminalSelectorOpen] = useState(false);
  const processedOperations = useRef(new Set<string>());
  const synchronizedOperations = useRef(new Set<string>());
  const synchronizedProposalEvents = useRef(new Set<string>());
  const sessions = useAssistSessions(projectId, scopeType, scopeId, search, archived, enabled), detail = useAssistSession(selectedId, enabled);
  const profiles = useCodexProfiles(enabled), models = useAssistModels(profileId, enabled), configurations = useAssistConfigurations(profileId, enabled);
  const stream = useAssistEvents(selectedId, enabled && !archived), goal = useAssistGoal(selectedId, enabled && !archived), operations = useAssistOperations(selectedId, enabled && !archived), terminalCapabilities = useTerminalCapabilities(enabled);
  const client = useQueryClient(), toast = useUi((state) => state.toast), session = detail.data, turns = session?.turns || [], running = activeTurn(turns);

  useEffect(() => { pendingSelectionId.current = null; setSelectedId(undefined); setView('chat'); setTerminal(null); setReviewTarget(null); processedOperations.current.clear(); synchronizedOperations.current.clear(); synchronizedProposalEvents.current.clear(); }, [projectId, scopeType, scopeId]);
  useEffect(() => { processedOperations.current.clear(); synchronizedOperations.current.clear(); synchronizedProposalEvents.current.clear(); }, [selectedId]);
  useEffect(() => {
    const rows = (sessions.data || []).filter((item) => !item.deleted_at);
    if (pendingSelectionId.current && rows.some((item) => item.id === pendingSelectionId.current)) pendingSelectionId.current = null;
    if (!rows.length) { if (!sessions.isLoading && !pendingSelectionId.current) setSelectedId(undefined); return; }
    if (!selectedId) setSelectedId(rows[0].id);
    else if (!rows.some((item) => item.id === selectedId) && pendingSelectionId.current !== selectedId) setSelectedId(rows[0].id);
  }, [sessions.data, sessions.isLoading, selectedId]);
  useEffect(() => { const rows = profiles.data || [], active = rows.find((item) => item.is_active && !item.assist_configuration) || rows.find((item) => !item.assist_configuration); if (active && (!profileId || !rows.some((item) => item.id === profileId && !item.assist_configuration))) { setProfileId(active.id); setModelState(active.model || ''); setReasoning(active.reasoning || ''); } }, [profiles.data, profileId]);
  useEffect(() => { const catalog = models.data, entries = Array.isArray(catalog?.models) ? catalog.models : []; if (!entries.length) return; const selected = entries.find((item) => item.model === model) || entries.find((item) => item.model === catalog?.default_model) || entries[0]; if (!selected) return; if (!model) setModelState(selected.model); const efforts = selected.supportedReasoningEfforts.map((item) => item.reasoningEffort); if (!efforts.includes(reasoning)) setReasoning(selected.defaultReasoningEffort || efforts[0] || reasoning); }, [models.data, model, reasoning]);
  useEffect(() => { setAttachmentIds((ids) => ids.filter((item) => session?.attachments?.some((attachment) => attachment.id === item))); }, [session?.id, session?.attachments?.length]);
  useEffect(() => { const prefill = (event: Event) => { const value = (event as CustomEvent<{ prompt?: string }>).detail?.prompt?.trim(); if (value) { setPrompt(value); setOperationReferenceId(null); } }; window.addEventListener('aiws:assist-prefill', prefill); return () => window.removeEventListener('aiws:assist-prefill', prefill); }, []);
  useEffect(() => { let active = true; setTerminal(null); setTerminalRolledBack(false); if (!session?.id) return () => { active = false; }; const query = new URLSearchParams({ project_id: session.project_id, assist_session_id: session.id }); api<TerminalSession[]>(`/assist/v3/terminal-sessions?${query}`).then((items) => { if (active && items[0]) setTerminal(items[0]); }).catch(() => undefined); return () => { active = false; }; }, [session?.id, session?.project_id]);
  useEffect(() => {
    if (!Array.isArray(operations.data)) return;
    for (const event of stream.events.filter((item) => item.type === 'operation' && item.data.execution_layer === 'server' && item.data.status === 'committed' && typeof item.data.operation_id === 'string')) {
      const operationId = String(event.data.operation_id); if (synchronizedOperations.current.has(operationId)) continue;
      synchronizedOperations.current.add(operationId);
      if (projectId) { void client.invalidateQueries({ queryKey: keys.onboarding(projectId) }); void client.invalidateQueries({ queryKey: keys.project(projectId) }); }
    }
    for (const event of stream.events.filter((item) => item.type === 'operation' && item.data.result_kind === 'change_proposal' && typeof item.data.operation_id === 'string')) {
      const key = `${event.data.operation_id}:${event.data.proposal_status || 'pending'}:${event.data.revision || 0}`; if (synchronizedProposalEvents.current.has(key)) continue;
      synchronizedProposalEvents.current.add(key);
      if (selectedId) void client.invalidateQueries({ queryKey: ['assist-v3-operations', selectedId] });
      void client.invalidateQueries({ queryKey: keys.approvals(projectId) }); void client.invalidateQueries({ queryKey: keys.proposals(projectId) });
      if (projectId && event.data.proposal_status === 'applied') void client.invalidateQueries({ queryKey: keys.project(projectId) });
    }
    for (const event of stream.events.filter((item) => item.type === 'operation' && item.data.claimable === true && typeof item.data.operation_id === 'string')) {
      const operationId = String(event.data.operation_id); if (processedOperations.current.has(operationId)) continue;
      if (!operations.data.some((item) => item.id === operationId && item.status === 'pending')) continue;
      processedOperations.current.add(operationId);
      void executeAssistOperation(operationId, route).then(() => refresh()).catch((error) => {
        processedOperations.current.delete(operationId);
        toast((error as Error).message, 'error');
      });
    }
  }, [stream.events, route, operations.data]);

  function beginTask() { pendingTasks.current += 1; setBusy(true); }
  function endTask() { pendingTasks.current = Math.max(0, pendingTasks.current - 1); if (!pendingTasks.current) setBusy(false); }
  async function perform(operation: () => Promise<void>) { beginTask(); try { await operation(); } catch (error) { toast((error as Error).message, 'error'); } finally { endTask(); } }
  async function refresh(sessionId = selectedId) { await client.invalidateQueries({ queryKey: ['assist-v3-sessions'] }); if (sessionId) { await client.invalidateQueries({ queryKey: assistKeys.session(sessionId) }); await client.invalidateQueries({ queryKey: ['assist-v3-goal', sessionId] }); await client.invalidateQueries({ queryKey: ['assist-v3-operations', sessionId] }); } }
  function selectModel(value: string) { setModelState(value); const entry = models.data?.models?.find((item) => item.model === value); if (!entry) return; const efforts = entry.supportedReasoningEfforts.map((item) => item.reasoningEffort); if (!efforts.includes(reasoning)) { const fallback = entry.defaultReasoningEffort || efforts[0] || ''; setReasoning(fallback); if (fallback) toast(`模型 ${value} 使用默认推理强度：${reasoningEffortLabel(fallback)}`); } }
  function selectConfiguration(value: string) { const item = configurations.data?.find((entry) => entry.id === value); if (!item) return; setConfigurationId(item.id); setModelState(item.model); setReasoning(item.reasoning); }
  async function createScopedSession() {
    if (!projectId || !scopeType || !scopeId) throw new Error('当前页面没有可用的智能助手作用域。');
    const label = ({ project: '项目', workflow: '工作流', workstream: '成果节点', task: '任务' })[scopeType];
    const surface = describeAssistSurface();
    const created = await api<AssistV3Session>('/assist/v3/sessions', json('POST', { project_id: projectId, scope_type: scopeType, scope_id: scopeId, title: `${label}智能助手`, repository_workspace_id: surface.repository_workspace_id || undefined, view_context: { route, project_id: projectId, scope_type: scopeType, scope_id: scopeId, repository_workspace_id: surface.repository_workspace_id, surface } }, '创建智能助手线程'));
    pendingSelectionId.current = created.id;
    setArchived(false); setSelectedId(created.id); setView('chat');
    return created;
  }
  async function resolveSubmitSession() {
    if (session && !session.archived_at && session.project_id === projectId && session.scope_type === scopeType && session.scope_id === scopeId && session.scope_status !== 'invalidated') return session;
    const existingId = archived ? undefined : (sessions.data || []).find((item) => !item.deleted_at && !item.archived_at && !item.read_only && (!item.scope_status || item.scope_status === 'active'))?.id;
    if (!existingId) return createScopedSession();
    const existing = await api<AssistV3Session>(`/assist/v3/sessions/${existingId}`);
    pendingSelectionId.current = existing.id; setSelectedId(existing.id);
    client.setQueryData(assistKeys.session(existing.id), existing);
    return existing;
  }
  function createSession() { if (!projectId) { toast('请先创建或选择项目，再新建智能助手线程。', 'error'); return; } void perform(async () => { const created = await createScopedSession(); await refresh(created.id); }); }
  function showArchived(value: boolean) { pendingSelectionId.current = null; setArchived(value); setSelectedId(undefined); setView('chat'); setReviewTarget(null); }
  function rename(item: AssistV3Session) { const title = window.prompt('重命名线程', item.title)?.trim(); if (!title || title === item.title) return; void perform(async () => { await api(`/assist/v3/sessions/${item.id}/rename`, json('POST', { title }, '重命名智能助手线程')); await refresh(item.id); }); }
  function pin(item: AssistV3Session) { void perform(async () => { await api(`/assist/v3/sessions/${item.id}/pin`, json('POST', { pinned: !item.pinned }, item.pinned ? '取消置顶智能助手线程' : '置顶智能助手线程')); await refresh(item.id); }); }
  function archive(item: AssistV3Session) { void perform(async () => { await api(`/assist/v3/sessions/${item.id}/${archived ? 'restore' : 'archive'}`, json('POST', undefined, archived ? '恢复智能助手线程' : '归档智能助手线程')); if (archived) { setArchived(false); setSelectedId(item.id); } else if (selectedId === item.id) setSelectedId(undefined); await refresh(item.id); }); }
  function fork(item: AssistV3Session) { void perform(async () => { const created = await api<AssistV3Session>(`/assist/v3/sessions/${item.id}/fork`, json('POST', { title: `${item.title} · 分支` }, '创建智能助手线程分支')); setSelectedId(created.id); setView('chat'); await refresh(created.id); }); }
  function deleteBranch(item: AssistV3Session) { void perform(async () => { await api(`/assist/v3/sessions/${item.id}`, json('DELETE', undefined, '删除智能助手线程')); if (selectedId === item.id) setSelectedId(undefined); await refresh(); }); }
  function restoreDeleted(item: AssistV3Session) { void perform(async () => { await api(`/assist/v3/sessions/${item.id}/restore-deleted`, json('POST', undefined, '恢复已删除智能助手线程')); setSelectedId(item.id); await refresh(item.id); }); }

  function submit(behavior: FollowUp) {
    const content = prompt.trim(); if (!content || !projectId) return;
    useUi.getState().setAssist(true);
    const collaborationMode = planNext ? 'plan' : 'default', selectedAttachments = [...attachmentIds];
    void perform(async () => {
      const target = await resolveSubmitSession();
      const active = activeTurn(target.turns || []) || (target.id === session?.id ? running : null);
      const surface = describeAssistSurface();
      const body = { content, project_id: projectId, scope_type: scopeType, scope_id: scopeId, collaboration_mode: collaborationMode, operation_reference_id: operationReferenceId || undefined, profile_id: profileId || undefined, configuration_id: configurationId || undefined, model: model || undefined, reasoning: reasoning || undefined, repository_workspace_id: surface.repository_workspace_id || undefined, attachment_ids: selectedAttachments, view_context: { route, project_id: projectId, scope_type: scopeType, scope_id: scopeId, repository_workspace_id: surface.repository_workspace_id, browser_instance_id: surface.browser_instance_id, surface } };
      const endpoint = active ? `/assist/v3/sessions/${target.id}/follow-ups` : `/assist/v3/sessions/${target.id}/turns`;
      await api<AssistV3Turn>(endpoint, json('POST', active ? { ...body, behavior } : body, active ? '发送智能助手后续消息' : '启动智能助手处理'));
      setPrompt((current) => current.trim() === content ? '' : current);
      setPlanNext(false); setOperationReferenceId(null);
      await refresh(target.id);
    });
  }
  function stop() { if (!running) return; void perform(async () => { await api(`/assist/v3/turns/${running.id}/stop`, json('POST', { reason: 'user_stop' }, '停止智能助手处理')); await refresh(); }); }
  function retry(turn: AssistV3Turn) { void perform(async () => { const surface = describeAssistSurface(); await api(`/assist/v3/turns/${turn.id}/retry`, json('POST', { profile_id: profileId || turn.profile_id, configuration_id: configurationId || turn.configuration_id, model: model || turn.model, reasoning: reasoning || turn.reasoning, collaboration_mode: turn.collaboration_mode || 'default', repository_workspace_id: surface.repository_workspace_id || turn.repository_workspace_id || undefined, view_context: { route, repository_workspace_id: surface.repository_workspace_id, browser_instance_id: surface.browser_instance_id, surface } }, '重试智能助手处理')); await refresh(); }); }
  async function saveConfiguration(name: string) { beginTask(); try { const created = await api<AssistConfiguration>('/assist/v3/configurations', json('POST', { base_profile_id: profileId, name, model, reasoning }, '保存智能助手配置')); await client.invalidateQueries({ queryKey: ['assist-v3-configurations', profileId] }); setConfigurationId(created.id); toast(`已保存配置“${created.name}”`); return true; } catch (error) { toast((error as Error).message, 'error'); return false; } finally { endTask(); } }
  function openTerminal(runtime: TerminalRuntime = 'linux_container') { if (!session || !projectId) return; setTerminalSelectorOpen(false); void perform(async () => { const created = await api<TerminalSession>('/assist/v3/terminal-sessions', json('POST', { project_id: projectId, assist_session_id: session.id, profile_id: profileId || undefined, configuration_id: configurationId || undefined, model, reasoning, runtime, cols: 120, rows: 32 }, '启动智能助手终端')); setTerminal(created); setTerminalRolledBack(false); setView('terminal'); }); }
  function setGoal(input: Partial<AssistGoal>) { if (!session) return; void perform(async () => { await api(`/assist/v3/sessions/${session.id}/goal`, json('PUT', { ...input, profile_id: profileId, configuration_id: configurationId || undefined, model, reasoning }, '更新智能助手目标')); await refresh(); }); }
  function clearGoal() { if (!session) return; void perform(async () => { await api(`/assist/v3/sessions/${session.id}/goal`, json('DELETE', undefined, '清除智能助手目标')); await refresh(); }); }
  function setClarificationPolicy(value: AssistClarificationPolicy) { if (!session || session.clarification_policy === value) return; void perform(async () => { await api(`/assist/v3/sessions/${session.id}`, json('PATCH', { clarification_policy: value }, '更新智能助手澄清策略')); await refresh(session.id); }); }
  function respondUserInput(turnId: string, itemId: string, answers: Record<string, { answers: string[]; note?: string }>) { void perform(async () => { await api(`/assist/v3/turns/${turnId}/user-input/${encodeURIComponent(itemId)}/respond`, json('POST', { answers }, '提交智能助手补充信息')); await refresh(); }); }
  function confirmOperation(item: AssistOperation, approved: boolean) { void perform(async () => { await api(`/assist/v3/operations/${item.id}/confirm`, json('POST', { approved }, approved ? '确认智能助手操作' : '拒绝智能助手操作')); await refresh(); }); }
  function undoOperation(item: AssistOperation, force = false) { void perform(async () => { const surface = describeAssistSurface(); await api(`/assist/v3/operations/${item.inverse_of || item.id}/undo`, json('POST', { force, route, surface_id: surface.id, surface_revision: surface.revision, browser_instance_id: surface.browser_instance_id, session_id: session?.id }, '撤销智能助手操作')); if (projectId) await client.invalidateQueries({ queryKey: keys.onboarding(projectId) }); await refresh(); }); }
  function reviseOperation(item: AssistOperation) { const initial = item.current_value ?? item.after_value ?? ''; const raw = window.prompt(`直接编辑“${item.target_label || item.target_id}”`, typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2)); if (raw == null) return; let value: unknown = raw; try { value = JSON.parse(raw); } catch { /* Plain text is a valid field value. */ } void perform(async () => { const surface = describeAssistSurface(); await api(`/assist/v3/operations/${item.id}/revisions`, json('POST', { value, route, surface_id: surface.id, surface_revision: surface.revision, browser_instance_id: surface.browser_instance_id, session_id: session?.id }, '修订智能助手操作')); if (projectId) await client.invalidateQueries({ queryKey: keys.onboarding(projectId) }); await refresh(); }); }
  function continueOperation(item: AssistOperation) { setOperationReferenceId(item.id); setPrompt(`继续修改“${item.target_label || item.target_id}”：`); }
  function openReview(turn: AssistV3Turn) { setReviewTarget({ kind: 'turn', id: turn.id }); setView('review'); }
  function openTerminalReview() { if (terminal && !terminalRolledBack) { setReviewTarget({ kind: 'terminal', id: terminal.id }); setView('review'); } }
  function resolveReview(action: 'apply' | 'rollback') { if (reviewTarget?.kind === 'terminal' && action === 'rollback') setTerminalRolledBack(true); backToChat(); void refresh(); }
  function showTerminal() { if (terminal) setView('terminal'); else setTerminalSelectorOpen(true); }
  function showReview() { if (reviewTarget) setView('review'); }
  function addAttachment(item: AssistAttachment) { client.setQueryData<AssistV3Session>(assistKeys.session(session?.id), (current) => current ? { ...current, attachments: [...(current.attachments || []), item] } : current); }
  function attachmentDeleted(item: AssistAttachment, tombstone: boolean) { setAttachmentIds((ids) => ids.filter((key) => key !== item.id)); client.setQueryData<AssistV3Session>(assistKeys.session(session?.id), (current) => current ? { ...current, attachments: tombstone ? (current.attachments || []).map((entry) => entry.id === item.id ? item : entry) : (current.attachments || []).filter((entry) => entry.id !== item.id) } : current); }
  function composerCommand(command: AssistCommand) {
    if (command === 'goal') window.dispatchEvent(new Event('aiws:edit-goal'));
    else if (command === 'review') { const target = [...turns].reverse().find((turn) => turn.change_batch_id && ['ready', 'changes_requested', 'applied'].includes(turn.review_status)); if (target) openReview(target); else toast('当前线程没有可审查的变更'); }
    else if (command === 'fork' && session) fork(session);
    else if (command === 'btw') publishSelectionAsk({ selection: '', rect: null, pageUrl: window.location.href });
  }
  function backToChat() { setView('chat'); setReviewTarget(null); }

  return { projectId, scopeType, scopeId, scopeBreadcrumb, search, setSearch, archived, setArchived: showArchived, selectedId, setSelectedId, planNext, setPlanNext, profileId, model, setModel: selectModel, reasoning, setReasoning, configurationId, selectConfiguration, configurations, models, prompt, setPrompt, operationReferenceId, attachmentIds, setAttachmentIds, busy, view, session, sessions, profiles, stream, running, goal, operations, terminalCapabilities, terminalSelectorOpen, setTerminalSelectorOpen, reviewTarget, terminal, terminalRolledBack, setTerminal, createSession, rename, pin, archive, fork, deleteBranch, restoreDeleted, submit, stop, retry, openReview, openTerminal, openTerminalReview, resolveReview, showTerminal, showReview, addAttachment, attachmentDeleted, composerCommand, backToChat, toast, refresh, saveConfiguration, setGoal, clearGoal, setClarificationPolicy, respondUserInput, confirmOperation, undoOperation, reviseOperation, continueOperation };
}

export type AssistController = ReturnType<typeof useAssistController>;
