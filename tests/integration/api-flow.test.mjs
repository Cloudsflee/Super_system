import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { eventually, fixture, mutate, onboardProject, request } from './helpers.mjs';

const execFileAsync = promisify(execFile);

async function readSse(response, count = 1) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream/);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  const deadline = Date.now() + 2_000;
  try {
    while (events.length < count && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SSE read timeout')), remaining))
      ]);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.startsWith(':')) continue;
        const fields = {};
        for (const line of block.split('\n')) {
          const separator = line.indexOf(':');
          if (separator < 0) continue;
          fields[line.slice(0, separator)] = line.slice(separator + 1).trimStart();
        }
        if (!fields.data) continue;
        const data = JSON.parse(fields.data);
        events.push({ fields, data });
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  assert.ok(events.length >= count, `expected ${count} SSE event(s), received ${events.length}`);
  return events;
}

async function initializeGitRepository(directory) {
  if (!fs.existsSync(path.join(directory, '.git'))) {
    await execFileAsync('git', ['init', directory], { windowsHide: true });
    await execFileAsync('git', ['-C', directory, 'config', 'user.email', 'aiws-fixture@example.invalid'], { windowsHide: true });
    await execFileAsync('git', ['-C', directory, 'config', 'user.name', 'AIWS Fixture'], { windowsHide: true });
    fs.writeFileSync(path.join(directory, 'README.md'), '# fixture\n', 'utf8');
    await execFileAsync('git', ['-C', directory, 'add', 'README.md'], { windowsHide: true });
    await execFileAsync('git', ['-C', directory, 'commit', '-m', 'fixture baseline', '--no-gpg-sign'], { windowsHide: true });
  }
  fs.appendFileSync(path.join(directory, 'README.md'), 'changed\n', 'utf8');
}

