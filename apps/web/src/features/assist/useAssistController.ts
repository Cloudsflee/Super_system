import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, json } from '../../api/client';
import type { AssistAttachment, AssistComposerMode, AssistV3Session, AssistV3Turn, CodexProfile, TerminalSession, UiAction } from '../../api/types';
import { describeAssistSurface, dispatchSemanticAction } from '../../components/assist/semantic-actions';
import { useUi } from '../../state/ui';
import { activeTurn, assistKeys, useAssistEvents, useAssistSession, useAssistSessions, useCodexProfiles } from './assist-api';
import type { ReviewTarget } from './DiffReviewPanel';

type FollowUp = 'queue' | 'steer' | 'interrupt';

export function useAssistController({ projectId, nodeId, enabled, route }: { projectId?: string; nodeId?: string; enabled: boolean; route: string }) {
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [mode, setMode] = useState<AssistComposerMode>('ask');
  const [profileId, setProfileId] = useState('');
  const [model, setModel] = useState('');
  const [reasoning, setReasoning] = useState('high');
  const [prompt, setPrompt] = useState('');
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'chat' | 'review' | 'terminal'>('chat');
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [terminal, setTerminal] = useState<TerminalSession | null>(null);
  const [terminalRolledBack, setTerminalRolledBack] = useState(false);
  const sessions = useAssistSessions(projectId, search, archived, enabled);
  const detail = useAssistSession(selectedId, enabled && !archived);
  const profiles = useCodexProfiles(enabled);
  const stream = useAssistEvents(selectedId, enabled && !archived);
  const client = useQueryClient();
  const toast = useUi((state) => state.toast);
  const session = detail.data;
  const turns = session?.turns || [];
  const running = activeTurn(turns);

  useEffect(() => { setSelectedId(undefined); setView('chat'); setTerminal(null); setReviewTarget(null); }, [projectId]);
  useEffect(() => {
    const rows = sessions.data || [];
    if (!rows.length) { if (!sessions.isLoading) setSelectedId(undefined); return; }
    if (!selectedId || !rows.some((item) => item.id === selectedId)) setSelectedId(rows[0].id);
  }, [sessions.data, sessions.isLoading, selectedId]);
  useEffect(() => {
    const rows = profiles.data || [], active = rows.find((item) => item.is_active) || rows[0];
    if (active && (!profileId || !rows.some((item) => item.id === profileId))) selectProfile(active.id);
    else if (!profiles.isLoading && !rows.length) { setProfileId(''); setModel(''); }
  }, [profiles.data, profiles.isLoading, profileId]);
  useEffect(() => { setAttachmentIds((ids) => ids.filter((id) => session?.attachments?.some((item) => item.id === id))); }, [session?.id, session?.attachments?.length]);
  useEffect(() => {
    let active = true; setTerminal(null); setTerminalRolledBack(false);
    if (!session?.id) return () => { active = false; };
    const query = new URLSearchParams({ project_id: session.project_id, assist_session_id: session.id });
    api<TerminalSession[]>(`/assist/v3/terminal-sessions?${query}`).then((items) => { if (active && items[0]) setTerminal(items[0]); }).catch(() => undefined);
    return () => { active = false; };
  }, [session?.id, session?.project_id]);

  async function perform(operation: () => Promise<void>) { setBusy(true); try { await operation(); } catch (error) { toast((error as Error).message, 'error'); } finally { setBusy(false); } }
  async function refresh(sessionId = selectedId) {
    await client.invalidateQueries({ queryKey: ['assist-v3-sessions'] });
    if (sessionId) await client.invalidateQueries({ queryKey: assistKeys.session(sessionId) });
  }
  function selectProfile(id: string) {
    setProfileId(id);
    const profile = profiles.data?.find((item) => item.id === id);
    if (profile) { setModel(profile.model || ''); setReasoning(profile.reasoning || 'high'); }
  }
  function createSession() {
    if (!projectId) { toast('请先创建或选择项目，再新建 Assist 线程。', 'error'); return; }
    void perform(async () => {
    const created = await api<AssistV3Session>('/assist/v3/sessions', json('POST', { project_id: projectId, scope_type: nodeId ? 'node' : 'project', scope_id: nodeId || projectId, title: nodeId ? '节点 Assist' : '项目 Assist', view_context: { route } }));
    setArchived(false); setSelectedId(created.id); setView('chat'); await refresh(created.id);
    });
  }
  function rename(item: AssistV3Session) { const title = window.prompt('重命名线程', item.title)?.trim(); if (!title || title === item.title) return; void perform(async () => { await api(`/assist/v3/sessions/${item.id}/rename`, json('POST', { title })); await refresh(item.id); }); }
  function pin(item: AssistV3Session) { void perform(async () => { await api(`/assist/v3/sessions/${item.id}/pin`, json('POST', { pinned: !item.pinned })); await refresh(item.id); }); }
  function archive(item: AssistV3Session) { void perform(async () => {
    await api(`/assist/v3/sessions/${item.id}/${archived ? 'restore' : 'archive'}`, json('POST'));
    if (archived) { setArchived(false); setSelectedId(item.id); } else if (selectedId === item.id) setSelectedId(undefined);
    await refresh(item.id);
  }); }
  function fork(item: AssistV3Session) { void perform(async () => { const created = await api<AssistV3Session>(`/assist/v3/sessions/${item.id}/fork`, json('POST', { from_turn_id: item.last_turn?.id, title: `${item.title} · Fork` })); setSelectedId(created.id); setView('chat'); await refresh(created.id); }); }

  function submit(behavior: FollowUp) { void perform(async () => {
    if (!session || !projectId) return;
    if (mode === 'cli') {
      const created = await api<TerminalSession>('/assist/v3/terminal-sessions', json('POST', { project_id: projectId, assist_session_id: session.id, profile_id: profileId || undefined, model, reasoning, cols: 120, rows: 32 }));
      setTerminal(created); setTerminalRolledBack(false); setView('terminal'); return;
    }
    const body = { content: prompt.trim(), mode, profile_id: profileId || undefined, model, reasoning, attachment_ids: attachmentIds, view_context: { route, surface: describeAssistSurface() } };
    const path = running ? `/assist/v3/sessions/${session.id}/follow-ups` : `/assist/v3/sessions/${session.id}/turns`;
    await api<AssistV3Turn>(path, json('POST', running ? { ...body, behavior } : body));
    setPrompt(''); await refresh(session.id);
  }); }
  function stop() { if (!running) return; void perform(async () => { await api(`/assist/v3/turns/${running.id}/stop`, json('POST', { reason: 'user_stop' })); await refresh(); }); }
  function retry(turn: AssistV3Turn) { void perform(async () => { await api(`/assist/v3/turns/${turn.id}/retry`, json('POST', { profile_id: profileId || turn.profile_id, model: model || turn.model, reasoning: reasoning || turn.reasoning, view_context: { route, surface: describeAssistSurface() } })); await refresh(); }); }
  async function saveConfiguration(name: string) {
    setBusy(true);
    try {
      const created = await api<CodexProfile>('/assist/v3/configurations', json('POST', { base_profile_id: profileId, name, model, reasoning }));
      client.setQueryData<CodexProfile[]>(['codex-profiles'], (current) => [...(current || []).filter((item) => item.id !== created.id), created]);
      setProfileId(created.id); setModel(created.model || model); setReasoning(created.reasoning || reasoning);
      toast(`已保存配置“${created.name}”`); return true;
    } catch (error) { toast((error as Error).message, 'error'); return false; }
    finally { setBusy(false); }
  }
  function applyPageAction(turn: AssistV3Turn, action: UiAction) { void perform(async () => {
    const result = await dispatchSemanticAction(action);
    await api<UiAction>(`/assist/v3/turns/${turn.id}/actions/${action.id}/result`, json('POST', { ok: result.handled, result }));
    await refresh(turn.session_id);
    if (!result.handled) throw new Error(String(result.error || '当前页面上找不到该字段'));
    toast('页面草稿已更新');
  }); }
  function openReview(turn: AssistV3Turn) { setReviewTarget({ kind: 'turn', id: turn.id }); setView('review'); }
  function openTerminalReview() { if (terminal && !terminalRolledBack) { setReviewTarget({ kind: 'terminal', id: terminal.id }); setView('review'); } }
  function resolveReview(action: 'apply' | 'rollback') { if (reviewTarget?.kind === 'terminal' && action === 'rollback') setTerminalRolledBack(true); backToChat(); void refresh(); }
  function showTerminal() { if (terminal) setView('terminal'); }
  function showReview() { if (reviewTarget) setView('review'); }
  function addAttachment(item: AssistAttachment) {
    client.setQueryData<AssistV3Session>(assistKeys.session(session?.id), (current) => current ? { ...current, attachments: [...(current.attachments || []), item] } : current);
  }
  function backToChat() { setView('chat'); setReviewTarget(null); }

  return {
    search, setSearch, archived, setArchived, selectedId, setSelectedId, mode, setMode, profileId, setProfileId: selectProfile, model, setModel, reasoning, setReasoning,
    prompt, setPrompt, attachmentIds, setAttachmentIds, busy, view, session, sessions, profiles, stream, running,
    reviewTarget, terminal, terminalRolledBack, setTerminal, createSession, rename, pin, archive, fork, submit, stop, retry, openReview,
    openTerminalReview, resolveReview, showTerminal, showReview, addAttachment, backToChat, toast, refresh, saveConfiguration, applyPageAction
  };
}
