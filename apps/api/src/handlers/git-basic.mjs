import path from 'node:path';
import { HttpError, send } from '../http.mjs';
import { ROOT } from '../config.mjs';
import { addTrace, mutate, owner, saveArtifact } from '../state.mjs';
import { ensureCodeChange } from '../helpers.mjs';
import { git, gitSummary, isGitRepo, parseGitStatus } from '../git-utils.mjs';
import { generateBranchName, now, unique } from '../../../../packages/shared/index.mjs';

function runBundle(state, runId) {
  const run = state.node_runs.find((item) => item.id === runId);
  if (!run) throw new HttpError(404, 'run_not_found');
  const node = state.workflow_nodes.find((item) => item.id === run.node_id);
  const project = state.projects.find((item) => item.id === run.project_id);
  const repoPath = project.repo_path || project.workspace_root || ROOT;
  return { run, node, project, repoPath };
}

export async function bindRepo({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    const project = state.projects.find((item) => item.id === params.id);
    if (!project) throw new HttpError(404, 'project_not_found');

    const repoPath = path.resolve(body.local_path || body.repo_path || project.repo_path || ROOT);
    project.repo_path = repoPath;
    project.workspace_root ||= repoPath;
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
    const branch = generateBranchName(node?.title || 'node', run.id);
    const commandResult = isGitRepo(repoPath)
      ? git(repoPath, ['checkout', '-B', branch], 10000)
      : { ok: false, stdout: '', stderr: 'not a git repo' };

    const change = ensureCodeChange(state, run, project, node, actor.id);
    Object.assign(change, {
      work_branch: branch,
      branch_result: commandResult,
      status: commandResult.ok ? 'branched' : 'draft'
    });

    addTrace(state, 'git.branch.created', {
      project_id: project.id,
      workspace_id: run.workspace_id,
      node_id: run.node_id,
      run_id: run.id,
      target_type: 'code_change',
      target_id: change.id,
      summary: commandResult.ok ? `创建分支 ${branch}` : `生成分支草稿 ${branch}`,
      data: commandResult
    }, actor.id);

    return { code_change: change, branch, command_result: commandResult };
  });
  return send(res, 200, result);
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

function collectDiff({ run, repoPath }) {
  if (!isGitRepo(repoPath)) {
    return {
      text: `Not a git repository: ${repoPath}\n${JSON.stringify(run.result_json?.changed_files || [], null, 2)}`,
      changed: run.result_json?.changed_files || []
    };
  }
  return {
    text: git(repoPath, ['diff', '--patch'], 10000).stdout,
    changed: parseGitStatus(git(repoPath, ['status', '--porcelain'], 5000).stdout)
  };
}

export { runBundle };
