import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCleanRuntime } from '../../apps/api/src/clean/runtime.mjs';

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p3-'));
  return {
    root,
    config: {
      runtime: 'v3-clean',
      apiVersion: '2',
      host: '127.0.0.1',
      port: 0,
      home: root,
      databaseFile: path.join(root, 'data', 'state.sqlite'),
      casRoot: path.join(root, 'cas'),
      receiptRoot: path.join(root, 'receipts'),
      vaultRoot: path.join(root, 'vault'),
      cursorSecret: 'p3-test-cursor-secret',
      sessionSecret: 'p3-test-session-secret',
      vaultMasterKey: 'p3-test-vault-master-secret',
      runtimeBuild: 'p3-test',
      maxBodyBytes: 1_000_000,
      ...overrides
    }
  };
}

async function open(overrides = {}) {
  const f = fixture(overrides);
  const runtime = createCleanRuntime({ config: f.config, targetVersion: 3, ...overrides });
  await runtime.recovery;
  const setup = await runtime.identity.setupComplete({
    display_name: 'P3 Owner',
    team_name: 'P3 Team',
    idempotency_key: 'p3-setup-key'
  });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  return { ...f, runtime, principal };
}

async function close(fixtureState) {
  fixtureState.runtime.close();
  fs.rmSync(fixtureState.root, { recursive: true, force: true });
}

async function waitForOperation(runtime, operationId, actorId, timeout = 2_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const receipt = runtime.operations.get(operationId, { actorId });
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(receipt.status)) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`operation_timeout:${operationId}`);
}

async function prepareWorkflow(state, suffix = 'flow') {
  const { runtime, principal } = state;
  const project = await runtime.project.createProject(
    { name: `P3 ${suffix}`, idempotency_key: `p3-${suffix}-project-key` },
    principal
  );
  const intake = await runtime.project.submitIntake(
    project.id,
    {
      mode: 'brainstorm',
      content: { objective: 'exercise p3' },
      expected_revision: 1,
      idempotency_key: `p3-${suffix}-intake-key`
    },
    principal
  );
  await waitForOperation(runtime, intake.operation.operation_id, principal.actorId);
  await runtime.project.createBrief(
    project.id,
    { objective: 'exercise', acceptance: ['head'], expected_revision: 1, idempotency_key: `p3-${suffix}-brief-key` },
    principal
  );
  await runtime.project.confirmBrief(
    project.id,
    { brief_revision: 1, expected_revision: 2, idempotency_key: `p3-${suffix}-confirm-key` },
    principal
  );
  const connection = await runtime.project.createRepositoryConnection(
    project.id,
    {
      provider: 'fixture',
      source_kind: 'git',
      source_locator: 'fixture/repository',
      idempotency_key: `p3-${suffix}-connection-key`
    },
    principal
  );
  const line = runtime.project.listRepositoryLines(project.id, principal)[0];
  await runtime.project.reconcileRepositoryLine(
    line.id,
    {
      source_revision: 'fixture-r1',
      source_hash: 'a'.repeat(64),
      expected_revision: 1,
      idempotency_key: `p3-${suffix}-line-key`
    },
    principal
  );
  const workspace = await runtime.project.createRepositoryWorkspace(
    project.id,
    { line_id: line.id, expected_revision: 0, idempotency_key: `p3-${suffix}-workspace-key` },
    principal
  );
  await runtime.project.lockRepositoryWorkspace(
    workspace.workspace.id,
    { expected_revision: 1, idempotency_key: `p3-${suffix}-lock-key` },
    principal
  );
  await runtime.project.releaseRepositoryWorkspace(
    workspace.workspace.id,
    { expected_revision: 2, idempotency_key: `p3-${suffix}-release-key` },
    principal
  );
  const workflow = await runtime.project.reviseWorkflow(
    project.id,
    {
      graph: {
        nodes: [
          { id: 'stream', kind: 'workstream', title: 'Stream' },
          { id: 'task', parent_id: 'stream', kind: 'task', title: 'Task', contract: { acceptance: ['done'] } }
        ]
      },
      expected_revision: 1,
      idempotency_key: `p3-${suffix}-workflow-key`
    },
    principal
  );
  return { project, intake, connection, line, workspace, workflow };
}

