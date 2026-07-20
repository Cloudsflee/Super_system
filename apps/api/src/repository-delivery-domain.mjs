import path from 'node:path';
import { hashString, id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { assertRepositoryDeletionInactive } from './repository-lifecycle-v19.mjs';

const DELIVERY_PERMISSIONS = new Set(['codex_run', 'commit', 'push', 'draft_pr']);

export function createRepositoryConnectionInState(state, projectId, input, actorId, { allowLocalPath = false } = {}) {
  const project = state.projects.find((item) => item.id === projectId && !item.deleted_at);
  if (!project) throw new HttpError(404, { error: 'project_not_found' });
  assertRepositoryDeletionInactive(state, { projectId, repositoryId: input.repository_id });
  rejectCredentials(input);
  const repositoryId = required(input.repository_id, 'repository_id_required', 200), fullName = required(input.full_name, 'repository_full_name_required', 300);
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) throw new HttpError(400, { error: 'repository_full_name_invalid' });
  const existing = state.repository_connections.find((item) => item.project_id === project.id && item.provider === 'github' && String(item.repository_id) === repositoryId);
  if (existing) return { connection: existing, idempotent: true };
  const connection = {
    id: id('rpc'), project_id: project.id, provider: 'github', github_account_id: clean(input.github_account_id, 200) || project.github_account_id || null,
    installation_id: required(input.installation_id, 'github_installation_required', 200), repository_id: repositoryId, full_name: fullName,
    default_branch: clean(input.default_branch, 240) || 'main', permissions: normalizePermissions(input.permissions), sync_status: clean(input.sync_status, 80) || 'ready',
    remote_name: clean(input.remote_name, 100) || 'origin', local_path: normalizeLocalPath(input.local_path, allowLocalPath) || (state.repository_connections.some((item) => item.project_id === project.id) ? null : project.repo_path || null),
    credential_ref_id: clean(input.credential_ref_id, 200) || null, created_by_user_id: actorId, created_at: now(), updated_at: now()
  };
  state.repository_connections.push(connection);
  project.repository_connection_ids ||= []; project.repository_connection_ids.push(connection.id); project.updated_at = now();
  return { connection, idempotent: false };
}

export function setWorkstreamRepositoryTargetsInState(state, workstreamId, input, actorId) {
  const workstream = requireNode(state, workstreamId, 'workstream'), projectId = projectIdFor(state, workstream);
  const connectionIds = unique(input.connection_ids);
  if (!connectionIds.length) throw new HttpError(400, { error: 'repository_target_connections_required' });
  const connections = connectionIds.map((connectionId) => requireConnection(state, projectId, connectionId));
  state.repository_targets = state.repository_targets.filter((item) => item.workstream_id !== workstream.id || item.task_id);
  const targets = connections.map((connection) => ({ id: id('rpt'), project_id: projectId, workflow_id: workstream.workflow_id, workstream_id: workstream.id, task_id: null, connection_id: connection.id, access: 'available', status: connection.sync_status === 'ready' ? 'ready' : 'pending', created_by_user_id: actorId, created_at: now(), updated_at: now() }));
  state.repository_targets.push(...targets); workstream.repository_target_ids = targets.map((item) => item.id); workstream.updated_at = now();
  return targets;
}

