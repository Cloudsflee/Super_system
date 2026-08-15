import assert from 'node:assert/strict';
import test from 'node:test';
import { criticIssues, validateWorkflowCandidate } from '../../apps/api/src/modules/workflow/validator.mjs';
import { eventually, fixture, mutate, onboardProject, request } from './helpers.mjs';

async function readyProject(env, suffix, content = { objective: 'Generate and apply a durable workflow', acceptance: ['tests pass'] }) {
  const project = await mutate(env.base, '/api/v1/projects', { name: `R4 workflow ${suffix}` }, `r4-${suffix}-project`);
  await onboardProject(env.base, project, {
    content,
    keyPrefix: `r4-${suffix}-onboard`
  });
  return project.json.id;
}

async function generation(env, projectId, suffix, input = {}) {
  const started = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-generations`, { provider: 'fixture', async: true, ...input }, `r4-${suffix}-generate`);
  assert.equal(started.response.status, 202);
  assert.match(started.json.operation_id, /^op_/);
  const current = await eventually(
    async () => (await request(env.base, `/api/v1/workflow-generations/${started.json.generation_id}`)).json,
    (value) => ['completed', 'rejected', 'failed', 'cancelled'].includes(value.phase),
    5000
  );
  return { started, current };
}

function contractCandidate() {
  return {
    name: 'Contract matrix',
    workstreams: [{
      id: 'delivery',
      tasks: [
        { id: 'prepare', goal: 'Prepare', outputs: ['artifacts/prepare.json'], acceptance: ['prepared'] },
        { id: 'publish', goal: 'Publish', deps: ['prepare'], outputs: ['artifacts/publish.json'], acceptance: ['published'] }
      ]
    }]
  };
}

function expectWorkflowCode(candidate, code) {
  assert.throws(() => validateWorkflowCandidate(candidate), (error) => error.code === code);
}

test('R4 provider contract accepts compatibility aliases and canonical slot references', () => {
  const compatibility = validateWorkflowCandidate({
    name: 'Compatibility workflow',
    tasks: [{
      title: 'Compatibility task',
      objective: 'Deliver compatibility output',
      dependencies: [],
      inputs_paths: ['inputs\\spec.json'],
      outputs_paths: ['artifacts\\compatibility.json'],
      tools: ['git'],
      acceptance_criteria: ['output exists']
    }]
  });
  assert.equal(compatibility.workstreams[0].id, 'workstream_1');
  assert.equal(compatibility.tasks[0].id, 'task_1');
  assert.equal(compatibility.tasks[0].inputs[0], 'inputs/spec.json');
  assert.equal(compatibility.tasks[0].outputs[0], 'artifacts/compatibility.json');

  const slotted = validateWorkflowCandidate({
    workstreams: [
      {
        id: 'source_stream', name: 'Source', objective: 'Collect source',
        tasks: [{
          id: 'source', title: 'Source', outputs: ['artifacts/source.json'], acceptance: ['source ready'],
          output_slots: [{ id: 'artifact', type: 'any', path: 'artifacts/source.json', required: false, acceptance: ['valid'] }]
        }]
      },
      {
        id: 'delivery_stream', name: 'Delivery', dependencies: ['source_stream'],
        tasks: [{
          id: 'consume', objective: 'Consume source', dependencies: ['source'], mode: 'write', tools: ['git'], acceptance_criteria: ['delivered'],
          inputs: [
            { id: 'by_name', type: 'json', targetOutput: 'artifact', acceptance: ['present'] },
            { id: 'by_path', type: 'any', target_output: 'artifacts/source.json', acceptance: ['present'] },
            { id: 'by_dot', target_output: 'source.artifact', acceptance: ['present'] },
            { id: 'by_colon', target_output: 'source:artifact', selector: 'artifacts/source.json', acceptance: ['present'] }
          ],
          outputs: [{ id: 'result', type: 'json', target: 'artifacts/result.json', required: false, acceptance: ['valid'] }]
        }]
      }
    ]
  }, { brief: null });
  assert.equal(slotted.tasks[1].input_slots.length, 4);
  assert.equal(slotted.tasks[1].input_slots[0].required, true);
  assert.equal(slotted.tasks[1].output_slots[0].required, false);
  assert.equal(slotted.tasks[1].mode, 'write');
  assert.deepEqual(criticIssues(slotted), []);
  assert.deepEqual(criticIssues({ workstreams: [], brief_coverage: { complete: false } }).map((issue) => issue.code), [
    'workflow_depth_invalid', 'workflow_brief_coverage_incomplete'
  ]);
  assert.equal(validateWorkflowCandidate({}, { allowEmpty: true }).tasks.length, 0);
});

test('R4 provider contract reports malformed hierarchy, paths, slots and dependencies', () => {
  expectWorkflowCode(null, 'workflow_depth_invalid');
  expectWorkflowCode({ workstreams: Array.from({ length: 13 }, (_, index) => ({
    id: `stream_${index}`, tasks: [{ id: `task_${index}`, outputs: [`${index}.json`], acceptance: ['done'] }]
  })) }, 'workflow_depth_invalid');

  const duplicateStream = contractCandidate();
  duplicateStream.workstreams.push({ ...structuredClone(duplicateStream.workstreams[0]), tasks: [{ id: 'other', outputs: ['other.json'], acceptance: ['done'] }] });
  expectWorkflowCode(duplicateStream, 'workflow_contract_invalid');
  expectWorkflowCode({ workstreams: [{ id: 'empty', tasks: [] }] }, 'workflow_depth_invalid');
  expectWorkflowCode({ workstreams: [{ id: 'large', tasks: Array.from({ length: 13 }, (_, index) => ({ id: `task_${index}`, outputs: [`${index}.json`], acceptance: ['done'] })) }] }, 'workflow_depth_invalid');

  const invalidWorkstreamId = contractCandidate();
  invalidWorkstreamId.workstreams[0].id = '1-invalid';
  expectWorkflowCode(invalidWorkstreamId, 'workflow_contract_invalid');
  const duplicateTask = contractCandidate();
  duplicateTask.workstreams[0].tasks[1].id = 'prepare';
  expectWorkflowCode(duplicateTask, 'workflow_contract_invalid');

  for (const [value, code] of [
    ['not-an-array', 'workflow_contract_invalid'],
    [[''], 'workflow_contract_invalid'],
    [['../outside.json'], 'workflow_contract_invalid'],
    [['same.json', 'same.json'], 'workflow_duplicate_output']
  ]) {
    const candidate = contractCandidate();
    candidate.workstreams[0].tasks[0].input_paths = value;
    expectWorkflowCode(candidate, code);
  }

  const malformedSlots = [
    { value: 'not-an-array', code: 'workflow_contract_invalid' },
    { value: [{ name: '1-invalid', selector: 'a.json', acceptance: ['ok'] }], code: 'workflow_contract_invalid' },
    { value: [{ name: 'same', selector: 'a.json', acceptance: ['ok'] }, { name: 'same', selector: 'b.json', acceptance: ['ok'] }], code: 'workflow_contract_invalid' },
    { value: [{ name: 'a', type: 'binary', selector: 'a.json', acceptance: ['ok'] }], code: 'workflow_contract_invalid' },
    { value: [{ name: 'a', selector: '../a.json', acceptance: ['ok'] }], code: 'workflow_contract_invalid' },
    { value: [{ name: 'a', selector: 'a.json', acceptance: ['ok'] }, { name: 'b', selector: 'a.json', acceptance: ['ok'] }], code: 'workflow_duplicate_output' },
    { value: [{ name: 'a', selector: 'a.json' }], code: 'workflow_contract_invalid' }
  ];
  for (const entry of malformedSlots) {
    const candidate = contractCandidate();
    candidate.workstreams[0].tasks[0].output_slots = entry.value;
    delete candidate.workstreams[0].tasks[0].outputs;
    expectWorkflowCode(candidate, entry.code);
  }

  const missingInputSource = contractCandidate();
  missingInputSource.workstreams[0].tasks[1].input_slots = [{ name: 'input', acceptance: ['present'] }];
  expectWorkflowCode(missingInputSource, 'workflow_contract_invalid');
  const missingOutput = contractCandidate();
  delete missingOutput.workstreams[0].tasks[0].outputs;
  expectWorkflowCode(missingOutput, 'workflow_contract_invalid');
  const missingNodeAcceptance = contractCandidate();
  missingNodeAcceptance.workstreams[0].tasks[0].acceptance = [];
  expectWorkflowCode(missingNodeAcceptance, 'workflow_contract_invalid');

  const unknownWorkstream = contractCandidate();
  unknownWorkstream.workstreams[0].deps = ['missing'];
  expectWorkflowCode(unknownWorkstream, 'workflow_dependency_scope_invalid');
  const selfWorkstream = contractCandidate();
  selfWorkstream.workstreams[0].deps = ['delivery'];
  expectWorkflowCode(selfWorkstream, 'workflow_dependency_scope_invalid');
  const unknownTask = contractCandidate();
  unknownTask.workstreams[0].tasks[1].deps = ['missing'];
  expectWorkflowCode(unknownTask, 'workflow_dependency_scope_invalid');
  const selfTask = contractCandidate();
  selfTask.workstreams[0].tasks[0].deps = ['prepare'];
  expectWorkflowCode(selfTask, 'workflow_dependency_scope_invalid');
  const cycle = contractCandidate();
  cycle.workstreams[0].tasks[0].deps = ['publish'];
  expectWorkflowCode(cycle, 'workflow_graph_cycle');

  const duplicateOutput = contractCandidate();
  duplicateOutput.workstreams[0].tasks[1].outputs = ['artifacts/prepare.json'];
  expectWorkflowCode(duplicateOutput, 'workflow_duplicate_output');
  const prefixOutput = contractCandidate();
  prefixOutput.workstreams[0].tasks[1].outputs = ['artifacts/prepare.json/report.json'];
  expectWorkflowCode(prefixOutput, 'workflow_output_path_conflict');

  const slotMismatch = contractCandidate();
  slotMismatch.workstreams[0].tasks[0].output_slots = [{ name: 'prepared', type: 'json', selector: 'artifacts/prepare.json', acceptance: ['valid'] }];
  slotMismatch.workstreams[0].tasks[1].input_slots = [{ name: 'prepared', type: 'text', selector: 'other.json', target_output: 'prepare.prepared', acceptance: ['present'] }];
  expectWorkflowCode(slotMismatch, 'workflow_contract_invalid');
  slotMismatch.workstreams[0].tasks[1].input_slots[0].type = 'json';
  expectWorkflowCode(slotMismatch, 'workflow_contract_invalid');
  slotMismatch.workstreams[0].tasks[1].input_slots[0].selector = 'artifacts/prepare.json';
  slotMismatch.workstreams[0].tasks[1].input_slots[0].target_output = 'prepare.missing';
  expectWorkflowCode(slotMismatch, 'workflow_contract_invalid');
});

test('R4 generates, critiques, replays events and idempotently applies a proposal', async () => {
  const env = await fixture();
  try {
    const projectId = await readyProject(env, 'success');
    const draft = await request(env.base, `/api/v1/projects/${projectId}/workflow-draft`);
    assert.equal(draft.response.status, 200);
    assert.equal(draft.json.hierarchy_mode, 'two_level');
    const layout = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-draft/layouts`, {
      draft_revision: draft.json.revision,
      nodes: [{ id: 'inspect', position: { x: 40, y: 80 } }],
      viewport: { x: 0, y: 0, zoom: 1 }
    }, 'r4-success-layout');
    assert.equal(layout.response.status, 201);
    assert.equal(layout.json.revision, 1);

    const { started, current } = await generation(env, projectId, 'success');
    assert.equal(current.phase, 'completed');
    assert.equal(current.critic.status, 'passed');
    assert.match(current.proposal.proposal_hash, /^[a-f0-9]{64}$/);
    const events = await request(env.base, `/api/v1/workflow-generations/${current.id}/events`);
    assert.deepEqual(events.json.map((event) => event.type).slice(0, 4), [
      'workflow.generation.queued', 'workflow.generation.running',
      'workflow.generation.critic_pending', 'workflow.generation.passed'
    ]);
    assert.equal(events.json.every((event) => !JSON.stringify(event).includes('tests pass')), true);
    const operation = await request(env.base, `/api/v1/operations/${started.json.operation_id}`);
    assert.equal(operation.json.status, 'completed');

    const applied = await mutate(env.base, `/api/v1/workflow-proposals/${current.proposal.id}/apply`, { async: true }, 'r4-success-apply');
    assert.equal(applied.response.status, 202);
    const appliedOperation = await eventually(async () => (await request(env.base, `/api/v1/operations/${applied.json.operation_id}`)).json, (value) => ['completed', 'failed'].includes(value.status), 5000);
    assert.equal(appliedOperation.status, 'completed');
    const appliedResult = appliedOperation.result;
    const repeated = await mutate(env.base, `/api/v1/workflow-proposals/${current.proposal.id}/apply`, { async: true }, 'r4-success-apply-repeat');
    assert.equal(repeated.json.workflow_revision || repeated.json.result?.workflow_revision, appliedResult.workflow_revision);
    const workflows = await request(env.base, `/api/v1/projects/${projectId}/workflows`);
    assert.equal(workflows.json[0].hierarchy_mode, 'two_level');
    const contracts = await request(env.base, `/api/v1/projects/${projectId}/node-contracts?workflow_revision=${appliedResult.workflow_revision}`);
    assert.equal(contracts.json.length, 2);
  } finally { await env.close(); }
});