test('public API completes the project-to-review delivery journey', async () => {
  const env = await fixture();
  try {
    const health = await request(env.base, '/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.json.status, 'alive');
    assert.equal((await request(env.base, '/livez')).response.status, 404);
    const ready = await request(env.base, '/readyz');
    assert.equal(ready.response.status, 200);
    assert.equal(ready.json.status, 'ready');
    assert.equal(ready.json.checks.sqlite.user_version, ready.json.checks.sqlite.migration_version);
    const performance = await request(env.base, '/api/v1/system/performance');
    assert.equal(performance.response.status, 200);
    assert.ok(performance.json.rss_bytes > 0);
    assert.ok(performance.json.event_loop_lag_p95_ms >= 0);
    const missingKey = await request(env.base, '/api/v1/projects', { method: 'POST', body: { name: 'Missing key' } });
    assert.equal(missingKey.response.status, 400);
    assert.equal(missingKey.json.error.code, 'idempotency_required');

    const projectResponse = await mutate(env.base, '/api/v1/projects', { name: 'Integration project', description: 'fixture' }, 'project-create');
    assert.equal(projectResponse.response.status, 201);
    const draftProject = projectResponse.json;
    const replay = await mutate(env.base, '/api/v1/projects', { name: 'Integration project', description: 'fixture' }, 'project-create');
    assert.equal(replay.json.id, draftProject.id);
    const conflictingReplay = await mutate(env.base, '/api/v1/projects', { name: 'Different project' }, 'project-create');
    assert.equal(conflictingReplay.response.status, 409);
    assert.equal(conflictingReplay.json.error.code, 'idempotency_conflict');
    const { project } = await onboardProject(env.base, draftProject, { content: { objective: 'Ship a verified change', acceptance: ['passes'] }, keyPrefix: 'api-flow-onboarding' });
    await mutate(env.base, `/api/v1/projects/${project.id}/workflows`, { tasks: [{ id: 'inspect', title: 'Inspect', level: 1, mode: 'read' }, { id: 'write', title: 'Write', level: 2, deps: ['inspect'], mode: 'write' }] }, 'workflow-create');
    const source = await mutate(env.base, `/api/v1/projects/${project.id}/context/sources`, { kind: 'note', title: 'Signal', content: 'deterministic fixture' }, 'source-create');
    const fts = await request(env.base, `/api/v1/projects/${project.id}/context/sources?q=deterministic`);
    assert.equal(fts.response.status, 200);
    assert.ok(fts.json.some((entry) => entry.id === source.json.id));
    const pack = await mutate(env.base, `/api/v1/projects/${project.id}/context/packs`, { source_ids: [source.json.id] }, 'pack-create');
    assert.match(pack.json.pack_hash, /^[a-f0-9]{64}$/);
    const asset = await mutate(env.base, `/api/v1/projects/${project.id}/assets`, { name: 'report.json', media_type: 'application/json', content: '{"ok":true}' }, 'asset-create');
    const expectedCas = createHash('sha256').update('{"ok":true}').digest('hex');
    assert.equal(asset.json.cas_hash, expectedCas);
    assert.equal(asset.json.version, 1);
    const attachmentBytes = Buffer.from([0, 255, 80, 75, 3, 4]);
    const attachment = await mutate(env.base, `/api/v1/projects/${project.id}/assets`, { name: 'evidence/archive.zip', media_type: 'application/zip', content: attachmentBytes.toString('base64'), encoding: 'base64' }, 'attachment-create');
    assert.equal(attachment.response.status, 201);
    const downloaded = await fetch(`${env.base}/api/v1/assets/${attachment.json.id}/content`);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('content-disposition'), 'attachment; filename="evidence_archive.zip"');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), attachmentBytes);
    const repositoryDirectory = path.join(env.home, 'projects', project.id);
    await initializeGitRepository(repositoryDirectory);
    const diff = await request(env.base, `/api/v1/projects/${project.id}/diff`);
    assert.equal(diff.response.status, 200);
    assert.deepEqual(diff.json.files, ['README.md']);
    assert.match(diff.json.diff, /changed/);
    await execFileAsync('git', ['-C', repositoryDirectory, 'checkout', '--', 'README.md'], { windowsHide: true });
    const executionResponse = await mutate(env.base, `/api/v1/projects/${project.id}/executions`, { context_pack_id: pack.json.id, asset_ids: [asset.json.id] }, 'execution-create');
    assert.equal(executionResponse.response.status, 201);
    const execution = executionResponse.json;
    assert.equal(execution.context_pack_hash, pack.json.pack_hash);
    assert.equal(execution.brief_hash.length, 64);
    const initialEvents = await readSse(await fetch(`${env.base}/api/v1/executions/${execution.id}/events`, { headers: { 'Last-Event-ID': '0' } }));
    const firstEvent = initialEvents[0];
    assert.equal(firstEvent.fields.id, String(firstEvent.data.cursor));
    assert.equal(firstEvent.fields.event, firstEvent.data.type);
    assert.deepEqual(Object.keys(firstEvent.data).sort(), ['created_at', 'cursor', 'data', 'execution_id', 'task_id', 'type']);
    const started = await mutate(env.base, `/api/v1/executions/${execution.id}/start`, { expected_revision: execution.revision }, 'execution-start');
    assert.equal(started.response.status, 201, JSON.stringify(started.json));
    const resumedEvents = await readSse(await fetch(`${env.base}/api/v1/executions/${execution.id}/events`, { headers: { 'Last-Event-ID': String(firstEvent.data.cursor) } }), 1);
    assert.ok(resumedEvents.every(({ data }) => data.cursor > firstEvent.data.cursor));
    const completed = await eventually(async () => (await request(env.base, `/api/v1/executions/${execution.id}`)).json, (value) => value.status === 'completed');
    assert.equal(completed.status, 'completed');
    assert.ok(completed.tasks.every((task) => task.status === 'completed'));
    const review = await mutate(env.base, '/api/v1/reviews', { project_id: project.id, execution_id: execution.id, kind: 'delivery_create', model_status: 'unavailable', suggestion: {} }, 'review-create');
    const decision = await mutate(env.base, `/api/v1/reviews/${review.json.id}/decisions`, { decision: 'approved', note: 'human fixture approval' }, 'review-decision');
    assert.equal(decision.json.decision.decision, 'approved');
    const duplicateDecision = await mutate(env.base, `/api/v1/reviews/${review.json.id}/decisions`, { decision: 'rejected' }, 'review-decision-duplicate');
    assert.equal(duplicateDecision.response.status, 409);
    assert.equal(duplicateDecision.json.error.code, 'immutable_review_decision');
    const missingCreateReview = await mutate(env.base, '/api/v1/deliveries', { project_id: project.id, execution_id: execution.id, title: 'Blocked draft' }, 'delivery-missing-review');
    assert.equal(missingCreateReview.response.status, 409);
    assert.equal(missingCreateReview.json.error.code, 'review_required');
    const delivery = await mutate(env.base, '/api/v1/deliveries', { project_id: project.id, execution_id: execution.id, review_id: review.json.id, title: 'Draft PR' }, 'delivery-create');
    assert.equal(delivery.response.status, 201);
    const missingMergeReview = await mutate(env.base, `/api/v1/deliveries/${delivery.json.id}/merge`, {}, 'delivery-merge-missing-review');
    assert.equal(missingMergeReview.response.status, 409);
    assert.equal(missingMergeReview.json.error.code, 'review_required');
    const mergeReview = await mutate(env.base, '/api/v1/reviews', { project_id: project.id, execution_id: execution.id, kind: 'delivery_merge', model_status: 'invalid', suggestion: { ready: true } }, 'merge-review-create');
    await mutate(env.base, `/api/v1/reviews/${mergeReview.json.id}/decisions`, { decision: 'approved', note: 'separate merge approval' }, 'merge-review-decision');
    const merged = await mutate(env.base, `/api/v1/deliveries/${delivery.json.id}/merge`, { review_id: mergeReview.json.id }, 'delivery-merge');
    assert.equal(merged.response.status, 201);
    assert.equal(merged.json.status, 'merged');
    const mergedReplay = await mutate(env.base, `/api/v1/deliveries/${delivery.json.id}/merge`, { review_id: mergeReview.json.id }, 'delivery-merge');
    assert.equal(mergedReplay.response.status, 201);
    assert.equal(mergedReplay.json.status, 'merged');
    const update = await mutate(env.base, `/api/v1/projects/${project.id}`, { expected_revision: project.revision, name: 'updated' }, 'project-update', 'PATCH');
    assert.equal(update.response.status, 200);
    const conflict = await mutate(env.base, `/api/v1/projects/${project.id}`, { expected_revision: project.revision, name: 'stale' }, 'project-update-stale', 'PATCH');
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.json.error.code, 'revision_conflict');
    const projectAudit = (await request(env.base, '/api/v1/audit?limit=300')).json.filter((event) => event.action === 'project.updated' && event.entity_id === project.id);
    assert.equal(projectAudit.length, 1);
  } finally { await env.close(); }
});
