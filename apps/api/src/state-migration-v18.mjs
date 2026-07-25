import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalStateHash,
  migrateState16To17,
  normalizeOfficialRunnerImagesV18,
  sha256,
  validateState17,
  V17_COLLECTIONS
} from './state-migration-v17.mjs';
import { collections as STATE_COLLECTIONS } from './config.mjs';
export const STATE_SCHEMA_VERSION = 18;
export const V18_COLLECTIONS = Object.freeze([
  ...V17_COLLECTIONS,
  'workflow_generations',
  'workflow_generation_events',
  'repository_connections',
  'repository_targets',
  'delivery_policies',
  'deliveries',
  'delivery_events',
  'workflow_migration_batches',
  'workflow_migration_jobs',
  'project_memberships',
  'project_invitations',
  'canonical_repositories',
  'project_repository_bindings',
  'repository_deletion_intents',
  'exchange_requests',
  'exchange_grants'
]);
export const V19_COLLECTIONS = V18_COLLECTIONS;
export { canonicalStateHash, normalizeOfficialRunnerImagesV18, sha256 };
export const V18_LEGACY_OFFICIAL_RUNNER_PATTERN = /^aiws-codex-runner:1\.[0-9]\.0-codex-\d+\.\d+\.\d+$/;
export const V19_RUNNER_IMAGE = 'aiws-codex-runner:1.10.0-codex-0.144.0';
const TERMINAL_GENERATION_STATUSES = new Set(['completed', 'failed', 'cancelled', 'superseded']);
const VALID_SCOPES = new Set(['project', 'workflow', 'workstream', 'task', 'node']);
export function migrateState17To18(source, { timestamp = new Date().toISOString() } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw migrationError('state_root_invalid');
  const inputVersion = source.schema_version == null ? 13 : Number(source.schema_version);
  if (inputVersion === STATE_SCHEMA_VERSION) {
    const state = structuredClone(source);
    normalizeV18RecordDefaults(state, timestamp);
    const runner = normalizeOfficialRunnerImagesV19(state, { timestamp });
    validateState18(state);
    return {
      ...migrationResult(state, false, 18, timestamp),
      normalized_runner_profiles: runner.profile_ids,
      staled_runner_probes: runner.staled_probe_count
    };
  }
  if (![12, 13, 14, 15, 16, 17].includes(inputVersion))
    throw migrationError('unsupported_state_schema', { schema_version: source.schema_version ?? null });
  const state = migrateState16To17(source, { timestamp }).state;
  for (const collection of V18_COLLECTIONS) if (!Array.isArray(state[collection])) state[collection] = [];
  const normalized = normalizeV18RecordDefaults(state, timestamp, { migrating: true });
  const runner = normalizeOfficialRunnerImagesV19(state, { timestamp });
  state.schema_version = STATE_SCHEMA_VERSION;
  validateState18(state);
  return {
    ...migrationResult(state, true, inputVersion, timestamp),
    legacy_workflow_ids: normalized.legacy_workflow_ids,
    repository_connection_ids: normalized.repository_connection_ids,
    legacy_assist_session_ids: normalized.legacy_assist_session_ids,
    normalized_runner_profiles: runner.profile_ids,
    staled_runner_probes: runner.staled_probe_count
  };
}
export function normalizeOfficialRunnerImagesV19(
  state,
  { targetImage = V19_RUNNER_IMAGE, timestamp = new Date().toISOString() } = {}
) {
  const changedProfiles = new Set(),
    changedFields = [];
  for (const profile of Array.isArray(state?.codex_profiles) ? state.codex_profiles : []) {
    for (const [container, field] of [
      [profile, 'image'],
      [profile?.config, 'image']
    ]) {
      if (
        !container ||
        !V18_LEGACY_OFFICIAL_RUNNER_PATTERN.test(String(container[field] || '')) ||
        container[field] === targetImage
      )
        continue;
      changedFields.push({
        profile_id: profile.id || null,
        field: container === profile ? 'image' : 'config.image',
        from: container[field],
        to: targetImage
      });
      container[field] = targetImage;
      if (profile.id) changedProfiles.add(profile.id);
    }
  }
  for (const integration of Array.isArray(state?.integration_statuses) ? state.integration_statuses : []) {
    if (
      integration?.key !== 'codex_docker' ||
      !V18_LEGACY_OFFICIAL_RUNNER_PATTERN.test(String(integration.image || '')) ||
      integration.image === targetImage
    )
      continue;
    changedFields.push({
      profile_id: null,
      field: 'integration_statuses.codex_docker.image',
      from: integration.image,
      to: targetImage
    });
    integration.image = targetImage;
  }
  let staledProbeCount = 0;
  for (const probe of Array.isArray(state?.integration_statuses) ? state.integration_statuses : []) {
    if (probe?.key !== 'codex_probe' || !changedProfiles.has(probe.profile_id)) continue;
    probe.status = 'stale';
    probe.updated_at = timestamp;
    staledProbeCount += 1;
  }
  return {
    changed: changedFields.length > 0,
    profile_ids: [...changedProfiles].sort(),
    changed_fields: changedFields,
    staled_probe_count: staledProbeCount
  };
}
export function validateState18(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw migrationError('state_root_invalid');
  if (Number(state.schema_version) !== STATE_SCHEMA_VERSION)
    throw migrationError('state_schema_not_18', { schema_version: state.schema_version ?? null });
  for (const collection of V18_COLLECTIONS)
    if (!Array.isArray(state[collection])) throw migrationError('state_collection_invalid', { collection });
  validateState17({ ...structuredClone(state), schema_version: 17 });
  for (const collection of [
    'workflow_generations',
    'workflow_generation_events',
    'repository_connections',
    'repository_targets',
    'delivery_policies',
    'deliveries',
    'delivery_events',
    'workflow_migration_batches',
    'workflow_migration_jobs'
  ])
    ensureUniqueIds(state[collection], collection);
  for (const collection of [
    'project_memberships',
    'project_invitations',
    'canonical_repositories',
    'project_repository_bindings',
    'repository_deletion_intents',
    'exchange_requests',
    'exchange_grants'
  ])
    ensureUniqueIds(state[collection], collection);
  const projectIds = new Set(state.projects.map((item) => item.id));
  const userIds = new Set(state.users.map((item) => item.id));
  const workflowIds = new Set(state.workflows.map((item) => item.id));
  const nodeIds = new Set(state.workflow_nodes.map((item) => item.id));
  for (const node of state.workflow_nodes) validateWorkflowNode18(node, nodeIds);
  validateAssistScopes18(state.assist_sessions);
  validateWorkflowGenerations18(state.workflow_generations, projectIds);
  validateRepositoryConnections18(state.repository_connections, projectIds);
  validateDeliveryScopes18(state, { projectIds, workflowIds, nodeIds });
  validateProjectAccess18(state, { projectIds, userIds });
  validateRepositoryExchange18(state, projectIds);
  return state;
}

