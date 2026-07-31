import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { owner, addTrace } from './state.mjs';
import { requireApprovedDeliveryPolicy } from './repository-delivery-domain.mjs';
import { assertProjectLifecycleIdle } from './project-lifecycle-operations.mjs';
import { assertRepositoryDeletionInactive } from './repository-lifecycle-v19.mjs';
import { prepareTaskExecutionContext } from './task-execution-context.mjs';
import { assertControlledTaskWrite } from './execution-governance.mjs';
import {
  appendDeliveryEvent,
  requireDeliveryTask,
  sanitizeDeliveryTestInput,
  stableDeliveryBranch
} from './delivery-state-domain.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const REQUIRED_AUTOMATION_PERMISSIONS = ['codex_run', 'commit', 'push', 'draft_pr'];

export function createTaskDeliveryInState(state, taskId, input = {}, actorId = null) {
  const task = requireDeliveryTask(state, taskId),
    actor = actorId ? state.users.find((item) => item.id === actorId) : owner(state),
    workflow = state.workflows.find((item) => item.id === task.workflow_id),
    project = state.projects.find((item) => item.id === workflow?.project_id);
  assertProjectLifecycleIdle(project);
  assertRepositoryDeletionInactive(state, { projectId: workflow?.project_id });
  const controlled = assertControlledTaskWrite(state, task.id, input, 'repository_delivery');
  assertDeliveryCapable(task);
  const active = state.deliveries.find((item) => item.task_id === task.id && !TERMINAL.has(item.status));
  if (active) return { delivery: active, idempotent: true, created: false };

  const { target, policy, connection } = requireApprovedDeliveryPolicy(state, task, input.policy_id || null);
  assertAutomationPermissions(policy);
  const previous = previousDelivery(state, task, connection),
    scope = deliveryScope(state, task, workflow, project),
    prepared = prepareDeliveryContext(state, actor, task, controlled, input, scope);
  assertPreparedContext(prepared, connection);
  const delivery = buildDelivery(task, actor, controlled, input, target, policy, connection, previous, prepared);
  state.deliveries.push(delivery);
  appendDeliveryEvent(state, delivery, 'queued', { attempt: delivery.attempt, branch: delivery.branch });
  target.status = 'active_delivery';
  target.updated_at = now();
  traceDeliveryStarted(state, delivery, task, connection, actor);
  return { delivery, idempotent: false, created: true };
}

function assertDeliveryCapable(task) {
  if (!['code', 'test', 'integration', 'deploy'].includes(task.task_kind))
    throw new HttpError(409, { error: 'task_not_delivery_capable', task_kind: task.task_kind });
}

function assertAutomationPermissions(policy) {
  const missingPermissions = REQUIRED_AUTOMATION_PERMISSIONS.filter(
    (permission) => !policy.automation_permissions.includes(permission)
  );
  if (missingPermissions.length)
    throw new HttpError(409, {
      error: 'delivery_policy_permissions_required',
      missing_permissions: missingPermissions
    });
}

function previousDelivery(state, task, connection) {
  return (
    state.deliveries
      .filter((item) => item.task_id === task.id && item.connection_id === connection.id && item.status === 'completed')
      .sort((left, right) => String(right.completed_at).localeCompare(String(left.completed_at)))[0] || null
  );
}

function deliveryScope(state, task, workflow, project) {
  return {
    project,
    workflow,
    workspace: state.workspaces.find((item) => item.id === task.workspace_id || item.workflow_node_id === task.id),
    contract: state.node_contracts.find((item) => item.id === task.current_contract_id)
  };
}

function prepareDeliveryContext(state, actor, task, controlled, input, scope) {
  if (controlled.controlled)
    return {
      context: structuredClone(controlled.task_execution.context_snapshot),
      context_pack: state.context_packs.find(
        (item) => item.id === controlled.task_execution.context_snapshot?.context_pack_id
      )
    };
  return prepareTaskExecutionContext(state, {
    actor,
    ...scope,
    task,
    purpose: 'delivery',
    receiverName: 'CodexDelivery',
    repositoryWorkspaceId: input.repository_workspace_id
  });
}