test('R4 marks stale proposals and retries provider failures as a new attempt', async () => {
  const env = await fixture();
  try {
    const projectId = await readyProject(env, 'conflict');
    const { current } = await generation(env, projectId, 'conflict');
    const draft = await request(env.base, `/api/v1/projects/${projectId}/workflow-draft`);
    const graph = current.proposal.candidate;
    const edited = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-draft`, { expected_revision: draft.json.revision, graph }, 'r4-conflict-edit', 'PATCH');
    assert.equal(edited.response.status, 201);
    const stale = await mutate(env.base, `/api/v1/workflow-proposals/${current.proposal.id}/apply`, {}, 'r4-conflict-apply');
    assert.equal(stale.response.status, 409);
    assert.equal(stale.json.error.code, 'workflow_proposal_stale');

    const failed = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-generations`, { provider: 'unavailable', async: true }, 'r4-failure-generate');
    const failedCurrent = await eventually(async () => (await request(env.base, `/api/v1/workflow-generations/${failed.json.generation_id}`)).json, (value) => value.phase === 'failed', 5000);
    assert.equal(failedCurrent.error_code, 'workflow_generator_unavailable');
    const retried = await mutate(env.base, `/api/v1/workflow-generations/${failedCurrent.id}/retry`, { provider: 'fixture' }, 'r4-failure-retry');
    assert.equal(retried.response.status, 202);
    assert.notEqual(retried.json.generation_id, failedCurrent.id);
  } finally { await env.close(); }
});

