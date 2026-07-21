import assert from 'node:assert/strict';
import { callOperation, callTool, resultData } from '../v18/mcp-test-helpers.mjs';
import { decide } from './v18-mcp-journey-helpers.mjs';

export async function completeHumanTask(operator, approver, { projectId, task }) {
  const proposal = resultData(await callOperation(operator, 'aiws.governance.post.change-proposals', {
    body: {
      project_id: projectId, node_id: task.id, change_type: 'node_run_write', title: `Authorize ${task.title}`,
      after: { runner: 'codex_docker' }, apply_action: { type: 'node_run_authorization', node_id: task.id, runner: 'codex_docker' }
    }
  }));
  await decide(approver, proposal);
  const started = await callOperation(operator, 'aiws.runs.post.nodes.by-id.run.start', {
    params: { id: task.id },
    body: { adapter: 'test', runner: 'codex_docker', approval_id: proposal.id, test_summary: `${task.title} completed with traceable evidence.` }
  });
  const runId = started.handle.id;
  const waited = await callTool(operator, 'aiws_operations', { action: 'wait', operation_id: runId, timeout_ms: 10_000, poll_ms: 50 });
  assert.equal(waited.data.operation.status, 'succeeded');
  const detail = resultData(await callOperation(operator, 'aiws.runs.get.runs.by-id', { params: { id: runId } }));
  const bindings = [];
  for (const candidate of detail.assets.filter((item) => item.status === 'candidate')) {
    const confirmed = resultData(await callOperation(operator, 'aiws.assets.post.asset-candidates.by-id.confirm', {
      params: { id: candidate.id }, body: { tags: ['v1.9', 'mcp-journey'] }
    }));
    const slot = task.output_slots.find((item) => item.key === candidate.output_key);
    assert.ok(slot, `Output slot missing for ${candidate.output_key}`);
    bindings.push({ key: slot.key, asset_id: confirmed.asset.id, version_id: confirmed.version.id, asset_type: slot.asset_type, acceptance_criteria: slot.acceptance_criteria });
  }
  assert.equal(bindings.length, task.output_slots.filter((item) => item.required !== false).length);
  await callOperation(operator, 'aiws.workflow.post.tasks.by-id.submissions', {
    params: { id: task.id },
    body: { title: `${task.title} result`, summary: `${task.title} produced confirmed, reviewable evidence.`, evidence_refs: [`node_run:${runId}`], output_bindings: bindings, input_snapshot_hash: detail.run.input_snapshot_hash }
  });
  await callOperation(approver, 'aiws.workflow.post.tasks.by-id.review', {
    params: { id: task.id },
    body: { decision: 'approve', summary: `${task.title} evidence accepted.`, acceptance_results: task.acceptance_criteria.map((criterion) => ({ criterion, passed: true })) }
  });
  return { runId, bindings };
}

export async function createRepositoryWorkspace(client, { projectId, connectionId, operationKey, makeDefault = false }) {
  const created = resultData(await callOperation(client, 'aiws.github.post.projects.by-id.repository-workspaces', {
    params: { id: projectId },
    body: { connection_id: connectionId, ref: 'main', mode: 'read_write', scope: { type: 'project', id: projectId, path_prefixes: ['.'] }, operation_key: operationKey, make_default: makeDefault }
  }));
  return created.workspace;
}

export async function completeDeliveryTask(operator, approver, { projectId, task, policyId, repositoryWorkspaceId, change, pullNumber }) {
  const started = await callOperation(approver, 'aiws.github.post.tasks.by-id.deliveries', {
    params: { id: task.id }, body: { adapter: 'test', policy_id: policyId, repository_workspace_id: repositoryWorkspaceId, test_changes: [change] }
  });
  const deliveryId = started.handle.id;
  const waited = await callTool(approver, 'aiws_operations', { action: 'wait', operation_id: deliveryId, timeout_ms: 20_000, poll_ms: 50 });
  assert.equal(waited.data.operation.status, 'completed');
  const delivery = resultData(await callOperation(approver, 'aiws.github.get.deliveries.by-id', { params: { id: deliveryId } }));
  assert.equal(delivery.pr_state, 'intent_proposed');
  assert.ok(delivery.output_bindings.length > 0 && delivery.test_results.every((item) => item.status === 'passed'));
  await callOperation(operator, 'aiws.workflow.post.tasks.by-id.submissions', {
    params: { id: task.id }, body: { summary: `${task.title} produced tested delivery evidence.`, evidence_refs: [`delivery:${delivery.id}`] }
  });
  await callOperation(approver, 'aiws.workflow.post.tasks.by-id.review', {
    params: { id: task.id }, body: { decision: 'approve', summary: 'Delivery evidence and policy checks accepted.' }
  });
  const intent = await createAndMergePullRequest(approver, delivery.pull_request_intent_id, pullNumber);
  return { delivery, intent };
}

