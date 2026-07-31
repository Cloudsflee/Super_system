import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { now } from '../../../packages/shared/index.mjs';
import { createAssetRecord, createImmutableAssetVersion } from './asset-cas.mjs';
import { attestAssetVersionInState } from './asset-attestation-service.mjs';
import { CAS_DIR, DATA_DIR } from './config.mjs';

export const LEGACY_EXECUTION_PROMOTION_VERSION = 1;
const TERMINAL_LEGACY = new Set([
  'completed',
  'succeeded',
  'accepted',
  'failed',
  'partial',
  'cancelled',
  'rejected',
  'blocked'
]);

export function inspectLegacyExecutionHistory(state) {
  const existing = new Set((state.task_executions || []).map((item) => item.task_id));
  const activeProjects = new Set((state.projects || []).filter((item) => !item.deleted_at).map((item) => item.id));
  const workflows = new Map(
    (state.workflows || [])
      .filter((item) => item.planning_quality === 'verified' && activeProjects.has(item.project_id))
      .map((item) => [item.id, item])
  );
  const candidates = [];
  for (const task of (state.workflow_nodes || []).filter(
    (item) =>
      item.role === 'task' && !item.legacy_read_only && workflows.has(item.workflow_id) && !existing.has(item.id)
  )) {
    const history = legacyHistoryForTask(state, task);
    if (history.length) candidates.push({ task, workflow: workflows.get(task.workflow_id), history });
  }
  return candidates;
}

export async function promoteLegacyExecutionHistoryInState(
  state,
  {
    timestamp = now(),
    actorId = state.instance_owner_user_id || state.users?.[0]?.id || null,
    casRoot = CAS_DIR,
    backupDirectory = path.join(DATA_DIR, 'migrations')
  } = {}
) {
  const candidates = inspectLegacyExecutionHistory(state);
  if (!candidates.length)
    return { changed: false, promoted_task_ids: [], workflow_execution_ids: [], backup_path: null };
  const backupPath = await writePromotionBackup(state, backupDirectory);
  const groups = groupCandidates(candidates),
    workflowExecutionIds = [],
    promotedTaskIds = [];
  for (const group of groups) {
    const promoted = await promoteGroup(state, group, { timestamp, actorId, casRoot });
    workflowExecutionIds.push(promoted.workflowExecution.id);
    promotedTaskIds.push(...promoted.taskIds);
  }
  state.legacy_execution_promotion = {
    version: LEGACY_EXECUTION_PROMOTION_VERSION,
    completed_at: timestamp,
    backup_path: backupPath,
    promoted_task_ids: [
      ...new Set([...(state.legacy_execution_promotion?.promoted_task_ids || []), ...promotedTaskIds])
    ],
    workflow_execution_ids: [
      ...new Set([...(state.legacy_execution_promotion?.workflow_execution_ids || []), ...workflowExecutionIds])
    ]
  };
  return {
    changed: true,
    promoted_task_ids: promotedTaskIds,
    workflow_execution_ids: workflowExecutionIds,
    backup_path: backupPath
  };
}

