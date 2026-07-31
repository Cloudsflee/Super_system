import { compareContextNodes } from '../../../packages/system-context/src/index.mjs';
import { HttpError } from './http.mjs';
import { instanceOwnerId } from './project-governance-v19.mjs';

export function contextRequestScopes(request) {
  const direct = request.scopes ?? request.req?.auth?.scopes;
  if (direct != null) return normalizeRequestScopes(direct);
  const headers = request.req?.headers || request.headers,
    header = typeof headers?.get === 'function' ? headers.get('x-aiws-scopes') : headers?.['x-aiws-scopes'];
  return header == null ? null : normalizeRequestScopes(header);
}

export function normalizeRequestScopes(value) {
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values
        .flatMap((item) => String(item || '').split(/[\s,]+/))
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

export function visibleContextNodes(state, actorContext, projectId) {
  return state.context_nodes.filter((node) => nodeIsVisible(node, actorContext, projectId)).sort(compareContextNodes);
}

export function assertNodeVisible(node, actorContext) {
  if (!node) throw new HttpError(404, { error: 'context_node_not_found' });
  if (!nodeIsVisible(node, actorContext, null, { checkScopes: false }))
    throw new HttpError(403, { error: 'context_node_access_denied' });
}

export function nodeIsVisible(node, actorContext, projectId, { checkScopes = true } = {}) {
  const owner = actorContext.actor.id === instanceOwnerId(actorContext.state);
  if (projectId && String(node.project_id || '') !== String(projectId)) return false;
  if (node.project_id && !actorContext.accessible.has(String(node.project_id))) return false;
  if (!node.project_id && !owner && !['system', 'project'].includes(node.kind)) return false;
  return !checkScopes || nodeScopesAllowed(node, actorContext.scopes);
}

export function nodeCanBeMaterialized(node, actorContext, projectId) {
  return nodeIsVisible(node, actorContext, projectId) && node.sensitivity !== 'secret' && node.status !== 'tombstone';
}

export function assertContextAnchor(state, actorContext, projectId, anchorNodeId) {
  if (!anchorNodeId) return;
  const node = state.context_nodes.find((item) => item.id === anchorNodeId);
  assertNodeVisible(node, actorContext);
  if (projectId && String(node.project_id || '') !== projectId)
    throw new HttpError(403, { error: 'context_node_cross_scope', node_id: anchorNodeId });
  if (node.sensitivity === 'secret')
    throw new HttpError(403, { error: 'context_node_sensitive', node_id: anchorNodeId });
  assertDomainScopes(node, actorContext.scopes);
}

export function projectionProjectIds(actorContext, projectId) {
  if (projectId) return new Set([String(projectId)]);
  if (actorContext.actor.id === instanceOwnerId(actorContext.state)) return null;
  return new Set([...actorContext.accessible].map(String));
}

export function projectionSystemNodeIds(actorContext, projectId) {
  if (projectId || actorContext.actor.id === instanceOwnerId(actorContext.state)) return null;
  return new Set(['ctx_root_system']);
}

export function assertDomainScopes(node, scopes) {
  if (!scopes) return;
  const missing = node.required_scopes.filter((scope) => !scopes.includes(scope));
  if (missing.length) throw new HttpError(403, { error: 'mcp_scope_required', required_scopes: missing });
}

function nodeScopesAllowed(node, scopes) {
  return !scopes || node.required_scopes.every((scope) => scopes.includes(scope));
}

export function requireContextAdmin(state, actorContext) {
  if (actorContext.actor.id !== instanceOwnerId(state))
    throw new HttpError(403, { error: 'context_admin_owner_required' });
  if (actorContext.scopes && !actorContext.scopes.includes('context:admin'))
    throw new HttpError(403, { error: 'mcp_scope_required', required_scopes: ['context:admin'] });
}
