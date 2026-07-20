import assert from 'node:assert/strict';
import {
  approveExchangeRequestInState, createExchangeContextPackInState, createExchangeRequestInState,
  revokeExchangeInState
} from '../../apps/api/src/exchange-v19.mjs';
import { ensureRunContextPack } from '../../apps/api/src/handlers/context-packs.mjs';

const timestamp = new Date().toISOString();
const state = fixture();
const created = createExchangeRequestInState(state, {
  source_project_id: 'source', target_project_id: 'target', root_scope: { type: 'task', id: 'task-a' }, allowed_depth: 0,
  items: [{ type: 'asset', id: 'asset-a' }], token_budget: 5000, operation_key: 'exchange-1'
}, 'source-owner');
assert.equal(createExchangeRequestInState(state, { source_project_id: 'source', target_project_id: 'target', root_scope: { type: 'task', id: 'task-a' }, items: [{ type: 'asset', id: 'asset-a' }], token_budget: 5000, operation_key: 'exchange-1' }, 'source-owner').idempotent, true);
assert.equal(created.request.snapshot.scope_path.map((item) => item.type).join('>'), 'project>workflow>workstream>task');
assert.equal(JSON.stringify(created.request.snapshot).includes('C:\\'), false);
assert.throws(() => approveExchangeRequestInState(state, created.request.id, { side: 'target', expected_revision: 1 }, 'source-owner'), code('exchange_owner_approval_required'));
approveExchangeRequestInState(state, created.request.id, { side: 'source', expected_revision: 1 }, 'source-owner');
const approved = approveExchangeRequestInState(state, created.request.id, { side: 'target', expected_revision: 1 }, 'target-owner');
assert.equal(approved.grant.status, 'active');
const pack = createExchangeContextPackInState(state, approved.grant.id, 'target-owner', { target_scope: { type: 'project', id: 'target' } });
assert.equal(pack.content_json.precedence, 'target_local_first');
assert.equal(pack.content_json.external_context.items.length, 1);
assert.equal(pack.content_json.policy.sibling_context_included, false);
const targetTask = state.workflow_nodes.find((item) => item.id === 'target-task');
const merged = ensureRunContextPack(state, {
  actor: state.users.find((item) => item.id === 'target-owner'), node: targetTask,
  project: state.projects.find((item) => item.id === 'target'), workspace: state.workspaces.find((item) => item.id === 'w-target-task'),
  contract: { node_goal: 'Use approved external context', acceptance_criteria: ['Context remains scoped'], allowed_tools: [] },
  body: { context_pack_id: pack.id, runner: 'codex_docker' }
});
assert.notEqual(merged.id, pack.id);
assert.equal(merged.content_json.workflow_node.id, 'target-task');
assert.equal(merged.content_json.external_context_pack_id, pack.id);
merged.status = 'confirmed';
state.context_packs.push({ id: 'source-local-pack', source_workspace_id: 'w-task', purpose: 'node_run', status: 'confirmed', content_json: { project: { id: 'source' }, workflow_node: { id: 'task-a' } } });
assert.throws(() => ensureRunContextPack(state, { actor: state.users[1], node: targetTask, project: state.projects[1], workspace: state.workspaces.find((item) => item.id === 'w-target-task'), contract: {}, body: { context_pack_id: 'source-local-pack' } }), code('context_pack_project_mismatch'));
revokeExchangeInState(state, created.request.id, 'source-owner', 'scope changed');
assert.throws(() => createExchangeContextPackInState(state, approved.grant.id, 'target-owner'), code('exchange_grant_inactive'));
assert.throws(() => ensureRunContextPack(state, { actor: state.users[1], node: targetTask, project: state.projects[1], workspace: state.workspaces.find((item) => item.id === 'w-target-task'), contract: {}, body: { context_pack_id: pack.id } }), code('exchange_grant_inactive'));
assert.throws(() => ensureRunContextPack(state, { actor: state.users[1], node: targetTask, project: state.projects[1], workspace: state.workspaces.find((item) => item.id === 'w-target-task'), contract: {}, body: { context_pack_id: merged.id } }), code('exchange_grant_inactive'));