function validateAssistScopes18(sessions) {
  for (const session of sessions) {
    if (session.version === 3 && !VALID_SCOPES.has(session.scope_type))
      throw migrationError('assist_scope_type_invalid', { id: session.id, scope_type: session.scope_type });
    if (
      session.scope_snapshot != null &&
      (typeof session.scope_snapshot !== 'object' || Array.isArray(session.scope_snapshot))
    )
      throw migrationError('assist_scope_snapshot_invalid', { id: session.id });
  }
}

function validateWorkflowGenerations18(generations, projectIds) {
  for (const item of generations) {
    if (!projectIds.has(item.project_id)) throw migrationError('workflow_generation_project_missing', { id: item.id });
    if (!['queued', 'running', ...TERMINAL_GENERATION_STATUSES].includes(item.status))
      throw migrationError('workflow_generation_status_invalid', { id: item.id });
  }
}

function validateRepositoryConnections18(connections, projectIds) {
  for (const connection of connections) {
    if (!projectIds.has(connection.project_id))
      throw migrationError('repository_connection_project_missing', { id: connection.id });
    for (const forbidden of ['token', 'access_token', 'credential', 'secret'])
      if (Object.hasOwn(connection, forbidden))
        throw migrationError('repository_connection_plaintext_credential_forbidden', {
          id: connection.id,
          field: forbidden
        });
  }
}

function validateDeliveryScopes18(state, scope) {
  const { projectIds, workflowIds, nodeIds } = scope;
  for (const target of state.repository_targets) {
    if (!projectIds.has(target.project_id) || (target.workstream_id && !nodeIds.has(target.workstream_id)))
      throw migrationError('repository_target_scope_missing', { id: target.id });
  }
  for (const policy of state.delivery_policies)
    if (!projectIds.has(policy.project_id) || (policy.workstream_id && !nodeIds.has(policy.workstream_id)))
      throw migrationError('delivery_policy_scope_missing', { id: policy.id });
  for (const delivery of state.deliveries)
    if (!projectIds.has(delivery.project_id) || (delivery.workflow_id && !workflowIds.has(delivery.workflow_id)))
      throw migrationError('delivery_scope_missing', { id: delivery.id });
}