function assertPreparedContext(prepared, connection) {
  if (!prepared.context || !prepared.context_pack)
    throw new HttpError(409, { error: 'task_execution_context_required' });
  const snapshot = prepared.context.repository_snapshot;
  if (snapshot?.connection_id && snapshot.connection_id !== connection.id)
    throw new HttpError(409, {
      error: 'task_context_not_ready',
      reasons: [
        {
          code: 'repository_workspace_connection_mismatch',
          repository_workspace_id: snapshot.repository_workspace_id,
          connection_id: connection.id
        }
      ]
    });
}

function buildDelivery(task, actor, controlled, input, target, policy, connection, previous, prepared) {
  const delivery = {
    ...deliveryIdentity(task, controlled, policy),
    ...deliveryRepository(target, connection, policy, input, previous, task),
    ...deliveryContext(prepared, input),
    ...deliveryLifecycle(actor)
  };
  delivery.operation_id = delivery.id;
  return delivery;
}

function deliveryIdentity(task, controlled, policy) {
  return {
    id: id('dlv'),
    operation_id: null,
    project_id: policy.project_id,
    workflow_id: task.workflow_id,
    workstream_id: task.parent_node_id,
    task_id: task.id,
    task_execution_id: nullable(property(controlled.task_execution, 'id'))
  };
}

function deliveryRepository(target, connection, policy, input, previous, task) {
  return {
    repository_target_id: target.id,
    connection_id: connection.id,
    policy_id: policy.id,
    policy_hash: policy.policy_hash,
    status: 'queued',
    phase: 'queued',
    attempt: Number(withDefault(input.attempt, 1)),
    retry_of_delivery_id: nullable(input.retry_of_delivery_id),
    branch: property(previous, 'branch') || stableDeliveryBranch(task),
    base_ref: policy.base_ref,
    expected_base_sha: clean(input.expected_base_sha, 64) || null,
    base_sha: null,
    worktree_path: nullable(property(previous, 'worktree_path')),
    commit_sha: null,
    changed_files: [],
    test_results: [],
    pr_number: nullable(property(previous, 'pr_number')),
    pr_url: nullable(property(previous, 'pr_url')),
    pr_state: nullable(property(previous, 'pr_state'))
  };
}

function deliveryContext(prepared, input) {
  const context = prepared.context,
    repositorySnapshot = context.repository_snapshot;
  return {
    adapter: input.adapter === 'test' ? 'test' : null,
    test_input: input.adapter === 'test' ? sanitizeDeliveryTestInput(input) : null,
    context_pack_id: prepared.context_pack.id,
    task_execution_context: structuredClone(context),
    input_snapshot_hash: context.input_snapshot_hash,
    repository_snapshot_hash: nullable(property(repositorySnapshot, 'snapshot_hash')),
    contract_snapshot: context.contract,
    task_snapshot: context.task,
    dependency_graph: context.dependency_graph,
    input_assets: context.inputs.flatMap((item) => item.asset_versions || []),
    repository_workspace_id: nullable(property(repositorySnapshot, 'repository_workspace_id'))
  };
}

function deliveryLifecycle(actor) {
  return {
    error_code: null,
    error_detail: null,
    retryable: false,
    input_superseded: false,
    cancel_requested_at: null,
    created_by_user_id: nullable(property(actor, 'id')),
    created_at: now(),
    updated_at: now(),
    completed_at: null
  };
}

function traceDeliveryStarted(state, delivery, task, connection, actor) {
  addTrace(
    state,
    'delivery.started',
    {
      project_id: delivery.project_id,
      node_id: task.id,
      target_id: delivery.id,
      summary: `Delivery queued for ${connection.full_name}.`
    },
    nullable(property(actor, 'id'))
  );
}

function property(value, key) {
  return value?.[key];
}

function nullable(value) {
  return value || null;
}

function withDefault(value, fallback) {
  return value || fallback;
}

function clean(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