async function promoteGroup(state, group, options) {
  const { workflow, workstreamId, candidates } = group,
    timestamps = candidates.flatMap((item) => item.history.map(activityTime));
  const startedAt = timestamps.sort()[0] || options.timestamp,
    completedAt = timestamps.sort().at(-1) || options.timestamp;
  const workflowExecution = {
    id: stableId('wex', workflow.id, workstreamId, 'legacy-promotion-v1'),
    project_id: workflow.project_id,
    workflow_id: workflow.id,
    workflow_revision: Number(workflow.workflow_revision || workflow.version || 1),
    status: 'completed',
    repository_selection: [],
    input_hash: digest({ workflow_id: workflow.id, workstream_id: workstreamId, source: 'legacy_execution_history' }),
    executor_config: { runner: 'history_promotion' },
    operation_key: `legacy-execution-promotion-v1:${workstreamId}`,
    frontier: [],
    waiting_reasons: [],
    created_by_user_id: options.actorId,
    started_at: startedAt,
    paused_at: null,
    completed_at: completedAt,
    cancelled_at: null,
    created_at: startedAt,
    updated_at: completedAt,
    provenance: { source: 'legacy_execution_promotion', version: LEGACY_EXECUTION_PROMOTION_VERSION }
  };
  state.workflow_executions.push(workflowExecution);
  const line = createPromotedRepositoryLine(state, workflowExecution, workstreamId, candidates, completedAt);
  if (line) {
    state.repository_lines.push(line);
    workflowExecution.repository_selection.push({
      workstream_id: workstreamId,
      connection_id: line.connection_id,
      canonical_repository_id: line.canonical_repository_id,
      base_ref: line.base_ref,
      base_sha: line.base_sha
    });
  }
  let sequence = appendEvent(
    state,
    workflowExecution,
    null,
    1,
    'workflow.history_promoted',
    { task_count: candidates.length },
    startedAt
  );
  const latestStatuses = [],
    taskIds = [];
  for (const candidate of candidates) {
    const promoted = await promoteTask(state, workflowExecution, candidate, line, options, sequence);
    sequence = promoted.sequence;
    latestStatuses.push(promoted.latestStatus);
    taskIds.push(candidate.task.id);
  }
  workflowExecution.status = latestStatuses.some((item) => item === 'failed')
    ? 'failed'
    : latestStatuses.some((item) => item === 'cancelled')
      ? 'cancelled'
      : 'completed';
  if (workflowExecution.status === 'cancelled') workflowExecution.cancelled_at = completedAt;
  sequence = appendEvent(
    state,
    workflowExecution,
    null,
    sequence,
    `workflow.${workflowExecution.status}`,
    { promoted: true },
    completedAt
  );
  workflowExecution.updated_at = completedAt;
  return { workflowExecution, taskIds, sequence };
}

async function promoteTask(state, workflowExecution, candidate, line, options, sequence) {
  const { task, history } = candidate,
    contract = state.node_contracts.find((item) => item.id === task.current_contract_id);
  if (!contract) throw promotionError('legacy_task_contract_missing', { task_id: task.id });
  let previousId = null,
    latestStatus = 'failed';
  for (const [index, activity] of history.entries()) {
    const latest = index === history.length - 1,
      sourceStatus = String(activity.record.status || task.status || 'failed');
    const status = latest ? promotedStatus(sourceStatus, task.status) : 'superseded',
      createdAt = activity.record.created_at || task.created_at || options.timestamp;
    const completedAt = activity.record.completed_at || activity.record.updated_at || createdAt,
      execution = {
        id: stableId('tex', task.id, activity.type, activity.record.id || index),
        workflow_execution_id: workflowExecution.id,
        project_id: workflowExecution.project_id,
        workflow_id: workflowExecution.workflow_id,
        workstream_id: task.parent_node_id,
        task_id: task.id,
        task_revision: Number(task.execution_revision || 1),
        contract_id: contract.id,
        contract_version: Number(contract.version || 1),
        attempt: index + 1,
        executor: promotedExecutor(task, activity.record),
        status,
        readiness: { ready: true, reasons: [], checked_at: completedAt },
        context_snapshot: promotedContext(workflowExecution, task, contract, activity, line),
        input_snapshot_hash: activity.record.input_snapshot_hash || null,
        repository_snapshot_hash: activity.record.repository_snapshot_hash || null,
        output_bindings: [],
        consumed_inputs: [],
        acceptance_results: [],
        evidence: {
          source: 'legacy_execution_promotion',
          source_type: activity.type,
          source_id: activity.record.id || null,
          original_status: sourceStatus
        },
        error_code: ['failed', 'partial', 'rejected', 'blocked'].includes(sourceStatus)
          ? activity.record.error_code || `legacy_${sourceStatus}`
          : null,
        retry_class: null,
        lease: null,
        supersedes_id: previousId,
        queued_at: createdAt,
        started_at: activity.record.started_at || createdAt,
        completed_at: completedAt,
        created_at: createdAt,
        updated_at: completedAt
      };
    state.task_executions.push(execution);
    sequence = appendEvent(
      state,
      workflowExecution,
      execution,
      sequence,
      'task.history_promoted',
      { source_type: activity.type, source_id: activity.record.id || null, original_status: sourceStatus, status },
      completedAt
    );
    if (latest) {
      if (status === 'completed')
        await promoteSuccessfulOutputs(state, execution, task, contract, activity, candidate, options);
      else await promoteDiagnostic(state, execution, task, activity, options);
      latestStatus = execution.status;
    }
    previousId = execution.id;
  }
  Object.assign(task, {
    execution_evidence_status: 'managed',
    legacy_execution_promoted_at: options.timestamp,
    latest_task_execution_id: previousId
  });
  return { sequence, latestStatus };
}

