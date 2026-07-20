import assert from 'node:assert/strict';
import { callOperation, createMcpTestFixture, resultData, waitFor } from '../v18/mcp-test-helpers.mjs';
let fixture;
try {
  fixture = await createMcpTestFixture('aiws-v19-migration-orchestrator-', {
    seed: async ({ stateApi }) => stateApi.mutate((state) => addLegacyProject(state, 'resume', { activeRun: true }))
  });
  let state = await fixture.stateApi.readState();
  const resumeIds = referenceSnapshot(state, 'resume');
  const initialBatch = state.workflow_migration_batches.find((item) => item.workflow_ids.includes('workflow-resume'));
  assert.equal(initialBatch.status, 'pending_approval');
  await fixture.stateApi.mutate((current) => {
    current.users.push({ id: 'user-migration-collaborator', display_name: 'Migration Collaborator', role: 'member', auth_mode: 'test' });
    current.project_memberships.push({ id: 'membership-migration-collaborator', project_id: 'project-resume', user_id: 'user-migration-collaborator', role: 'collaborator', status: 'active' });
  });
  assert.equal((await request(fixture, '/api/workflow-migrations', 'GET', undefined, 200, { 'x-aiws-user-id': 'user-migration-collaborator' })).batch.id, initialBatch.id);
  const denied = await request(fixture, `/api/workflow-migrations/batches/${initialBatch.id}/approve`, 'POST', { adapter: 'test' }, 403, { 'x-aiws-user-id': 'user-migration-collaborator' });
  assert.equal(denied.error, 'workflow_migration_owner_required');
  await fixture.stateApi.mutate((current) => {
    current.project_memberships = current.project_memberships.filter((item) => item.user_id !== 'user-migration-collaborator');
    current.users = current.users.filter((item) => item.id !== 'user-migration-collaborator');
  });

  let connection = await fixture.connect(undefined, 'aiws-v18-legacy-reader');
  const legacyViaMcp = resultData(await callOperation(connection.client, 'aiws.projects.get.projects.by-id', { params: { id: 'project-resume' } }));
  assert.equal(legacyViaMcp.workflows[0].hierarchy_mode, 'legacy');
  assert.deepEqual(legacyViaMcp.nodes.map((item) => item.id), resumeIds.nodeIds);
  const legacyViaHttp = await request(fixture, '/api/projects/project-resume');
  assert.equal(legacyViaHttp.workflows[0].legacy_read_only, true);

  await request(fixture, `/api/workflow-migrations/batches/${initialBatch.id}/approve`, 'POST', { adapter: 'test' }, 202);
  await waitFor(async () => {
    const current = await fixture.stateApi.readState();
    const job = current.workflow_migration_jobs.find((item) => item.workflow_id === 'workflow-resume');
    return job?.status === 'waiting_active_runs' && job.active_run_ids?.includes('run-resume');
  }, { message: 'migration did not wait for the active Run' });

  await connection.close();
  await fixture.stopServer();
  await fixture.stateApi.mutate((current) => {
    const run = current.node_runs.find((item) => item.id === 'run-resume');
    run.status = 'completed'; run.completed_at = new Date().toISOString();
  });
  await fixture.restartServer();

  state = await waitFor(async () => {
    const current = await fixture.stateApi.readState();
    return current.workflow_migration_jobs.find((item) => item.workflow_id === 'workflow-resume')?.status === 'completed' ? current : null;
  }, { message: 'migration did not resume after server restart' });
  assertSuccessfulMigration(state, 'resume', resumeIds);
  const completedJob = state.workflow_migration_jobs.find((item) => item.workflow_id === 'workflow-resume');
  assert.deepEqual(completedJob.snapshot.workspace_ids, resumeIds.workspaceIds);
  assert.deepEqual(completedJob.snapshot.contract_ids, resumeIds.contractIds);
  assert.deepEqual(completedJob.snapshot.run_ids, resumeIds.runIds);
  assert.deepEqual(completedJob.snapshot.asset_ids, resumeIds.assetIds);
  assert.deepEqual(completedJob.snapshot.trace_ids, resumeIds.traceIds);
  assert.deepEqual(completedJob.snapshot.assist_session_ids, resumeIds.assistIds);
  await fixture.stopServer();
  await fixture.stateApi.mutate((current) => addLegacyProject(current, 'interrupted'));
  await fixture.restartServer();
  state = await fixture.stateApi.readState();
  const interruptedIds = referenceSnapshot(state, 'interrupted'), interruptedJob = state.workflow_migration_jobs.find((item) => item.workflow_id === 'workflow-interrupted'), interruptedBatch = state.workflow_migration_batches.find((item) => item.id === interruptedJob.batch_id);
  await fixture.stopServer();
  await fixture.stateApi.mutate((current) => {
    Object.assign(current.workflow_migration_batches.find((item) => item.id === interruptedBatch.id), { status: 'completed', adapter: 'test', completed_at: new Date().toISOString() });
    Object.assign(current.workflow_migration_jobs.find((item) => item.id === interruptedJob.id), { status: 'generating', adapter: 'test', attempt: 1 });
  });
  await fixture.restartServer();
  state = await waitFor(async () => {
    const current = await fixture.stateApi.readState(), job = current.workflow_migration_jobs.find((item) => item.id === interruptedJob.id);
    return job?.status === 'completed' ? current : null;
  }, { message: 'generating migration did not recover after server restart' });
  const recoveredJob = state.workflow_migration_jobs.find((item) => item.id === interruptedJob.id);
  assert.equal(recoveredJob.attempt, 2);
  assert.equal(recoveredJob.restart_recovery_count, 1);
  assertSuccessfulMigration(state, 'interrupted', interruptedIds);
  await fixture.stopServer();
  await fixture.stateApi.mutate((current) => addLegacyProject(current, 'rollback'));
  await fixture.restartServer();
  state = await fixture.stateApi.readState();
  const rollbackIds = referenceSnapshot(state, 'rollback');
  const legacyGraphBefore = graphRecords(state, 'rollback');
  const rollbackJob = state.workflow_migration_jobs.find((item) => item.workflow_id === 'workflow-rollback');
  const rollbackBatch = state.workflow_migration_batches.find((item) => item.id === rollbackJob.batch_id);
  assert.equal(rollbackBatch.status, 'pending_approval');
  connection = await fixture.connect(undefined, 'aiws-v18-failed-migration-reader');
  const rollbackLegacy = resultData(await callOperation(connection.client, 'aiws.projects.get.projects.by-id', { params: { id: 'project-rollback' } }));
  assert.equal(rollbackLegacy.workflows[0].semantic_migration_status, 'pending');
  assert.equal((await request(fixture, '/api/projects/project-rollback')).nodes.length, 8);
  await request(fixture, `/api/workflow-migrations/batches/${rollbackBatch.id}/approve`, 'POST', {}, 202);
  await assertFailedAttempt(fixture, rollbackJob.id, 1, 'active_codex_profile_required', legacyGraphBefore);
  const lowConfidence = migrationCandidate('rollback', { confidence: 0.4 });
  await request(fixture, `/api/workflow-migrations/jobs/${rollbackJob.id}/retry`, 'POST', { adapter: 'test', test_candidate: lowConfidence }, 202);
  await assertFailedAttempt(fixture, rollbackJob.id, 2, 'workflow_migration_critic_rejected', legacyGraphBefore);
  const missingMapping = migrationCandidate('rollback', { mapping: false });
  await request(fixture, `/api/workflow-migrations/jobs/${rollbackJob.id}/retry`, 'POST', { adapter: 'test', test_candidate: missingMapping }, 202);
  await assertFailedAttempt(fixture, rollbackJob.id, 3, 'workflow_migration_mapping_not_bijective', legacyGraphBefore);
  await request(fixture, `/api/workflow-migrations/jobs/${rollbackJob.id}/retry`, 'POST', { adapter: 'test' }, 202);
  state = await waitFor(async () => {
    const current = await fixture.stateApi.readState();
    const job = current.workflow_migration_jobs.find((item) => item.id === rollbackJob.id);
    return job?.status === 'completed' && current.workflow_migration_batches.find((item) => item.id === job.batch_id)?.status === 'completed' ? current : null;
  }, { message: 'failed migration did not complete after deterministic retry' });
  assert.equal(state.workflow_migration_jobs.find((item) => item.id === rollbackJob.id).attempt, 4);
  assertSuccessfulMigration(state, 'rollback', rollbackIds);
  const migratedViaMcp = resultData(await callOperation(connection.client, 'aiws.projects.get.projects.by-id', { params: { id: 'project-rollback' } }));
  assert.equal(migratedViaMcp.workflows[0].hierarchy_mode, 'two_level');
  assert.equal(migratedViaMcp.nodes.filter((item) => item.role === 'task').length, 8);
  await connection.close(); connection = null;
  await fixture.stopServer();
  await fixture.stateApi.mutate((current) => { addLegacyProject(current, 'trashed'); current.projects.find((item) => item.id === 'project-trashed').deleted_at = new Date().toISOString(); });
  await fixture.restartServer();
  state = await fixture.stateApi.readState();
  assert.equal(state.workflow_migration_jobs.some((item) => item.workflow_id === 'workflow-trashed'), false);
  const migrationView = await request(fixture, '/api/workflow-migrations');
  assert.equal(migrationView.legacy_workflow_ids.includes('workflow-trashed'), false);
  await fixture.stateApi.mutate((current) => { current.projects.find((item) => item.id === 'project-trashed').deleted_at = null; });
  const restoredMigrationView = await request(fixture, '/api/workflow-migrations');
  assert.equal(restoredMigrationView.legacy_workflow_ids.includes('workflow-trashed'), true);
  assert.equal(restoredMigrationView.jobs.some((item) => item.workflow_id === 'workflow-trashed' && item.status === 'pending'), true);
  console.log('V1.9 workflow migration orchestrator integration tests passed');
} finally {
  await fixture?.close();
}

