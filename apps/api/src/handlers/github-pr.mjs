import { HttpError, send } from '../http.mjs';
import { addTrace, mutate, owner, saveArtifact } from '../state.mjs';
import { ensureCodeChange } from '../helpers.mjs';
import { generatePrBody, now } from '../../../../packages/shared/index.mjs';
import { githubAccount } from './github-account.mjs';

export async function createPr({ res, params, body }) {
  const result = await mutate(async (state) => {
    const actor = owner(state);
    const run = state.node_runs.find((item) => item.id === params.id);
    if (!run) throw new HttpError(404, 'run_not_found');

    const node = state.workflow_nodes.find((item) => item.id === run.node_id);
    const project = state.projects.find((item) => item.id === run.project_id);
    const account = githubAccount(state, actor.id);
    const change = ensureCodeChange(state, run, project, node, actor.id);
    const prBody = buildPrBody({ state, project, node, run, change, body });
    const prRef = await saveArtifact('git', `${run.id}.pr-body.md`, prBody, { run_id: run.id });

    state.file_refs.push(prRef);
    change.pr_body_file_ref_id = prRef.id;
    if (account && body.mock !== false) markPrCreated(state, { actor, run, node, project, change, account, body });
    else markPrDraft(state, { actor, run, node, project, change, prRef });
    change.updated_at = now();

    return { code_change: change, pr_body: prBody, file_ref: prRef, github_connected: Boolean(account) };
  });
  return send(res, 200, result);
}

function buildPrBody({ state, project, node, run, change, body }) {
  return body.body || generatePrBody({
    project,
    node,
    run,
    diff: change,
    assets: state.assets.filter((item) => item.run_id === run.id),
    tests: run.result_json?.test_results || []
  });
}

function markPrCreated(state, { actor, run, node, project, change, account, body }) {
  change.pr_url = body.pr_url || `https://github.com/mock/${project.title.replace(/\s+/g, '-').toLowerCase()}/pull/${state.code_changes.length + 1}`;
  change.pr_created_by_connected_account_id = account.id;
  change.status = 'pr_created';
  addTrace(state, 'git.pr.created', {
    project_id: project.id,
    workspace_id: run.workspace_id,
    node_id: run.node_id,
    run_id: run.id,
    target_type: 'code_change',
    target_id: change.id,
    summary: `创建 GitHub PR：${change.pr_url}`,
    data: { pr_url: change.pr_url }
  }, actor.id);
}

function markPrDraft(state, { actor, run, node, project, change, prRef }) {
  change.pr_url = '';
  change.status ||= 'draft';
  addTrace(state, 'git.pr.created', {
    project_id: project.id,
    workspace_id: run.workspace_id,
    node_id: run.node_id,
    run_id: run.id,
    target_type: 'code_change',
    target_id: change.id,
    summary: 'GitHub 未绑定或未启用 live，已生成 PR 草稿。',
    raw_file_ref_id: prRef.id
  }, actor.id);
}
