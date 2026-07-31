import { estimateTokens, now } from '../../../packages/shared/index.mjs';
import { buildContextPack, buildRunnerInstruction } from '../../../packages/shared/src/context-run.mjs';
import { isContributionTask } from '../../../packages/shared/src/task-contributions.mjs';
import { compactRuntimeMap, createSelectionForRuntimeInState } from './context-service.mjs';
import { HttpError } from './http.mjs';
import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { executionInputEffectObligations, validateRepositoryVersionBinding } from './task-execution-input-domain.mjs';
import {
  applyV21ContextPackFields,
  assertMandatoryContextEvidence,
  prepareV21ContextSelection
} from './task-execution-context-v21.mjs';
import { executionInputHash } from './task-execution-context-freshness.mjs';
import {
  dependencySnapshot,
  digestSnapshot,
  legacyRepositorySnapshot,
  repositoryLineSnapshot,
  requiredContextSourceRefs,
  runtimeContextSourceRefs,
  taskSnapshot
} from './task-execution-context-snapshots.mjs';
import { resolveExecutionInputSlot } from './task-execution-input-resolution.mjs';

export { evaluateTaskExecutionContextFreshness, executionInputHash } from './task-execution-context-freshness.mjs';
export { inspectWorkstreamDependencyHandoff, selectTaskOutputBindings } from './task-execution-handoff.mjs';

export const EXECUTION_INPUT_HASH_VERSION = 3;

export function prepareTaskExecutionContext(state, input) {
  const scope = requireExecutionScope(state, input);
  const { errors, resolved } = resolveExecutionInputs(state, input, scope);
  const repositorySnapshot = selectRepositorySnapshot(input, scope.project, scope.task, scope.strict, resolved);
  validateRepositoryVersionBinding(resolved, repositorySnapshot, errors);
  if (errors.length && scope.strict) throw contextNotReady(errors);
  const snapshot = createExecutionSnapshot(state, input, { ...scope, resolved, repositorySnapshot });
  snapshot.input_snapshot_hash_version = EXECUTION_INPUT_HASH_VERSION;
  snapshot.input_snapshot_hash = executionInputHash(snapshot);
  const contextPack = persistExecutionContext(state, input, { ...scope, snapshot });
  return { context: snapshot, context_pack: contextPack };
}

function requireExecutionScope(state, input) {
  const { project, task, contract } = input;
  const workflow = input.workflow || state.workflows.find((item) => item.id === task?.workflow_id);
  if (!project || !task || !contract || !workflow)
    throw new HttpError(404, { error: 'task_execution_scope_not_found' });
  if (task.role === 'workstream')
    throw new HttpError(409, { error: 'workstream_is_aggregate_not_executable', node_id: task.id });
  if (task.status === 'completed' && input.allowCompletedTask !== true)
    throw contextNotReady([
      { code: 'task_completed_immutable', task_id: task.id, action: 'create_follow_up_task_or_reopen_revision' }
    ]);
  return {
    project,
    workspace: input.workspace,
    task,
    contract,
    workflow,
    strict: workflow.planning_quality === 'verified'
  };
}

function resolveExecutionInputs(state, input, scope) {
  const errors = [];
  const resolved = [];
  const slots = Array.isArray(scope.contract?.expected_inputs) ? scope.contract.expected_inputs : [];
  for (const slot of slots) {
    const value = resolveExecutionInputSlot(state, { ...input, ...scope }, slot, errors);
    if (value) resolved.push(value);
    else if (slot.required !== false && !errors.some((item) => item.slot_key === slot.key))
      errors.push({ code: 'required_input_missing', slot_key: slot.key });
  }
  return { errors, resolved };
}

function selectRepositorySnapshot(input, project, task, strict, resolved) {
  const resolvedRepository = resolved.find((item) => item.kind === 'repository')?.repository_snapshot;
  if (resolvedRepository) return resolvedRepository;
  return input.repositoryLine
    ? repositoryLineSnapshot(input.repositoryLine, task)
    : legacyRepositorySnapshot(project, strict);
}

