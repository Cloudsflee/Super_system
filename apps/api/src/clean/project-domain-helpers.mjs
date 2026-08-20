import { canonicalJson, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';

/** Pure helpers shared by the P3 owner facades. */
export function normalizeProjectName(value, max = 200) {
  const name = String(value ?? '').trim();
  if (!name || name.length > max) throw new PlatformError('schema_invalid', 'name is required', {}, 422);
  return name;
}

export function normalizeProjectRevision(value, { allowZero = false } = {}) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < (allowZero ? 0 : 1)) {
    throw new PlatformError('expected_revision_required', 'expected revision is required', {}, 400);
  }
  return revision;
}

export function canonicalProjectPayload(value = {}) {
  const payload = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const json = canonicalJson(payload);
  return Object.freeze({ value: JSON.parse(json), json, sha256: sha256Hex(json) });
}

export function transitionStatus(current, next, transitions = {}) {
  const allowed = transitions[current];
  if (allowed && !new Set(allowed).has(next)) {
    throw new PlatformError('state_conflict', `invalid transition: ${current} -> ${next}`, { current, next }, 409);
  }
  return next;
}

export function revisionView(row) {
  return row ? { revision: Number(row.revision || 0), etag: row.etag || null } : null;
}

export function projectCommandOwner(commandId) {
  const command = String(commandId || '');
  if (command.startsWith('repository.')) return 'Repository';
  if (command.startsWith('workflow.') || command.startsWith('generation.') || command.startsWith('critic.')) return 'Workflow';
  if (command.startsWith('outcome.')) return 'Outcome';
  return 'Project';
}
export const PROJECT_OWNER_TABLES = Object.freeze({
  Project: Object.freeze(['projects', 'project_intakes', 'briefs', 'brief_revisions']),
  Repository: Object.freeze(['repository_connections', 'repository_targets', 'repository_lines', 'repository_workspaces', 'repository_locks']),
  Workflow: Object.freeze(['workflows', 'workflow_revisions', 'workflow_nodes', 'node_contracts', 'workflow_generations', 'workflow_generation_proposals', 'workflow_critic_receipts']),
  Outcome: Object.freeze(['outcome_requirements'])
});