test('R4 records an independent critic rejection without exposing the brief payload', async () => {
  const env = await fixture();
  try {
    const projectId = await readyProject(env, 'critic-rejection', { objective: 'Critic fixture', feature: 'feature-that-is-not-in-candidate', acceptance: ['tests pass'] });
    const started = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-generations`, { provider: 'fixture', async: true }, 'r4-critic-reject-generate');
    assert.equal(started.response.status, 202);
    const current = await eventually(async () => (await request(env.base, `/api/v1/workflow-generations/${started.json.generation_id}`)).json, (value) => ['completed', 'rejected', 'failed', 'cancelled'].includes(value.phase), 5000);
    assert.equal(current.phase, 'rejected');
    assert.equal(current.error_code, 'workflow_generation_critic_rejected');
    assert.equal(current.critic.status, 'rejected');
    assert.equal(current.proposal, undefined);
    const events = await request(env.base, `/api/v1/workflow-generations/${current.id}/events`);
    assert.equal(events.json.every((event) => !JSON.stringify(event).includes('feature-that-is-not-in-candidate')), true);
    const operation = await eventually(async () => (await request(env.base, `/api/v1/operations/${started.json.operation_id}`)).json, (value) => ['completed', 'failed'].includes(value.status), 5000);
    assert.equal(operation.status, 'completed');
  } finally { await env.close(); }
});

test('R4 cancels a running generation and retries as a new attempt', async () => {
  const env = await fixture();
  try {
    const projectId = await readyProject(env, 'cancel-retry');
    const started = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-generations`, { provider: 'fixture', fixture_delay_ms: 900, async: true }, 'r4-cancel-generate');
    assert.equal(started.response.status, 202);
    const operation = await request(env.base, `/api/v1/operations/${started.json.operation_id}`);
    const cancelled = await mutate(env.base, `/api/v1/workflow-generations/${started.json.generation_id}/cancel`, { expected_revision: operation.json.revision }, 'r4-cancel-action');
    assert.equal(cancelled.response.status, 202);
    assert.equal(cancelled.json.operation_id, started.json.operation_id);
    const stopped = await eventually(async () => (await request(env.base, `/api/v1/workflow-generations/${started.json.generation_id}`)).json, (value) => value.phase === 'cancelled', 5000);
    const retried = await mutate(env.base, `/api/v1/workflow-generations/${stopped.id}/retry`, { provider: 'fixture', async: true }, 'r4-cancel-retry');
    assert.equal(retried.response.status, 202);
    assert.notEqual(retried.json.generation_id, stopped.id);
    const completed = await eventually(async () => (await request(env.base, `/api/v1/workflow-generations/${retried.json.generation_id}`)).json, (value) => ['completed', 'failed', 'rejected', 'cancelled'].includes(value.phase), 5000);
    assert.equal(completed.phase, 'completed');
    assert.equal(completed.attempt, 2);
    assert.equal(completed.retry_of_generation_id, stopped.id);
  } finally { await env.close(); }
});

