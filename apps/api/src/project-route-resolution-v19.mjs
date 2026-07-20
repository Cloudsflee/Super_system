/** Resolve a request to its authoritative Project. Resource identity always
 * wins over body/query hints so callers cannot spoof a different Project. */
export async function resolveProjectIdForContext(route, ctx, suppliedState = null) {
  const params = ctx.params || {}, body = ctx.body || {}, query = ctx.query || {};
  const explicitPath = params.projectId || (route.pattern.startsWith('/projects/:id') ? params.id : null);
  if (explicitPath) return String(explicitPath);
  const state = suppliedState || await (await import('./state.mjs')).readState();
  if (params.id && route.pattern.startsWith('/exchange-requests/')) {
    const request = state.exchange_requests?.find((item) => item.id === params.id);
    if (!request) return null;
    if (route.pattern.includes('/approve') && body.side === 'source') return request.source_project_id;
    if (route.pattern.includes('/approve') && body.side === 'target') return request.target_project_id;
    if (route.pattern.endsWith('/context-packs')) return request.target_project_id;
    return null;
  }
  if (params.id && route.pattern.startsWith('/exchange-grants/')) return state.exchange_grants?.find((item) => item.id === params.id)?.target_project_id || null;
  const find = (collection, key) => state[collection]?.find((item) => item.id === key)?.project_id || null;
  for (const collection of ['workspaces', 'workflows', 'node_runs', 'assets', 'asset_versions', 'change_proposals', 'agent_sessions', 'assist_sessions', 'assist_turns', 'terminal_sessions', 'deliveries', 'delivery_policies', 'repository_connections', 'repository_targets', 'exchange_requests', 'exchange_grants', 'assist_operations', 'assist_change_batches', 'attachments', 'submissions', 'runner_memory_candidates']) { const project = find(collection, params.id); if (project) return project; }
  if (params.id && route.pattern.startsWith('/context-packs/')) {
    const pack = state.context_packs?.find((item) => item.id === params.id);
    if (pack?.project_id) return pack.project_id;
    const workspace = state.workspaces?.find((item) => item.id === pack?.source_workspace_id);
    if (workspace?.project_id) return workspace.project_id;
    if (pack?.content_json?.project?.id) return String(pack.content_json.project.id);
  }
  if (params.id && route.pattern.startsWith('/approvals/')) {
    const approval = params.type === 'runtime' ? state.runtime_approvals?.find((item) => item.id === params.id) : state.change_proposals?.find((item) => item.id === params.id);
    if (approval?.project_id) return approval.project_id;
    if (approval?.turn_id) return state.assist_turns?.find((item) => item.id === approval.turn_id)?.project_id || null;
  }
  if (params.id && route.pattern.startsWith('/project-invitations/')) return state.project_invitations?.find((item) => item.id === params.id)?.project_id || null;
  if (params.id && ['nodes', 'tasks', 'workstreams'].some((prefix) => route.pattern.startsWith(`/${prefix}/`))) {
    const node = state.workflow_nodes?.find((item) => item.id === params.id), workflow = state.workflows?.find((item) => item.id === node?.workflow_id);
    return workflow?.project_id || null;
  }
  if (params.id) return null;
  return body.project_id || query.project_id ? String(body.project_id || query.project_id) : null;
}

export function isProjectRoute(pattern = '') {
  return /^\/(?:projects|workspaces|workflows|nodes|workstreams|tasks|runs|deliveries|delivery-policies|context-packs|assets|asset-candidates|change-proposals|approvals|agent-sessions|exchange-requests|exchange-grants|project-invitations|submissions|review)/.test(pattern)
    || /^\/assist\/(?:v2\/sessions|v3\/(?:sessions|turns|terminal-sessions|operations|change-batches|attachments))/.test(pattern)
    || /\/repository-(?:connections|targets)/.test(pattern) || pattern === '/brief-templates/:templateId/apply';
}
