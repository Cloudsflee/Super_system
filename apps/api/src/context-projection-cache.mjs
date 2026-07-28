import { CONTEXT_INTERNAL_COLLECTIONS } from '../../../packages/system-context/src/index.mjs';
import { collections as STATE_COLLECTIONS } from './config.mjs';

const RESOURCE_REFRESH_MS = boundedEnvironment('AIWS_CONTEXT_RESOURCE_REFRESH_MS', 15_000, 1_000, 300_000),
  verifiedScopes = new WeakMap();

export function contextProjectionScopeKey({ projectId, nodeIds, projectIds, systemNodeIds }) {
  return JSON.stringify({
    project_id: projectId || null,
    node_ids: normalizeArray(nodeIds).sort(),
    project_ids: projectIds == null ? null : [...new Set(projectIds.map(String))].sort(),
    system_node_ids: systemNodeIds == null ? null : [...new Set(systemNodeIds.map(String))].sort()
  });
}

export function contextProjectionReusable(state, scope, failures) {
  const checkedAt = Date.parse(state.context_resource_coverage?.checked_at || '');
  return (
    (verifiedScopes.get(state)?.has(scope) || false) &&
    Number.isFinite(checkedAt) &&
    Date.now() - checkedAt <= RESOURCE_REFRESH_MS &&
    failures.length === 0
  );
}

export function markContextProjectionScopeVerified(state, scope) {
  const scopes = verifiedScopes.get(state) || new Set();
  scopes.add(scope);
  verifiedScopes.set(state, scopes);
}

export function contextSourceCollections(state) {
  return STATE_COLLECTIONS.filter((name) => Array.isArray(state[name]) && !CONTEXT_INTERNAL_COLLECTIONS.includes(name));
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function boundedEnvironment(name, fallback, minimum, maximum) {
  const number = Number(process.env[name]);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.floor(number))) : fallback;
}