function validateProjectAccess18(state, scope) {
  const { projectIds, userIds } = scope;
  if (state.instance_owner_user_id && !userIds.has(state.instance_owner_user_id))
    throw migrationError('instance_owner_user_missing', { instance_owner_user_id: state.instance_owner_user_id });
  const membershipKeys = new Set();
  for (const membership of state.project_memberships) {
    if (!projectIds.has(membership.project_id) || !userIds.has(membership.user_id))
      throw migrationError('project_membership_reference_missing', { id: membership.id });
    if (
      !['owner', 'collaborator', 'viewer'].includes(membership.role) ||
      !['active', 'revoked'].includes(membership.status)
    )
      throw migrationError('project_membership_invalid', { id: membership.id });
    const key = `${membership.project_id}:${membership.user_id}`;
    if (membershipKeys.has(key)) throw migrationError('project_membership_duplicate', { id: membership.id });
    membershipKeys.add(key);
  }
  for (const project of state.projects)
    if (!userIds.has(project.owner_user_id))
      throw migrationError('project_owner_user_missing', {
        project_id: project.id,
        owner_user_id: project.owner_user_id
      });
  for (const invitation of state.project_invitations)
    if (!projectIds.has(invitation.project_id) || !userIds.has(invitation.invited_by_user_id))
      throw migrationError('project_invitation_reference_missing', { id: invitation.id });
}