export function setTaskRepositoryTargetsInState(state, taskId, input, actorId) {
  const task = requireNode(state, taskId, 'task'), workstream = requireNode(state, task.parent_node_id, 'workstream'), projectId = projectIdFor(state, task);
  const available = new Set(state.repository_targets.filter((item) => item.workstream_id === workstream.id && !item.task_id).map((item) => item.connection_id));
  const writeId = clean(input.write_connection_id, 200) || null, readIds = unique(input.read_connection_ids).filter((item) => item !== writeId);
  if (writeId) requireConnection(state, projectId, writeId);
  for (const connectionId of readIds) requireConnection(state, projectId, connectionId);
  for (const connectionId of [writeId, ...readIds].filter(Boolean)) if (!available.has(connectionId)) throw new HttpError(409, { error: 'repository_target_not_in_workstream', connection_id: connectionId, workstream_id: workstream.id });
  if (writeId && state.repository_targets.some((item) => item.task_id === task.id && item.access === 'write' && item.connection_id !== writeId && item.status === 'active_delivery')) throw new HttpError(409, { error: 'task_write_repository_change_blocked_by_delivery' });
  state.repository_targets = state.repository_targets.filter((item) => item.task_id !== task.id);
  const targets = [
    ...(writeId ? [{ id: id('rpt'), project_id: projectId, workflow_id: task.workflow_id, workstream_id: workstream.id, task_id: task.id, connection_id: writeId, access: 'write', status: 'ready', created_by_user_id: actorId, created_at: now(), updated_at: now() }] : []),
    ...readIds.map((connectionId) => ({ id: id('rpt'), project_id: projectId, workflow_id: task.workflow_id, workstream_id: workstream.id, task_id: task.id, connection_id: connectionId, access: 'read', status: 'ready', created_by_user_id: actorId, created_at: now(), updated_at: now() }))
  ];
  state.repository_targets.push(...targets); task.repository_target_ids = targets.map((item) => item.id); task.updated_at = now();
  return targets;
}

export function approveDeliveryPolicyInState(state, workstreamId, input, actorId) {
  const workstream = requireNode(state, workstreamId, 'workstream'), projectId = projectIdFor(state, workstream), connection = requireConnection(state, projectId, input.connection_id);
  const available = state.repository_targets.some((item) => item.workstream_id === workstream.id && !item.task_id && item.connection_id === connection.id);
  if (!available) throw new HttpError(409, { error: 'repository_target_not_in_workstream', connection_id: connection.id });
  const permissions = unique(input.automation_permissions || input.permissions || ['codex_run', 'commit', 'push', 'draft_pr']);
  if (!permissions.length || permissions.some((item) => !DELIVERY_PERMISSIONS.has(item))) throw new HttpError(400, { error: 'delivery_policy_permissions_invalid', allowed: [...DELIVERY_PERMISSIONS] });
  const pathPrefixes = normalizePrefixes(input.path_prefixes), tests = normalizeCommands(input.test_commands);
  const baseRef = clean(input.base_ref, 240) || connection.default_branch || 'main';
  if (!/^[A-Za-z0-9._/-]{1,240}$/.test(baseRef)) throw new HttpError(400, { error: 'delivery_policy_base_ref_invalid' });
  const expiresAt = input.expires_at ? validFutureTimestamp(input.expires_at) : null;
  for (const prior of state.delivery_policies.filter((item) => item.workstream_id === workstream.id && item.connection_id === connection.id && item.status === 'approved')) Object.assign(prior, { status: 'superseded', superseded_at: now(), updated_at: now() });
  const policyData = { connection_id: connection.id, base_ref: baseRef, path_prefixes: pathPrefixes, test_commands: tests, automation_permissions: permissions };
  const policy = {
    id: id('dpl'), project_id: projectId, workflow_id: workstream.workflow_id, workstream_id: workstream.id, connection_id: connection.id,
    base_ref: baseRef, path_prefixes: pathPrefixes, test_commands: tests, automation_permissions: permissions,
    policy_hash: hashString(JSON.stringify(policyData)), status: 'approved', approved_by_user_id: actorId, approved_at: now(), expires_at: expiresAt,
    revoked_at: null, created_at: now(), updated_at: now()
  };
  state.delivery_policies.push(policy); return policy;
}

export function revokeDeliveryPolicyInState(state, policyId, actorId) {
  const policy = state.delivery_policies.find((item) => item.id === policyId);
  if (!policy) throw new HttpError(404, { error: 'delivery_policy_not_found' });
  if (policy.status === 'approved') Object.assign(policy, { status: 'revoked', revoked_by_user_id: actorId, revoked_at: now(), updated_at: now() });
  return policy;
}