test('R4 concurrent proposal apply returns one stable operation and contract history is immutable', async () => {
  const env = await fixture();
  try {
    const projectId = await readyProject(env, 'apply-race');
    const { current } = await generation(env, projectId, 'apply-race');
    const [first, second] = await Promise.all([
      mutate(env.base, `/api/v1/workflow-proposals/${current.proposal.id}/apply`, { async: true }, 'r4-race-apply-a'),
      mutate(env.base, `/api/v1/workflow-proposals/${current.proposal.id}/apply`, { async: true }, 'r4-race-apply-b')
    ]);
    assert.equal(first.response.status, 202);
    assert.equal(second.response.status, 202);
    assert.equal(first.json.operation_id, second.json.operation_id);
    const operation = await eventually(async () => (await request(env.base, `/api/v1/operations/${first.json.operation_id}`)).json, (value) => ['completed', 'failed'].includes(value.status), 5000);
    assert.equal(operation.status, 'completed');
    const contracts = await request(env.base, `/api/v1/projects/${projectId}/node-contracts?workflow_revision=${operation.result.workflow_revision}`);
    assert.equal(contracts.json.every((row) => !Object.hasOwn(row, 'contract_json')), true);
    const firstContract = contracts.json[0];
    const updated = await mutate(env.base, `/api/v1/projects/${projectId}/node-contracts/${firstContract.id}`, { expected_revision: firstContract.revision, contract: { ...firstContract.contract, note: 'updated' } }, 'r4-contract-update', 'PATCH');
    assert.equal(updated.response.status, 200);
    assert.equal(updated.json.revision, firstContract.revision + 1);
    const stale = await mutate(env.base, `/api/v1/projects/${projectId}/node-contracts/${firstContract.id}`, { expected_revision: firstContract.revision, contract: {} }, 'r4-contract-stale', 'PATCH');
    assert.equal(stale.response.status, 409);
    assert.equal(stale.json.error.code, 'revision_conflict');
    await assert.rejects(() => env.app.database.run('UPDATE node_contract_revisions SET contract_hash=? WHERE project_id=? AND workflow_revision=? AND node_id=? AND revision=?', ['0'.repeat(64), projectId, operation.result.workflow_revision, firstContract.node_id, firstContract.revision]), /immutable_record/);
  } finally { await env.close(); }
});

