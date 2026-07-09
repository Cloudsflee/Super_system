import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { nodeBundle } from '../helpers.mjs';
import { ensureRunContextPack, confirmContextPack, previewContextPack } from '../handlers/context-packs.mjs';
import { cancelRunInState, executeRunner } from '../handlers/runners.mjs';
import { RunnerStatus, makeAssetFromCandidate, now } from '../../../../packages/shared/index.mjs';

export const runRoutes = [
  makeRoute('POST', '/nodes/:id/context-pack/preview', previewRoute),
  makeRoute('POST', '/context-packs/:id/confirm', confirmContextRoute),
  makeRoute('GET', '/context-packs/:id', getContextRoute),
  makeRoute('POST', '/nodes/:id/run', runNodeRoute),
  makeRoute('POST', '/runs/:id/cancel', cancelRunRoute),
  makeRoute('GET', '/runs/:id/trace', traceRoute),
  makeRoute('GET', '/runs/:id', getRunRoute)
];

async function previewRoute({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state), bundle = nodeBundle(state, params.id);
    requireNodeBundle(bundle);
    return previewContextPack(state, { actor, ...bundle, body });
  });
  return send(res, 201, result);
}

async function confirmContextRoute({ res, params }) {
  const result = await mutate((state) => confirmContextPack(state, { actor: owner(state), contextPackId: params.id }));
  return send(res, 200, result);
}

async function getContextRoute({ res, params }) {
  const ctx = (await readState()).context_packs.find((item) => item.id === params.id);
  return ctx ? send(res, 200, ctx) : send(res, 404, { error: 'context_pack_not_found' });
}

async function runNodeRoute({ res, params, body }) {
  const result = await mutate(async (state) => {
    const actor = owner(state), bundle = nodeBundle(state, params.id);
    requireNodeBundle(bundle);
    const ctx = ensureRunContextPack(state, { actor, ...bundle, body });
    const run = createRun({ actor, ...bundle, ctx, body });
    state.node_runs.push(run);
    if (body.enqueue_only === true) {
      enqueueRunTrace(state, { actor, ...bundle, run });
      return { run, context_pack: ctx, assets: [] };
    }
    startRunTrace(state, { actor, ...bundle, run, ctx });
    const executed = await executeRunner(state, { actor, run, ...bundle, ctx, body });
    const assets = createAssetsFromRun(state, { actor, ...bundle, run, resultJson: executed.resultJson });
    return { run, context_pack: ctx, assets };
  });
  return send(res, 201, result);
}

function createRun({ actor, project, workspace, node, ctx, body }) {
  return { id: `run_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`, project_id: project.id, workspace_id: workspace.id, node_id: node.id, context_pack_id: ctx.id, runner: body.runner || project.settings?.preferred_runner || 'mock', status: RunnerStatus.Queued, summary: '', result_json: null, raw_output_file_ref_id: null, started_at: null, completed_at: null, created_by_user_id: actor.id, created_at: now(), updated_at: now() };
}

function enqueueRunTrace(state, { actor, project, workspace, node, run }) {
  node.status = 'running';
  addTrace(state, 'node_run.queued', { project_id: project.id, workspace_id: workspace.id, node_id: node.id, run_id: run.id, summary: 'NodeRun 已入队，等待执行。' }, actor.id);
}

function startRunTrace(state, { actor, project, workspace, node, run, ctx }) {
  enqueueRunTrace(state, { actor, project, workspace, node, run });
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
