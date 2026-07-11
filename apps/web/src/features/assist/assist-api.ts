import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, assistV3StreamUrl } from '../../api/client';
import type { AssistV3Event, AssistV3EventType, AssistV3Session, AssistV3Turn, CodexProfile } from '../../api/types';
import { useUi } from '../../state/ui';

export const assistKeys = {
  sessions: (projectId?: string, search = '', archived = false) => ['assist-v3-sessions', projectId || '', search, archived] as const,
  session: (id?: string) => ['assist-v3-session', id || ''] as const,
  review: (turnId?: string) => ['assist-v3-review', turnId || ''] as const,
  terminal: (id?: string) => ['assist-v3-terminal', id || ''] as const
};

export function useAssistSessions(projectId?: string, search = '', archived = false, enabled = true) {
  const query = new URLSearchParams();
  if (projectId) query.set('project_id', projectId);
  if (search.trim()) query.set('search', search.trim());
  if (archived) query.set('archived', 'only');
  query.set('limit', '100');
  return useQuery({
    queryKey: assistKeys.sessions(projectId, search, archived),
    queryFn: () => api<AssistV3Session[]>(`/assist/v3/sessions?${query}`),
    enabled: Boolean(projectId && enabled), refetchInterval: enabled ? 4_000 : false
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
  return useQuery({ queryKey: ['codex-profiles'], queryFn: () => api<CodexProfile[]>('/codex/profiles'), enabled });
}

const eventTypes: AssistV3EventType[] = ['queued', 'started', 'text', 'plan', 'command', 'file_change', 'test', 'mcp', 'search', 'usage', 'approval', 'reasoning_summary', 'status', 'terminal', 'completed', 'failed', 'stopped', 'interrupted', 'steered'];

export function useAssistEvents(sessionId?: string, enabled = true) {
  const [events, setEvents] = useState<AssistV3Event[]>([]);
  const [connected, setConnected] = useState(false);
  const cursor = useRef(0);
  const client = useQueryClient();
  useEffect(() => {
    setEvents([]); cursor.current = 0; setConnected(false);
    if (!sessionId || !enabled) return;
    const source = new EventSource(assistV3StreamUrl(sessionId, 0));
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    const consume = (raw: Event) => {
      const event = JSON.parse((raw as MessageEvent).data) as AssistV3Event;
      cursor.current = Math.max(cursor.current, Number(event.sequence || event.id || 0));
      setEvents((items) => items.some((item) => item.sequence === event.sequence) ? items : [...items, event].sort((a, b) => a.sequence - b.sequence));
      if (event.type === 'approval' && typeof event.data.approval_id === 'string') useUi.getState().showProposal(event.data.approval_id);
      if (['queued', 'started', 'completed', 'failed', 'stopped', 'interrupted', 'approval'].includes(event.type)) {
        void client.invalidateQueries({ queryKey: assistKeys.session(sessionId) });
        void client.invalidateQueries({ queryKey: ['assist-v3-sessions'] });
      }
    };
    for (const type of eventTypes) source.addEventListener(type, consume);
    return () => { source.close(); setConnected(false); };
  }, [sessionId, enabled, client]);
  return { events, connected, cursor: cursor.current };
}

export function hasActiveTurn(turns?: AssistV3Turn[]) {
  return Boolean(turns?.some((turn) => ['queued', 'preparing', 'running', 'waiting_approval', 'stopping'].includes(turn.status)));
}

export function activeTurn(turns?: AssistV3Turn[]) {
  return turns?.find((turn) => ['preparing', 'running', 'waiting_approval', 'stopping'].includes(turn.status)) || null;
}