async function assertFailedAttempt(currentFixture, jobId, attempt, errorCode, graphBefore) {
  const state = await waitFor(async () => {
    const value = await currentFixture.stateApi.readState();
    const job = value.workflow_migration_jobs.find((item) => item.id === jobId);
    const batch = value.workflow_migration_batches.find((item) => item.id === job?.batch_id);
    return job?.status === 'failed' && job.attempt === attempt && batch?.status === 'completed_with_failures' ? value : null;
  }, { message: `migration failure ${attempt} did not settle` });
  const job = state.workflow_migration_jobs.find((item) => item.id === jobId);
  assert.equal(job.error_code, errorCode);
  assert.deepEqual(graphRecords(state, 'rollback'), graphBefore, `failed attempt ${attempt} partially changed the legacy graph`);
  assert.equal(state.workflows.find((item) => item.id === 'workflow-rollback').hierarchy_mode, 'legacy');
  assert.equal(state.workflows.find((item) => item.id === 'workflow-rollback').legacy_read_only, true);
}

function assertSuccessfulMigration(state, suffix, before) {
  const workflow = state.workflows.find((item) => item.id === `workflow-${suffix}`);
  const nodes = state.workflow_nodes.filter((item) => item.workflow_id === workflow.id);
  const tasks = nodes.filter((item) => item.role === 'task');
  const workstreams = nodes.filter((item) => item.role === 'workstream');
  assert.equal(workflow.hierarchy_mode, 'two_level');
  assert.equal(workflow.legacy_read_only, false);
  assert.equal(workflow.semantic_migration_status, 'completed');
  assert.deepEqual(tasks.map((item) => item.id), before.nodeIds);
  assert.deepEqual(tasks.map((item) => item.workspace_id), before.workspaceIds);
  assert.deepEqual(tasks.map((item) => item.current_contract_id), before.contractIds);
  assert.equal(workstreams.length, 1);
  const workstreamWorkspace = workstreams[0].workspace_id;
  assert.ok(tasks.every((item) => state.workspaces.find((workspace) => workspace.id === item.workspace_id)?.parent_workspace_id === workstreamWorkspace));
  assert.deepEqual(idsFor(state.node_runs, `project-${suffix}`), before.runIds);
  assert.deepEqual(idsFor(state.assets, `project-${suffix}`), before.assetIds);
  assert.ok(before.traceIds.every((id) => state.traces.some((item) => item.id === id)));
  assert.deepEqual(idsFor(state.assist_sessions, `project-${suffix}`), before.assistIds);
  const assist = state.assist_sessions.find((item) => item.id === `assist-${suffix}`);
  assert.equal(assist.scope_type, 'task');
  assert.equal(assist.scope_status, 'active');
  assert.equal(assist.scope_snapshot.scope_type, 'node', 'the original Assist scope snapshot remains an audit record');
}