test('R4 replan snapshots the current head and preserves completed node definitions', async () => {
  const env = await fixture();
  try {
    const projectId = await readyProject(env, 'replan');
    const initial = await generation(env, projectId, 'replan-initial');
    const applied = await mutate(env.base, `/api/v1/workflow-proposals/${initial.current.proposal.id}/apply`, { async: true }, 'r4-replan-initial-apply');
    const appliedOperation = await eventually(async () => (await request(env.base, `/api/v1/operations/${applied.json.operation_id}`)).json, (value) => value.status === 'completed', 5000);
    const execution = await mutate(env.base, `/api/v1/projects/${projectId}/executions`, {}, 'r4-replan-execution');
    assert.equal(execution.response.status, 201);
    await env.app.database.run("UPDATE task_attempts SET status='completed',finished_at=? WHERE execution_id=? AND task_id='inspect'", [new Date().toISOString(), execution.json.id]);
    const replanned = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-generations/replan`, { provider: 'fixture', async: true }, 'r4-replan-generate');
    assert.equal(replanned.response.status, 202);
    const generationState = await eventually(async () => (await request(env.base, `/api/v1/workflow-generations/${replanned.json.generation_id}`)).json, (value) => ['completed', 'rejected', 'failed', 'cancelled'].includes(value.phase), 5000);
    assert.equal(generationState.phase, 'completed');
    const appliedReplan = await mutate(env.base, `/api/v1/workflow-proposals/${generationState.proposal.id}/apply`, { async: true }, 'r4-replan-apply');
    const replanOperation = await eventually(async () => (await request(env.base, `/api/v1/operations/${appliedReplan.json.operation_id}`)).json, (value) => ['completed', 'failed'].includes(value.status), 5000);
    assert.equal(replanOperation.status, 'completed');
    const next = await request(env.base, `/api/v1/projects/${projectId}/workflows`);
    assert.equal(next.json[0].revision, appliedOperation.result.workflow_revision + 1);
    const inspect = next.json[0].tasks.find((task) => task.id === 'inspect');
    assert.equal(inspect.goal, 'Generate and apply a durable workflow');
  } finally { await env.close(); }
});

test('R4 restart recovery reconciles terminal resources and reports interrupted operations', async () => {
  const env = await fixture();
  try {
    const projectId = await readyProject(env, 'restart');
    const { current } = await generation(env, projectId, 'restart-generation');
    const terminal = await env.app.domain.operationService.create({ kind: 'workflow.generate', resourceType: 'workflow_generation', resourceId: current.id });
    const missing = await env.app.domain.operationService.create({ kind: 'workflow.generate', resourceType: 'workflow_generation', resourceId: 'wgen_missing_after_restart' });
    await env.app.domain.recover();
    const terminalState = await env.app.domain.operationService.get(terminal.operation_id);
    const missingState = await env.app.domain.operationService.get(missing.operation_id);
    assert.equal(terminalState.status, 'completed');
    assert.equal(missingState.status, 'failed');
    assert.equal(missingState.error_code, 'operation_interrupted');
    const secretInput = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-generations`, { provider: 'fixture', async: true, prompt: 'prompt-secret-fixture' }, 'r4-redaction-generation');
    const redacted = await eventually(async () => (await request(env.base, `/api/v1/workflow-generations/${secretInput.json.generation_id}`)).json, (value) => ['completed', 'failed', 'rejected', 'cancelled'].includes(value.phase), 5000);
    const events = await request(env.base, `/api/v1/workflow-generations/${redacted.id}/events`);
    assert.equal(JSON.stringify(events.json).includes('prompt-secret-fixture'), false);
    const stream = await fetch(`${env.base}/api/v1/workflow-generations/${redacted.id}/events`, { headers: { accept: 'text/event-stream' } });
    assert.equal((await stream.text()).includes('prompt-secret-fixture'), false);
  } finally { await env.close(); }
});

