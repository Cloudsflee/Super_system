import assert from 'node:assert/strict';
import test from 'node:test';
import { eventually, fixture, mutate, request } from './helpers.mjs';

test('public API completes the project-to-review delivery journey', async () => {
  const env = await fixture();
  try {
    const ready = await request(env.base, '/readyz');
    assert.equal(ready.response.status, 200);
    assert.equal(ready.json.status, 'ready');
    const performance = await request(env.base, '/api/v1/system/performance');
    assert.equal(performance.response.status, 200);
    assert.ok(performance.json.rss_bytes > 0);
    assert.ok(performance.json.event_loop_lag_p95_ms >= 0);
    const missingKey = await request(env.base, '/api/v1/projects', { method: 'POST', body: { name: 'Missing key' } });
    assert.equal(missingKey.response.status, 400);
    assert.equal(missingKey.json.error.code, 'idempotency_required');

    const projectResponse = await mutate(env.base, '/api/v1/projects', { name: 'Integration project', description: 'fixture' }, 'project-create');
    assert.equal(projectResponse.response.status, 201);
    const project = projectResponse.json;
    const replay = await mutate(env.base, '/api/v1/projects', { name: 'Integration project', description: 'fixture' }, 'project-create');
    assert.equal(replay.json.id, project.id);
    await mutate(env.base, `/api/v1/projects/${project.id}/briefs`, { content: { objective: 'Ship a verified change', acceptance: ['passes'] } }, 'brief-create');
    await mutate(env.base, `/api/v1/projects/${project.id}/workflows`, { tasks: [{ id: 'inspect', title: 'Inspect', level: 1, mode: 'read' }, { id: 'write', title: 'Write', level: 2, deps: ['inspect'], mode: 'write' }] }, 'workflow-create');
    const source = await mutate(env.base, `/api/v1/projects/${project.id}/context/sources`, { kind: 'note', title: 'Signal', content: 'deterministic fixture' }, 'source-create');
    const pack = await mutate(env.base, `/api/v1/projects/${project.id}/context/packs`, { source_ids: [source.json.id] }, 'pack-create');
    const asset = await mutate(env.base, `/api/v1/projects/${project.id}/assets`, { name: 'report.json', media_type: 'application/json', content: '{"ok":true}' }, 'asset-create');
    const attachmentBytes = Buffer.from([0, 255, 80, 75, 3, 4]);
    const attachment = await mutate(env.base, `/api/v1/projects/${project.id}/assets`, { name: 'evidence/archive.zip', media_type: 'application/zip', content: attachmentBytes.toString('base64'), encoding: 'base64' }, 'attachment-create');
    assert.equal(attachment.response.status, 201);
    const downloaded = await fetch(`${env.base}/api/v1/assets/${attachment.json.id}/content`);
    assert.equal(downloaded.headers.get('content-disposition'), 'attachment; filename="evidence_archive.zip"');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), attachmentBytes);
    const executionResponse = await mutate(env.base, `/api/v1/projects/${project.id}/executions`, { context_pack_id: pack.json.id, asset_ids: [asset.json.id] }, 'execution-create');
    assert.equal(executionResponse.response.status, 201);
    const execution = executionResponse.json;
    const eventsResponse = await fetch(`${env.base}/api/v1/executions/${execution.id}/events`, { headers: { 'Last-Event-ID': '0' }, signal: AbortSignal.timeout(800) }).catch((error) => error);
    assert.ok(eventsResponse instanceof Response || eventsResponse.name === 'TimeoutError');
    const started = await mutate(env.base, `/api/v1/executions/${execution.id}/start`, { expected_revision: execution.revision }, 'execution-start');
    assert.equal(started.response.status, 201);
    const completed = await eventually(async () => (await request(env.base, `/api/v1/executions/${execution.id}`)).json, (value) => value.status === 'completed');
    assert.equal(completed.status, 'completed');
    assert.ok(completed.tasks.every((task) => task.status === 'completed'));
    const review = await mutate(env.base, '/api/v1/reviews', { project_id: project.id, execution_id: execution.id, kind: 'delivery_create', model_status: 'unavailable', suggestion: {} }, 'review-create');
    const decision = await mutate(env.base, `/api/v1/reviews/${review.json.id}/decisions`, { decision: 'approved', note: 'human fixture approval' }, 'review-decision');
    assert.equal(decision.json.decision.decision, 'approved');
    const delivery = await mutate(env.base, '/api/v1/deliveries', { project_id: project.id, execution_id: execution.id, review_id: review.json.id, title: 'Draft PR' }, 'delivery-create');
    assert.equal(delivery.response.status, 201);
    const update = await mutate(env.base, `/api/v1/projects/${project.id}`, { expected_revision: 1, name: 'updated' }, 'project-update', 'PATCH');
    assert.equal(update.response.status, 201);
    const conflict = await mutate(env.base, `/api/v1/projects/${project.id}`, { expected_revision: 1, name: 'stale' }, 'project-update-stale', 'PATCH');
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.json.error.code, 'revision_conflict');
    const projectAudit = (await request(env.base, '/api/v1/audit?limit=300')).json.filter((event) => event.action === 'project.updated' && event.entity_id === project.id);
    assert.equal(projectAudit.length, 1);
  } finally { await env.close(); }
});
