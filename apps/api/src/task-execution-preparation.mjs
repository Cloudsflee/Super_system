import path from 'node:path';

import { now } from '../../../packages/shared/index.mjs';
import { materializeAssetVersion, verifyAssetVersionPayload } from './asset-cas.mjs';
import { EXECUTION_DIR } from './config.mjs';
import { HttpError } from './http.mjs';
import { verifyRepositoryLineHead } from './repository-line-service.mjs';
import { cloneStateValue as structuredClone } from './state-clone.mjs';
import {
  EXECUTION_INPUT_HASH_VERSION,
  executionInputHash,
  prepareTaskExecutionContext
} from './task-execution-context.mjs';
import { appendExecutionEvent, requireTaskExecution } from './workflow-execution-domain.mjs';

export async function prepareTaskExecutionInState(state, taskExecutionId, { allowCompletedTask = false } = {}) {
  const execution = requireTaskExecution(state, taskExecutionId);
  assertPreparationStatus(execution);
  if (execution.context_snapshot) return execution.context_snapshot;

  const scope = requirePreparationScope(state, execution);
  assertExecutionRevisionCurrent(execution, scope);
  if (scope.repositoryLine?.checkout_path)
    await verifyRepositoryLineHead(scope.repositoryLine, scope.repositoryLine.head_sha, { requireClean: true });

  const prepared = prepareContext(state, execution, scope, allowCompletedTask);
  const mounts = await materializeInputAssets(state, execution, scope.workflowExecution, prepared.context.inputs);
  finalizePreparedContext(prepared.context, execution, scope.repositoryLine, mounts);
  validateRetryInputSnapshot(state, execution, scope.workflowExecution, prepared.context);
  persistPreparedContext(state, execution, scope.workflowExecution, prepared, mounts);
  return execution.context_snapshot;
}

function assertPreparationStatus(execution) {
  if (!['queued', 'running'].includes(execution.status))
    throw new HttpError(409, { error: 'task_execution_context_status_invalid', status: execution.status });
}

function requirePreparationScope(state, execution) {
  const project = state.projects.find((item) => item.id === execution.project_id);
  const workflow = state.workflows.find((item) => item.id === execution.workflow_id);
  const task = state.workflow_nodes.find((item) => item.id === execution.task_id);
  const contract = state.node_contracts.find((item) => item.id === execution.contract_id);
  const workspace = state.workspaces.find((item) => item.id === task?.workspace_id);
  const workflowExecution = state.workflow_executions.find((item) => item.id === execution.workflow_execution_id);
  const repositoryLine = state.repository_lines.find(
    (item) =>
      item.workflow_execution_id === execution.workflow_execution_id && item.workstream_id === execution.workstream_id
  );
  if (!project || !workflow || !task || !contract || !workspace || !workflowExecution)
    throw new HttpError(409, { error: 'task_execution_scope_incomplete' });
  return { project, workflow, task, contract, workspace, workflowExecution, repositoryLine };
}

function assertExecutionRevisionCurrent(execution, { workflow, task, contract, workflowExecution }) {
  const workflowCurrent =
    Number(workflow.workflow_revision || workflow.version || 1) === workflowExecution.workflow_revision;
  const taskCurrent = Number(task.execution_revision || 1) === execution.task_revision;
  const contractCurrent =
    contract.id === task.current_contract_id && Number(contract.version || 1) === execution.contract_version;
  if (!workflowCurrent || !taskCurrent || !contractCurrent)
    throw new HttpError(409, { error: 'task_execution_revision_superseded' });
}

function prepareContext(state, execution, scope, allowCompletedTask) {
  return prepareTaskExecutionContext(state, {
    project: scope.project,
    workflow: scope.workflow,
    workspace: scope.workspace,
    task: scope.task,
    contract: scope.contract,
    taskExecution: execution,
    workflowExecution: scope.workflowExecution,
    repositoryLine: scope.repositoryLine,
    allowCompletedTask,
    purpose: execution.executor,
    receiverName: receiverFor(execution.executor)
  });
}