async function promoteSuccessfulOutputs(state, execution, task, contract, activity, candidate, options) {
  const slots = contract.expected_outputs || [],
    submission = candidate.submissions.at(-1) || null;
  for (const slot of slots) {
    const summary = submission?.summary || activity.record.summary || `Promoted completed output for ${task.title}`;
    const asset = createAssetRecord({
      projectId: execution.project_id,
      workspaceId: task.workspace_id,
      taskId: task.id,
      taskExecutionId: execution.id,
      assetType: slot.asset_type || 'ExecutionOutputAsset',
      title: submission?.title || `${task.title} ${slot.key}`,
      summary,
      outputKey: slot.key,
      actorId: options.actorId
    });
    Object.assign(asset, {
      acceptance_criteria: [...(slot.acceptance_criteria || [])],
      confirmation_policy: slot.confirmation_policy || 'human',
      execution_type: 'task_execution',
      execution_id: execution.id
    });
    state.assets.push(asset);
    const repositorySha = repositoryShaFor(activity.record),
      payload = promotedPayload(task, activity, submission, repositorySha);
    const version = await createImmutableAssetVersion(state, {
      asset,
      payload: {
        payload_kind: 'json',
        media_type: 'application/json',
        content: payload,
        metadata: promotedMetadata(activity, repositorySha)
      },
      title: asset.title,
      summary,
      evidenceRefs: promotedEvidenceRefs(activity, submission, repositorySha),
      repositorySha,
      provenance: {
        source: 'legacy_execution_promotion',
        source_type: activity.type,
        source_id: activity.record.id || null,
        workflow_execution_id: execution.workflow_execution_id,
        task_execution_id: execution.id
      },
      actorId: options.actorId,
      outputKey: slot.key,
      casRoot: options.casRoot
    });
    const attestorType = slot.confirmation_policy === 'system_evidence' ? 'trusted_verifier' : 'human';
    await attestAssetVersionInState(state, {
      assetId: asset.id,
      versionId: version.id,
      expectedSha256: version.content_sha256,
      taskExecutionId: execution.id,
      outputKey: slot.key,
      decision: 'accepted',
      attestorType,
      attestorId:
        attestorType === 'human'
          ? submission?.reviewed_by_user_id || task.reviewed_by_user_id || options.actorId
          : verifierFor(slot.asset_type),
      evidence: attestationEvidence(slot.asset_type, version, repositorySha),
      summary: 'Promoted from accepted legacy execution evidence.',
      casRoot: options.casRoot
    });
  }
  execution.status = 'completed';
  execution.error_code = null;
}

async function promoteDiagnostic(state, execution, task, activity, options) {
  const summary =
    activity.record.summary || `Legacy ${activity.type} ended with ${activity.record.status || task.status}`;
  const asset = createAssetRecord({
    projectId: execution.project_id,
    workspaceId: task.workspace_id,
    taskId: task.id,
    taskExecutionId: execution.id,
    assetType: 'ExecutionDiagnosticAsset',
    title: `${task.title} execution diagnostic`,
    summary,
    outputKey: 'execution_diagnostic',
    actorId: options.actorId
  });
  Object.assign(asset, { confirmation_policy: 'human', execution_type: 'task_execution', execution_id: execution.id });
  state.assets.push(asset);
  const version = await createImmutableAssetVersion(state, {
    asset,
    payload: {
      payload_kind: 'json',
      media_type: 'application/json',
      content: promotedPayload(task, activity, null, repositoryShaFor(activity.record)),
      metadata: promotedMetadata(activity, repositoryShaFor(activity.record))
    },
    title: asset.title,
    summary,
    evidenceRefs: promotedEvidenceRefs(activity),
    provenance: {
      source: 'legacy_execution_promotion',
      source_type: activity.type,
      source_id: activity.record.id || null,
      task_execution_id: execution.id
    },
    actorId: options.actorId,
    outputKey: asset.output_key,
    casRoot: options.casRoot
  });
  await attestAssetVersionInState(state, {
    assetId: asset.id,
    versionId: version.id,
    expectedSha256: version.content_sha256,
    taskExecutionId: execution.id,
    outputKey: asset.output_key,
    decision: 'accepted',
    attestorType: 'human',
    attestorId: options.actorId,
    evidence: { external_snapshot_sha256: version.content_sha256 },
    summary: 'Promoted diagnostic from legacy execution history.',
    casRoot: options.casRoot
  });
}

