import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { eventually, fixture, mutate, request } from './helpers.mjs';

test('fixture execution isolates a worktree and captures diff, output, and evidence', async () => {
  const env = await fixture();
  try {
    const project = (await mutate(env.base, '/api/v1/projects', {
      name: 'Real slice fixture', repository: { source: { kind: 'fixture', id: 'designsignal-v1' }, head_sha: '0'.repeat(40) }
    }, 'real-project')).json;
    assert.match(project.repository.head_sha, /^[a-f0-9]{40}$/);
    assert.deepEqual(project.repository.source, { kind: 'fixture', id: 'designsignal-v1' });
    await mutate(env.base, `/api/v1/projects/${project.id}/briefs`, { content: { objective: 'capture', acceptance: ['node_test'] } }, 'real-brief');
    await mutate(env.base, `/api/v1/projects/${project.id}/workflows`, { tasks: [{ id: 'write', title: 'Write output', level: 1, mode: 'write', outputs: ['result.txt'] }] }, 'real-workflow');
    const execution = (await mutate(env.base, `/api/v1/projects/${project.id}/executions`, {}, 'real-execution')).json;
    await mutate(env.base, `/api/v1/executions/${execution.id}/start`, { expected_revision: execution.revision }, 'real-start');
    let worktree;
    for (let i = 0; i < 20 && !worktree; i += 1) {
      worktree = await env.app.database.get('SELECT * FROM repository_worktrees WHERE execution_id=?', [execution.id]);
      if (!worktree) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(worktree?.worktree_path);
    const worktreePath = path.join(env.home, worktree.worktree_path);
    const writer = setInterval(() => { if (fs.existsSync(worktreePath)) fs.writeFileSync(path.join(worktreePath, 'result.txt'), 'captured\n', 'utf8'); }, 2);
    await eventually(async () => (await request(env.base, `/api/v1/executions/${execution.id}`)).json, (value) => value.status === 'completed');
    clearInterval(writer);
    const completed = await eventually(
      async () => (await request(env.base, `/api/v1/executions/${execution.id}`)).json,
      (value) => value.status === 'completed' && value.runner.worktree_status === 'removed'
    );
    assert.equal(completed.runner.worktree_status, 'removed');
    assert.ok(completed.evidence.some((item) => item.name.endsWith('.diff')));
    assert.ok(completed.evidence.some((item) => item.name.endsWith('result.txt')));
    const captured = await request(env.base, `/api/v1/executions/${execution.id}/diff`);
    assert.equal(captured.json.captured, true);
    assert.deepEqual(captured.json.files, ['result.txt']);
    assert.match(captured.json.diff_sha256, /^[a-f0-9]{64}$/);
    const diffRow = await env.app.database.get('SELECT * FROM execution_diffs WHERE execution_id=?', [execution.id]);
    const executionLinks = await env.app.database.query("SELECT * FROM evidence_links WHERE target_type='execution' AND target_id=?", [execution.id]);
    const taskLinks = await env.app.database.query("SELECT * FROM evidence_links WHERE target_type='task' AND target_id=?", [`${execution.id}:write`]);
    assert.ok(executionLinks.some((link) => link.asset_version_id === diffRow.asset_version_id));
    assert.ok(taskLinks.length >= 2, 'task must link its check report and declared output');
    for (const item of completed.evidence) {
      const casPath = path.join(env.home, 'cas', item.cas_hash.slice(0, 2), item.cas_hash);
      assert.equal(fs.existsSync(casPath), true);
    }
    const review = (await mutate(env.base, '/api/v1/reviews', { project_id: project.id, execution_id: execution.id, kind: 'task', model_status: 'unavailable', suggestion: {} }, 'real-review')).json;
    const reviewLinks = await env.app.database.query("SELECT * FROM evidence_links WHERE target_type='review' AND target_id=?", [review.id]);
    const linkedAssets = new Set([...executionLinks, ...taskLinks].map((link) => link.asset_version_id));
    assert.deepEqual(new Set(reviewLinks.map((link) => link.asset_version_id)), linkedAssets);
    assert.equal(fs.existsSync(path.join(env.home, 'projects', project.id, 'README.md')), true);
    assert.equal(fs.existsSync(worktreePath), false);
  } finally {
    await env.close();
  }
});

test('Codex probe requires an explicit profile and never falls back to credential material', async () => {
  const env = await fixture();
  try {
    const first = await mutate(env.base, '/api/v1/integrations/codex/probe', {}, 'probe-real-slice');
    const replay = await mutate(env.base, '/api/v1/integrations/codex/probe', {}, 'probe-real-slice');
    assert.equal(first.response.status, 409);
    assert.equal(first.json.error.code, 'codex_profile_missing');
    assert.equal(replay.response.status, 409);
    assert.equal(replay.json.error.code, first.json.error.code);
    assert.equal(JSON.stringify(first.json).includes('credential'), false);
  } finally {
    await env.close();
  }
});