test('P3 complete project workflow keeps every aggregate head and audit aligned', async () => {
  const state = await open();
  try {
    const { runtime, principal } = state;
    const prepared = await prepareWorkflow(state, 'complete');
    const projectId = prepared.project.id;
    const projectRow = runtime.db.get('SELECT revision FROM projects WHERE id=?', [projectId]);
    const generation = await runtime.project.startGeneration(
      projectId,
      {
        mode: 'initial',
        candidate: { nodes: [{ id: 'generated', kind: 'workstream', title: 'Generated' }] },
        expected_revision: projectRow.revision,
        idempotency_key: 'p3-complete-generation-key'
      },
      principal
    );
    await waitForOperation(runtime, generation.operation.operation_id, principal.actorId);
    const pending = runtime.project.listGenerations(projectId, principal)[0];
    assert.equal(pending.phase, 'critic_pending');
    const evaluated = await runtime.project.evaluateCritic(
      pending.id,
      { status: 'passed', issues: [], expected_revision: pending.revision, idempotency_key: 'p3-complete-critic-key' },
      principal
    );
    assert.equal(
      evaluated.generation.revision,
      runtime.db.get('SELECT revision FROM workflow_generations WHERE id=?', [pending.id]).revision
    );
    const applied = await runtime.project.applyProposal(
      evaluated.proposal.id,
      { expected_revision: prepared.workflow.workflow.revision, idempotency_key: 'p3-complete-apply-key' },
      principal
    );
    assert.equal(applied.proposal.status, 'applied');
    await runtime.project.createOutcomeRequirement(
      projectId,
      { requirement_key: 'verification', rubric: { minimum: 1 }, idempotency_key: 'p3-complete-outcome-key' },
      principal
    );

    const mutable = {
      projects: 'project',
      project_intakes: 'project_intake',
      briefs: 'brief',
      repository_connections: 'repository_connection',
      repository_targets: 'repository_target',
      repository_lines: 'repository_line',
      repository_workspaces: 'repository_workspace',
      repository_locks: 'repository_lock',
      workflows: 'workflow',
      workflow_generations: 'workflow_generation',
      workflow_generation_proposals: 'workflow_generation_proposal',
      outcome_requirements: 'outcome_requirement',
      project_memberships: 'project_membership'
    };
    for (const [table, aggregateType] of Object.entries(mutable)) {
      for (const row of runtime.db.query(`SELECT id,revision FROM ${table}`)) {
        const head = runtime.db.get(
          'SELECT current_revision FROM aggregate_heads WHERE aggregate_type=? AND aggregate_id=?',
          [aggregateType, row.id]
        );
        assert.ok(head, `${table}:${row.id} has no aggregate head`);
        assert.equal(Number(head.current_revision), Number(row.revision), `${table}:${row.id} head mismatch`);
      }
    }
    const immutable = {
      brief_revisions: 'brief_revision',
      workflow_revisions: 'workflow_revision',
      workflow_nodes: 'workflow_node',
      node_contracts: 'node_contract',
      workflow_critic_receipts: 'workflow_critic_receipt'
    };
    for (const [table, aggregateType] of Object.entries(immutable)) {
      for (const row of runtime.db.query(`SELECT id FROM ${table}`)) {
        assert.equal(
          runtime.db.get(
            'SELECT current_revision FROM aggregate_heads WHERE aggregate_type=? AND aggregate_id=?',
            [aggregateType, row.id]
          )?.current_revision,
          1,
          `${table}:${row.id} immutable head`
        );
      }
    }
    assert.equal(runtime.db.query('PRAGMA foreign_key_check').length, 0);
    assert.equal(runtime.db.get('SELECT count(*) AS count FROM events').count, runtime.db.get('SELECT count(*) AS count FROM audit_events').count);
  } finally {
    await close(state);
  }
});