function addLegacyProject(state, suffix, { activeRun = false } = {}) {
  const projectId = `project-${suffix}`, workflowId = `workflow-${suffix}`, rootWorkspaceId = `workspace-${suffix}-root`;
  const nodes = Array.from({ length: 8 }, (_, index) => legacyNode(suffix, workflowId, index));
  state.projects.push({
    id: projectId, title: `Eight node ${suffix} project`, goal: 'Preserve all legacy references', status: 'active', onboarding_state: 'confirmed',
    current_workspace_id: rootWorkspaceId, workflow_migration_status: 'pending', lifecycle_operation: null
  });
  state.workflows.push({
    id: workflowId, project_id: projectId, workspace_id: rootWorkspaceId, title: `Legacy ${suffix} workflow`, status: 'active', version: 3,
    workflow_revision: 3, hierarchy_mode: 'legacy', semantic_migration_status: 'pending', legacy_read_only: true, graph_json: { nodes: [], edges: [] }
  });
  state.workflow_nodes.push(...nodes);
  state.workspaces.push(
    { id: rootWorkspaceId, project_id: projectId, title: `Root ${suffix}`, status: 'active' },
    ...nodes.map((node) => ({ id: node.workspace_id, project_id: projectId, parent_workspace_id: rootWorkspaceId, workflow_node_id: node.id, type: 'node', title: node.title, goal: node.goal, status: 'active' }))
  );
  state.node_contracts.push(...nodes.map((node) => ({
    id: node.current_contract_id, node_id: node.id, version: 1, node_goal: node.goal, expected_inputs: [], expected_outputs: [{ label: 'Legacy result', required: true }],
    acceptance_criteria: ['Legacy result remains accepted.'], required_context: [], allowed_tools: ['assist'], asset_output_types: [], status: 'confirmed'
  })));
  state.node_runs.push({ id: `run-${suffix}`, project_id: projectId, node_id: nodes[5].id, workspace_id: nodes[5].workspace_id, status: activeRun ? 'waiting_approval' : 'completed' });
  state.assets.push({ id: `asset-${suffix}`, project_id: projectId, node_id: nodes[2].id, workspace_id: nodes[2].workspace_id, status: 'ready', title: 'Legacy asset' });
  state.traces.push({ id: `trace-${suffix}`, project_id: projectId, node_id: nodes[3].id, workspace_id: nodes[3].workspace_id, event_type: 'legacy.event', created_at: new Date().toISOString() });
  state.assist_sessions.push({
    id: `assist-${suffix}`, version: 3, project_id: projectId, scope_type: 'node', scope_id: nodes[4].id, scope_status: 'legacy_read_only',
    scope_snapshot: { project_id: projectId, scope_type: 'node', scope_id: nodes[4].id, scope_title: nodes[4].title, captured_at: new Date().toISOString() },
    read_only: true, title: 'Legacy node thread', status: 'active', lifecycle: 'active', pinned: false, clarification_policy: 'ask'
  });
  state.agent_sessions.push({ id: `agent-${suffix}`, project_id: projectId, scope_type: 'node', scope_id: nodes[4].id });
  state.project_briefs.push({
    id: `brief-${suffix}`, project_id: projectId, version: 1, revision: 1, status: 'active',
    content: { goal: 'Preserve all legacy references', acceptance_criteria: ['All legacy results remain traceable.'], sections: [{ id: `brief-${suffix}-goal`, type: 'text', title: 'Goal' }] }
  });
}

