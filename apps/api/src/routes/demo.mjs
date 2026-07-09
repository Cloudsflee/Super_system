import { makeRoute, send } from '../http.mjs';
import { ROOT } from '../config.mjs';
import { addTrace, mutate, owner, saveArtifact } from '../state.mjs';
import { buildContextPack, buildDigest, buildNodeRunResult, confirmAsset, contextPackToMarkdown, createDecisionRecord, createNodeWorkspace, createProject, defaultContractForNode, generatePrBody, id, makeAssetFromCandidate, now, recommendWorkflow, RunnerStatus } from '../../../../packages/shared/index.mjs';

export const demoRoutes = [makeRoute('POST', '/demo/full-chain', fullChainDemo)];

async function fullChainDemo({ res }) {
  const result = await mutate(async (state) => {
    const actor = owner(state);
    const created = seedProject(state, actor);
    const workflow = seedWorkflow(state, actor, created.project);
    const execution = pickExecution(workflow);
    const decision = seedDecision(state, actor, created.project, execution);
    const ctx = await seedContextPack(state, actor, created.project, execution);
    const run = await seedNodeRun(state, actor, created.project, execution, ctx);
    const asset = seedConfirmedAsset(state, actor, created.project, execution, run, ctx);
    const digest = seedDigest(state, actor, created.project, execution.workspace);
    const codeChange = await seedCodeReview(state, actor, created.project, execution, run);
    return { project: created.project, workflow: workflow.workflow, nodes: workflow.nodes, decision, context_pack: ctx, run, asset, digest, code_change: codeChange };
  });
  return send(res, 201, result);
}

function seedProject(state, actor) {
  const created = createProject({ title: 'AI Workspace System 自身功能开发', goal: '实现 Tool Registry 基础 CRUD，并跑通 Context Pack、Trace、Asset、Digest、Git Review 闭环。', role: '毕业设计演示开发者', background: '证明 Codex 在可追溯、可接续、可资产化工作空间中完成任务。', workspace_root: ROOT, repo_path: ROOT, created_by_user_id: actor.id });
  state.projects.push(created.project);
  state.workspaces.push(created.workspace);
  addTrace(state, 'project.created', { project_id: created.project.id, workspace_id: created.workspace.id, summary: 'Demo 创建 Project' }, actor.id);
  return created;
}

function seedWorkflow(state, actor, project) {
  const wf = recommendWorkflow(project, actor.id);
  state.workflows.push(wf.workflow);
  state.workflow_nodes.push(...wf.nodes);
  addTrace(state, 'workflow.recommended', { project_id: project.id, workspace_id: project.current_workspace_id, target_id: wf.workflow.id, summary: 'Demo 推荐工作流' }, actor.id);
  Object.assign(wf.workflow, { status: 'confirmed', confirmed_by_user_id: actor.id, confirmed_by: 'human' });
  for (const node of wf.nodes) seedNodeWorkspaceAndContract(state, actor, project, node);
  addTrace(state, 'workflow.confirmed', { project_id: project.id, workspace_id: project.current_workspace_id, target_id: wf.workflow.id, summary: 'Demo 确认工作流与 5 个节点契约' }, actor.id);
  return wf;
}

function seedNodeWorkspaceAndContract(state, actor, project, node) {
  node.status = 'ready';
  const workspace = createNodeWorkspace(project, node, actor.id);
  const contract = defaultContractForNode(node, project, actor.id, 'confirmed');
  node.workspace_id = workspace.id;
  node.current_contract_id = contract.id;
  state.workspaces.push(workspace);
  state.node_contracts.push(contract);
  addTrace(state, 'node_contract.confirmed', { project_id: project.id, workspace_id: workspace.id, node_id: node.id, target_id: contract.id, summary: `Demo 确认契约：${node.title}` }, actor.id);
}

function pickExecution(wf) {
  const node = wf.nodes.find((item) => item.type === 'execution') || wf.nodes[3];
  return { node, workspace: null, contract: null };
}


