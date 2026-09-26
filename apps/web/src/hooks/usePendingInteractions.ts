import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiV2 } from '../api';
import { queryClient, workspaceQueryKey } from '../query';

export type PendingInteraction = { id: string; action?: string; question?: string; status?: string; decision?: string; operation_id?: string; revision: number };
export type PendingInteractionsData = { approvals: PendingInteraction[]; inputs: PendingInteraction[]; count: number };

export function pendingInteractionsKey(projectId: string) {
  const scope = { actorId: sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor', teamId: '', projectId };
  return workspaceQueryKey(scope, 'pending-interactions', { status: 'pending' });
}

export function usePendingInteractions(projectId: string, enabled = true) {
  const queryKey = useMemo(() => pendingInteractionsKey(projectId), [projectId]);
  const query = useQuery({
    queryKey,
    enabled: enabled && Boolean(projectId),
    refetchInterval: 10_000,
    queryFn: async ({ signal }) => {
      const query = `?project_id=${encodeURIComponent(projectId)}&status=pending`;
      const [approvals, inputs] = await Promise.all([
        apiV2<{ approvals: PendingInteraction[] }>(`/api/v2/approvals${query}`, { signal }),
        apiV2<{ inputs: PendingInteraction[] }>(`/api/v2/user-inputs${query}`, { signal })
      ]);
      const values = { approvals: approvals.data.approvals || [], inputs: inputs.data.inputs || [] };
      return { ...values, count: values.approvals.length + values.inputs.length } satisfies PendingInteractionsData;
    }
  }, queryClient);
  return { ...query, queryKey };
}