function validateRepositoryExchange18(state, projectIds) {
  const repositoryIds = new Set(state.canonical_repositories.map((item) => item.id));
  for (const binding of state.project_repository_bindings)
    if (!projectIds.has(binding.project_id) || !repositoryIds.has(binding.canonical_repository_id))
      throw migrationError('project_repository_binding_reference_missing', { id: binding.id });
  for (const intent of state.repository_deletion_intents)
    if (!repositoryIds.has(intent.canonical_repository_id))
      throw migrationError('repository_deletion_intent_repository_missing', { id: intent.id });
  for (const request of state.exchange_requests)
    if (!projectIds.has(request.source_project_id) || !projectIds.has(request.target_project_id))
      throw migrationError('exchange_project_missing', { id: request.id });
  for (const grant of state.exchange_grants)
    if (!state.exchange_requests.some((item) => item.id === grant.exchange_request_id))
      throw migrationError('exchange_grant_request_missing', { id: grant.id });
}
export async function migrateStateFileToV18(
  stateFile,
  {
    backupDirectory = path.join(path.dirname(stateFile), 'migrations'),
    clock = () => new Date(),
    beforeReplace,
    afterReplace
  } = {}
) {
  const original = await fsp.readFile(stateFile);
  const parsed = JSON.parse(original.toString('utf8'));
  const result = migrateState17To18(parsed, { timestamp: clock().toISOString() });
  if (!result.migrated)
    return { ...result, state_hash: canonicalStateHash(result.state), backup_path: null, manifest_path: null };
  await fsp.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = clock().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.json`);
  const manifestPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.manifest.json`);
  await writeExclusiveAndSync(backupPath, original);
  const originalDigest = sha256(original);
  const migratedBytes = Buffer.from(`${JSON.stringify(result.state, null, 2)}\n`, 'utf8');
  const tempPath = `${stateFile}.v18-${process.pid}-${Date.now()}.tmp`;
  const manifest = {
    migration: `aiws-state-${result.from_version}-to-18`,
    status: 'prepared',
    from_schema: result.from_version,
    to_schema: 18,
    created_at: clock().toISOString(),
    original_sha256: originalDigest,
    original_state_hash: canonicalStateHash(parsed),
    migrated_sha256: sha256(migratedBytes),
    migrated_state_hash: canonicalStateHash(result.state),
    legacy_workflow_ids: result.legacy_workflow_ids,
    repository_connection_ids: result.repository_connection_ids,
    legacy_assist_session_ids: result.legacy_assist_session_ids,
    normalized_runner_profiles: result.normalized_runner_profiles || [],
    staled_runner_probes: result.staled_runner_probes || 0,
    backup_file: path.basename(backupPath),
    state_file: path.basename(stateFile)
  };
  await writeExclusiveAndSync(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  let replaced = false;
  try {
    await writeExclusiveAndSync(tempPath, migratedBytes);
    const staged = await fsp.readFile(tempPath);
    if (sha256(staged) !== manifest.migrated_sha256) throw migrationError('migrated_state_checksum_mismatch');
    validateState18(JSON.parse(staged.toString('utf8')));
    await beforeReplace?.({ stateFile, tempPath, backupPath, manifest });
    await replaceFile(tempPath, stateFile);
    replaced = true;
    await syncDirectory(path.dirname(stateFile));
    const installed = await fsp.readFile(stateFile);
    if (sha256(installed) !== manifest.migrated_sha256) throw migrationError('installed_state_checksum_mismatch');
    validateState18(JSON.parse(installed.toString('utf8')));
    await afterReplace?.({ stateFile, backupPath, manifest });
    manifest.status = 'committed';
    manifest.committed_at = clock().toISOString();
    await atomicRewrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    return {
      ...result,
      state_hash: manifest.migrated_state_hash,
      backup_path: backupPath,
      manifest_path: manifestPath,
      manifest
    };
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    if (replaced) {
      const backup = await fsp.readFile(backupPath);
      if (sha256(backup) !== originalDigest)
        throw migrationError('migration_failed_and_backup_corrupt', { cause: String(error?.message || error) });
      const restoreTemp = `${stateFile}.restore-${process.pid}-${Date.now()}.tmp`;
      await writeExclusiveAndSync(restoreTemp, backup);
      await replaceFile(restoreTemp, stateFile);
      await syncDirectory(path.dirname(stateFile));
    }
    manifest.status = 'rolled_back';
    manifest.failed_at = clock().toISOString();
    manifest.error = safeErrorCode(error);
    await atomicRewrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)).catch(() => undefined);
    throw error;
  }
}
function normalizeV18RecordDefaults(state, timestamp, { migrating = false } = {}) {
  for (const collection of STATE_COLLECTIONS) if (!Array.isArray(state[collection])) state[collection] = [];
  if (!Array.isArray(state.repository_bindings)) state.repository_bindings = [];
  if (!Array.isArray(state.legacy_project_allowlist_compat)) state.legacy_project_allowlist_compat = [];
  ensureV18LocalOwner(state, timestamp);
  const legacyWorkflowIds = [],
    repositoryConnectionIds = [],
    legacyAssistSessionIds = [];
  const instanceOwnerId =
    state.instance_owner_user_id || state.users.find((item) => item.role === 'owner')?.id || state.users[0]?.id || null;
  if (instanceOwnerId && !state.instance_owner_user_id) state.instance_owner_user_id = instanceOwnerId;
  const nodesByWorkflow = indexV18Nodes(state.workflow_nodes);
  normalizeV18Workflows(state.workflows, nodesByWorkflow, legacyWorkflowIds);
  normalizeV18Nodes(state.workflow_nodes, state.workflows);
  normalizeV18Projects(state, { timestamp, migrating, instanceOwnerId, legacyWorkflowIds });
  migrateV18RepositoryBindings(state, timestamp, repositoryConnectionIds);
  normalizeV18AssistSessions(state, timestamp, legacyAssistSessionIds);
  if (migrating) interruptV18Generations(state.workflow_generations, timestamp);
  return {
    legacy_workflow_ids: legacyWorkflowIds.sort(),
    repository_connection_ids: repositoryConnectionIds.sort(),
    legacy_assist_session_ids: legacyAssistSessionIds.sort()
  };
}

function ensureV18LocalOwner(state, timestamp) {
  if (!state.users.length) {
    const userId = 'usr_migrated_local_owner';
    state.users.push({
      id: userId,
      display_name: 'Local Owner',
      email: '',
      avatar_url: '',
      role: 'owner',
      auth_mode: 'local_auto',
      created_at: timestamp,
      updated_at: timestamp
    });
    state.sessions.push({
      id: 'ses_migrated_local_owner',
      user_id: userId,
      session_token_hash: sha256(`${userId}:local_auto`),
      mode: 'local_auto',
      expires_at: null,
      created_at: timestamp
    });
  }
}

function indexV18Nodes(nodes) {
  const nodesByWorkflow = new Map();
  for (const node of nodes) {
    const records = nodesByWorkflow.get(node.workflow_id) || [];
    records.push(node);
    nodesByWorkflow.set(node.workflow_id, records);
  }
  return nodesByWorkflow;
}

