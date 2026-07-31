import { id, now } from '../../../packages/shared/index.mjs';
import { attestAssetVersionInState } from './asset-attestation-service.mjs';
import { createAssetRecord, createImmutableAssetVersion } from './asset-cas.mjs';
import { HttpError } from './http.mjs';
import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { appendExecutionEvent, currentTaskExecutions } from './workflow-execution-domain.mjs';

export async function ensureCompletedWorkstreamOutcomesInState(state, workflowExecutionId) {
  const workflowExecution = state.workflow_executions.find((item) => item.id === workflowExecutionId);
  if (!workflowExecution) throw new HttpError(404, { error: 'workflow_execution_not_found' });

  const executions = currentTaskExecutions(state, workflowExecutionId);
  const workstreams = state.workflow_nodes.filter(
    (item) => item.workflow_id === workflowExecution.workflow_id && item.role === 'workstream'
  );
  const outcomes = [];
  for (const workstream of workstreams) {
    const scope = completedWorkstreamScope(state, executions, workstream, workflowExecutionId);
    if (!scope) continue;
    if (scope.existing) {
      outcomes.push(scope.existing);
      continue;
    }
    if (scope.line && scope.line.status !== 'merged') continue;
    const outcome = await createWorkstreamOutcome(state, workflowExecution, workstream, scope);
    outcomes.push(outcome);
  }
  return outcomes;
}

function completedWorkstreamScope(state, executions, workstream, workflowExecutionId) {
  const taskNodes = state.workflow_nodes.filter(
    (item) => item.parent_node_id === workstream.id && item.required !== false
  );
  const taskIds = new Set(taskNodes.map((item) => item.id));
  const tasks = executions.filter((item) => taskIds.has(item.task_id));
  if (!tasks.length || tasks.some((item) => item.status !== 'completed')) return null;

  const existing = findConfirmedOutcome(state, workstream.id, workflowExecutionId);
  if (existing) return { existing };
  const bindings = tasks.flatMap((item) => item.output_bindings || []);
  const terminalTaskIds = terminalTaskIdsFor(taskNodes);
  const terminalBindings = terminalBindingsFor(state, tasks, terminalTaskIds);
  const handoffBindings = terminalBindings.filter((binding) => binding.handoff !== false);
  if (!handoffBindings.length)
    throw new HttpError(409, {
      error: 'workstream_handoff_outputs_missing',
      workstream_id: workstream.id,
      terminal_task_ids: [...terminalTaskIds]
    });
  const line = state.repository_lines.find(
    (item) => item.workflow_execution_id === workflowExecutionId && item.workstream_id === workstream.id
  );
  return { tasks, bindings, terminalBindings, handoffBindings, line };
}

function findConfirmedOutcome(state, workstreamId, workflowExecutionId) {
  return state.assets.find(
    (item) =>
      item.node_id === workstreamId &&
      item.asset_type === 'WorkstreamOutcomeAsset' &&
      item.provenance_workflow_execution_id === workflowExecutionId &&
      item.status === 'confirmed'
  );
}

function terminalTaskIdsFor(taskNodes) {
  return new Set(
    taskNodes
      .filter((task) => !taskNodes.some((candidate) => nodeDependencyIds(candidate).includes(task.id)))
      .map((item) => item.id)
  );
}

function terminalBindingsFor(state, tasks, terminalTaskIds) {
  return tasks
    .filter((item) => terminalTaskIds.has(item.task_id))
    .flatMap((item) => executionTerminalBindings(state, item));
}

function executionTerminalBindings(state, execution) {
  const contract = state.node_contracts.find((entry) => entry.id === execution.contract_id);
  return (execution.output_bindings || []).map((binding) => {
    const outputSlot = (contract?.expected_outputs || []).find((slot) => slot.key === binding.key);
    return {
      ...structuredClone(binding),
      required: outputSlot?.required !== false,
      producer_task_id: execution.task_id,
      producer_task_execution_id: execution.id
    };
  });
}

async function createWorkstreamOutcome(state, workflowExecution, workstream, scope) {
  const asset = createOutcomeAsset(workflowExecution, workstream);
  state.assets.push(asset);
  const version = await createOutcomeVersion(state, workflowExecution, workstream, asset, scope);
  recordWorkstreamOutcomeEvidence(state, scope.bindings, asset, version, workflowExecution.id);
  await attestOutcomeVersion(state, workflowExecution.id, asset, version, scope);
  appendExecutionEvent(
    state,
    workflowExecution,
    null,
    'workstream.outcome_created',
    { workstream_id: workstream.id, asset_id: asset.id, version_id: version.id },
    'system',
    null
  );
  return asset;
}