test('R4 serializes concurrent Draft and Layout mutations', async () => {
  const env = await fixture();
  try {
    const projectId = await readyProject(env, 'mutation-race');
    const draft = (await request(env.base, `/api/v1/projects/${projectId}/workflow-draft`)).json;
    const graphA = {
      name: 'Race A',
      workstreams: [{ id: 'delivery', tasks: [{ id: 'task_a', goal: 'Task A', outputs: ['a.json'], acceptance: ['done'] }] }]
    };
    const graphB = {
      name: 'Race B',
      workstreams: [{ id: 'delivery', tasks: [{ id: 'task_b', goal: 'Task B', outputs: ['b.json'], acceptance: ['done'] }] }]
    };
    const draftWrites = await Promise.all([
      mutate(env.base, `/api/v1/projects/${projectId}/workflow-draft`, { expected_revision: draft.revision, graph: graphA }, 'r4-draft-race-a', 'PATCH'),
      mutate(env.base, `/api/v1/projects/${projectId}/workflow-draft`, { expected_revision: draft.revision, graph: graphB }, 'r4-draft-race-b', 'PATCH')
    ]);
    assert.deepEqual(draftWrites.map((item) => item.response.status).toSorted(), [201, 409]);
    assert.equal(draftWrites.find((item) => item.response.status === 409).json.error.code, 'workflow_draft_revision_conflict');

    const latest = (await request(env.base, `/api/v1/projects/${projectId}/workflow-draft`)).json;
    const layoutWrites = await Promise.all([
      mutate(env.base, `/api/v1/projects/${projectId}/workflow-draft/layouts`, {
        expected_revision: 0, draft_revision: latest.revision, nodes: [{ id: 'delivery', position: { x: 40, y: 40 } }]
      }, 'r4-layout-race-a'),
      mutate(env.base, `/api/v1/projects/${projectId}/workflow-draft/layouts`, {
        expected_revision: 0, draft_revision: latest.revision, nodes: [{ id: 'delivery', position: { x: 80, y: 80 } }]
      }, 'r4-layout-race-b')
    ]);
    assert.deepEqual(layoutWrites.map((item) => item.response.status).toSorted(), [201, 409]);
    assert.equal(layoutWrites.find((item) => item.response.status === 409).json.error.code, 'revision_conflict');
    const layouts = await request(env.base, `/api/v1/projects/${projectId}/workflow-draft/layouts?draft_id=${latest.id}`);
    assert.equal(layouts.json.length, 1);
  } finally { await env.close(); }
});