async function materializeInputAssets(state, execution, workflowExecution, inputs = []) {
  const mountRoot = path.resolve(EXECUTION_DIR, workflowExecution.id, execution.id, 'inputs');
  const mounts = [];
  for (const input of inputs) {
    for (const binding of input.asset_versions || []) {
      const version = state.asset_versions.find((item) => item.id === binding.version_id);
      const verified = await verifyAssetVersionPayload(state, version);
      if (!verified.ok)
        throw new HttpError(409, {
          error: 'task_input_asset_integrity_failed',
          version_id: binding.version_id,
          reasons: verified.reasons
        });
      const mount = await materializeAssetVersion(state, version, path.join(mountRoot, binding.version_id));
      mounts.push(mountedAsset(input.key, binding, mount));
    }
  }
  return mounts;
}

function mountedAsset(inputKey, binding, mount) {
  return {
    input_key: inputKey,
    asset_id: binding.asset_id,
    version_id: binding.version_id,
    content_sha256: binding.content_sha256,
    manifest: binding.manifest,
    mount
  };
}

function finalizePreparedContext(context, execution, repositoryLine, mounts) {
  context.asset_mounts = mounts;
  context.repository_checkout = repositoryCheckout(repositoryLine, execution.executor);
  context.input_snapshot_hash = executionInputHash(context);
  context.input_snapshot_hash_version = EXECUTION_INPUT_HASH_VERSION;
}

function repositoryCheckout(repositoryLine, executor) {
  if (!repositoryLine) return null;
  return {
    repository_line_id: repositoryLine.id,
    path: repositoryLine.checkout_path,
    expected_head_sha: repositoryLine.head_sha,
    access: repositoryAccess(executor)
  };
}

function repositoryAccess(executor) {
  if (['assist', 'repository_verify'].includes(executor)) return 'read_only';
  if (executor === 'repository_integrate') return 'integrate_only';
  return 'read_write';
}

function validateRetryInputSnapshot(state, execution, workflowExecution, context) {
  if (!execution.retry_input_snapshot_hash) return;
  const retryHashVersion = Number(execution.retry_input_snapshot_hash_version || 1);
  if (retryHashVersion === EXECUTION_INPUT_HASH_VERSION) {
    if (execution.retry_input_snapshot_hash !== context.input_snapshot_hash)
      throw new HttpError(409, {
        error: 'task_execution_retry_input_changed',
        expected_input_snapshot_hash: execution.retry_input_snapshot_hash,
        actual_input_snapshot_hash: context.input_snapshot_hash
      });
    return;
  }
  appendExecutionEvent(
    state,
    workflowExecution,
    execution,
    'task.retry_input_hash_upgraded',
    { from_version: retryHashVersion, to_version: EXECUTION_INPUT_HASH_VERSION },
    'system',
    null
  );
  execution.retry_input_snapshot_hash = null;
  execution.retry_input_snapshot_hash_version = null;
}

function persistPreparedContext(state, execution, workflowExecution, prepared, mounts) {
  prepared.context_pack.task_execution_context = structuredClone(prepared.context);
  prepared.context_pack.input_snapshot_hash = prepared.context.input_snapshot_hash;
  prepared.context_pack.input_snapshot_hash_version = prepared.context.input_snapshot_hash_version;
  Object.assign(execution, {
    context_snapshot: structuredClone(prepared.context),
    input_snapshot_hash: prepared.context.input_snapshot_hash,
    input_snapshot_hash_version: prepared.context.input_snapshot_hash_version,
    repository_snapshot_hash: prepared.context.repository_snapshot?.snapshot_hash || null,
    updated_at: now()
  });
  appendExecutionEvent(
    state,
    workflowExecution,
    execution,
    'task.context_prepared',
    {
      input_snapshot_hash: execution.input_snapshot_hash,
      input_version_ids: mounts.map((item) => item.version_id),
      repository_sha: prepared.context.repository_snapshot?.fixed_sha || null
    },
    'system',
    null
  );
}

function receiverFor(executor) {
  return (
    {
      assist: 'AssistExecutor',
      manual: 'ManualExecutor',
      repository_change: 'RepositoryChangeExecutor',
      repository_verify: 'RepositoryVerifyExecutor',
      repository_integrate: 'RepositoryIntegrateExecutor'
    }[executor] || 'TaskExecutor'
  );
}
