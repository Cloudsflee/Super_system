import assert from 'node:assert/strict';
import test from 'node:test';
import { eventually, fixture, mutate, request } from './helpers.mjs';

test('workflow generation preserves candidate, critic, and node contract persistence', async () => {
  const env = await fixture();
  try {
    const project = await mutate(env.base, '/api/v1/projects', { name: 'Generated workflow' }, 'generation-project');
    const brief = await mutate(env.base, `/api/v1/projects/${project.json.id}/briefs`, { content: { objective: 'Build a deterministic fixture workflow', acceptance: ['tests pass'] } }, 'generation-brief');
    assert.equal(brief.response.status, 201);
    const generated = await mutate(env.base, `/api/v1/projects/${project.json.id}/workflow-generations`, { name: 'Generated fixture' }, 'generation-run');
    assert.equal(generated.response.status, 201);
    assert.equal(generated.json.status, 'completed');
    assert.equal(generated.json.critic.status, 'passed');
    assert.equal(generated.json.candidate.tasks.length, 2);
    assert.equal(generated.json.critic.brief_hash, brief.json.content_hash);

    const workflow = await mutate(env.base, `/api/v1/projects/${project.json.id}/workflows`, { name: 'Persisted workflow', tasks: generated.json.candidate.tasks }, 'generation-workflow');
    assert.equal(workflow.response.status, 201);
    const contracts = await request(env.base, `/api/v1/projects/${project.json.id}/node-contracts?workflow_revision=${workflow.json.revision}`);
    assert.equal(contracts.response.status, 200);
    assert.equal(contracts.json.length, 2);
    assert.deepEqual(contracts.json[0].contract.dependencies, contracts.json[0].node_id === 'analyze' ? [] : ['analyze']);

    const custom = await mutate(env.base, `/api/v1/projects/${project.json.id}/node-contracts`, { workflow_revision: workflow.json.revision, node_id: 'analyze', contract: { acceptance: ['brief hash is pinned'] } }, 'generation-contract-duplicate');
    assert.equal(custom.response.status, 409);
    const missingNode = await mutate(env.base, `/api/v1/projects/${project.json.id}/node-contracts`, { workflow_revision: workflow.json.revision, node_id: 'missing', contract: {} }, 'generation-contract-missing');
    assert.equal(missingNode.response.status, 422);
    const generations = await request(env.base, `/api/v1/projects/${project.json.id}/workflow-generations`);
    assert.equal(generations.json[0].id, generated.json.id);

    const requirement = await mutate(env.base, `/api/v1/projects/${project.json.id}/outcome-requirements`, { workflow_revision: workflow.json.revision, requirement_key: 'tests-pass', rubric: { min_score: 80 } }, 'outcome-requirement');
    assert.equal(requirement.response.status, 201);
    const secondRequirement = await mutate(env.base, `/api/v1/projects/${project.json.id}/outcome-requirements`, { workflow_revision: workflow.json.revision, requirement_key: 'review-ready' }, 'outcome-requirement-second');
    assert.equal(secondRequirement.response.status, 201);
    const execution = await mutate(env.base, `/api/v1/projects/${project.json.id}/executions`, {}, 'outcome-execution');
    assert.equal(execution.response.status, 201);
    const started = await mutate(env.base, `/api/v1/executions/${execution.json.id}/start`, { expected_revision: execution.json.revision }, 'outcome-start');
    assert.equal(started.response.status, 201);
    const final = await eventually(async () => (await request(env.base, `/api/v1/executions/${execution.json.id}`)).json, (value) => value.status === 'completed', 5000);
    assert.equal(final.status, 'completed');
    const evaluated = await mutate(env.base, `/api/v1/executions/${execution.json.id}/outcome/evaluate`, {}, 'outcome-evaluate');
    assert.equal(evaluated.response.status, 201);
    assert.equal(evaluated.json.release_eligible, true);
    assert.equal(evaluated.json.requirements.every((item) => item.evaluation?.status === 'passed'), true);
    const waived = await mutate(env.base, `/api/v1/executions/${execution.json.id}/outcome/waive`, { requirement_id: secondRequirement.json.id, reason: 'Human review accepted the fixture result' }, 'outcome-waive');
    assert.equal(waived.response.status, 201);
    assert.equal(waived.json.requirements.find((item) => item.id === secondRequirement.json.id).waiver.reason, 'Human review accepted the fixture result');

    const noBrief = await mutate(env.base, '/api/v1/projects', { name: 'No brief generation' }, 'generation-no-brief-project');
    const rejected = await mutate(env.base, `/api/v1/projects/${noBrief.json.id}/workflow-generations`, {}, 'generation-no-brief');
    assert.equal(rejected.response.status, 422);
  } finally { await env.close(); }
});