export function requireApprovedDeliveryPolicy(state, task, requestedPolicyId = null) {
  const target = state.repository_targets.find((item) => item.task_id === task.id && item.access === 'write');
  if (!target) throw new HttpError(409, { error: 'task_write_repository_target_required' });
  const policy = state.delivery_policies.filter((item) => item.id === requestedPolicyId || !requestedPolicyId && item.workstream_id === task.parent_node_id && item.connection_id === target.connection_id).sort((a, b) => String(b.approved_at).localeCompare(String(a.approved_at)))[0];
  if (!policy) throw new HttpError(409, { error: 'delivery_policy_approval_required', workstream_id: task.parent_node_id, connection_id: target.connection_id });
  if (policy.status !== 'approved' || policy.expires_at && new Date(policy.expires_at).getTime() <= Date.now()) throw new HttpError(409, { error: 'delivery_policy_reapproval_required', policy_id: policy.id, status: policy.status, expired: Boolean(policy.expires_at && new Date(policy.expires_at).getTime() <= Date.now()) });
  const connection = requireConnection(state, policy.project_id, target.connection_id); if (connection.sync_status === 'disconnected') throw new HttpError(409, { error: 'repository_connection_not_ready', connection_id: connection.id, status: connection.sync_status }); return { target, policy, connection };
}

export function assertDeliveryPath(policy, filePath) {
  const normalized = String(filePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) throw new HttpError(409, { error: 'delivery_path_invalid', path: filePath });
  if (!policy.path_prefixes.some((prefix) => prefix === '.' || normalized === prefix || normalized.startsWith(`${prefix}/`))) throw new HttpError(409, { error: 'delivery_path_outside_policy', path: normalized, path_prefixes: policy.path_prefixes });
  return normalized;
}

function requireNode(state, nodeId, role) { const node = state.workflow_nodes.find((item) => item.id === nodeId && item.role === role && !item.legacy_read_only); if (!node) throw new HttpError(404, { error: `${role}_not_found` }); return node; }
function projectIdFor(state, node) { const workflow = state.workflows.find((item) => item.id === node.workflow_id); if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' }); return workflow.project_id; }
function requireConnection(state, projectId, connectionId) { const connection = state.repository_connections.find((item) => item.id === connectionId && item.project_id === projectId); if (!connection) throw new HttpError(404, { error: 'repository_connection_not_found', connection_id: connectionId }); return connection; }
function rejectCredentials(input) { for (const key of ['token', 'access_token', 'secret', 'password', 'credential']) if (input[key] != null) throw new HttpError(400, { error: 'repository_plaintext_credential_forbidden', field: key }); }
function normalizePermissions(value) { const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}; return { read: source.read !== false, push: source.push === true, pull_requests: source.pull_requests === true || source.push === true, administration: source.administration === true }; }
function normalizeLocalPath(value, allowed) { if (!value) return null; if (!allowed) throw new HttpError(400, { error: 'repository_local_path_platform_managed' }); return path.resolve(String(value)); }
function normalizePrefixes(value) { const prefixes = unique(value?.length ? value : ['.']).map((item) => item.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '') || '.'); if (prefixes.some((item) => item.startsWith('/') || item.split('/').includes('..') || item.includes('\0'))) throw new HttpError(400, { error: 'delivery_policy_path_prefix_invalid' }); return prefixes; }
function normalizeCommands(value) { if (!Array.isArray(value) || !value.length || value.length > 20) throw new HttpError(400, { error: 'delivery_policy_test_commands_required' }); return value.map((item) => required(item, 'delivery_policy_test_command_invalid', 1000)); }
function validFutureTimestamp(value) { const timestamp = new Date(value); if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() <= Date.now()) throw new HttpError(400, { error: 'delivery_policy_expiry_invalid' }); return timestamp.toISOString(); }
function unique(value) { return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, 300)).filter(Boolean))]; }
function required(value, error, max) { const result = clean(value, max); if (!result) throw new HttpError(400, { error }); return result; }
function clean(value, max = 120) { return String(value ?? '').replace(/\0/g, '').trim().slice(0, max); }