test('P3 stale proposal is committed before conflict and retry paths honor supplied revisions', async () => {
  const state = await open();
  try {
    const { runtime, principal } = state;
    const prepared = await prepareWorkflow(state, 'stale');
    const projectId = prepared.project.id;
    const projectRevision = runtime.db.get('SELECT revision FROM projects WHERE id=?', [projectId]).revision;
    const started = await runtime.project.startGeneration(
      projectId,
      { mode: 'initial', expected_revision: projectRevision, idempotency_key: 'p3-stale-generation-key' },
      principal
    );
    await waitForOperation(runtime, started.operation.operation_id, principal.actorId);
    const pending = runtime.project.listGenerations(projectId, principal)[0];
    const rejected = await runtime.project.evaluateCritic(
      pending.id,
      { status: 'rejected', issues: [{ code: 'fixture_reject' }], expected_revision: pending.revision, idempotency_key: 'p3-stale-critic-key' },
      principal
    );
    assert.throws(
      () => runtime.project.retryGeneration(pending.id, { expected_revision: pending.revision - 1, idempotency_key: 'p3-stale-retry-old-key' }, principal),
      (error) => error.code === 'revision_conflict'
    );
    const rejectedRevision = runtime.db.get('SELECT revision FROM workflow_generations WHERE id=?', [pending.id]).revision;
    const retried = await runtime.project.retryGeneration(
      pending.id,
      { expected_revision: rejectedRevision, idempotency_key: 'p3-stale-retry-good-key' },
      principal
    );
    await waitForOperation(runtime, retried.operation.operation_id, principal.actorId);

    const staleState = await prepareWorkflow(state, 'stale-proposal');
    const staleProjectId = staleState.project.id;
    const staleProjectRevision = runtime.db.get('SELECT revision FROM projects WHERE id=?', [staleProjectId]).revision;
    const staleGeneration = await runtime.project.startGeneration(
      staleProjectId,
      { mode: 'initial', expected_revision: staleProjectRevision, idempotency_key: 'p3-stale-proposal-generation-key' },
      principal
    );
    await waitForOperation(runtime, staleGeneration.operation.operation_id, principal.actorId);
    const stalePending = runtime.project.listGenerations(staleProjectId, principal)[0];
    const proposalReceipt = await runtime.project.evaluateCritic(
      stalePending.id,
      { status: 'passed', issues: [], expected_revision: stalePending.revision, idempotency_key: 'p3-stale-proposal-critic-key' },
      principal
    );
    const beforeWorkflowRevision = runtime.db.get('SELECT revision FROM workflows WHERE project_id=?', [staleProjectId]).revision;
    const currentProjectRevision = runtime.db.get('SELECT revision FROM projects WHERE id=?', [staleProjectId]).revision;
    await runtime.project.reviseWorkflow(
      staleProjectId,
      { graph: { nodes: [{ id: 'new', title: 'New' }] }, expected_revision: beforeWorkflowRevision, idempotency_key: 'p3-stale-proposal-revise-key' },
      principal
    );
    await assert.rejects(
      () => runtime.project.applyProposal(
        proposalReceipt.proposal.id,
        { expected_revision: beforeWorkflowRevision + 1, idempotency_key: 'p3-stale-proposal-apply-key' },
        principal
      ),
      (error) => error.code === 'workflow_proposal_stale'
    );
    const stale = runtime.db.get('SELECT status,revision FROM workflow_generation_proposals WHERE id=?', [proposalReceipt.proposal.id]);
    assert.deepEqual(stale, { status: 'stale', revision: 2 });
    assert.equal(
      runtime.db.get("SELECT current_revision FROM aggregate_heads WHERE aggregate_type='workflow_generation_proposal' AND aggregate_id=?", [proposalReceipt.proposal.id]).current_revision,
      2
    );
    assert.equal(runtime.db.get("SELECT status FROM operations WHERE command_id='workflow.proposal.apply' AND status='failed' AND resource_id=?", [proposalReceipt.proposal.id]).status, 'failed');
    assert.equal(currentProjectRevision + 1, runtime.db.get('SELECT revision FROM projects WHERE id=?', [staleProjectId]).revision);
  } finally {
    await close(state);
  }
});

test('P3 domain cancellation propagates to a delayed generator operation', async () => {
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const state = await open({
    generator: async () => {
      entered();
      await releasePromise;
      return { nodes: [] };
    }
  });
  try {
    const { runtime, principal } = state;
    const prepared = await prepareWorkflow(state, 'cancel');
    const projectId = prepared.project.id;
    const generation = await runtime.project.startGeneration(
      projectId,
      { mode: 'initial', expected_revision: runtime.db.get('SELECT revision FROM projects WHERE id=?', [projectId]).revision, idempotency_key: 'p3-cancel-generation-key' },
      principal
    );
    await enteredPromise;
    const current = runtime.project.listGenerations(projectId, principal)[0];
    const cancelled = await runtime.project.cancelGeneration(
      current.id,
      { expected_revision: current.revision, idempotency_key: 'p3-cancel-domain-key' },
      principal
    );
    assert.equal(cancelled.generation.phase, 'cancelled');
    release();
    const operation = await waitForOperation(runtime, generation.operation.operation_id, principal.actorId);
    assert.equal(operation.status, 'cancelled');
    assert.equal(runtime.db.get('SELECT phase FROM workflow_generations WHERE id=?', [current.id]).phase, 'cancelled');
  } finally {
    release();
    await close(state);
  }
});