function legacyNode(suffix, workflowId, index) {
  const id = `legacy-${suffix}-${index + 1}`, previousId = index ? `legacy-${suffix}-${index}` : null;
  const type = index === 0 ? 'goal_definition' : index < 3 ? 'research' : index < 5 ? 'analysis' : index === 7 ? 'retrospective' : 'execution';
  return {
    id, workflow_id: workflowId, workspace_id: `workspace-${suffix}-${index + 1}`, current_contract_id: `contract-${suffix}-${index + 1}`,
    type, legacy_node_type: type, role: 'task', parent_node_id: null, title: `Legacy ${suffix} step ${index + 1}`, goal: `Complete ${suffix} step ${index + 1}`,
    status: index === 0 ? 'completed' : 'ready', order_index: index, dependencies: previousId ? [{ node_id: previousId, type: 'finish_to_start' }] : [],
    legacy_read_only: true, task_kind: taskKind(type), execution_mode: type === 'execution' ? 'codex' : 'assist', position: { x: index * 120, y: 100 }
  };
}

function migrationCandidate(suffix, { confidence = 0.95, mapping = true } = {}) {
  const tasks = Array.from({ length: 8 }, (_, index) => {
    const type = index === 0 ? 'goal_definition' : index < 3 ? 'research' : index < 5 ? 'analysis' : index === 7 ? 'retrospective' : 'execution';
    return {
      id: `legacy-${suffix}-${index + 1}`, role: 'task', title: `Legacy ${suffix} step ${index + 1}`, goal: `Complete ${suffix} step ${index + 1}`,
      task_kind: taskKind(type), execution_mode: type === 'execution' ? 'codex' : 'assist',
      dependency_ids: index ? [`legacy-${suffix}-${index}`] : []
    };
  });
  const candidate = {
    project_classification: 'legacy_semantic_migration', decomposition_basis: 'One independently accepted outcome preserves every legacy task.',
    evidence_refs: [{ section_id: `brief-${suffix}-goal`, quote: 'Preserve all legacy references.' }], confidence, repository_intent: [],
    workstreams: [{
      id: `workstream-${suffix}-candidate`, role: 'workstream', title: 'Accepted legacy outcome package', outcome: 'A reviewable package retaining every legacy result.',
      category: 'deliverable', boundary: { deliverable: `legacy-${suffix}-package` }, acceptance_criteria: ['All mapped results remain traceable.'], dependency_ids: [], tasks
    }]
  };
  if (mapping) candidate.legacy_mapping = tasks.map((task) => ({ legacy_node_id: task.id, task_id: task.id, workstream_id: `workstream-${suffix}-candidate` }));
  return candidate;
}