function createOutcomeAsset(workflowExecution, workstream) {
  const asset = createAssetRecord({
    projectId: workflowExecution.project_id,
    workspaceId: workstream.workspace_id,
    taskId: workstream.id,
    taskExecutionId: null,
    assetType: 'WorkstreamOutcomeAsset',
    title: `${workstream.title} outcome`,
    summary: workstream.outcome || workstream.goal,
    outputKey: 'workstream_outcome',
    actorId: workflowExecution.created_by_user_id
  });
  Object.assign(asset, {
    confirmation_policy: 'system_evidence',
    provenance_workflow_execution_id: workflowExecution.id
  });
  return asset;
}

function createOutcomeVersion(state, workflowExecution, workstream, asset, scope) {
  return createImmutableAssetVersion(state, {
    asset,
    payload: outcomePayload(workflowExecution, workstream.id, scope),
    title: asset.title,
    summary: asset.summary,
    evidenceRefs: [
      ...scope.bindings.map((item) => `asset-version:${item.version_id}`),
      ...(scope.line?.merged_sha ? [`merge:${scope.line.merged_sha}`] : [])
    ],
    repositorySha: scope.line?.merged_sha || scope.line?.head_sha || null,
    provenance: {
      source: 'workstream_execution',
      workflow_execution_id: workflowExecution.id,
      workstream_id: workstream.id
    },
    actorId: workflowExecution.created_by_user_id
  });
}

function outcomePayload(workflowExecution, workstreamId, scope) {
  return {
    payload_kind: 'json',
    media_type: 'application/json',
    content: {
      schema_version: 'aiws.workstream_outcome.v1',
      workflow_execution_id: workflowExecution.id,
      workstream_id: workstreamId,
      workflow_revision: workflowExecution.workflow_revision,
      handoff_output_bindings: scope.handoffBindings,
      terminal_output_bindings: scope.terminalBindings,
      terminal_task_executions: scope.tasks.map(taskExecutionSummary),
      repository_line: repositoryLineSummary(scope.line)
    }
  };
}

function taskExecutionSummary(execution) {
  return {
    id: execution.id,
    task_id: execution.task_id,
    attempt: execution.attempt,
    input_snapshot_hash: execution.input_snapshot_hash,
    output_bindings: execution.output_bindings
  };
}

function repositoryLineSummary(line) {
  if (!line) return null;
  return {
    id: line.id,
    base_sha: line.base_sha,
    head_sha: line.head_sha,
    merged_sha: line.merged_sha,
    pr_number: line.pr_number
  };
}

function attestOutcomeVersion(state, workflowExecutionId, asset, version, scope) {
  return attestAssetVersionInState(state, {
    assetId: asset.id,
    versionId: version.id,
    expectedSha256: version.content_sha256,
    outputKey: 'workstream_outcome',
    decision: 'accepted',
    attestorType: 'trusted_verifier',
    attestorId: 'aiws_cas_verifier',
    evidence: {
      workflow_execution_id: workflowExecutionId,
      handoff_output_bindings: scope.handoffBindings,
      terminal_output_bindings: scope.terminalBindings,
      external_snapshot_sha256: version.content_sha256,
      repository_line: scope.line
        ? { id: scope.line.id, merged_sha: scope.line.merged_sha, pr_number: scope.line.pr_number }
        : null
    }
  });
}

function nodeDependencyIds(node) {
  const source = Array.isArray(node?.dependency_ids) ? node.dependency_ids : node?.dependencies || [];
  return source.map((item) => (typeof item === 'string' ? item : item?.node_id)).filter(Boolean);
}

function recordWorkstreamOutcomeEvidence(state, bindings, outcomeAsset, outcomeVersion, workflowExecutionId) {
  const seen = new Set();
  for (const binding of bindings) {
    if (!binding?.asset_id || !binding?.version_id || seen.has(binding.version_id)) continue;
    seen.add(binding.version_id);
    if (hasOutcomeEvidenceRelation(state, binding.version_id, outcomeVersion.id)) continue;
    state.asset_relations.push(outcomeEvidenceRelation(binding, outcomeAsset, outcomeVersion, workflowExecutionId));
  }
}

function hasOutcomeEvidenceRelation(state, sourceVersionId, targetVersionId) {
  return state.asset_relations.some(
    (item) =>
      item.relation_type === 'evidenced_by' &&
      item.source_asset_version_id === sourceVersionId &&
      item.target_asset_version_id === targetVersionId
  );
}

function outcomeEvidenceRelation(binding, outcomeAsset, outcomeVersion, workflowExecutionId) {
  return {
    id: id('arl'),
    relation_type: 'evidenced_by',
    source_asset_id: binding.asset_id,
    source_asset_version_id: binding.version_id,
    target_asset_id: outcomeAsset.id,
    target_asset_version_id: outcomeVersion.id,
    input_snapshot_hash: null,
    execution_id: null,
    workflow_execution_id: workflowExecutionId,
    created_at: now()
  };
}
