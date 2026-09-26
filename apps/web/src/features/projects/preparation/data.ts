import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiV2 } from '../../../api';
import { queryClient, workspaceQueryKey } from '../../../query';

export type PreparationConnection = { id: string; project_id: string; provider: string; source_kind: string; source_revision?: string; source_hash?: string; status: string; revision: number; metadata?: Record<string, unknown> };
export type PreparationLine = { id: string; status: string; line_kind?: string; source_revision?: string; source_hash?: string; revision: number; updated_at?: string; fault_code?: string; fault?: Record<string, unknown> };
export type PreparationWorkspace = { id: string; line_id: string; status: string; relative_path: string; revision: number; updated_at?: string; error_code?: string };
export type PreparationPack = { id: string; status: string; pack_hash: string; revision: number; memory_manifest?: { token_budget?: number; token_used?: number } };
export type PreparationProfile = { id: string; provider: string; label?: string; status: string; revision?: number; lifecycle_status?: string };

export type PreparationRepositorySnapshot = {
  connections: PreparationConnection[];
  lines: PreparationLine[];
  workspaces: PreparationWorkspace[];
};

function scopeFor(projectId: string) {
  return {
    actorId: sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor',
    teamId: '',
    projectId
  };
}

/** Shared preparation data owner for ProjectWorkflow and PreparationPanel. */
export function useProjectPreparationData(projectId: string, enabled = true) {
  const actorId = sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor';
  const scope = useMemo(() => ({ ...scopeFor(projectId), actorId }), [actorId, projectId]);
  const base = `/api/v2/projects/${encodeURIComponent(projectId)}`;
  const active = enabled && Boolean(projectId);
  const key = useCallback((resource: string) => workspaceQueryKey(scope, resource), [scope]);
  const repositoryQuery = useQuery({
    queryKey: key('repository'),
    enabled: active,
    queryFn: async ({ signal }) => {
      const [connections, lines, workspaces] = await Promise.all([
        apiV2<{ connections: PreparationConnection[] }>(`${base}/repository-connections`, { signal }),
        apiV2<{ lines: PreparationLine[] }>(`${base}/repository-lines`, { signal }),
        apiV2<{ workspaces: PreparationWorkspace[] }>(`${base}/repository-workspaces`, { signal })
      ]);
      return {
        connections: connections.data.connections || [],
        lines: lines.data.lines || [],
        workspaces: workspaces.data.workspaces || []
      } satisfies PreparationRepositorySnapshot;
    }
  }, queryClient);
  const profileQuery = useQuery({
    queryKey: key('provider'),
    enabled: active,
    queryFn: ({ signal }) => apiV2<{ profiles: PreparationProfile[] }>('/api/v2/profiles', { signal })
  }, queryClient);
  const packQuery = useQuery({
    queryKey: key('context'),
    enabled: active,
    queryFn: ({ signal }) => apiV2<{ packs: PreparationPack[] }>(`${base}/context/packs`, { signal })
  }, queryClient);
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: key('repository') }),
      queryClient.invalidateQueries({ queryKey: key('provider') }),
      queryClient.invalidateQueries({ queryKey: key('context') })
    ]);
  }, [key]);
  const upsertWorkspace = useCallback((workspace: PreparationWorkspace) => {
    queryClient.setQueryData<PreparationRepositorySnapshot>(key('repository'), (current) => ({
      connections: current?.connections || [],
      lines: current?.lines || [],
      workspaces: [...(current?.workspaces || []).filter((item) => item.id !== workspace.id), workspace]
    }));
  }, [key]);
  const replacePacks = useCallback((packs: PreparationPack[]) => {
    queryClient.setQueryData<{ data: { packs: PreparationPack[] } }>(key('context'), (current) => current ? { ...current, data: { ...current.data, packs } } : current);
  }, [key]);
  const repository = repositoryQuery.data || { connections: [], lines: [], workspaces: [] };
  const profiles = profileQuery.data?.data.profiles || [];
  const packs = packQuery.data?.data.packs || [];
  return {
    ...repository,
    profiles,
    packs,
    loading: repositoryQuery.isPending || profileQuery.isPending || packQuery.isPending,
    error: repositoryQuery.error || profileQuery.error || packQuery.error,
    refresh,
    upsertWorkspace,
    replacePacks
  };
}
