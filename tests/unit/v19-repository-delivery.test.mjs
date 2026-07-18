import assert from 'node:assert/strict';

import {
  approveDeliveryPolicyInState, assertDeliveryPath, createRepositoryConnectionInState,
  requireApprovedDeliveryPolicy, revokeDeliveryPolicyInState, setTaskRepositoryTargetsInState,
  setWorkstreamRepositoryTargetsInState
} from '../../apps/api/src/repository-delivery-domain.mjs';

const state = {
  projects: [{ id: 'project-1', title: 'Multi repository project', repository_connection_ids: [], repo_path: null }],
  workflows: [{ id: 'workflow-1', project_id: 'project-1' }],
  workflow_nodes: [
    { id: 'ws-1', workflow_id: 'workflow-1', role: 'workstream', legacy_read_only: false, repository_target_ids: [] },
    { id: 'task-code', workflow_id: 'workflow-1', role: 'task', parent_node_id: 'ws-1', task_kind: 'code', legacy_read_only: false, repository_target_ids: [] },
    { id: 'task-docs', workflow_id: 'workflow-1', role: 'task', parent_node_id: 'ws-1', task_kind: 'content', legacy_read_only: false, repository_target_ids: [] }
  ],
  repository_connections: [], repository_targets: [], delivery_policies: []
};

assert.throws(() => createRepositoryConnectionInState(state, 'project-1', repository('1', 'acme/app', { token: 'plaintext' }), 'owner'), error('repository_plaintext_credential_forbidden'));
const first = createRepositoryConnectionInState(state, 'project-1', repository('1', 'acme/app'), 'owner');
const second = createRepositoryConnectionInState(state, 'project-1', repository('2', 'acme/docs'), 'owner');
assert.equal(first.idempotent, false);
assert.equal(createRepositoryConnectionInState(state, 'project-1', repository('1', 'acme/app'), 'owner').idempotent, true);
assert.equal(state.projects[0].repository_connection_ids.length, 2);

const available = setWorkstreamRepositoryTargetsInState(state, 'ws-1', { connection_ids: [first.connection.id, second.connection.id] }, 'owner');
assert.equal(available.length, 2);
const taskTargets = setTaskRepositoryTargetsInState(state, 'task-code', { write_connection_id: first.connection.id, read_connection_ids: [first.connection.id, second.connection.id] }, 'owner');
assert.equal(taskTargets.filter((item) => item.access === 'write').length, 1);
assert.deepEqual(taskTargets.filter((item) => item.access === 'read').map((item) => item.connection_id), [second.connection.id]);
assert.throws(() => setTaskRepositoryTargetsInState(state, 'task-docs', { write_connection_id: 'missing' }, 'owner'), error('repository_connection_not_found'));

const policy = approveDeliveryPolicyInState(state, 'ws-1', {
  connection_id: first.connection.id, base_ref: 'main', path_prefixes: ['src', 'tests'], test_commands: ['node --test'],
  automation_permissions: ['codex_run', 'commit', 'push', 'draft_pr']
}, 'owner');
assert.equal(requireApprovedDeliveryPolicy(state, state.workflow_nodes[1], policy.id).policy.id, policy.id);
assert.equal(assertDeliveryPath(policy, 'src/index.mjs'), 'src/index.mjs');
assert.equal(assertDeliveryPath(policy, '.\\tests\\unit.test.mjs'), 'tests/unit.test.mjs');
assert.throws(() => assertDeliveryPath(policy, 'docs/readme.md'), error('delivery_path_outside_policy'));
assert.throws(() => assertDeliveryPath(policy, '../secret.txt'), error('delivery_path_invalid'));

state.repository_targets.find((item) => item.task_id === 'task-code' && item.access === 'write').status = 'active_delivery';
assert.throws(() => setTaskRepositoryTargetsInState(state, 'task-code', { write_connection_id: second.connection.id }, 'owner'), error('task_write_repository_change_blocked_by_delivery'));
revokeDeliveryPolicyInState(state, policy.id, 'owner');
assert.throws(() => requireApprovedDeliveryPolicy(state, state.workflow_nodes[1], policy.id), error('delivery_policy_reapproval_required'));

console.log('V1.9 repository target and Delivery Policy unit tests passed');

function repository(id, fullName, extra = {}) {
  return { installation_id: 'installation-1', repository_id: id, full_name: fullName, default_branch: 'main', permissions: { read: true, push: true, pull_requests: true }, ...extra };
}

function error(expected) { return (value) => value?.payload?.error === expected; }