test('P3 project archive and restore replay exactly one mutation per idempotency key', async () => {
  const state = await open();
  try {
    const { runtime, principal } = state;
    const project = await runtime.project.createProject(
      { name: 'Lifecycle project', idempotency_key: 'p3-project-lifecycle-create-key' },
      principal
    );
    const archiveInput = { expected_revision: 1, idempotency_key: 'p3-project-archive-key' };
    const archived = await runtime.project.archiveProject(project.id, archiveInput, principal);
    const archiveReplay = await runtime.project.archiveProject(project.id, archiveInput, principal);
    assert.equal(archived.project.status, 'archived');
    assert.equal(archiveReplay.replayed, true);
    assert.equal(archiveReplay.operation.operation_id, archived.operation.operation_id);

    const restoreInput = { expected_revision: 2, idempotency_key: 'p3-project-restore-key' };
    const restored = await runtime.project.restoreProject(project.id, restoreInput, principal);
    const restoreReplay = await runtime.project.restoreProject(project.id, restoreInput, principal);
    assert.equal(restored.project.status, 'active');
    assert.equal(restored.project.revision, 3);
    assert.equal(restoreReplay.replayed, true);
    assert.equal(
      runtime.db.get("SELECT count(*) AS count FROM operations WHERE command_id IN ('project.archive','project.restore')").count,
      2
    );
    assert.equal(
      runtime.db.get("SELECT current_revision FROM aggregate_heads WHERE aggregate_type='project' AND aggregate_id=?", [project.id]).current_revision,
      3
    );
  } finally {
    await close(state);
  }
});

test('P3 intake drift is retryable with CAS and cancellation reaches the operation', async () => {
  let probes = 0;
  const expectedSource = { revision: 'expected-r1', hash: 'a'.repeat(64) };
  const state = await open({
    repositoryAdapter: {
      async probe(source) {
        probes += 1;
        if (probes === 1) return { revision: 'observed-r2', hash: 'b'.repeat(64) };
        return { revision: source.revision, hash: source.hash };
      }
    }
  });
  try {
    const { runtime, principal } = state;
    const project = await runtime.project.createProject(
      { name: 'Drift project', idempotency_key: 'p3-intake-drift-project-key' },
      principal
    );
    const submitted = await runtime.project.submitIntake(
      project.id,
      {
        mode: 'existing',
        source: { kind: 'git', locator: 'fixture/drift', ...expectedSource },
        expected_revision: 1,
        idempotency_key: 'p3-intake-drift-submit-key'
      },
      principal
    );
    const failedOperation = await waitForOperation(runtime, submitted.operation.operation_id, principal.actorId);
    assert.equal(failedOperation.status, 'failed');
    const failed = runtime.project.getIntake(project.id, principal);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_code, 'source_drift');
    assert.throws(
      () => runtime.project.retryIntake(project.id, { expected_revision: failed.revision - 1, idempotency_key: 'p3-intake-drift-stale-key' }, principal),
      (error) => error.code === 'revision_conflict'
    );
    const retried = await runtime.project.retryIntake(
      project.id,
      { expected_revision: failed.revision, idempotency_key: 'p3-intake-drift-retry-key' },
      principal
    );
    const succeeded = await waitForOperation(runtime, retried.operation.operation_id, principal.actorId);
    assert.equal(succeeded.status, 'succeeded');
    assert.equal(runtime.project.getIntake(project.id, principal).status, 'ready');
    assert.equal(
      runtime.db.get('SELECT command_id FROM operations WHERE id=?', [retried.operation.operation_id]).command_id,
      'intake.retry'
    );
  } finally {
    await close(state);
  }

  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const cancelState = await open({ repositoryAdapter: { probe: async () => { entered(); await releasePromise; return expectedSource; } } });
  try {
    const { runtime, principal } = cancelState;
    const project = await runtime.project.createProject(
      { name: 'Cancel intake project', idempotency_key: 'p3-intake-cancel-project-key' },
      principal
    );
    const submitted = await runtime.project.submitIntake(
      project.id,
      { mode: 'brainstorm', expected_revision: 1, idempotency_key: 'p3-intake-cancel-submit-key' },
      principal
    );
    await enteredPromise;
    const current = runtime.project.getIntake(project.id, principal);
    const cancelled = await runtime.project.cancelIntake(
      project.id,
      { expected_revision: current.revision, idempotency_key: 'p3-intake-cancel-domain-key' },
      principal
    );
    assert.equal(cancelled.intake.status, 'cancelled');
    release();
    const operation = await waitForOperation(runtime, submitted.operation.operation_id, principal.actorId);
    assert.equal(operation.status, 'cancelled');
    assert.equal(runtime.project.getIntake(project.id, principal).status, 'cancelled');
  } finally {
    release();
    await close(cancelState);
  }
});