const unsafeState = fixture();
unsafeState.assets[0].summary = 'read C:\\Users\\owner\\secret.txt';
unsafeState.asset_versions[0].body = unsafeState.assets[0].summary;
assert.throws(() => createExchangeRequestInState(unsafeState, { source_project_id: 'source', target_project_id: 'target', root_scope: { type: 'task', id: 'task-a' }, items: [{ type: 'asset', id: 'asset-a' }], token_budget: 5000 }, 'source-owner'), code('exchange_absolute_path_forbidden'));
const traversalState = fixture();
traversalState.assets[0].summary = 'read ../../private/context.json';
traversalState.asset_versions[0].body = traversalState.assets[0].summary;
assert.throws(() => createExchangeRequestInState(traversalState, { source_project_id: 'source', target_project_id: 'target', root_scope: { type: 'task', id: 'task-a' }, items: [{ type: 'asset', id: 'asset-a' }], token_budget: 5000 }, 'source-owner'), code('exchange_absolute_path_forbidden'));

console.log('V1.9 Exchange approvals, hierarchy boundary, redaction, and Context Pack tests passed');

function fixture() {
  return {
    instance_owner_user_id: 'source-owner', users: [user('source-owner', 'owner'), user('target-owner', 'owner')],
    projects: [project('source', 'source-owner', 'w-source'), project('target', 'target-owner', 'w-target')],
    project_memberships: [membership('source', 'source-owner'), membership('target', 'target-owner')],
    workflows: [{ id: 'workflow-a', project_id: 'source', workspace_id: 'w-source', title: 'Source workflow' }, { id: 'workflow-target', project_id: 'target', workspace_id: 'w-target', title: 'Target workflow' }],
    workflow_nodes: [{ id: 'ws-a', workflow_id: 'workflow-a', workspace_id: 'w-ws', role: 'workstream', parent_node_id: null, title: 'Outcome A' }, { id: 'task-a', workflow_id: 'workflow-a', workspace_id: 'w-task', role: 'task', parent_node_id: 'ws-a', title: 'Task A' }, { id: 'task-b', workflow_id: 'workflow-a', workspace_id: 'w-task-b', role: 'task', parent_node_id: 'ws-a', title: 'Sibling B' }, { id: 'target-workstream', workflow_id: 'workflow-target', workspace_id: 'w-target-workstream', role: 'workstream', parent_node_id: null, title: 'Target outcome' }, { id: 'target-task', workflow_id: 'workflow-target', workspace_id: 'w-target-task', role: 'task', parent_node_id: 'target-workstream', title: 'Target task' }],
    workspaces: [{ id: 'w-source', project_id: 'source' }, { id: 'w-target', project_id: 'target' }, { id: 'w-ws', project_id: 'source', workflow_node_id: 'ws-a' }, { id: 'w-task', project_id: 'source', workflow_node_id: 'task-a' }, { id: 'w-target-workstream', project_id: 'target', workflow_node_id: 'target-workstream' }, { id: 'w-target-task', project_id: 'target', workflow_node_id: 'target-task' }],
    assets: [{ id: 'asset-a', project_id: 'source', workspace_id: 'w-task', node_id: 'task-a', asset_type: 'DecisionAsset', title: 'Accepted fact', summary: 'A safe confirmed fact.', status: 'confirmed', current_version_id: 'version-a', evidence_refs: ['decision:one'] }],
    asset_versions: [{ id: 'version-a', asset_id: 'asset-a', version: 1, title: 'Accepted fact', summary: 'A safe confirmed fact.', body: 'Only the confirmed finding.', evidence_refs: ['decision:one'], confirmed_by_user_id: 'source-owner' }],
    decisions: [], digests: [], submissions: [], tools: [], runner_memory_candidates: [], exchange_requests: [], exchange_grants: [], context_packs: [], context_sufficiency_checks: [], traces: []
  };
}
function user(id, role) { return { id, display_name: id, role, auth_mode: 'test', created_at: timestamp, updated_at: timestamp }; }
function project(id, owner, workspace) { return { id, title: id, goal: `${id} goal`, owner_user_id: owner, created_by_user_id: owner, current_workspace_id: workspace, created_at: timestamp }; }
function membership(projectId, userId) { return { id: `m-${projectId}`, project_id: projectId, user_id: userId, role: 'owner', status: 'active', created_at: timestamp, updated_at: timestamp }; }
function code(expected) { return (error) => error?.payload?.error === expected; }
