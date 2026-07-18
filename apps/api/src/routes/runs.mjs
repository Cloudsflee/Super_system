import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { nodeBundle } from '../helpers.mjs';
import { ensureRunContextPack, confirmContextPack, previewContextPack } from '../handlers/context-packs.mjs';
import { cancelRunInState, invokeRunner, persistRunnerResult } from '../handlers/runners.mjs';
import { consumeNodeRunApproval, requireNodeRunApproval } from '../run-approval.mjs';
import { testAdapter } from '../test-adapter.mjs';
import { RunnerStatus, buildNodeRunResult, makeAssetFromCandidate, now } from '../../../../packages/shared/index.mjs';
import { assertManagedProjectWritable } from '../project-lifecycle.mjs';
import { isContainerized } from '../container-runtime-config.mjs';
import { assertProjectLifecycleIdle } from '../project-lifecycle-operations.mjs';

const runControllers = new Map();

export const runRoutes = [
  makeRoute('POST', '/nodes/:id/context-pack/preview', previewRoute),
  makeRoute('POST', '/context-packs/:id/confirm', confirmContextRoute),
  makeRoute('GET', '/context-packs/:id', getContextRoute),
  makeRoute('POST', '/nodes/:id/run/start', startNodeRunRoute),
  makeRoute('POST', '/nodes/:id/run', runNodeRoute),
  makeRoute('POST', '/runs/:id/cancel', cancelRunRoute),
  makeRoute('GET', '/runs/:id/trace', traceRoute),
  makeRoute('GET', '/runs/:id', getRunRoute)
];

async function previewRoute({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state), bundle = nodeBundle(state, params.id);
    requireNodeBundle(bundle);
    assertProjectLifecycleIdle(bundle.project);
    return previewContextPack(state, { actor, ...bundle, body });
  });
  return send(res, 201, result);
}

async function confirmContextRoute({ res, params }) {
  const result = await mutate((state) => {
    const contextPack = state.context_packs.find((item) => item.id === params.id);
    if (!contextPack) throw new HttpError(404, 'context_pack_not_found');
    const projectId = contextPack.content_json?.project?.id || state.workspaces.find((item) => item.id === contextPack.source_workspace_id)?.project_id;
    assertProjectLifecycleIdle(state.projects.find((item) => item.id === projectId));
    return confirmContextPack(state, { actor: owner(state), contextPackId: params.id });
  });
  return send(res, 200, result);
}

async function getContextRoute({ res, params }) {
  const ctx = (await readState()).context_packs.find((item) => item.id === params.id);
  return ctx ? send(res, 200, ctx) : send(res, 404, { error: 'context_pack_not_found' });
}

async function runNodeRoute({ res, params, body }) {
  return send(res, 201, await executeNodeRun(params.id, body));
}

export async function executeNodeRun(nodeId, body = {}) {
  const prepared = await prepareNodeRun(nodeId, body);
  return completeNodeRun(nodeId, body, prepared);
}

async function startNodeRunRoute({ res, params, body }) {
  const prepared = await prepareNodeRun(params.id, body);
  setImmediate(() => completeNodeRun(params.id, body, prepared).catch((error) => console.error('background NodeRun failed', error.message)));
  const state = await readState();
  return send(res, 202, { run: state.node_runs.find((item) => item.id === prepared.run_id), context_pack: state.context_packs.find((item) => item.id === prepared.context_pack_id), assets: [] });
}

async function prepareNodeRun(nodeId, body) {
  if (body.enqueue_only === true) throw new HttpError(400, { error: 'enqueue_only_not_supported' });
  return mutate((state) => {
    const actor = owner(state), bundle = nodeBundle(state, nodeId);
    requireNodeBundle(bundle);
    assertTaskDependencies(state, bundle.node);
    assertManagedProjectWritable(bundle.project);
    const ctx = ensureRunContextPack(state, { actor, ...bundle, body });
    const run = createRun({ actor, ...bundle, ctx, body });
    const approval = requireNodeRunApproval(state, { approvalId: body.approval_id, nodeId, runner: run.runner });
    state.node_runs.push(run);
    consumeNodeRunApproval(approval, run.id);
    addTrace(state, 'node_run.approval.consumed', { project_id: bundle.project.id, workspace_id: bundle.workspace.id, node_id: nodeId, run_id: run.id, target_type: 'change_proposal', target_id: approval.id, summary: `NodeRun 使用审批：${approval.title}` }, actor.id);
    startRunTrace(state, { actor, ...bundle, run, ctx });
    return { run_id: run.id, context_pack_id: ctx.id };
  });
}

