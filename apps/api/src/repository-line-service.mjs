import fsp from 'node:fs/promises';
import path from 'node:path';

import { now } from '../../../packages/shared/index.mjs';
import { commandAsync } from './http.mjs';
import { EXECUTION_DIR } from './config.mjs';
import { HttpError } from './http.mjs';
import { mutate, readState } from './state.mjs';
import { reconcileWorkflowExecutionInState } from './workflow-execution-domain.mjs';

export async function provisionWorkflowRepositoryLines(workflowExecutionId) {
  const snapshot = await readState(),
    execution = snapshot.workflow_executions.find((item) => item.id === workflowExecutionId);
  if (!execution) throw new HttpError(404, { error: 'workflow_execution_not_found' });
  const lines = snapshot.repository_lines.filter(
    (item) => item.workflow_execution_id === execution.id && item.status === 'active'
  );
  const results = [];
  for (const line of lines) {
    try {
      results.push(await provisionRepositoryLine(line.id));
    } catch (error) {
      await mutate((state) => {
        const current = state.repository_lines.find((item) => item.id === line.id);
        if (current)
          Object.assign(current, { status: 'failed', error_code: error.code || error.message, updated_at: now() });
        reconcileWorkflowExecutionInState(state, workflowExecutionId);
      });
      results.push({ id: line.id, status: 'failed', error: error.code || error.message });
    }
  }
  return results;
}

export async function provisionRepositoryLine(repositoryLineId) {
  const state = await readState(),
    line = state.repository_lines.find((item) => item.id === repositoryLineId);
  if (!line) throw new HttpError(404, { error: 'repository_line_not_found' });
  if (line.checkout_path) {
    const head = await repositoryHead(line.checkout_path);
    if (line.head_sha && head !== line.head_sha)
      throw lineError('repository_line_head_changed', { expected_sha: line.head_sha, actual_sha: head });
    return line;
  }
  const connection = state.repository_connections.find((item) => item.id === line.connection_id),
    workspace = state.repository_workspaces.find(
      (item) =>
        item.connection_id === line.connection_id &&
        item.project_id === line.project_id &&
        item.status === 'active' &&
        !item.stale
    );
  const source = connection?.local_path || workspace?.managed_path;
  if (!source) throw lineError('repository_line_source_checkout_missing');
  const desiredHead = line.head_sha || line.base_sha || line.base_ref,
    sourceHead = await gitOutput(source, ['rev-parse', desiredHead]);
  if (line.head_sha && sourceHead !== line.head_sha)
    throw lineError('repository_line_head_sha_mismatch', { expected_sha: line.head_sha, actual_sha: sourceHead });
  if (!line.head_sha && line.base_sha && sourceHead !== line.base_sha)
    throw lineError('repository_line_base_sha_mismatch', { expected_sha: line.base_sha, actual_sha: sourceHead });
  const root = path.resolve(EXECUTION_DIR, 'repository-lines'),
    target = path.resolve(root, line.id);
  assertWithin(root, target);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const exists = await fsp.stat(target).then(
    () => true,
    () => false
  );
  if (!exists) {
    const created = await commandAsync('git', ['worktree', 'add', '--detach', target, sourceHead], source, 120_000);
    if (!created.ok)
      throw lineError('repository_line_worktree_create_failed', { detail: tail(created.stderr || created.error) });
  }
  const status = await gitOutput(target, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) throw lineError('repository_line_recovery_dirty');
  const branch = await commandAsync('git', ['switch', '-C', line.branch, sourceHead], target, 30_000);
  if (!branch.ok)
    throw lineError('repository_line_branch_create_failed', { detail: tail(branch.stderr || branch.error) });
  const head = await repositoryHead(target);
  if (head !== sourceHead)
    throw lineError('repository_line_checkout_sha_mismatch', { expected_sha: sourceHead, actual_sha: head });
  return mutate((current) => {
    const record = current.repository_lines.find((item) => item.id === repositoryLineId);
    if (!record) throw new HttpError(404, { error: 'repository_line_not_found' });
    Object.assign(record, {
      base_sha: record.base_sha || sourceHead,
      head_sha: head,
      checkout_path: target,
      status: 'active',
      updated_at: now()
    });
    reconcileWorkflowExecutionInState(current, record.workflow_execution_id);
    return record;
  });
}

export async function verifyRepositoryLineHead(line, expectedSha = line?.head_sha, { requireClean = false } = {}) {
  if (!line?.checkout_path) throw lineError('repository_line_checkout_missing');
  const head = await repositoryHead(line.checkout_path);
  if (expectedSha != null && head !== expectedSha)
    throw lineError('repository_line_head_mismatch', { expected_sha: expectedSha, actual_sha: head });
  const status = await gitOutput(line.checkout_path, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (requireClean && status)
    throw lineError('repository_verify_diff_forbidden', {
      changed_paths: status
        .split(/\r?\n/)
        .filter(Boolean)
        .map((item) => item.slice(3))
    });
  return { repository_sha: head, checkout_head: head, clean: !status, status_porcelain: status };
}

export async function updateRepositoryLineHeadInState(state, line, expectedPreviousSha) {
  if (!line?.checkout_path) throw lineError('repository_line_checkout_missing');
  if (line.head_sha !== expectedPreviousSha)
    throw lineError('repository_line_concurrent_head_change', {
      expected_sha: expectedPreviousSha,
      actual_sha: line.head_sha
    });
  const head = await repositoryHead(line.checkout_path);
  if (head === expectedPreviousSha) throw lineError('repository_change_commit_required');
  line.head_sha = head;
  line.updated_at = now();
  return head;
}

async function repositoryHead(directory) {
  return gitOutput(directory, ['rev-parse', 'HEAD']);
}
async function gitOutput(directory, args) {
  const result = await commandAsync('git', args, directory, 30_000);
  if (!result.ok) throw lineError('repository_line_git_failed', { args, detail: tail(result.stderr || result.error) });
  return String(result.stdout || '').trim();
}
function assertWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw lineError('repository_line_path_outside_root');
}
function tail(value) {
  return String(value || '').slice(-4000);
}
function lineError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