function createExecutionSnapshot(state, input, scope) {
  const { project, task, contract, workflow, strict, resolved, repositorySnapshot } = scope;
  const digest = requiresContext(contract, 'latest_digest') ? currentWorkstreamDigest(state, task) : null;
  const brief = resolved.find((item) => item.source === 'brief')?.context || null;
  const decisions = resolved.filter((item) => item.source === 'decision' && item.context).map((item) => item.context);
  return {
    ...executionIdentitySnapshot(input, task, workflow),
    task: taskSnapshot(task),
    contract: structuredClone(contract),
    dependency_graph: dependencySnapshot(state, task, input.taskExecution?.workflow_execution_id),
    inputs: resolved,
    input_effect_obligations: executionInputEffectObligations(resolved),
    repository_snapshot: repositorySnapshot,
    workstream_digest: digest ? digestSnapshot(digest) : null,
    project_brief: brief ? structuredClone(brief) : null,
    project_decisions: decisions.map((item) => structuredClone(item)),
    ...executionQualitySnapshot(input, workflow, strict)
  };
}

function executionIdentitySnapshot(input, task, workflow) {
  return {
    schema_version: executionContextSchema(input.taskExecution, task),
    project_id: input.project.id,
    workflow_id: workflow.id,
    workflow_execution_id: input.workflowExecution?.id || input.taskExecution?.workflow_execution_id || null,
    workflow_revision: executionWorkflowRevision(input.workflowExecution, workflow),
    task_execution_id: input.taskExecution?.id || null,
    task_revision: input.taskExecution?.task_revision || Number(task.execution_revision || 1),
    workstream_id: task.parent_node_id || null
  };
}

function executionContextSchema(taskExecution, task) {
  if (!taskExecution) return 'aiws.task_execution_context.v2';
  return isContributionTask(task) ? 'aiws.task_execution_context.v5' : 'aiws.task_execution_context.v4';
}

function executionWorkflowRevision(workflowExecution, workflow) {
  return workflowExecution?.workflow_revision || Number(workflow.workflow_revision || workflow.version || 1);
}

function executionQualitySnapshot(input, workflow, strict) {
  return {
    planning_quality: workflow.planning_quality || 'legacy_unverified',
    outcome_contract_hash: input.workflowExecution?.outcome_contract_hash || workflow.outcome_contract_hash || null,
    quality_rubric_hash: input.workflowExecution?.quality_rubric_hash || workflow.quality_rubric_hash || null,
    quality_rubric: workflow.quality_rubric ? structuredClone(workflow.quality_rubric) : null,
    legacy_compatibility: !strict
  };
}

function currentWorkstreamDigest(state, task) {
  const parent = state.workflow_nodes.find((item) => item.id === task.parent_node_id);
  const workspace = state.workspaces.find(
    (item) => item.id === parent?.workspace_id || item.workflow_node_id === parent?.id
  );
  return (
    state.digests
      .filter((item) => item.workspace_id === workspace?.id && item.status === 'confirmed')
      .sort(byNewest)[0] || null
  );
}

function requiresContext(contract, type) {
  return (contract?.required_context || []).some((item) => item?.type === type && item.required === true);
}

function persistExecutionContext(state, input, scope) {
  const runtime = prepareRuntimeContext(state, input, scope);
  assertMandatoryContextEvidence(runtime.selection, runtime.v21.enabled);
  attachSystemContext(scope.snapshot, scope.task, runtime);
  applyV21ContextPackFields(runtime.contextPack, scope.snapshot, runtime.selection, runtime.v21);
  attachContextPackRuntimeContent(runtime.contextPack, scope, runtime);
  finalizeContextPack(runtime.contextPack, scope.snapshot, scope);
  state.context_packs.push(runtime.contextPack);
  state.context_sufficiency_checks.push(runtime.contextPack._sufficiency_check);
  return runtime.contextPack;
}

