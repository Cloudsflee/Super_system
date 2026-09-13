import { useCallback, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiV2, type ApiV2Envelope } from '../../api';
import { queryClient, workspaceQueryKey } from '../../query';
import type { P3Project, Brief, Intake, Workflow, Generation, Requirement, RepositoryConnection, RepositoryLine, ProviderProfile, RunnerProfile, ContextPack } from './workflowTypes';

type Detail = { project?: P3Project & { brief?: Brief; workflow?: Workflow }; brief?: Brief; workflow?: Workflow };
export function useProjectWorkflowData(projectId: string, enabled = true, showArchived = false) {
  const actorId = sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor';
  const scope = useMemo(() => ({ actorId, teamId: '', projectId }), [actorId, projectId]);
  const base = `/api/v2/projects/${encodeURIComponent(projectId)}`;
  const key = (resource: string) => workspaceQueryKey(scope, resource);
  const active = enabled && Boolean(projectId);
  const projectsQuery = useQuery({ queryKey: workspaceQueryKey({ ...scope, projectId: '' }, 'projects', { showArchived }), enabled,
    queryFn: ({ signal }) => apiV2<{ projects: P3Project[] }>(`/api/v2/projects?include_archived=${showArchived}`, { signal }) }, queryClient);
  const projectQuery = useQuery({ queryKey: key('project'), enabled: active, queryFn: ({ signal }) => apiV2<Detail>(base, { signal }) }, queryClient);
  const briefQuery = useQuery({ queryKey: key('brief'), enabled: active, queryFn: async ({ signal }) => {
    const [intake, briefs] = await Promise.all([apiV2<{ intake: Intake }>(`${base}/intake`, { signal }), apiV2<{ briefs: Array<Brief & { content?: Record<string, unknown>; content_sha256?: string }> }>(`${base}/briefs`, { signal })]);
    return { intake: intake.data.intake || null, briefs: briefs.data.briefs || [] };
  } }, queryClient);
  const repositoryQuery = useQuery({ queryKey: key('repository'), enabled: active, queryFn: async ({ signal }) => {
    const [connections, lines] = await Promise.all([apiV2<{ connections: RepositoryConnection[] }>(`${base}/repository-connections`, { signal }), apiV2<{ lines: RepositoryLine[] }>(`${base}/repository-lines`, { signal })]);
    return { connections: connections.data.connections || [], lines: lines.data.lines || [] };
  } }, queryClient);
  const workflowQuery = useQuery({ queryKey: key('workflow'), enabled: active, queryFn: ({ signal }) => apiV2<{ workflow: Workflow }>(`${base}/workflow-draft`, { signal }) }, queryClient);
  const generationQuery = useQuery({ queryKey: key('generation'), enabled: active, queryFn: async ({ signal }) => {
    const result = await apiV2<{ generations: Generation[] }>(`${base}/workflow-generations`, { signal });
    return Promise.all((result.data.generations || []).map(async row => {
      const detail = await apiV2<{ generation?: Generation; critic?: Generation['critic']; proposal?: Generation['proposal'] }>(`/api/v2/workflow-generations/${encodeURIComponent(row.id)}`, { signal });
      return { ...row, ...detail.data.generation, critic: detail.data.critic ?? detail.data.generation?.critic ?? row.critic, proposal: detail.data.proposal ?? detail.data.generation?.proposal ?? row.proposal };
    }));
  }, refetchInterval: query => query.state.data?.some(row => ['queued', 'running', 'critic_pending'].includes(row.phase)) ? 1500 : false }, queryClient);
  const requirementQuery = useQuery({ queryKey: key('requirements'), enabled: active, queryFn: ({ signal }) => apiV2<{ requirements: Requirement[] }>(`${base}/outcome-requirements`, { signal }) }, queryClient);
  const profileQuery = useQuery({ queryKey: key('provider'), enabled: active, queryFn: ({ signal }) => apiV2<{ profiles: ProviderProfile[] }>('/api/v2/profiles', { signal }) }, queryClient);
  const runnerQuery = useQuery({ queryKey: key('runner'), enabled: active, queryFn: ({ signal }) => apiV2<{ profiles: RunnerProfile[] }>('/api/v2/runners/profiles', { signal }) }, queryClient);
  const contextQuery = useQuery({ queryKey: key('context'), enabled: active, queryFn: ({ signal }) => apiV2<{ packs: ContextPack[] }>(`${base}/context/packs`, { signal }) }, queryClient);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['v2', scope.actorId, scope.teamId, scope.projectId] });
  }, [scope]);
  useEffect(() => () => { void queryClient.cancelQueries({ queryKey: ['v2', scope.actorId, scope.teamId, scope.projectId] }); }, [scope]);
  // The existing event synchronizer invalidates workflow. Include the dependent
  // generation and head queries without refreshing any local editor state.
  useEffect(() => queryClient.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'invalidate') return;
    const queryKey = event.query.queryKey;
    if (queryKey[1] !== scope.actorId || queryKey[3] !== projectId) return;
    const resources = queryKey[4] === 'workflow' ? ['generation', 'project'] : queryKey[4] === 'project' ? ['brief', 'repository'] : queryKey[4] === 'outcome' ? ['requirements'] : [];
    for (const resource of resources) void queryClient.invalidateQueries({ queryKey: workspaceQueryKey(scope, resource) });
  }), [scope, projectId]);
  const expanded = projectQuery.data?.data;
  const project = expanded?.project || null;
  const brief = useMemo(() => {
    const head = expanded?.brief || expanded?.project?.brief;
    const revisions = briefQuery.data?.briefs || [];
    const currentRevision = head?.current_revision || project?.current_brief_revision || revisions[0]?.current_revision || revisions[0]?.revision || 0;
    const row = revisions.find(item => (item.current_revision || item.revision) === currentRevision) || revisions[0];
    if (!head && !row) return null;
    const current = row?.content ? { revision: row.revision || currentRevision, content: row.content, content_sha256: row.content_sha256 } : row?.current || head?.current;
    return { ...row, ...head, project_id: projectId, current_revision: currentRevision, confirmed_revision: head?.confirmed_revision ?? project?.confirmed_brief_revision ?? row?.confirmed_revision, current } as Brief;
  }, [expanded, briefQuery.data, project, projectId]);
  const required = [projectQuery, briefQuery, workflowQuery, repositoryQuery, generationQuery, requirementQuery];
  const error = projectsQuery.error || required.find(query => query.error)?.error;
  return {
    project, projects: projectsQuery.data?.data.projects || [], brief, intake: briefQuery.data?.intake || null,
    workflow: workflowQuery.data?.data.workflow || expanded?.workflow || expanded?.project?.workflow || null,
    connections: repositoryQuery.data?.connections || [], lines: repositoryQuery.data?.lines || [],
    generations: generationQuery.data || [], requirements: requirementQuery.data?.data.requirements || [],
    profiles: profileQuery.data?.data.profiles || [], runnerProfiles: runnerQuery.data?.data.profiles || [], contextPacks: contextQuery.data?.data.packs || [],
    prerequisiteError: profileQuery.error || runnerQuery.error || contextQuery.error,
    loading: !error && (projectId ? required.some(query => query.isPending) : projectsQuery.isPending), error, refresh,
    loadProjects: async () => { await projectsQuery.refetch({ throwOnError: true }); },
    replaceWorkflow: (workflow: Workflow) => queryClient.setQueryData<ApiV2Envelope<{ workflow: Workflow }>>(key('workflow'), previous => previous ? { ...previous, data: { workflow } } : previous)
  };
}
