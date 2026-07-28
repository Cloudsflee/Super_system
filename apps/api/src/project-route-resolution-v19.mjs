/** Resolve a request to its authoritative Project. Resource identity always
 * wins over body/query hints so callers cannot spoof a different Project. */
export async function resolveProjectIdForContext(route, ctx, suppliedState = null) {
  const params = ctx.params || {},
    body = ctx.body || {},
    query = ctx.query || {};
  const explicitPath = params.projectId || (route.pattern.startsWith('/projects/:id') ? params.id : null);
  if (explicitPath) return String(explicitPath);
  const state = suppliedState || (await (await import('./state.mjs')).readStateSnapshot());
  if (!params.id) return body.project_id || query.project_id ? String(body.project_id || query.project_id) : null;
  const exchangeProject = resolveExchangeRequestProject(route.pattern, body, state, params.id);
  if (exchangeProject.matched) return exchangeProject.projectId;
  const directProject = findDirectProject(state, params.id);
  if (directProject) return directProject;
  return resolveSpecialProject(route.pattern, params, state);
}

function resolveExchangeRequestProject(pattern, body, state, id) {
  if (pattern.startsWith('/exchange-requests/')) {
    const request = state.exchange_requests?.find((item) => item.id === id);
    if (!request) return { matched: true, projectId: null };
    if (pattern.includes('/approve') && body.side === 'source')
      return { matched: true, projectId: request.source_project_id };
    if ((pattern.includes('/approve') && body.side === 'target') || pattern.endsWith('/context-packs'))
      return { matched: true, projectId: request.target_project_id };
    return { matched: true, projectId: null };
  }
  if (pattern.startsWith('/exchange-grants/'))
    return {
      matched: true,
      projectId: state.exchange_grants?.find((item) => item.id === id)?.target_project_id || null
    };
  return { matched: false };
}

function findDirectProject(state, id) {
  for (const collection of [
    'workspaces',
    'workflows',
    'workflow_executions',
    'task_executions',
    'repository_lines',
    'node_runs',
    'assets',
    'change_proposals',
    'agent_sessions',
    'assist_sessions',
    'assist_turns',
    'terminal_sessions',
    'deliveries',
    'delivery_policies',
    'repository_connections',
    'repository_targets',
    'repository_workspaces',
    'pull_request_intents',
    'exchange_requests',
    'exchange_grants',
    'assist_operations',
    'assist_change_batches',
    'attachments',
    'submissions',
    'runner_memory_candidates'
  ]) {
    const project = state[collection]?.find((item) => item.id === id)?.project_id || null;
    if (project) return project;
  }
  return null;
}

function resolveSpecialProject(pattern, params, state) {
  if (pattern.startsWith('/asset-versions/')) return resolveAssetVersionProject(params.id, state);
  if (pattern.startsWith('/context-packs/')) return resolveContextPackProject(params.id, state);
  if (pattern.startsWith('/context/v1/nodes/'))
    return state.context_nodes?.find((item) => item.id === params.id)?.project_id || null;
  if (pattern.startsWith('/context/v1/selections/'))
    return state.context_selections?.find((item) => item.id === params.id)?.project_id || null;
  if (pattern.startsWith('/approvals/')) return resolveApprovalProject(params, state);
  if (pattern.startsWith('/project-invitations/'))
    return state.project_invitations?.find((item) => item.id === params.id)?.project_id || null;
  if (['nodes', 'tasks', 'workstreams'].some((prefix) => pattern.startsWith(`/${prefix}/`)))
    return resolveWorkflowNodeProject(params.id, state);
  return null;
}

function resolveAssetVersionProject(id, state) {
  const version = state.asset_versions?.find((item) => item.id === id);
  return state.assets?.find((item) => item.id === version?.asset_id)?.project_id || null;
}

function resolveContextPackProject(id, state) {
  const pack = state.context_packs?.find((item) => item.id === id);
  if (pack?.project_id) return pack.project_id;
  const workspace = state.workspaces?.find((item) => item.id === pack?.source_workspace_id);
  if (workspace?.project_id) return workspace.project_id;
  return pack?.content_json?.project?.id ? String(pack.content_json.project.id) : null;
}

function resolveApprovalProject(params, state) {
  const approval =
    params.type === 'runtime'
      ? state.runtime_approvals?.find((item) => item.id === params.id)
      : state.change_proposals?.find((item) => item.id === params.id);
  if (approval?.project_id) return approval.project_id;
  if (approval?.turn_id) return state.assist_turns?.find((item) => item.id === approval.turn_id)?.project_id || null;
  return null;
}

function resolveWorkflowNodeProject(id, state) {
  const node = state.workflow_nodes?.find((item) => item.id === id),
    workflow = state.workflows?.find((item) => item.id === node?.workflow_id);
  return workflow?.project_id || null;
}

export function isProjectRoute(pattern = '') {
  return (
    /^\/context\/v1\/(?:map|search|nodes|selections|policy)/.test(pattern) ||
    /^\/(?:projects|workspaces|repository-workspaces|repository-lines|pull-request-intents|workflows|workflow-executions|task-executions|nodes|workstreams|tasks|runs|deliveries|delivery-policies|context-packs|assets|asset-versions|asset-candidates|change-proposals|approvals|agent-sessions|exchange-requests|exchange-grants|project-invitations|submissions|review)/.test(
      pattern
    ) ||
    /^\/assist\/(?:v2\/sessions|v3\/(?:sessions|turns|terminal-sessions|operations|change-batches|attachments))/.test(
      pattern
    ) ||
    /\/repository-(?:connections|targets)/.test(pattern) ||
    pattern === '/brief-templates/:templateId/apply'
  );
}
