import { HttpError, send } from '../http.mjs';
import { addTrace, mutate, owner, readState, saveArtifact } from '../state.mjs';
import { ensureCodeChange } from '../helpers.mjs';
import { connectedGithubAccount, createInstallationToken, githubGitAuthEnv, githubJson, resolveGithubAppConfig } from '../github-service.mjs';
import { testAdapter } from '../test-adapter.mjs';
import { generatePrBody, now } from '../../../../packages/shared/index.mjs';
import { git, isGitRepo } from '../git-utils.mjs';
import { consumeGitActionApproval, GIT_PUBLISH_APPROVAL, requireGitActionApproval } from '../run-approval.mjs';
import { assertManagedProjectWritable } from '../project-lifecycle.mjs';
import { assertProjectLifecycleIdle, withProjectLifecycleLock } from '../project-lifecycle-operations.mjs';

export async function createPr(context) {
  const state = await readState(), run = state.node_runs.find((item) => item.id === context.params.id);
  if (!run) throw new HttpError(404, { error: 'run_not_found' });
  const project = assertProjectLifecycleIdle(state.projects.find((item) => item.id === run.project_id));
  return withProjectLifecycleLock(project.id, () => createPrLocked(context));
}

async function createPrLocked({ res, params, body, query }) {
  await mutate((data) => {
    const run = data.node_runs.find((item) => item.id === params.id);
    const node = data.workflow_nodes.find((item) => item.id === run?.node_id);
    const project = data.projects.find((item) => item.id === run?.project_id);
    if (!run) throw new HttpError(404, { error: 'run_not_found' });
    if (!node || !project) throw new HttpError(404, { error: 'run_project_or_node_not_found' });
    assertManagedProjectWritable(project);
    const approval = requireGitActionApproval(data, { approvalId: body.approval_id, type: GIT_PUBLISH_APPROVAL, run, project, node });
    consumeGitActionApproval(approval, `publish:${run.id}`);
    return { run_id: run.id };
  });
  const state = await readState(), actor = owner(state);
  const run = state.node_runs.find((item) => item.id === params.id);
  if (!run) throw new HttpError(404, { error: 'run_not_found' });
  const node = state.workflow_nodes.find((item) => item.id === run.node_id);
  const project = state.projects.find((item) => item.id === run.project_id);
  if (!node || !project) throw new HttpError(404, { error: 'run_project_or_node_not_found' });
  const account = connectedGithubAccount(state, actor.id);
  const binding = state.repository_bindings.find((item) => item.project_id === project.id);
  if (binding && binding.permissions?.push !== true) throw new HttpError(403, { error: 'repository_push_permission_required' });
  const change = ensureCodeChange(state, run, project, node, actor.id);
  if (account && binding && (change.status !== 'committed' || !change.head_commit)) throw new HttpError(409, { error: 'git_commit_required_before_pr' });
  const prBody = body.body || generatePrBody({ project, node, run, diff: change, assets: state.assets.filter((item) => item.run_id === run.id), tests: run.result_json?.test_results || [] });
  let created = null;
  if (account && binding) {
    try {
      created = testAdapter(body, query) ? { html_url: `https://github.com/${binding.full_name}/pull/1`, number: 1 } : await createLivePr(state, binding, change, body, prBody, (pushed) => recordPushAttempt(run, actor.id, pushed));
    } catch (error) {
      await mutate((data) => { addTrace(data, 'git.pr.created', { project_id: project.id, workspace_id: run.workspace_id, node_id: run.node_id, run_id: run.id, target_type: 'code_change', target_id: change.id, summary: 'GitHub PR 创建失败。', data: { error: error.message } }, actor.id); });
      throw error;
    }
  }
  const result = await mutate(async (data) => {
    const currentRun = data.node_runs.find((item) => item.id === run.id), currentProject = data.projects.find((item) => item.id === project.id), currentNode = data.workflow_nodes.find((item) => item.id === node.id);
    assertManagedProjectWritable(currentProject);
    const currentChange = ensureCodeChange(data, currentRun, currentProject, currentNode, actor.id);
    const prRef = await saveArtifact('git', `${run.id}.pr-body.md`, prBody, { run_id: run.id });
    data.file_refs.push(prRef);
    Object.assign(currentChange, { pr_body_file_ref_id: prRef.id, pr_url: created?.html_url || '', status: created ? 'pr_created' : 'draft', pr_created_by_connected_account_id: created ? account.id : null, updated_at: now() });
    addTrace(data, 'git.pr.created', { project_id: project.id, workspace_id: run.workspace_id, node_id: run.node_id, run_id: run.id, target_type: 'code_change', target_id: currentChange.id, summary: created ? `创建 GitHub PR：${created.html_url}` : '缺少有效 GitHub repository binding，已生成 PR 草稿。', raw_file_ref_id: prRef.id, data: created ? { pr_url: created.html_url, number: created.number } : {} }, actor.id);
    return { code_change: currentChange, pr_body: prBody, file_ref: prRef, github_connected: Boolean(account), repository_bound: Boolean(binding) };
  });
  return send(res, 200, result);
}

async function createLivePr(state, binding, change, body, prBody, onPush) {
  const config = resolveGithubAppConfig(state);
  if (!config) throw new HttpError(409, { error: 'github_app_config_required' });
  const token = await createInstallationToken(config, binding.installation_id);
  const [ownerName, repoName] = binding.full_name.split('/');
  const head = body.head || change.work_branch;
  const base = body.base || change.base_branch || 'main';
  if (!head) throw new HttpError(409, { error: 'git_work_branch_required' });
  if (!/^[a-zA-Z0-9._\/-]+$/.test(head)) throw new HttpError(400, { error: 'invalid_git_work_branch' });
  if (isGitRepo(change.repo_path)) {
    const pushed = git(change.repo_path, ['push', binding.remote_name || 'origin', `HEAD:refs/heads/${head}`], 60000, githubGitAuthEnv(token.token));
    await onPush?.(pushed);
    if (!pushed.ok) throw new HttpError(409, { error: 'git_push_failed', detail: pushed.stderr || pushed.error });
  }
  return githubJson(`https://api.github.com/repos/${ownerName}/${repoName}/pulls`, {
    method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: body.title || change.commit_message || 'AI Workspace change', head, base, body: prBody, draft: body.draft !== false })
  });
}

function recordPushAttempt(run, actorId, result) { return mutate((state) => { addTrace(state, 'git.push.created', { project_id: run.project_id, workspace_id: run.workspace_id, node_id: run.node_id, run_id: run.id, summary: result.ok ? '确认后推送 Git ref。' : 'Git push 执行失败。', data: result }, actorId); }); }
