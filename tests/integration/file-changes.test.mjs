import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, mutate, request } from './helpers.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

test('file workspace change batches apply, protect stale edits, and undo with a checkpoint', async () => {
  const env = await fixture();
  try {
    const project = await mutate(env.base, '/api/v1/projects', { name: 'File change fixture', repository: { source: { kind: 'fixture', id: 'designsignal-v1' } } }, 'file-project');
    const session = await mutate(env.base, '/api/v1/assist/sessions', { project_id: project.json.id, scope: 'project', scope_id: project.json.id }, 'file-session');
    const initial = await request(env.base, `/api/v1/projects/${project.json.id}/files?path=README.md`);
    assert.equal(initial.response.status, 200);
    const original = initial.json.content;
    const updated = `${original}\n\nChange batch fixture.\n`;
    const batch = await mutate(env.base, `/api/v1/projects/${project.json.id}/change-batches`, {
      session_id: session.json.id,
      changes: [{ path: 'README.md', operation: 'update', expected_sha256: initial.json.sha256, content: updated }]
    }, 'file-batch');
    assert.equal(batch.response.status, 201);
    assert.equal(batch.json.status, 'proposed');
    assert.equal(batch.json.file_changes[0].before_sha256, initial.json.sha256);

    const applied = await mutate(env.base, `/api/v1/change-batches/${batch.json.id}/apply`, {}, 'file-batch-apply');
    assert.equal(applied.response.status, 201);
    assert.equal(applied.json.status, 'applied');
    const afterApply = await request(env.base, `/api/v1/projects/${project.json.id}/files?path=README.md`);
    assert.equal(afterApply.json.content, updated);
    assert.equal(afterApply.json.sha256, digest(updated));

    const rolledBack = await mutate(env.base, `/api/v1/change-batches/${batch.json.id}/rollback`, {}, 'file-batch-rollback');
    assert.equal(rolledBack.response.status, 201);
    assert.equal(rolledBack.json.status, 'rolled_back');
    const afterUndo = await request(env.base, `/api/v1/projects/${project.json.id}/files?path=README.md`);
    assert.equal(afterUndo.json.content, original);
    assert.equal(afterUndo.json.sha256, initial.json.sha256);

    const stale = await mutate(env.base, `/api/v1/projects/${project.json.id}/change-batches`, {
      session_id: session.json.id,
      changes: [{ path: 'README.md', operation: 'update', expected_sha256: initial.json.sha256, content: `${original}\nexternal\n` }]
    }, 'file-batch-stale');
    assert.equal(stale.response.status, 201);
    fs.appendFileSync(path.join(env.home, 'projects', project.json.id, 'README.md'), 'outside\n');
    const staleApply = await mutate(env.base, `/api/v1/change-batches/${stale.json.id}/apply`, {}, 'file-batch-stale-apply');
    assert.equal(staleApply.response.status, 409);
    assert.equal(staleApply.json.error.code, 'change_batch_stale');
    const staleView = await request(env.base, `/api/v1/change-batches/${stale.json.id}`);
    assert.equal(staleView.json.status, 'stale');
  } finally { await env.close(); }
});
