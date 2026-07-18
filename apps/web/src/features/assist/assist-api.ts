import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, assistV3StreamUrl } from '../../api/client';
import type { AssistConfiguration, AssistGoal, AssistModelCatalog, AssistOperation, AssistV3Event, AssistV3EventType, AssistV3Session, AssistV3Turn, CodexProfile, TerminalCapabilities } from '../../api/types';
import { useUi } from '../../state/ui';

export const assistKeys = {
  sessions: (projectId?: string, scopeType?: string, scopeId?: string, search = '', archived = false) => ['assist-v3-sessions', projectId || '', scopeType || '', scopeId || '', search, archived] as const,
  session: (id?: string) => ['assist-v3-session', id || ''] as const,
  review: (turnId?: string) => ['assist-v3-review', turnId || ''] as const,
  terminal: (id?: string) => ['assist-v3-terminal', id || ''] as const
};

export function useAssistSessions(projectId?: string, scopeType?: string, scopeId?: string, search = '', archived = false, enabled = true) {
  const query = new URLSearchParams();
  if (projectId) query.set('project_id', projectId);
  if (scopeType) query.set('scope_type', scopeType);
  if (scopeId) query.set('scope_id', scopeId);
  if (search.trim()) query.set('search', search.trim());
  if (archived) query.set('archived', 'only');
  else query.set('deleted', 'include');
  query.set('limit', '100');
  return useQuery({
    queryKey: assistKeys.sessions(projectId, scopeType, scopeId, search, archived),
    queryFn: () => api<AssistV3Session[]>(`/assist/v3/sessions?${query}`),
    enabled: Boolean(projectId && scopeType && scopeId && enabled), refetchInterval: enabled ? 4_000 : false
  });
}

export function useAssistSession(sessionId?: string, enabled = true) {
  return useQuery({
    queryKey: assistKeys.session(sessionId),
    queryFn: () => api<AssistV3Session>(`/assist/v3/sessions/${sessionId}`),
    enabled: Boolean(sessionId && enabled),
    refetchInterval: (query) => hasActiveTurn(query.state.data?.turns) ? 1_500 : false
  });
}

export function useCodexProfiles(enabled = true) {
  return useQuery({ queryKey: ['codex-profiles'], queryFn: () => api<CodexProfile[]>('/codex/profiles'), select: (items) => items.filter((item) => item.status === 'validated'), enabled });
}

export function useAssistModels(profileId?: string, enabled = true) { return useQuery({ queryKey: ['assist-v3-models', profileId || ''], queryFn: () => api<AssistModelCatalog>(`/assist/v3/models?profile_id=${encodeURIComponent(profileId || '')}`), enabled: Boolean(profileId && enabled) }); }
export function useAssistConfigurations(profileId?: string, enabled = true) { const query = profileId ? `?base_profile_id=${encodeURIComponent(profileId)}` : ''; return useQuery({ queryKey: ['assist-v3-configurations', profileId || ''], queryFn: () => api<AssistConfiguration[]>(`/assist/v3/configurations${query}`), enabled }); }
export function useAssistGoal(sessionId?: string, enabled = true) { return useQuery({ queryKey: ['assist-v3-goal', sessionId || ''], queryFn: () => api<{ goal: AssistGoal | null }>(`/assist/v3/sessions/${sessionId}/goal`), enabled: Boolean(sessionId && enabled), refetchInterval: enabled ? 10_000 : false }); }
export function useAssistOperations(sessionId?: string, enabled = true) { return useQuery({ queryKey: ['assist-v3-operations', sessionId || ''], queryFn: () => api<AssistOperation[]>(`/assist/v3/operations?session_id=${encodeURIComponent(sessionId || '')}`), enabled: Boolean(sessionId && enabled), refetchInterval: enabled ? 3_000 : false }); }
export function useTerminalCapabilities(enabled = true) { return useQuery({ queryKey: ['assist-v3-terminal-capabilities'], queryFn: () => api<TerminalCapabilities>('/assist/v3/terminal-capabilities'), enabled, refetchInterval: enabled ? 10_000 : false }); }

const eventTypes: AssistV3EventType[] = ['queued', 'started', 'text', 'plan', 'command', 'file_change', 'diff', 'test', 'mcp', 'search', 'usage', 'approval', 'reasoning_summary', 'request_user_input', 'request_user_input_resolved', 'operation', 'status', 'terminal', 'completed', 'failed', 'stopped', 'interrupted', 'steered'];

export function useAssistEvents(sessionId?: string, enabled = true) {
  const [events, setEvents] = useState<AssistV3Event[]>([]);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const cursor = useRef(0);
  const client = useQueryClient();
  useEffect(() => {
    setEvents([]); cursor.current = 0; setConnected(false); setReconnecting(false);
    if (!sessionId || !enabled) return;
    const source = new EventSource(assistV3StreamUrl(sessionId, 0));
    source.onopen = () => { setConnected(true); setReconnecting(false); };
    source.onerror = () => { setConnected(false); setReconnecting(true); };
    const consume = (raw: Event) => {
      const event = JSON.parse((raw as MessageEvent).data) as AssistV3Event;
      cursor.current = Math.max(cursor.current, Number(event.sequence || event.id || 0));
      setEvents((items) => items.some((item) => item.sequence === event.sequence) ? items : [...items, event].sort((a, b) => a.sequence - b.sequence));
      if (event.type === 'approval' && typeof event.data.approval_id === 'string') useUi.getState().showProposal(event.data.approval_id);
      if (['queued', 'started', 'completed', 'failed', 'stopped', 'interrupted', 'approval', 'request_user_input', 'request_user_input_resolved', 'operation'].includes(event.type)) {
        void client.invalidateQueries({ queryKey: assistKeys.session(sessionId) });
        void client.invalidateQueries({ queryKey: ['assist-v3-sessions'] });
      }
      if (event.type === 'operation') void client.invalidateQueries({ queryKey: ['assist-v3-operations', sessionId] });
    };
    for (const type of eventTypes) source.addEventListener(type, consume);
    return () => { source.close(); setConnected(false); setReconnecting(false); };
  }, [sessionId, enabled, client]);
  return { events, connected, reconnecting, cursor: cursor.current };
}

export function hasActiveTurn(turns?: AssistV3Turn[]) {
  return Boolean(turns?.some((turn) => ['queued', 'preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping'].includes(turn.status)));
}

export function activeTurn(turns?: AssistV3Turn[]) {
  return turns?.find((turn) => ['preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping'].includes(turn.status)) || null;
}