function legacyHistoryForTask(state, task) {
  const targetIds = new Set(
    (state.repository_targets || []).filter((item) => item.task_id === task.id).map((item) => item.id)
  );
  const deliveries = (state.deliveries || [])
    .filter(
      (item) =>
        (item.task_id === task.id || targetIds.has(item.repository_target_id)) && TERMINAL_LEGACY.has(item.status)
    )
    .map((record) => ({ type: 'delivery', record }));
  const runs = (state.node_runs || [])
    .filter((item) => item.node_id === task.id && !item.task_execution_id && TERMINAL_LEGACY.has(item.status))
    .map((record) => ({ type: 'node_run', record }));
  const submissions = (state.submissions || [])
    .filter((item) => item.node_id === task.id || item.from_scope_id === task.id)
    .sort(byTime);
  const history = [...deliveries, ...runs].sort((left, right) => byTime(left.record, right.record));
  if (!history.length && submissions.length) history.push({ type: 'submission', record: submissions.at(-1) });
  history.submissions = submissions;
  return history;
}

function groupCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    candidate.submissions = candidate.history.submissions || [];
    const key = `${candidate.workflow.id}:${candidate.task.parent_node_id}`;
    if (!groups.has(key))
      groups.set(key, { workflow: candidate.workflow, workstreamId: candidate.task.parent_node_id, candidates: [] });
    groups.get(key).candidates.push(candidate);
  }
  return [...groups.values()];
}

function createPromotedRepositoryLine(state, execution, workstreamId, candidates, timestamp) {
  const delivery = candidates
    .flatMap((item) => item.history.filter((entry) => entry.type === 'delivery').map((entry) => entry.record))
    .filter((item) => item.branch)
    .sort(byTime)
    .at(-1);
  if (!delivery) return null;
  const target = state.repository_targets.find((item) => item.id === delivery.repository_target_id),
    connection = state.repository_connections.find((item) => item.id === target?.connection_id);
  const binding = state.project_repository_bindings.find(
    (item) => item.project_id === execution.project_id && item.status !== 'removed'
  );
  return {
    id: stableId('rln', execution.id, workstreamId),
    workflow_execution_id: execution.id,
    project_id: execution.project_id,
    workflow_id: execution.workflow_id,
    workstream_id: workstreamId,
    connection_id: target?.connection_id || connection?.id || null,
    canonical_repository_id: binding?.canonical_repository_id || null,
    base_ref: connection?.default_branch || 'main',
    base_sha: delivery.base_sha || null,
    branch: safeRef(delivery.branch, `legacy/${workstreamId}`),
    head_sha: repositoryShaFor(delivery),
    checkout_path: null,
    status: delivery.pr_state === 'merged' ? 'merged' : delivery.status === 'failed' ? 'failed' : 'active',
    active_writer_execution_id: null,
    pull_request_intent_id: null,
    pr_number: delivery.pr_number || null,
    merged_sha: delivery.pr_state === 'merged' ? repositoryShaFor(delivery) : null,
    pr_url: delivery.pr_url || null,
    pr_state: delivery.pr_state || null,
    created_at: delivery.created_at || timestamp,
    updated_at: timestamp
  };
}