test('P3 repository source, target, line recovery and repeated workspace leases preserve CAS heads', async () => {
  const state = await open();
  try {
    const { runtime, principal } = state;
    const project = await runtime.project.createProject(
      { name: 'Repository lifecycle', idempotency_key: 'p3-repository-project-key' },
      principal
    );
    const connection = await runtime.project.createRepositoryConnection(
      project.id,
      {
        provider: 'fixture',
        source_kind: 'git',
        source_locator: 'fixture/repository-lifecycle',
        source_revision: 'source-r1',
        source_hash: 'a'.repeat(64),
        idempotency_key: 'p3-repository-connection-key'
      },
      principal
    );
    const updated = await runtime.project.updateRepositoryConnection(
      connection.connection.id,
      {
        source_revision: 'source-r2',
        source_hash: 'b'.repeat(64),
        expected_revision: 1,
        idempotency_key: 'p3-repository-update-key'
      },
      principal
    );
    assert.equal(updated.connection.revision, 2);
    const target = await runtime.project.createRepositoryTarget(
      connection.connection.id,
      { name: 'secondary', branch: 'staging', expected_revision: 2, idempotency_key: 'p3-repository-target-key' },
      principal
    );
    assert.equal(target.target.revision, 1);
    await assert.rejects(
      () => runtime.project.createRepositoryTarget(
        connection.connection.id,
        { name: 'stale', expected_revision: 2, idempotency_key: 'p3-repository-target-stale-key' },
        principal
      ),
      (error) => error.code === 'revision_conflict'
    );
    assert.equal(
      runtime.db.get("SELECT current_revision FROM aggregate_heads WHERE aggregate_type='repository_connection' AND aggregate_id=?", [connection.connection.id]).current_revision,
      3
    );

    const line = runtime.project.listRepositoryLines(project.id, principal)[0];
    const drifted = await runtime.project.reconcileRepositoryLine(
      line.id,
      { source_revision: 'source-r2', source_hash: 'b'.repeat(64), expected_revision: 1, idempotency_key: 'p3-repository-line-drift-key' },
      principal
    );
    assert.equal(drifted.source_drift, true);
    assert.equal(drifted.line.status, 'faulted');
    const recovered = await runtime.project.reconcileRepositoryLine(
      line.id,
      { source_revision: 'source-r2', source_hash: 'b'.repeat(64), expected_revision: 2, idempotency_key: 'p3-repository-line-recover-key' },
      principal
    );
    assert.equal(recovered.source_drift, false);
    assert.equal(recovered.line.status, 'ready');

    const createdWorkspace = await runtime.project.createRepositoryWorkspace(
      project.id,
      { line_id: line.id, expected_revision: 0, idempotency_key: 'p3-repository-workspace-key' },
      principal
    );
    const workspaceId = createdWorkspace.workspace.id;
    const refreshed = await runtime.project.refreshRepositoryWorkspace(
      workspaceId,
      { expected_revision: 1, idempotency_key: 'p3-repository-refresh-key' },
      principal
    );
    const firstLock = await runtime.project.lockRepositoryWorkspace(
      workspaceId,
      { expected_revision: refreshed.workspace.revision, idempotency_key: 'p3-repository-first-lock-key' },
      principal
    );
    await assert.rejects(
      () => runtime.project.refreshRepositoryWorkspace(
        workspaceId,
        { expected_revision: firstLock.workspace.revision, idempotency_key: 'p3-repository-locked-refresh-key' },
        principal
      ),
      (error) => error.code === 'state_conflict'
    );
    const firstRelease = await runtime.project.releaseRepositoryWorkspace(
      workspaceId,
      { expected_revision: firstLock.workspace.revision, idempotency_key: 'p3-repository-first-release-key' },
      principal
    );
    const secondLock = await runtime.project.lockRepositoryWorkspace(
      workspaceId,
      { expected_revision: firstRelease.workspace.revision, idempotency_key: 'p3-repository-second-lock-key' },
      principal
    );
    const secondRelease = await runtime.project.releaseRepositoryWorkspace(
      workspaceId,
      { expected_revision: secondLock.workspace.revision, idempotency_key: 'p3-repository-second-release-key' },
      principal
    );
    assert.equal(secondRelease.workspace.status, 'released');
    assert.equal(runtime.db.get("SELECT count(*) AS count FROM repository_locks WHERE workspace_id=? AND status='released'", [workspaceId]).count, 2);
    assert.equal(runtime.db.get("SELECT count(*) AS count FROM repository_locks WHERE workspace_id=? AND status='active'", [workspaceId]).count, 0);
    assert.equal(runtime.db.integrity().semantic.valid, true);
  } finally {
    await close(state);
  }
});

