/* Explicitly public MCP surface. Internal/credential commands are never
 * inferred from the complete command registry. */
export const MCP_PUBLIC_TOOL_SNAPSHOT = Object.freeze([
  'project.create', 'project.update', 'project.get', 'projects.list', 'brief.create',
  'brief.confirm', 'workflow.create', 'context.source.create', 'context.pack.create',
  'context.rebuild', 'context.selection.create', 'context.policy.update',
  'context.projection.cancel', 'context.projection.retry',
  'context.map', 'context.search', 'context.read', 'context.status', 'context.packs.list',
  'operation.get', 'operation.wait', 'operation.events', 'operation.cancel'
]);