function seedDecision(state, actor, project, execution) {
  execution.workspace = state.workspaces.find((item) => item.workflow_node_id === execution.node.id);
  const decision = createDecisionRecord({ projectId: project.id, workspaceId: execution.workspace.id, title: 'Demo 执行策略确认', summary: '采用 MockRunner 稳定跑通闭环，CodexRunner 保留 live/partial 可追溯路径。', rationale: '答辩演示需要稳定，同时保留真实 Codex CLI Adapter 证据。', evidenceRefs: [`node:${execution.node.id}`], actorId: actor.id, tags: ['demo', 'runner-strategy'] });
  state.decisions.push(decision);
  addTrace(state, 'decision.accepted', { project_id: project.id, workspace_id: execution.workspace.id, node_id: execution.node.id, target_id: decision.id, summary: 'Demo 确认执行策略决策' }, actor.id);
  return decision;
}

async function seedContextPack(state, actor, project, execution) {
  execution.workspace = state.workspaces.find((item) => item.workflow_node_id === execution.node.id);
  execution.contract = state.node_contracts.find((item) => item.id === execution.node.current_contract_id);
  const ctx = buildContextPack({ state, project, workspace: execution.workspace, node: execution.node, contract: execution.contract });
  state.context_packs.push(ctx);
  state.context_sufficiency_checks.push(ctx._sufficiency_check);
  addTrace(state, 'memory.sufficiency.checked', { project_id: project.id, workspace_id: execution.workspace.id, node_id: execution.node.id, target_id: ctx.id, summary: `Demo sufficiency: ${ctx._sufficiency_check.status}` }, actor.id);
  addTrace(state, 'memory.manifest.generated', { project_id: project.id, workspace_id: execution.workspace.id, node_id: execution.node.id, target_id: ctx.id, summary: 'Demo Memory Manifest generated' }, actor.id);
  const refs = await saveContextArtifacts(ctx);
  state.file_refs.push(...refs);
  Object.assign(ctx, { status: 'confirmed', content_file_ref_id: refs[0].id, markdown_file_ref_id: refs[1].id, confirmed_by_user_id: actor.id });
  addTrace(state, 'context_pack.confirmed', { project_id: project.id, workspace_id: execution.workspace.id, node_id: execution.node.id, target_id: ctx.id, summary: 'Demo Context Pack confirmed' }, actor.id);
  return ctx;
}

async function saveContextArtifacts(ctx) {
  return [await saveArtifact('context-packs', `${ctx.id}.json`, ctx.content_json, { context_pack_id: ctx.id }), await saveArtifact('context-packs', `${ctx.id}.md`, contextPackToMarkdown(ctx), { context_pack_id: ctx.id })];
}

async function seedNodeRun(state, actor, project, execution, ctx) {
  const run = { id: id('run'), project_id: project.id, workspace_id: execution.workspace.id, node_id: execution.node.id, context_pack_id: ctx.id, runner: 'mock', status: RunnerStatus.Running, summary: '', result_json: null, raw_output_file_ref_id: null, started_at: now(), completed_at: null, created_by_user_id: actor.id, created_at: now(), updated_at: now() };
  state.node_runs.push(run);
  addTrace(state, 'node_run.started', { project_id: project.id, workspace_id: execution.workspace.id, node_id: execution.node.id, run_id: run.id, summary: 'Demo NodeRun started' }, actor.id);
  addTrace(state, 'runner.invoked', { project_id: project.id, workspace_id: execution.workspace.id, node_id: execution.node.id, run_id: run.id, summary: 'Demo MockRunner invoked' }, actor.id);
  const result = buildNodeRunResult({ run, contextPack: ctx, changedFiles: [{ path: 'virtual://demo-tool-registry.md', status: 'generated', source: 'demo' }], raw: 'Demo MockRunner completed', status: RunnerStatus.Succeeded });
  const rawRef = await saveArtifact('runs', `${run.id}.raw.log`, JSON.stringify(result, null, 2), { run_id: run.id });
  state.file_refs.push(rawRef);
  Object.assign(run, { status: RunnerStatus.Succeeded, summary: result.summary, result_json: result, raw_output_file_ref_id: rawRef.id, completed_at: now(), updated_at: now() });
  addTrace(state, 'runner.completed', { project_id: project.id, workspace_id: execution.workspace.id, node_id: execution.node.id, run_id: run.id, raw_file_ref_id: rawRef.id, summary: 'Demo Runner completed' }, actor.id);
  return run;
}