test('P3 generator failures become retryable domain state with explicit lineage', async () => {
  let attempts = 0;
  const state = await open({
    generator: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('fixture generation failed');
        error.code = 'generation_fixture_failed';
        throw error;
      }
      return { nodes: [{ id: 'retry', kind: 'workstream', title: 'Retry' }] };
    }
  });
  try {
    const { runtime, principal } = state;
    const prepared = await prepareWorkflow(state, 'generation-failure');
    const projectRevision = runtime.db.get('SELECT revision FROM projects WHERE id=?', [prepared.project.id]).revision;
    const started = await runtime.project.startGeneration(
      prepared.project.id,
      { mode: 'initial', expected_revision: projectRevision, idempotency_key: 'p3-generation-failure-key' },
      principal
    );
    const failedOperation = await waitForOperation(runtime, started.operation.operation_id, principal.actorId);
    assert.equal(failedOperation.status, 'failed');
    await runtime.db.transactionTail;
    const failed = runtime.project.getGeneration(started.generation.id, principal);
    assert.equal(failed.phase, 'failed');
    assert.equal(failed.error_code, 'generation_fixture_failed');
    const retried = await runtime.project.retryGeneration(
      failed.id,
      { expected_revision: failed.revision, idempotency_key: 'p3-generation-retry-lineage-key' },
      principal
    );
    const succeeded = await waitForOperation(runtime, retried.operation.operation_id, principal.actorId);
    assert.equal(succeeded.status, 'succeeded');
    const retryRow = runtime.project.getGeneration(retried.generation.id, principal);
    assert.equal(retryRow.phase, 'critic_pending');
    assert.equal(retryRow.attempt, 2);
    assert.equal(retryRow.retry_of_generation_id, failed.id);
    assert.equal(runtime.db.integrity().semantic.valid, true);
  } finally {
    await close(state);
  }
});

test('P3 restart resumes a running generation only after recovery settles', async () => {
  const f = fixture();
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const never = new Promise(() => {});
  const first = createCleanRuntime({
    config: f.config,
    targetVersion: 3,
    generator: async () => {
      entered();
      await never;
      return { nodes: [] };
    }
  });
  let second;
  try {
    await first.recovery;
    const setup = await first.identity.setupComplete({ display_name: 'Restart owner', team_name: 'Restart team', idempotency_key: 'p3-restart-setup-key' });
    const principal = first.identity.authenticateProof(setup.session.proof);
    const state = { ...f, runtime: first, principal };
    const prepared = await prepareWorkflow(state, 'restart');
    const projectRevision = first.db.get('SELECT revision FROM projects WHERE id=?', [prepared.project.id]).revision;
    const started = await first.project.startGeneration(
      prepared.project.id,
      { mode: 'initial', expected_revision: projectRevision, idempotency_key: 'p3-restart-generation-key' },
      principal
    );
    await enteredPromise;
    assert.equal(first.db.get('SELECT phase FROM workflow_generations WHERE id=?', [started.generation.id]).phase, 'running');
    first.close();

    second = createCleanRuntime({
      config: f.config,
      targetVersion: 3,
      generator: async () => ({ nodes: [{ id: 'recovered', kind: 'workstream', title: 'Recovered' }] })
    });
    const recovered = await second.recovery;
    assert.equal(recovered[1], 1);
    const principalAfterRestart = second.identity.authenticateProof(setup.session.proof);
    const generation = second.project.getGeneration(started.generation.id, principalAfterRestart);
    assert.equal(generation.phase, 'critic_pending');
    assert.equal(second.operations.get(started.operation.operation_id, { actorId: principalAfterRestart.actorId }).status, 'succeeded');
    assert.equal(second.db.integrity().semantic.valid, true);
  } finally {
    second?.close();
    try { first.close(); } catch { /* already closed */ }
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