test('R4 rejects layout drift and proposal payload tampering', async () => {
  const env = await fixture();
  try {
    const layoutProjectId = await readyProject(env, 'layout-drift');
    const draft = (await request(env.base, `/api/v1/projects/${layoutProjectId}/workflow-draft`)).json;
    await mutate(env.base, `/api/v1/projects/${layoutProjectId}/workflow-draft/layouts`, {
      expected_revision: 0, draft_revision: draft.revision, nodes: [], viewport: { x: 0, y: 0, zoom: 1 }
    }, 'r4-layout-drift-first');
    const generated = await generation(env, layoutProjectId, 'layout-drift');
    await mutate(env.base, `/api/v1/projects/${layoutProjectId}/workflow-draft/layouts`, {
      expected_revision: 1, draft_revision: draft.revision, nodes: [], viewport: { x: 20, y: 20, zoom: 1 }
    }, 'r4-layout-drift-second');
    const staleLayout = await mutate(env.base, `/api/v1/workflow-proposals/${generated.current.proposal.id}/apply`, {}, 'r4-layout-drift-apply');
    assert.equal(staleLayout.response.status, 409);
    assert.equal(staleLayout.json.error.code, 'workflow_proposal_stale');
    assert.equal(staleLayout.json.error.details.current_layout_revision, 2);

    const tamperProjectId = await readyProject(env, 'proposal-tamper');
    const tampered = await generation(env, tamperProjectId, 'proposal-tamper');
    await env.app.database.run('UPDATE workflow_generation_proposals SET candidate_json=? WHERE id=?', [
      JSON.stringify({ ...tampered.current.proposal.candidate, name: 'Tampered candidate' }), tampered.current.proposal.id
    ]);
    const stalePayload = await mutate(env.base, `/api/v1/workflow-proposals/${tampered.current.proposal.id}/apply`, {}, 'r4-proposal-tamper-apply');
    assert.equal(stalePayload.response.status, 409);
    assert.equal(stalePayload.json.error.code, 'workflow_proposal_stale');
  } finally { await env.close(); }
});

test('R4 rejects a replan proposal after the Workflow head advances', async () => {
  const env = await fixture();
  try {
    const projectId = await readyProject(env, 'replan-head-drift');
    const first = await generation(env, projectId, 'replan-head-first');
    const firstApply = await mutate(env.base, `/api/v1/workflow-proposals/${first.current.proposal.id}/apply`, { async: true }, 'r4-replan-head-first-apply');
    await eventually(async () => (await request(env.base, `/api/v1/operations/${firstApply.json.operation_id}`)).json, (value) => value.status === 'completed', 5000);

    const replan = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-generations/replan`, { provider: 'fixture', async: true }, 'r4-replan-head-generate');
    const replanState = await eventually(async () => (await request(env.base, `/api/v1/workflow-generations/${replan.json.generation_id}`)).json, (value) => value.phase === 'completed', 5000);
    const replacement = await generation(env, projectId, 'replan-head-replacement');
    const replacementApply = await mutate(env.base, `/api/v1/workflow-proposals/${replacement.current.proposal.id}/apply`, { async: true }, 'r4-replan-head-replacement-apply');
    await eventually(async () => (await request(env.base, `/api/v1/operations/${replacementApply.json.operation_id}`)).json, (value) => value.status === 'completed', 5000);

    const stale = await mutate(env.base, `/api/v1/workflow-proposals/${replanState.proposal.id}/apply`, {}, 'r4-replan-head-stale-apply');
    assert.equal(stale.response.status, 409);
    assert.equal(stale.json.error.code, 'workflow_proposal_stale');
    assert.equal(stale.json.error.details.current_workflow_revision, 2);
  } finally { await env.close(); }
});