function referenceSnapshot(state, suffix) {
  const nodes = state.workflow_nodes.filter((item) => item.workflow_id === `workflow-${suffix}`);
  return {
    nodeIds: nodes.map((item) => item.id), workspaceIds: nodes.map((item) => item.workspace_id), contractIds: nodes.map((item) => item.current_contract_id),
    runIds: idsFor(state.node_runs, `project-${suffix}`), assetIds: idsFor(state.assets, `project-${suffix}`),
    traceIds: idsFor(state.traces, `project-${suffix}`), assistIds: idsFor(state.assist_sessions, `project-${suffix}`)
  };
}

function graphRecords(state, suffix) {
  const workflowId = `workflow-${suffix}`, nodeIds = new Set(state.workflow_nodes.filter((item) => item.workflow_id === workflowId).map((item) => item.id));
  return {
    nodes: structuredClone(state.workflow_nodes.filter((item) => nodeIds.has(item.id))),
    workspaces: structuredClone(state.workspaces.filter((item) => nodeIds.has(item.workflow_node_id))),
    contracts: structuredClone(state.node_contracts.filter((item) => nodeIds.has(item.node_id)))
  };
}

async function request(currentFixture, pathname, method = 'GET', body, expected = 200, headers = {}) {
  const response = await fetch(`${currentFixture.baseUrl}${pathname}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return data;
}

function idsFor(records, projectId) { return records.filter((item) => item.project_id === projectId).map((item) => item.id); }
function taskKind(type) { return ({ goal_definition: 'analysis', research: 'research', analysis: 'analysis', execution: 'code', retrospective: 'review' })[type] || 'manual'; }