function seedConfirmedAsset(state, actor, project, execution, run, ctx) {
  const made = makeAssetFromCandidate(run.result_json.asset_candidates[0], { projectId: project.id, workspaceId: execution.workspace.id, nodeId: execution.node.id, runId: run.id, actorId: actor.id });
  state.assets.push(made.asset);
  state.asset_versions.push(made.version);
  addTrace(state, 'asset_candidate.created', { project_id: project.id, workspace_id: execution.workspace.id, node_id: execution.node.id, run_id: run.id, target_id: made.asset.id, summary: 'Demo 创建资产候选' }, actor.id);
  const confirmed = confirmAsset(made.asset, made.version, actor.id, { tags: ['demo', 'confirmed'] });
  Object.assign(made.asset, confirmed.asset);
  state.asset_versions.push(confirmed.version);
  addTrace(state, 'asset.confirmed', { project_id: project.id, workspace_id: execution.workspace.id, node_id: execution.node.id, run_id: run.id, target_id: made.asset.id, summary: 'Demo 确认资产' }, actor.id);
  return made.asset;
}

function seedDigest(state, actor, project, workspace) {
  const digest = buildDigest({ state, project, workspace, actorId: actor.id });
  state.digests.push(digest);
  workspace.current_digest_id = digest.id;
  addTrace(state, 'digest.confirmed', { project_id: project.id, workspace_id: workspace.id, target_id: digest.id, summary: 'Demo Digest confirmed' }, actor.id);
  return digest;
}

async function seedCodeReview(state, actor, project, execution, run) {
  const diffRef = await saveArtifact('git', `${run.id}.diff.patch`, '# virtual demo diff\n', { run_id: run.id });
  const prBody = generatePrBody({ project, node: execution.node, run, diff: { changed_files: run.result_json.changed_files }, assets: state.assets.filter((item) => item.run_id === run.id), tests: run.result_json.test_results });
  const prRef = await saveArtifact('git', `${run.id}.pr-body.md`, prBody, { run_id: run.id });
  state.file_refs.push(diffRef, prRef);
  const change = { id: id('chg'), project_id: project.id, workspace_id: execution.workspace.id, node_id: execution.node.id, run_id: run.id, repo_path: project.repo_path, base_branch: '', work_branch: 'aiws/demo-full-chain', base_commit: '', head_commit: '', status: 'pr_draft', changed_files: run.result_json.changed_files, diff_file_ref_id: diffRef.id, test_results: run.result_json.test_results, commit_message: 'demo: aiws full-chain evidence', pr_body_file_ref_id: prRef.id, pr_url: '', committed_by_user_id: actor.id, pr_created_by_connected_account_id: null, created_by_user_id: actor.id, created_at: now(), updated_at: now() };
  state.code_changes.push(change);
  addTrace(state, 'git.diff.captured', { project_id: project.id, workspace_id: execution.workspace.id, node_id: execution.node.id, run_id: run.id, target_id: change.id, raw_file_ref_id: diffRef.id, summary: 'Demo 捕获虚拟 diff' }, actor.id);
  addTrace(state, 'git.pr.created', { project_id: project.id, workspace_id: execution.workspace.id, node_id: execution.node.id, run_id: run.id, target_id: change.id, raw_file_ref_id: prRef.id, summary: 'Demo 生成 PR 草稿' }, actor.id);
  return change;
}