function normalizeV18Workflows(workflows, nodesByWorkflow, legacyWorkflowIds) {
  for (const workflow of workflows) {
    const nodes = nodesByWorkflow.get(workflow.id) || [];
    const alreadyTwoLevel =
      nodes.some((node) => node.role === 'workstream') &&
      nodes.every((node) => ['workstream', 'task'].includes(node.role));
    if (workflow.hierarchy_mode === undefined)
      workflow.hierarchy_mode = alreadyTwoLevel ? 'two_level' : nodes.length ? 'legacy' : 'two_level';
    if (workflow.workflow_revision === undefined) workflow.workflow_revision = Number(workflow.version || 1);
    if (workflow.semantic_migration_status === undefined)
      workflow.semantic_migration_status = workflow.hierarchy_mode === 'legacy' ? 'pending' : 'not_required';
    if (workflow.legacy_read_only === undefined) workflow.legacy_read_only = workflow.hierarchy_mode === 'legacy';
    if (workflow.hierarchy_mode === 'legacy') legacyWorkflowIds.push(workflow.id);
  }
}

function normalizeV18Nodes(nodes, workflows) {
  for (const node of nodes) {
    const workflow = workflows.find((item) => item.id === node.workflow_id);
    const legacy = workflow?.hierarchy_mode === 'legacy';
    if (node.role === undefined) node.role = legacy ? 'task' : node.parent_node_id ? 'task' : 'workstream';
    if (node.parent_node_id === undefined) node.parent_node_id = null;
    if (node.outcome === undefined) node.outcome = node.role === 'workstream' ? node.goal || node.title : null;
    if (node.category === undefined) node.category = node.role === 'workstream' ? 'deliverable' : null;
    if (node.task_kind === undefined) node.task_kind = node.role === 'task' ? legacyTaskKind(node.type) : null;
    if (node.execution_mode === undefined)
      node.execution_mode = node.role === 'task' ? legacyExecutionMode(node.task_kind) : null;
    if (node.boundary === undefined)
      node.boundary = node.role === 'workstream' ? { deliverable: node.outcome || node.title } : null;
    if (node.plan_revision === undefined) node.plan_revision = node.role === 'workstream' ? 1 : null;
    if (node.repository_target_ids === undefined) node.repository_target_ids = [];
    if (node.required === undefined) node.required = true;
    if (node.legacy_read_only === undefined) node.legacy_read_only = legacy;
    if (legacy && node.legacy_node_type === undefined) node.legacy_node_type = node.type || null;
  }
}

function normalizeV18Projects(state, options) {
  const { timestamp, migrating, instanceOwnerId, legacyWorkflowIds } = options;
  for (const project of state.projects) {
    if (migrating && !state.legacy_project_allowlist_compat.includes(project.id))
      state.legacy_project_allowlist_compat.push(project.id);
    if (project.owner_user_id === undefined || project.owner_user_id === null)
      project.owner_user_id = project.created_by_user_id || instanceOwnerId;
    if (!project.created_by_user_id) project.created_by_user_id = project.owner_user_id;
    if (project.workflow_migration_status === undefined)
      project.workflow_migration_status = legacyWorkflowIds.some((workflowId) =>
        state.workflows.some((item) => item.id === workflowId && item.project_id === project.id)
      )
        ? 'pending'
        : 'not_required';
    if (project.repository_connection_ids === undefined) project.repository_connection_ids = [];
    if (
      project.owner_user_id &&
      !state.project_memberships.some(
        (item) => item.project_id === project.id && item.user_id === project.owner_user_id
      )
    )
      state.project_memberships.push({
        id: deterministicMembershipId(project.id, project.owner_user_id),
        project_id: project.id,
        user_id: project.owner_user_id,
        role: 'owner',
        status: 'active',
        source: 'migration',
        invited_by_user_id: null,
        github_identity: null,
        accepted_at: project.created_at || timestamp,
        revoked_at: null,
        created_at: project.created_at || timestamp,
        updated_at: timestamp
      });
  }
}

function migrateV18RepositoryBindings(state, timestamp, repositoryConnectionIds) {
  const existingBindings = new Set(state.repository_connections.map((item) => item.legacy_binding_id || item.id));
  for (const binding of state.repository_bindings) {
    binding.legacy_read_only = true;
    if (existingBindings.has(binding.id)) continue;
    const connection = {
      id: binding.id,
      project_id: binding.project_id,
      provider: 'github',
      github_account_id: binding.github_account_id || null,
      installation_id: binding.installation_id || null,
      repository_id: binding.repository_id || null,
      full_name: binding.full_name || null,
      default_branch: binding.default_branch || 'main',
      permissions: structuredClone(binding.permissions || {}),
      sync_status: binding.status || 'pending',
      credential_ref_id: binding.credential_ref_id || null,
      legacy_binding_id: binding.id,
      created_by_user_id: binding.created_by_user_id || null,
      created_at: binding.created_at || timestamp,
      updated_at: binding.updated_at || timestamp
    };
    state.repository_connections.push(connection);
    repositoryConnectionIds.push(connection.id);
    const project = state.projects.find((item) => item.id === connection.project_id);
    if (project && !project.repository_connection_ids.includes(connection.id))
      project.repository_connection_ids.push(connection.id);
  }
}

