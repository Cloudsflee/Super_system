import { HttpError, send } from '../http.mjs';
import { addTrace, mutate, owner } from '../state.mjs';
import { ensureCodeChange } from '../helpers.mjs';
import { git, isGitRepo } from '../git-utils.mjs';
import { makeAssetFromCandidate, now } from '../../../../packages/shared/index.mjs';
import { runBundle } from './git-basic.mjs';
import { consumeGitActionApproval, GIT_COMMIT_APPROVAL, requireGitActionApproval } from '../run-approval.mjs';
import { assertManagedProjectWritable } from '../project-lifecycle.mjs';

export async function commitRun({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    const { run, node, project, repoPath } = runBundle(state, params.id);
    assertManagedProjectWritable(project);
    const approval = requireGitActionApproval(state, { approvalId: body.approval_id, type: GIT_COMMIT_APPROVAL, run, project, node });
    consumeGitActionApproval(approval, `commit:${run.id}`);
    const change = ensureCodeChange(state, run, project, node, actor.id);
    const message = String(body.message || `feat(aiws): ${node?.title || 'complete node run'}\n\nNodeRun: ${run.id}`).slice(0, 500);
    const commandResult = executeCommit(repoPath, change, message, body.files);

    Object.assign(change, {
      commit_message: message,
      commit_result: commandResult,
      status: commandResult.ok ? 'committed' : 'draft',
      committed_by_user_id: actor.id,
      updated_at: now()
    });

    addTrace(state, 'git.commit.created', {
      project_id: project.id,
      workspace_id: run.workspace_id,
      node_id: run.node_id,
      run_id: run.id,
      target_type: 'code_change',
      target_id: change.id,
      summary: commandResult.ok ? `创建 commit ${change.head_commit}` : '生成 commit 草稿 / commit 未执行',
      data: commandResult
    }, actor.id);

    if (commandResult.ok) addCodeChangeAsset(state, { actor, run, node, project, change });
    return { code_change: change, command_result: commandResult };
  });
  return send(res, result.command_result.ok ? 200 : 409, result);
}

function executeCommit(repoPath, change, message, selectedFiles) {
  if (!isGitRepo(repoPath)) throw new HttpError(409, { error: 'git_repository_required' });
  const requested = selectedFiles || change.changed_files?.map((item) => item.path || item.file).filter(Boolean) || [];
  const files = requested.filter((item) => typeof item === 'string' && !item.includes('..') && !/^[/\\]/.test(item));
  if (files.length !== requested.length) throw new HttpError(400, { error: 'invalid_commit_file_path' });
  const staged = files.length ? git(repoPath, ['add', '--', ...files], 10000) : git(repoPath, ['add', '-A'], 10000);
  if (!staged.ok) return staged;
  const result = git(repoPath, ['commit', '-m', message], 15000);
  if (result.ok) change.head_commit = git(repoPath, ['rev-parse', 'HEAD'], 5000).stdout.trim();
  return result;
}

function addCodeChangeAsset(state, { actor, run, node, project, change }) {
  const made = makeAssetFromCandidate({
    asset_type: 'CodeChangeAsset',
    title: `${node?.title || 'NodeRun'} 代码提交`,
    summary: `提交 ${change.head_commit} 关联 NodeRun ${run.id}`,
    evidence_refs: [`node_run:${run.id}`, `code_change:${change.id}`],
    tags: ['code-change', 'git-commit']
  }, {
    projectId: project.id,
    workspaceId: run.workspace_id,
    nodeId: run.node_id,
    runId: run.id,
    actorId: actor.id
  });

  state.assets.push(made.asset);
  state.asset_versions.push(made.version);
  addTrace(state, 'asset_candidate.created', {
    project_id: project.id,
    workspace_id: run.workspace_id,
    node_id: run.node_id,
    run_id: run.id,
    target_type: 'asset',
    target_id: made.asset.id,
    summary: 'Git commit 生成 CodeChangeAsset candidate'
  }, actor.id);
}
