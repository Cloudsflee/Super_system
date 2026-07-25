import { generatePrBody } from '../../../packages/shared/index.mjs';
import { git } from './git-utils.mjs';
import { HttpError } from './http.mjs';
import { createPullRequestIntentInState } from './pull-request-intent-domain.mjs';

export function prepareManagedDeliveryCheckout(context, delivery, baseSha) {
  const snapshot = delivery.task_execution_context?.repository_snapshot;
  if (!snapshot?.repository_workspace_id) return null;
  if (snapshot.mode !== 'read_write')
    throw new HttpError(409, {
      error: 'task_context_not_ready',
      reasons: [
        { code: 'repository_workspace_write_required', repository_workspace_id: snapshot.repository_workspace_id }
      ]
    });
  const dirty = git(snapshot.managed_path, ['status', '--porcelain', '--untracked-files=all'], 10_000);
  if (!dirty.ok || dirty.stdout.trim())
    throw new HttpError(409, {
      error: 'task_context_not_ready',
      reasons: [
        { code: 'repository_workspace_uncommitted_changes', repository_workspace_id: snapshot.repository_workspace_id }
      ]
    });
  const checked = git(snapshot.managed_path, ['checkout', '--detach', baseSha], 30_000);
  if (!checked.ok)
    throw new HttpError(409, { error: 'delivery_workspace_checkout_failed', detail: checked.stderr || checked.error });
  return snapshot.managed_path;
}

export function markDeliveryWorkspaceHeadInState(state, deliveryId, commitSha) {
  const delivery = state.deliveries.find((item) => item.id === deliveryId),
    workspace = state.repository_workspaces.find(
      (item) => item.id === delivery?.repository_workspace_id && item.status === 'active'
    );
  if (!workspace) return null;
  const created = git(workspace.managed_path, ['branch', '--force', delivery.branch, commitSha], 10_000);
  if (!created.ok)
    throw new HttpError(409, {
      error: 'repository_workspace_review_branch_failed',
      detail: created.stderr || created.error
    });
  Object.assign(workspace, {
    current_sha: commitSha,
    review_ref: delivery.branch,
    review_sha: commitSha,
    dirty: false,
    updated_at: new Date().toISOString()
  });
  return workspace;
}

export function createDeliveryPullRequestIntentInState(state, deliveryId, changedFiles, tests, actorId) {
  const delivery = state.deliveries.find((item) => item.id === deliveryId),
    task = state.workflow_nodes.find((item) => item.id === delivery?.task_id),
    project = state.projects.find((item) => item.id === delivery?.project_id);
  if (!delivery || !task || !project || !delivery.repository_workspace_id) return null;
  const run = {
    id: delivery.id,
    summary: `Delivery for ${task.title}`,
    changed_files: changedFiles,
    test_results: tests
  };
  const body = generatePrBody({
    project,
    node: task,
    run,
    diff: { summary: run.summary, changed_files: changedFiles },
    tests
  });
  const created = createPullRequestIntentInState(
    state,
    project.id,
    {
      repository_workspace_id: delivery.repository_workspace_id,
      head_ref: delivery.branch,
      head_sha: delivery.commit_sha,
      base_ref: delivery.base_ref,
      base_sha: delivery.base_sha,
      title: task.title,
      body,
      operation_key: `delivery:${delivery.id}`
    },
    actorId
  );
  Object.assign(delivery, { pull_request_intent_id: created.intent.id, pr_state: 'intent_proposed' });
  return created.intent;
}