async function completeNodeRun(nodeId, body, prepared) {
  const controller = new AbortController();
  runControllers.set(prepared.run_id, controller);
  try {
    let execution;
    try {
      const current = await readState(), currentRun = current.node_runs.find((item) => item.id === prepared.run_id);
      if (currentRun?.status === RunnerStatus.Cancelled) return { run: currentRun, context_pack: current.context_packs.find((item) => item.id === prepared.context_pack_id), assets: [] };
      if (testAdapter(body)) {
        await delay(Number(body.test_delay_ms || 10));
        const snapshot = await readState(), run = snapshot.node_runs.find((item) => item.id === prepared.run_id), ctx = snapshot.context_packs.find((item) => item.id === prepared.context_pack_id);
        execution = { raw: 'test adapter execution', resultJson: buildNodeRunResult({ run, contextPack: ctx, changedFiles: [], raw: body.test_summary || '测试 NodeRun 已完成', status: RunnerStatus.Succeeded }) };
      } else {
        const snapshot = await readState(), actor = owner(snapshot), bundle = nodeBundle(snapshot, nodeId);
        requireNodeBundle(bundle);
        const run = snapshot.node_runs.find((item) => item.id === prepared.run_id), ctx = snapshot.context_packs.find((item) => item.id === prepared.context_pack_id);
        execution = await invokeRunner(snapshot, { actor, run, ...bundle, ctx, body: { ...body, signal: controller.signal } });
      }
    } catch (error) { await failNodeRun(prepared.run_id, error); throw error; }
    return await mutate(async (state) => {
      const actor = owner(state), bundle = nodeBundle(state, nodeId), run = state.node_runs.find((item) => item.id === prepared.run_id), ctx = state.context_packs.find((item) => item.id === prepared.context_pack_id);
      if (!run || !ctx) throw new HttpError(404, { error: 'prepared_node_run_not_found' });
      if (run.status === RunnerStatus.Cancelled) return { run, context_pack: ctx, assets: [] };
      requireNodeBundle(bundle);
      await persistRunnerResult(state, { actor, run, ...bundle, ...execution });
      const assets = createAssetsFromRun(state, { actor, ...bundle, run, resultJson: execution.resultJson });
      return { run, context_pack: ctx, assets };
    });
  } finally { runControllers.delete(prepared.run_id); }
}

async function failNodeRun(runId, error) {
  return mutate((state) => {
    const run = state.node_runs.find((item) => item.id === runId);
    if (!run || run.status === RunnerStatus.Cancelled) return run;
    const node = state.workflow_nodes.find((item) => item.id === run.node_id);
    Object.assign(run, { status: RunnerStatus.Failed, summary: String(error.message || error), completed_at: now(), updated_at: now() });
    if (node) node.status = 'blocked';
    addTrace(state, 'runner.failed', { project_id: run.project_id, workspace_id: run.workspace_id, node_id: run.node_id, run_id: run.id, summary: `Runner 启动失败：${run.summary}` }, owner(state).id);
    return run;
  });
}

function createRun({ actor, project, workspace, node, ctx, body }) {
  const runner = body.runner || project.settings?.preferred_runner || 'codex_docker';
  if (isContainerized() && runner === 'codex') throw new HttpError(409, { error: 'host_runner_disabled_in_container' });
  if (!['codex_docker', 'codex'].includes(runner)) throw new HttpError(400, { error: 'unsupported_runner', allowed: ['codex_docker', 'codex'] });
  return { id: `run_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`, project_id: project.id, workspace_id: workspace.id, node_id: node.id, context_pack_id: ctx.id, runner, status: RunnerStatus.Queued, summary: '', result_json: null, raw_output_file_ref_id: null, started_at: null, completed_at: null, created_by_user_id: actor.id, created_at: now(), updated_at: now() };
}