function promotedContext(workflowExecution, task, contract, activity, line) {
  return {
    schema_version: 'aiws.task_execution_context.v3',
    project_id: workflowExecution.project_id,
    workflow_id: workflowExecution.workflow_id,
    workflow_execution_id: workflowExecution.id,
    workflow_revision: workflowExecution.workflow_revision,
    task_revision: Number(task.execution_revision || 1),
    workstream_id: task.parent_node_id,
    task: { id: task.id, title: task.title, task_kind: task.task_kind, execution_mode: task.execution_mode },
    contract: structuredClone(contract),
    inputs: [],
    repository_snapshot: line
      ? {
          repository_line_id: line.id,
          connection_id: line.connection_id,
          ref: line.branch,
          fixed_sha: line.head_sha,
          current_sha: line.head_sha,
          mode: 'read_only',
          managed_path: null
        }
      : null,
    planning_quality: 'verified',
    legacy_compatibility: false,
    migration: { source_type: activity.type, source_id: activity.record.id || null }
  };
}
function promotedPayload(task, activity, submission, repositorySha) {
  return {
    schema_version: 'aiws.promoted_execution_output.v1',
    task: { id: task.id, title: task.title },
    source: {
      type: activity.type,
      id: activity.record.id || null,
      status: activity.record.status || null,
      created_at: activity.record.created_at || null,
      completed_at: activity.record.completed_at || activity.record.updated_at || null
    },
    summary: submission?.summary || activity.record.summary || '',
    repository: repositorySha
      ? { sha: repositorySha, base_sha: activity.record.base_sha || null, branch: activity.record.branch || null }
      : null,
    pull_request: activity.record.pr_url
      ? {
          number: activity.record.pr_number || null,
          url: activity.record.pr_url,
          state: activity.record.pr_state || null
        }
      : null,
    submission: submission
      ? {
          id: submission.id,
          title: submission.title,
          status: submission.status,
          reviewed_at: submission.reviewed_at || null
        }
      : null
  };
}
function promotedMetadata(activity, repositorySha) {
  return {
    source: 'legacy_execution_promotion',
    source_type: activity.type,
    source_id: activity.record.id || null,
    repository_sha: repositorySha,
    branch: activity.record.branch || null,
    pull_request_number: activity.record.pr_number || null,
    pull_request_url: activity.record.pr_url || null,
    pull_request_state: activity.record.pr_state || null
  };
}
function promotedEvidenceRefs(activity, submission = null, repositorySha = null) {
  return [
    `${activity.type}:${activity.record.id || 'unknown'}`,
    submission?.id ? `submission:${submission.id}` : null,
    repositorySha ? `commit:${repositorySha}` : null,
    activity.record.pr_url || null
  ].filter(Boolean);
}
function attestationEvidence(assetType, version, repositorySha) {
  if (/TestReport|TestEvidence/i.test(assetType))
    return {
      repository_sha: repositorySha,
      commands: [{ command: 'legacy-evidence-promotion', exit_code: 0, log_sha256: version.content_sha256 }]
    };
  if (/RepositoryVersion|CodeChange/i.test(assetType)) {
    if (!repositorySha) throw promotionError('legacy_repository_sha_missing');
    return { repository_sha: repositorySha, commit_sha: repositorySha, checkout_head: repositorySha };
  }
  return { repository_sha: repositorySha || null, external_snapshot_sha256: version.content_sha256 };
}
function verifierFor(assetType) {
  return /TestReport|TestEvidence/i.test(assetType)
    ? 'repository_verify_verifier'
    : /RepositoryVersion|CodeChange/i.test(assetType)
      ? 'repository_change_verifier'
      : /Integration|DeliveryEvidence/i.test(assetType)
        ? 'repository_integrate_verifier'
        : 'aiws_cas_verifier';
}
function promotedExecutor(task, record) {
  if (task.task_kind === 'integration' || task.execution_mode === 'integration') return 'repository_integrate';
  if (task.execution_mode === 'assist') return 'assist';
  if (task.execution_mode === 'manual') return 'manual';
  return record.runner === 'codex' ? 'codex' : 'codex_docker';
}
function promotedStatus(source, nodeStatus) {
  if (['completed', 'succeeded', 'accepted'].includes(source) || (nodeStatus === 'completed' && source === 'submitted'))
    return 'completed';
  if (source === 'cancelled') return 'cancelled';
  return 'failed';
}
function repositoryShaFor(record) {
  const value = record.commit_sha || record.head_sha || record.repository_sha || null;
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(String(value || '')) ? value : null;
}
function appendEvent(state, workflow, execution, sequence, type, data, createdAt) {
  state.execution_events.push({
    id: stableId('exe', workflow.id, sequence, type),
    workflow_execution_id: workflow.id,
    task_execution_id: execution?.id || null,
    project_id: workflow.project_id,
    sequence,
    type,
    actor_type: 'system',
    actor_id: null,
    data,
    created_at: createdAt
  });
  return sequence + 1;
}
function activityTime(item) {
  return item.record.completed_at || item.record.updated_at || item.record.created_at || '';
}
function byTime(left, right) {
  return String(left.created_at || left.updated_at || '').localeCompare(
    String(right.created_at || right.updated_at || '')
  );
}
function safeRef(value, fallback) {
  const text = String(value || fallback)
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .slice(0, 240);
  return text && !text.includes('..') ? text : 'legacy/promoted';
}
function stableId(prefix, ...parts) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 20)}`;
}
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function writePromotionBackup(state, directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`),
    hash = createHash('sha256').update(bytes).digest('hex'),
    target = path.join(directory, `state-schema19-execution-promotion-v1-${hash.slice(0, 16)}.json`);
  await fsp.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  return target;
}
function promotionError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