function prepareRuntimeContext(state, input, scope) {
  const { project, workspace, task, contract, snapshot } = scope;
  const requiredRefs = requiredContextSourceRefs(snapshot);
  const explicitRefs = runtimeContextSourceRefs(snapshot);
  const v21 = prepareV21ContextSelection(state, snapshot, task, explicitRefs, requiredRefs);
  const contextPack = buildContextPack({
    state,
    project,
    workspace,
    node: task,
    contract,
    purpose: input.purpose || 'node_run',
    receiver_name: input.receiverName || 'CodexRunner',
    executionContext: snapshot
  });
  const actorId = input.actorId || project.owner_user_id || project.created_by_user_id || state.instance_owner_user_id;
  const selection = createSelectionForRuntimeInState(state, {
    actorId,
    projectId: project.id,
    anchorSourceCollection: 'workflow_nodes',
    anchorSourceId: task.id,
    explicitSourceRefs: explicitRefs,
    candidateLimit: 0,
    tokenBudget: Number(project.settings?.token_budget || 12_000),
    ...v21.selectionOptions
  });
  return {
    v21,
    contextPack,
    selection,
    compactMap: compactRuntimeMap(state, project.id, task.id),
    documentVersions: contextDocumentVersions(state, selection, requiredRefs),
    retrievalProtocol: contextRetrievalProtocol()
  };
}

function contextDocumentVersions(state, selection, requiredRefs) {
  return selection.included.map((item) => {
    const node = state.context_nodes.find((entry) => entry.id === item.node_id);
    const sourceKey = `${node?.source_collection || ''}:${node?.source_id || ''}`;
    return {
      node_id: item.node_id,
      document_version_id: item.document_version_id,
      content_sha256: item.content_sha256,
      source_collection: node?.source_collection || null,
      source_id: node?.source_id || null,
      title: node?.title || null,
      reason: item.reason,
      required: requiredRefs.has(sourceKey),
      consumption_policy: 'available',
      delivery_mode: 'metadata_only'
    };
  });
}

function contextRetrievalProtocol() {
  return {
    tool: 'aiws_context',
    order: ['map', 'search', 'read'],
    instruction: '按任务锚点读取必要上下文；不得绕过项目 ACL、资源 scope、新鲜度或 Exchange Grant。'
  };
}

function attachSystemContext(snapshot, task, runtime) {
  snapshot.system_context = {
    current_anchor: {
      node_id: runtime.compactMap.anchor_node_id,
      source_collection: 'workflow_nodes',
      source_id: task.id
    },
    context_map: runtime.compactMap,
    context_selection_id: runtime.selection.id,
    document_versions: runtime.documentVersions,
    retrieval_protocol: runtime.retrievalProtocol
  };
}

function attachContextPackRuntimeContent(contextPack, scope, runtime) {
  Object.assign(contextPack.content_json, {
    context_map: runtime.compactMap,
    context_selection_id: runtime.selection.id,
    document_versions: runtime.documentVersions,
    retrieval_protocol: runtime.retrievalProtocol
  });
  contextPack.content_json.runner_instruction = buildRunnerInstruction({
    project: scope.project,
    node: scope.task,
    contract: scope.contract,
    executionContext: scope.snapshot
  });
  contextPack.token_estimate = estimateTokens(JSON.stringify(contextPack.content_json));
}

function finalizeContextPack(contextPack, snapshot) {
  snapshot.context_pack_id = contextPack.id;
  snapshot.prepared_at = now();
  Object.assign(contextPack, {
    task_execution_context: structuredClone(snapshot),
    input_snapshot_hash: snapshot.input_snapshot_hash,
    input_snapshot_hash_version: snapshot.input_snapshot_hash_version,
    repository_snapshot_hash: snapshot.repository_snapshot?.snapshot_hash || null
  });
}

function contextNotReady(reasons) {
  return new HttpError(409, { error: 'task_context_not_ready', reasons });
}

function byNewest(a, b) {
  return String(b.reviewed_at || b.created_at || '').localeCompare(String(a.reviewed_at || a.created_at || ''));
}