function normalizeV18AssistSessions(state, timestamp, legacyAssistSessionIds) {
  for (const session of state.assist_sessions) {
    if (session.version !== 3) continue;
    if (session.scope_snapshot === undefined) session.scope_snapshot = snapshotScope(state, session, timestamp);
    if (session.scope_status === undefined)
      session.scope_status = session.scope_type === 'node' ? 'legacy_read_only' : 'active';
    if (session.scope_type === 'node') {
      session.legacy_scope_type = 'node';
      session.read_only = true;
      legacyAssistSessionIds.push(session.id);
    }
  }
}

function interruptV18Generations(generations, timestamp) {
  for (const generation of generations.filter((item) => ['queued', 'running'].includes(item.status)))
    Object.assign(generation, {
      status: 'failed',
      error_code: 'service_restarted',
      retryable: true,
      completed_at: timestamp,
      updated_at: timestamp
    });
}
function validateWorkflowNode18(node, nodeIds) {
  if (!['workstream', 'task'].includes(node.role))
    throw migrationError('workflow_node_role_invalid', { id: node.id, role: node.role ?? null });
  if (node.role === 'workstream' && node.parent_node_id != null)
    throw migrationError('workflow_workstream_parent_forbidden', { id: node.id });
  if (node.role === 'task' && node.parent_node_id != null && !nodeIds.has(node.parent_node_id))
    throw migrationError('workflow_task_parent_missing', { id: node.id, parent_node_id: node.parent_node_id });
  if (node.role === 'task' && node.parent_node_id == null && !node.legacy_read_only)
    throw migrationError('workflow_task_parent_required', { id: node.id });
}
function snapshotScope(state, session, timestamp) {
  const project = state.projects.find((item) => item.id === session.project_id);
  const workflow =
    session.scope_type === 'workflow' ? state.workflows.find((item) => item.id === session.scope_id) : null;
  const node = ['workstream', 'task', 'node'].includes(session.scope_type)
    ? state.workflow_nodes.find((item) => item.id === session.scope_id)
    : null;
  return {
    project_id: session.project_id,
    project_title: project?.title || null,
    scope_type: session.scope_type,
    scope_id: session.scope_id,
    scope_title: workflow?.title || node?.title || project?.title || null,
    captured_at: timestamp
  };
}
function legacyTaskKind(type) {
  return (
    {
      research: 'research',
      analysis: 'analysis',
      retrospective: 'review',
      execution: 'code',
      goal_definition: 'analysis'
    }[type] || 'manual'
  );
}
function legacyExecutionMode(kind) {
  return ['code', 'test', 'deploy'].includes(kind) ? 'codex' : kind === 'manual' ? 'manual' : 'assist';
}
function deterministicMembershipId(projectId, userId) {
  return `pmb_migrated_${sha256(`${projectId}:${userId}`).slice(0, 18)}`;
}
function migrationResult(state, migrated, fromVersion) {
  return {
    state,
    migrated,
    from_version: fromVersion,
    to_version: 18,
    legacy_workflow_ids: [],
    repository_connection_ids: [],
    legacy_assist_session_ids: []
  };
}
function ensureUniqueIds(items, collection) {
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || !String(item.id || ''))
      throw migrationError('state_record_id_missing', { collection });
    if (seen.has(item.id)) throw migrationError('state_record_id_duplicate', { collection, id: item.id });
    seen.add(item.id);
  }
}
function migrationError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
function safeErrorCode(error) {
  return /^[a-z0-9_.-]{1,120}$/i.test(String(error?.code || '')) ? String(error.code) : 'state_migration_failed';
}
async function writeExclusiveAndSync(file, bytes) {
  const handle = await fsp.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function atomicRewrite(file, bytes) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeExclusiveAndSync(temp, bytes);
  await replaceFile(temp, file);
  await syncDirectory(path.dirname(file));
}
async function replaceFile(source, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1))));
    }
  }
}
async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
