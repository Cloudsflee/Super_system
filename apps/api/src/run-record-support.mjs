import { RunnerStatus, now } from '../../../packages/shared/index.mjs';
import { isContainerized } from './container-runtime-config.mjs';
import { HttpError } from './http.mjs';
import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { addTrace } from './state.mjs';
import { createExecutionOutputAssets } from './task-output-service.mjs';

export function createRun({ actor, project, workspace, node, ctx, body }) {
  const runner = validatedRunner(body.runner || project.settings?.preferred_runner || 'codex_docker');
  const execution = structuredClone(ctx.task_execution_context || ctx._task_execution_context || null);
  return {
    id: `run_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
    project_id: project.id,
    workspace_id: workspace.id,
    node_id: node.id,
    context_pack_id: ctx.id,
    task_execution_context: execution,
    ...executionRunSnapshot(execution, ctx),
    runner,
    status: RunnerStatus.Queued,
    summary: '',
    result_json: null,
    raw_output_file_ref_id: null,
    input_superseded: false,
    started_at: null,
    completed_at: null,
    created_by_user_id: actor.id,
    created_at: now(),
    updated_at: now()
  };
}

export function startRunTrace(state, { actor, project, workspace, node, run, ctx }) {
  registerRunTrace(state, { actor, project, workspace, node, run });
  addTrace(
    state,
    'node_run.started',
    {
      project_id: project.id,
      workspace_id: workspace.id,
      node_id: node.id,
      run_id: run.id,
      summary: `NodeRun 启动：${run.runner}`
    },
    actor.id
  );
  addTrace(
    state,
    'runner.invoked',
    {
      project_id: project.id,
      workspace_id: workspace.id,
      node_id: node.id,
      run_id: run.id,
      summary: `调用 Runner：${run.runner}`,
      data: { runner: run.runner, context_pack_id: ctx.id }
    },
    actor.id
  );
  Object.assign(run, { status: RunnerStatus.Running, started_at: now() });
}

export function createAssetsFromRun(state, { actor, project, workspace, node, run, resultJson }) {
  const { assets } = createExecutionOutputAssets(state, {
    actorId: actor.id,
    project,
    task: node,
    workspace,
    execution: run,
    candidates: resultJson.asset_candidates || []
  });
  for (const asset of assets) traceCreatedAsset(state, { actor, project, workspace, node, run, asset });
  return assets;
}

export function requireNodeBundle({ node, project, contract }) {
  if (!node || !project || !contract) throw new HttpError(404, 'node_or_contract_not_found');
}

export function assertNodeRunDependencies(state, node, { controlled = false } = {}) {
  if (node.role === 'workstream')
    throw new HttpError(409, { error: 'workstream_is_aggregate_not_executable', node_id: node.id });
  if (node.role !== 'task' || controlled) return;
  const parent = state.workflow_nodes.find((item) => item.id === node.parent_node_id && item.role === 'workstream');
  const incompleteUpstream = incompleteDependencies(state, parent?.dependencies);
  const incompleteTasks = incompleteDependencies(state, node.dependencies);
  if (incompleteUpstream.length || incompleteTasks.length)
    throw new HttpError(409, {
      error: 'task_dependency_blocked',
      node_id: node.id,
      workstream_dependencies: incompleteUpstream.map((item) => item.id),
      task_dependencies: incompleteTasks.map((item) => item.id),
      action: 'create_change_proposal'
    });
}

function validatedRunner(runner) {
  if (isContainerized() && runner === 'codex') throw new HttpError(409, { error: 'host_runner_disabled_in_container' });
  if (!['codex_docker', 'codex'].includes(runner))
    throw new HttpError(400, { error: 'unsupported_runner', allowed: ['codex_docker', 'codex'] });
  return runner;
}

function executionRunSnapshot(execution, contextPack) {
  return {
    input_snapshot_hash: nullable(execution?.input_snapshot_hash),
    repository_snapshot_hash: nullable(execution?.repository_snapshot?.snapshot_hash),
    contract_snapshot: executionContractSnapshot(execution, contextPack),
    task_snapshot: nullable(execution?.task),
    dependency_graph: arrayOrEmpty(execution?.dependency_graph),
    input_assets: executionInputAssets(execution),
    repository_workspace_id: nullable(execution?.repository_snapshot?.repository_workspace_id)
  };
}

function executionContractSnapshot(execution, contextPack) {
  return execution?.contract || structuredClone(contextPack.content_json?.node_contract || null);
}

function executionInputAssets(execution) {
  return execution?.inputs?.flatMap((item) => item.asset_versions || []) || [];
}

function nullable(value) {
  return value || null;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function registerRunTrace(state, { actor, project, workspace, node, run }) {
  node.status = 'running';
  addTrace(
    state,
    'node_run.queued',
    {
      project_id: project.id,
      workspace_id: workspace.id,
      node_id: node.id,
      run_id: run.id,
      summary: 'NodeRun 已登记并准备执行。'
    },
    actor.id
  );
}

function traceCreatedAsset(state, { actor, project, workspace, node, run, asset }) {
  const confirmed = asset.status === 'confirmed';
  addTrace(
    state,
    confirmed ? 'asset.confirmed' : 'asset_candidate.created',
    {
      project_id: project.id,
      workspace_id: workspace.id,
      node_id: node.id,
      run_id: run.id,
      target_type: 'asset',
      target_id: asset.id,
      summary: `${confirmed ? '系统确认资产' : '创建资产候选'}：${asset.title}`
    },
    actor.id
  );
}

function incompleteDependencies(state, dependencies) {
  return (dependencies || [])
    .map((item) => (typeof item === 'string' ? item : item.node_id))
    .map((id) => state.workflow_nodes.find((item) => item.id === id))
    .filter((item) => item && item.status !== 'completed');
}