function registerRunTrace(state, { actor, project, workspace, node, run }) {
  node.status = 'running';
  addTrace(state, 'node_run.queued', { project_id: project.id, workspace_id: workspace.id, node_id: node.id, run_id: run.id, summary: 'NodeRun 已登记并准备执行。' }, actor.id);
}

function startRunTrace(state, { actor, project, workspace, node, run, ctx }) {
  registerRunTrace(state, { actor, project, workspace, node, run });
  addTrace(state, 'node_run.started', { project_id: project.id, workspace_id: workspace.id, node_id: node.id, run_id: run.id, summary: `NodeRun 启动：${run.runner}` }, actor.id);
  addTrace(state, 'runner.invoked', { project_id: project.id, workspace_id: workspace.id, node_id: node.id, run_id: run.id, summary: `调用 Runner：${run.runner}`, data: { runner: run.runner, context_pack_id: ctx.id } }, actor.id);
  Object.assign(run, { status: RunnerStatus.Running, started_at: now() });
}

function createAssetsFromRun(state, { actor, project, workspace, node, run, resultJson }) {
  const assets = [];
  for (const candidate of resultJson.asset_candidates || []) {
    const made = makeAssetFromCandidate(candidate, { projectId: project.id, workspaceId: workspace.id, nodeId: node.id, runId: run.id, actorId: actor.id });
    state.assets.push(made.asset); state.asset_versions.push(made.version); assets.push(made.asset);
    addTrace(state, 'asset_candidate.created', { project_id: project.id, workspace_id: workspace.id, node_id: node.id, run_id: run.id, target_type: 'asset', target_id: made.asset.id, summary: `创建资产候选：${made.asset.title}` }, actor.id);
  }
  return assets;
}

async function cancelRunRoute({ res, params }) {
  runControllers.get(params.id)?.abort();
  const result = await mutate((state) => cancelRunInState(state, params.id, owner(state).id));
  return send(res, 200, result);
}

async function traceRoute({ res, params }) {
  const state = await readState();
  return send(res, 200, state.traces.filter((trace) => trace.run_id === params.id).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)));
}

async function getRunRoute({ res, params }) {
  const state = await readState();
  const run = state.node_runs.find((item) => item.id === params.id);
  if (!run) return send(res, 404, { error: 'run_not_found' });
  return send(res, 200, { run, context_pack: state.context_packs.find((c) => c.id === run.context_pack_id), traces: state.traces.filter((t) => t.run_id === run.id), assets: state.assets.filter((a) => a.run_id === run.id), code_change: state.code_changes.find((c) => c.run_id === run.id) });
}

function requireNodeBundle({ node, project, contract }) { if (!node || !project || !contract) throw new HttpError(404, 'node_or_contract_not_found'); }
function assertTaskDependencies(state, node) {
  if (node.role === 'workstream') throw new HttpError(409, { error: 'workstream_is_aggregate_not_executable', node_id: node.id });
  if (node.role !== 'task') return;
  const parent = state.workflow_nodes.find((item) => item.id === node.parent_node_id && item.role === 'workstream');
  const incompleteUpstream = (parent?.dependencies || []).map((item) => typeof item === 'string' ? item : item.node_id).map((id) => state.workflow_nodes.find((item) => item.id === id)).filter((item) => item && item.status !== 'completed');
  const incompleteTasks = (node.dependencies || []).map((item) => typeof item === 'string' ? item : item.node_id).map((id) => state.workflow_nodes.find((item) => item.id === id)).filter((item) => item && item.status !== 'completed');
  if (incompleteUpstream.length || incompleteTasks.length) throw new HttpError(409, { error: 'task_dependency_blocked', node_id: node.id, workstream_dependencies: incompleteUpstream.map((item) => item.id), task_dependencies: incompleteTasks.map((item) => item.id), action: 'create_change_proposal' });
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 5000)))); }
