import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, json } from '../../api/client';
import type { AssistAttachment, AssistConfiguration, AssistGoal, AssistOperation, AssistV3Session, AssistV3Turn, TerminalSession } from '../../api/types';
import { describeAssistSurface, executeAssistOperation } from '../../components/assist/semantic-actions';
import { useUi } from '../../state/ui';
import { activeTurn, assistKeys, useAssistConfigurations, useAssistEvents, useAssistGoal, useAssistModels, useAssistOperations, useAssistSession, useAssistSessions, useCodexProfiles, useTerminalCapabilities } from './assist-api';
import type { ReviewTarget } from './DiffReviewPanel';

type FollowUp = 'queue' | 'steer' | 'interrupt';
type TerminalRuntime = 'linux_container' | 'windows_bridge' | 'host_dev';

export function useAssistController({ projectId, nodeId, enabled, route }: { projectId?: string; nodeId?: string; enabled: boolean; route: string }) {
  const [search, setSearch] = useState(''), [archived, setArchived] = useState(false), [selectedId, setSelectedId] = useState<string>();
  const [planNext, setPlanNext] = useState(false), [profileId, setProfileId] = useState(''), [configurationId, setConfigurationId] = useState('');
  const [model, setModelState] = useState(''), [reasoning, setReasoning] = useState(''), [prompt, setPrompt] = useState('');
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const [view, setView] = useState<'chat' | 'review' | 'terminal'>('chat'), [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [terminal, setTerminal] = useState<TerminalSession | null>(null), [terminalRolledBack, setTerminalRolledBack] = useState(false), [terminalSelectorOpen, setTerminalSelectorOpen] = useState(false);
  const processedOperations = useRef(new Set<string>());
  const sessions = useAssistSessions(projectId, search, archived, enabled), detail = useAssistSession(selectedId, enabled && !archived);
  const profiles = useCodexProfiles(enabled), models = useAssistModels(profileId, enabled), configurations = useAssistConfigurations(profileId, enabled);
  const stream = useAssistEvents(selectedId, enabled && !archived), goal = useAssistGoal(selectedId, enabled && !archived), operations = useAssistOperations(selectedId, enabled && !archived), terminalCapabilities = useTerminalCapabilities(enabled);
  const client = useQueryClient(), toast = useUi((state) => state.toast), session = detail.data, turns = session?.turns || [], running = activeTurn(turns);

  useEffect(() => { setSelectedId(undefined); setView('chat'); setTerminal(null); setReviewTarget(null); processedOperations.current.clear(); }, [projectId]);
  useEffect(() => { processedOperations.current.clear(); }, [selectedId]);
  useEffect(() => { const rows = sessions.data || []; if (!rows.length) { if (!sessions.isLoading) setSelectedId(undefined); return; } if (!selectedId || !rows.some((item) => item.id === selectedId)) setSelectedId(rows[0].id); }, [sessions.data, sessions.isLoading, selectedId]);
  useEffect(() => { const rows = profiles.data || [], active = rows.find((item) => item.is_active && !item.assist_configuration) || rows.find((item) => !item.assist_configuration); if (active && (!profileId || !rows.some((item) => item.id === profileId && !item.assist_configuration))) { setProfileId(active.id); setModelState(active.model || ''); setReasoning(active.reasoning || ''); } }, [profiles.data, profileId]);
  useEffect(() => { const catalog = models.data, entries = Array.isArray(catalog?.models) ? catalog.models : []; if (!entries.length) return; const selected = entries.find((item) => item.model === model) || entries.find((item) => item.model === catalog?.default_model) || entries[0]; if (!selected) return; if (!model) setModelState(selected.model); const efforts = selected.supportedReasoningEfforts.map((item) => item.reasoningEffort); if (!efforts.includes(reasoning)) setReasoning(selected.defaultReasoningEffort || efforts[0] || reasoning); }, [models.data, model, reasoning]);
  useEffect(() => { setAttachmentIds((ids) => ids.filter((item) => session?.attachments?.some((attachment) => attachment.id === item))); }, [session?.id, session?.attachments?.length]);
  useEffect(() => { let active = true; setTerminal(null); setTerminalRolledBack(false); if (!session?.id) return () => { active = false; }; const query = new URLSearchParams({ project_id: session.project_id, assist_session_id: session.id }); api<TerminalSession[]>(`/assist/v3/terminal-sessions?${query}`).then((items) => { if (active && items[0]) setTerminal(items[0]); }).catch(() => undefined); return () => { active = false; }; }, [session?.id, session?.project_id]);
  useEffect(() => {
    if (!Array.isArray(operations.data)) return;
    for (const event of stream.events.filter((item) => item.type === 'operation' && item.data.claimable === true && typeof item.data.operation_id === 'string')) {
      const operationId = String(event.data.operation_id); if (processedOperations.current.has(operationId)) continue;
      if (!operations.data.some((item) => item.id === operationId && item.status === 'pending')) continue;
      processedOperations.current.add(operationId);
      void executeAssistOperation(operationId, route).then(() => refresh()).catch((error) => toast((error as Error).message, 'error'));
    }
  }, [stream.events, route, operations.data]);

  async function perform(operation: () => Promise<void>) { setBusy(true); try { await operation(); } catch (error) { toast((error as Error).message, 'error'); } finally { setBusy(false); } }
  async function refresh(sessionId = selectedId) { await client.invalidateQueries({ queryKey: ['assist-v3-sessions'] }); if (sessionId) { await client.invalidateQueries({ queryKey: assistKeys.session(sessionId) }); await client.invalidateQueries({ queryKey: ['assist-v3-goal', sessionId] }); await client.invalidateQueries({ queryKey: ['assist-v3-operations', sessionId] }); } }
  function selectModel(value: string) { setModelState(value); const entry = models.data?.models?.find((item) => item.model === value); if (!entry) return; const efforts = entry.supportedReasoningEfforts.map((item) => item.reasoningEffort); if (!efforts.includes(reasoning)) { const fallback = entry.defaultReasoningEffort || efforts[0] || ''; setReasoning(fallback); if (fallback) toast(`模型 ${value} 使用默认 reasoning：${fallback}`); } }
  function selectConfiguration(value: string) { const item = configurations.data?.find((entry) => entry.id === value); if (!item) return; setConfigurationId(item.id); setModelState(item.model); setReasoning(item.reasoning); }
  function createSession() { if (!projectId) { toast('请先创建或选择项目，再新建 Assist 线程。', 'error'); return; } void perform(async () => { const created = await api<AssistV3Session>('/assist/v3/sessions', json('POST', { project_id: projectId, scope_type: nodeId ? 'node' : 'project', scope_id: nodeId || projectId, title: nodeId ? '节点 Assist' : '项目 Assist', view_context: { route } })); setArchived(false); setSelectedId(created.id); setView('chat'); await refresh(created.id); }); }
  function rename(item: AssistV3Session) { const title = window.prompt('重命名线程', item.title)?.trim(); if (!title || title === item.title) return; void perform(async () => { await api(`/assist/v3/sessions/${item.id}/rename`, json('POST', { title })); await refresh(item.id); }); }
  function pin(item: AssistV3Session) { void perform(async () => { await api(`/assist/v3/sessions/${item.id}/pin`, json('POST', { pinned: !item.pinned })); await refresh(item.id); }); }
  function archive(item: AssistV3Session) { void perform(async () => { await api(`/assist/v3/sessions/${item.id}/${archived ? 'restore' : 'archive'}`, json('POST')); if (archived) { setArchived(false); setSelectedId(item.id); } else if (selectedId === item.id) setSelectedId(undefined); await refresh(item.id); }); }
  function fork(item: AssistV3Session) { void perform(async () => { const created = await api<AssistV3Session>(`/assist/v3/sessions/${item.id}/fork`, json('POST', { from_turn_id: item.last_turn?.id, title: `${item.title} · Fork` })); setSelectedId(created.id); setView('chat'); await refresh(created.id); }); }

  function submit(behavior: FollowUp) { const collaborationMode = planNext ? 'plan' : 'default'; setPlanNext(false); void perform(async () => { if (!session || !projectId) return; const body = { content: prompt.trim(), collaboration_mode: collaborationMode, profile_id: profileId || undefined, configuration_id: configurationId || undefined, model, reasoning, attachment_ids: attachmentIds, view_context: { route, browser_instance_id: describeAssistSurface().browser_instance_id, surface: describeAssistSurface() } }; const endpoint = running ? `/assist/v3/sessions/${session.id}/follow-ups` : `/assist/v3/sessions/${session.id}/turns`; await api<AssistV3Turn>(endpoint, json('POST', running ? { ...body, behavior } : body)); setPrompt(''); await refresh(session.id); }); }
  function stop() { if (!running) return; void perform(async () => { await api(`/assist/v3/turns/${running.id}/stop`, json('POST', { reason: 'user_stop' })); await refresh(); }); }
  function retry(turn: AssistV3Turn) { void perform(async () => { await api(`/assist/v3/turns/${turn.id}/retry`, json('POST', { profile_id: profileId || turn.profile_id, configuration_id: configurationId || turn.configuration_id, model: model || turn.model, reasoning: reasoning || turn.reasoning, collaboration_mode: turn.collaboration_mode || 'default', view_context: { route, browser_instance_id: describeAssistSurface().browser_instance_id, surface: describeAssistSurface() } })); await refresh(); }); }
  async function saveConfiguration(name: string) { setBusy(true); try { const created = await api<AssistConfiguration>('/assist/v3/configurations', json('POST', { base_profile_id: profileId, name, model, reasoning })); await client.invalidateQueries({ queryKey: ['assist-v3-configurations', profileId] }); setConfigurationId(created.id); toast(`已保存配置“${created.name}”`); return true; } catch (error) { toast((error as Error).message, 'error'); return false; } finally { setBusy(false); } }
  function openTerminal(runtime: TerminalRuntime = 'linux_container') { if (!session || !projectId) return; setTerminalSelectorOpen(false); void perform(async () => { const created = await api<TerminalSession>('/assist/v3/terminal-sessions', json('POST', { project_id: projectId, assist_session_id: session.id, profile_id: profileId || undefined, configuration_id: configurationId || undefined, model, reasoning, runtime, cols: 120, rows: 32 })); setTerminal(created); setTerminalRolledBack(false); setView('terminal'); }); }
  function setGoal(input: Partial<AssistGoal>) { if (!session) return; void perform(async () => { await api(`/assist/v3/sessions/${session.id}/goal`, json('PUT', { ...input, profile_id: profileId, configuration_id: configurationId || undefined, model, reasoning })); await refresh(); }); }
  function clearGoal() { if (!session) return; void perform(async () => { await api(`/assist/v3/sessions/${session.id}/goal`, { method: 'DELETE' }); await refresh(); }); }
  function respondUserInput(turnId: string, itemId: string, answers: Record<string, { answers: string[] }>) { void perform(async () => { await api(`/assist/v3/turns/${turnId}/user-input/${encodeURIComponent(itemId)}/respond`, json('POST', { answers })); await refresh(); }); }
  function confirmOperation(item: AssistOperation, approved: boolean) { void perform(async () => { await api(`/assist/v3/operations/${item.id}/confirm`, json('POST', { approved })); await refresh(); }); }
  function undoOperation(item: AssistOperation, force = false) { void perform(async () => { await api(`/assist/v3/operations/${item.inverse_of || item.id}/undo`, json('POST', { force })); await refresh(); }); }
  function openReview(turn: AssistV3Turn) { setReviewTarget({ kind: 'turn', id: turn.id }); setView('review'); }
  function openTerminalReview() { if (terminal && !terminalRolledBack) { setReviewTarget({ kind: 'terminal', id: terminal.id }); setView('review'); } }
  function resolveReview(action: 'apply' | 'rollback') { if (reviewTarget?.kind === 'terminal' && action === 'rollback') setTerminalRolledBack(true); backToChat(); void refresh(); }
  function showTerminal() { if (terminal) setView('terminal'); else setTerminalSelectorOpen(true); }
  function showReview() { if (reviewTarget) setView('review'); }
  function addAttachment(item: AssistAttachment) { client.setQueryData<AssistV3Session>(assistKeys.session(session?.id), (current) => current ? { ...current, attachments: [...(current.attachments || []), item] } : current); }
  function backToChat() { setView('chat'); setReviewTarget(null); }

  return { search, setSearch, archived, setArchived, selectedId, setSelectedId, planNext, setPlanNext, profileId, model, setModel: selectModel, reasoning, setReasoning, configurationId, selectConfiguration, configurations, models, prompt, setPrompt, attachmentIds, setAttachmentIds, busy, view, session, sessions, profiles, stream, running, goal, operations, terminalCapabilities, terminalSelectorOpen, setTerminalSelectorOpen, reviewTarget, terminal, terminalRolledBack, setTerminal, createSession, rename, pin, archive, fork, submit, stop, retry, openReview, openTerminal, openTerminalReview, resolveReview, showTerminal, showReview, addAttachment, backToChat, toast, refresh, saveConfiguration, setGoal, clearGoal, respondUserInput, confirmOperation, undoOperation };
}
