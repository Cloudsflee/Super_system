import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiV2 } from '../../api';
import { queryClient, workspaceQueryKey } from '../../query';
import { statusLabel } from '../../i18n';
export function OperationNotice({ id, projectId, onTerminal }: { id: string; projectId: string; onTerminal: () => void }) {
  const notified = useRef('');
  const query = useQuery({ queryKey: workspaceQueryKey({ actorId: sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor', teamId: '', projectId }, 'operations', { id }),
    queryFn: ({ signal }) => apiV2<{ operation?: { status: string; error_code?: string }; status?: string; error_code?: string }>(`/api/v2/operations/${encodeURIComponent(id)}`, { signal }),
    refetchInterval: query => { const data = query.state.data?.data; return ['queued', 'running', 'cancel_requested'].includes(data?.operation?.status || data?.status || '') ? 1500 : false; }
  }, queryClient);
  const operation = query.data?.data.operation || query.data?.data;
  const status = operation?.status || '';
  useEffect(() => { if (['succeeded', 'failed', 'cancelled'].includes(status) && notified.current !== id) { notified.current = id; onTerminal(); } }, [id, onTerminal, status]);
  return <span>操作 <code>{id}</code> · {status ? statusLabel(status) : query.error ? '状态查询失败，请刷新' : '查询状态中'} {operation?.error_code || ''}</span>;
}