async function createAndMergePullRequest(client, intentId, pullNumber) {
  let intent = resultData(await callOperation(client, 'aiws.github.get.pull-request-intents.by-id', { params: { id: intentId } }));
  let approved = resultData(await callOperation(client, 'aiws.github.post.pull-request-intents.by-id.approve', {
    params: { id: intent.id }, body: { action: 'create_pr', expected_revision: intent.revision, expected_snapshot_hash: intent.snapshot_hash }
  }));
  intent = resultData(await callOperation(client, 'aiws.github.post.pull-request-intents.by-id.execute', {
    params: { id: intent.id }, body: { action: 'create_pr', expected_revision: approved.intent.revision, expected_snapshot_hash: intent.snapshot_hash, adapter: 'test', test_pr_number: pullNumber, test_pr_url: `https://github.test/pull/${pullNumber}` }
  }));
  intent = resultData(await callOperation(client, 'aiws.github.post.pull-request-intents.by-id.reconcile', {
    params: { id: intent.id }, body: { adapter: 'test', test_pr_state: 'open', test_draft: true, test_checks_status: 'passed' }
  }));
  approved = resultData(await callOperation(client, 'aiws.github.post.pull-request-intents.by-id.approve', {
    params: { id: intent.id }, body: { action: 'merge_pr', expected_revision: intent.revision, expected_snapshot_hash: intent.snapshot_hash }
  }));
  intent = resultData(await callOperation(client, 'aiws.github.post.pull-request-intents.by-id.execute', {
    params: { id: intent.id }, body: { action: 'merge_pr', expected_revision: approved.intent.revision, expected_snapshot_hash: intent.snapshot_hash, adapter: 'test', test_checks_status: 'passed', test_merge_commit_sha: 'f'.repeat(40) }
  }));
  assert.equal(intent.status, 'merged');
  assert.deepEqual(intent.approvals.map((item) => item.action), ['create_pr', 'merge_pr']);
  return intent;
}

export function codingHierarchy() {
  const evidenceCriterion = 'Release constraints and repository evidence are traceable.';
  const alphaCriterion = 'The alpha change passes its repository policy tests.';
  const betaCriterion = 'The beta integration passes tests and completes delivery evidence.';
  return [{
    id: 'ws-multi-repo-release', role: 'workstream', title: 'Verified multi-repository release', outcome: 'Two independently tested repository changes, each represented by its own approved PR intent.',
    category: 'deliverable', boundary: { repositories: ['acme/service-alpha', 'acme/service-beta'], deliverable: 'two-pull-requests' }, acceptance_criteria: ['Both repository policy tests pass.', 'Each repository change completes the two-approval PR flow.'], dependency_ids: [],
    tasks: [
      typedTask('task-release-evidence', 'Prepare release evidence', 'Establish constraints and evidence for both repository changes', 'research', 'assist', ['research_evidence', 'constraint_analysis', 'solution_decision'], evidenceCriterion, [], [{ key: 'project_brief', kind: 'context', required: true, source: 'brief', selector: 'current' }], 'release_evidence', 'ResearchEvidenceAsset', 'human'),
      typedTask('task-alpha-repository', 'Deliver alpha repository change', 'Create the tested alpha change', 'code', 'codex', ['execution'], alphaCriterion, ['task-release-evidence'], dependencyInputs('task-release-evidence'), 'alpha_change', 'CodeChangeAsset', 'system_evidence', { mode: 'write', repository: 'acme/service-alpha' }),
      typedTask('task-beta-repository', 'Accept and deliver beta integration', 'Create and accept the tested beta integration', 'integration', 'codex', ['acceptance', 'integration_delivery'], betaCriterion, ['task-alpha-repository'], dependencyInputs('task-alpha-repository'), 'beta_delivery', 'DeliveryEvidenceAsset', 'system_evidence', { mode: 'write', repository: 'acme/service-beta' })
    ]
  }];
}

function dependencyInputs(dependencyId) { return [{ key: 'upstream_result', kind: 'asset_version', required: true, source: 'dependency', selector: 'required_outputs', ref_id: dependencyId }, { key: 'repository_snapshot', kind: 'repository', required: true, source: 'repository_workspace', selector: 'fixed_sha' }]; }
function typedTask(id, title, goal, taskKind, executionMode, tags, criterion, dependencyIds, inputSlots, outputKey, assetType, confirmationPolicy, repositoryIntent = null) { return { id, role: 'task', title, goal, task_kind: taskKind, execution_mode: executionMode, capability_tags: tags, acceptance_criteria: [criterion], dependency_ids: dependencyIds, input_slots: inputSlots, output_slots: [{ key: outputKey, kind: 'asset', required: true, asset_type: assetType, acceptance_criteria: [criterion], confirmation_policy: confirmationPolicy }], repository_intent: repositoryIntent }; }
