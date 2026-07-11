import path from 'node:path';
import { HttpError, send } from '../http.mjs';
import { addTrace, mutate, owner, saveArtifact } from '../state.mjs';
import { ensureCodeChange } from '../helpers.mjs';
import { git, gitSummary, isGitRepo, parseGitStatus } from '../git-utils.mjs';
import { generateBranchName, now, unique } from '../../../../packages/shared/index.mjs';
import { assertManagedProjectWritable, materializeCodeSource } from '../project-lifecycle.mjs';

function runBundle(state, runId) {
  const run = state.node_runs.find((item) => item.id === runId);
  if (!run) throw new HttpError(404, 'run_not_found');
  const node = state.workflow_nodes.find((item) => item.id === run.node_id);
  const project = state.projects.find((item) => item.id === run.project_id);
  if (!node || !project) throw new HttpError(404, { error: 'run_project_or_node_not_found' });
  const repoPath = project?.repo_path || project?.workspace_root || '';
  return { run, node, project, repoPath };
}

export async function bindRepo({ res, params, body }) {
  const snapshot = await import('../state.mjs').then((module) => module.readState());
  const sourceProject = snapshot.projects.find((item) => item.id === params.id);
  if (!sourceProject) throw new HttpError(404, 'project_not_found');
  const requested = body.local_path || body.repo_path || sourceProject.repo_path || sourceProject.workspace_root;
  if (!requested) throw new HttpError(400, { error: 'repository_path_required' });
  const checkout = await materializeCodeSource(sourceProject, { type: isGitRepo(requested) ? 'local_git' : 'local_directory', path: requested }, body.operation_key || 'legacy-local-bind');
  const result = await mutate((state) => {
    const actor = owner(state);
    const project = state.projects.find((item) => item.id === params.id);
    if (!project) throw new HttpError(404, 'project_not_found');

    const repoPath = checkout.repo_path;
    if (!isGitRepo(repoPath)) throw new HttpError(409, { error: 'git_repository_required', repo_path: repoPath });
    project.repo_path = repoPath;
    project.workspace_root = path.dirname(repoPath);
    project.managed_workspace_state = 'ready';
    project.settings ||= {};
    project.settings.workspace_root_whitelist = unique([...(project.settings.workspace_root_whitelist || []), repoPath]);
    project.updated_at = now();

    addTrace(state, 'human.reviewed', {
      project_id: project.id,
      workspace_id: project.current_workspace_id,
      summary: `绑定 Git repo：${repoPath}`
    }, actor.id);

    return { project, git: gitSummary(repoPath) };
  });
  return send(res, 200, result);
}

export async function createBranch({ res, params }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    const { run, node, project, repoPath } = runBundle(state, params.id);
    assertManagedProjectWritable(project);
    const branch = generateBranchName(node?.title || 'node', run.id);
    if (!isGitRepo(repoPath)) throw new HttpError(409, { error: 'git_repository_required' });
    const change = ensureCodeChange(state, run, project, node, actor.id);
    const commandResult = git(repoPath, ['checkout', '-B', branch], 10000);
    Object.assign(change, {
      work_branch: branch,
      branch_result: commandResult,
      status: commandResult.ok ? 'branched' : 'failed'
    });

    addTrace(state, 'git.branch.created', {
      project_id: project.id,
      workspace_id: run.workspace_id,
      node_id: run.node_id,
      run_id: run.id,
      target_type: 'code_change',
      target_id: change.id,
      summary: commandResult.ok ? `创建分支 ${branch}` : `创建分支失败 ${branch}`,
      data: commandResult
    }, actor.id);

    return { code_change: change, branch, command_result: commandResult };
  });
  return send(res, result.command_result.ok ? 200 : 409, result);
}

export async function captureDiff({ res, params }) {
  const result = await mutate(async (state) => {
    const actor = owner(state);
    const bundle = runBundle(state, params.id);
    const diff = collectDiff(bundle);
    const diffRef = await saveArtifact('git', `${bundle.run.id}.diff.patch`, diff.text || '# no diff\n', { run_id: bundle.run.id });
    state.file_refs.push(diffRef);

    const change = ensureCodeChange(state, bundle.run, bundle.project, bundle.node, actor.id);
    Object.assign(change, {
      diff_file_ref_id: diffRef.id,
      changed_files: diff.changed,
      status: 'diff_captured',
      updated_at: now()
    });

    addTrace(state, 'git.diff.captured', {
      project_id: bundle.project.id,
      workspace_id: bundle.run.workspace_id,
      node_id: bundle.run.node_id,
      run_id: bundle.run.id,
      target_type: 'code_change',
      target_id: change.id,
      raw_file_ref_id: diffRef.id,
      summary: `捕获 diff：${diff.changed.length} 个文件`,
      data: { changed_files: diff.changed }
    }, actor.id);

    return { code_change: change, diff: diff.text, changed_files: diff.changed, file_ref: diffRef };
  });
  return send(res, 200, result);
}

function collectDiff({ repoPath }) {
  if (!isGitRepo(repoPath)) throw new HttpError(409, { error: 'git_repository_required' });
  const patch = git(repoPath, ['diff', '--patch'], 10000);
  const status = git(repoPath, ['status', '--porcelain'], 5000);
  if (!patch.ok || !status.ok) throw new HttpError(409, { error: 'git_diff_failed', detail: patch.stderr || status.stderr || patch.error || status.error });
  return {
    text: patch.stdout,
    changed: parseGitStatus(status.stdout)
  };
}

export { runBundle };
