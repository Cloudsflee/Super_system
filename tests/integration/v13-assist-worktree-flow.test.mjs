import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { api, cleanup, createConfirmedProject, makeFixture, repositorySnapshot, startApi } from './v13-test-helpers.mjs';

const port = Number(process.env.AIWS_TEST_PORT || 4597);
const fixture = makeFixture('aiws-v13-assist-');
const source = path.join(fixture.root, 'external-repo');
fs.mkdirSync(source);
run('git', ['init'], source); run('git', ['config', 'user.email', 'assist-v3@example.test'], source); run('git', ['config', 'user.name', 'Assist V3'], source);
fs.writeFileSync(path.join(source, 'README.md'), '# Assist V3 baseline\n', 'utf8');
run('git', ['add', '.'], source); run('git', ['commit', '-m', 'init'], source);
const sourceBefore = repositorySnapshot(source);
let server;

try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const project = await createConfirmedProject({
    baseUrl: `http://127.0.0.1:${port}`, title: 'Assist V3 Worktree', goal: '验证 Agent review', source,
    workflowNodes: [{ type: 'execution', title: 'Agent execution', goal: '在独立 worktree 中修改文件' }]
  });
  const onboardingSession = await api(port, `/assist/v3/sessions/${project.draft.assist_session.id}`);
  assert.equal(onboardingSession.scope_status, 'active');
  assert.equal(onboardingSession.scope_type, 'project');
  const sessionId = onboardingSession.id;
  const managedReadme = path.join(project.managedRepo, 'README.md');
  assert.equal(normalize(fs.readFileSync(managedReadme, 'utf8')), '# Assist V3 baseline\n');
  const turn = await api(port, `/assist/v3/sessions/${sessionId}/turns`, 'POST', {
    collaboration_mode: 'default', content: '在 change batch 中更新 README 并等待审批', adapter: 'test',
    test_response: {
      message: 'Agent worktree ready for review.',
      files: [{ path: 'README.md', content: '# Assist V3 managed change\n' }],
      events: [
        { type: 'plan', data: { text: '修改并验证', status: 'running' } },
        { type: 'command', data: { command: 'node --version', status: 'completed', exit_code: 0 } },
        { type: 'test', data: { name: 'unit', status: 'passed', summary: 'ok' } },
        { type: 'mcp', data: { server: 'fixture', tool: 'inspect', status: 'completed' } },
        { type: 'search', data: { query: 'managed workspace', status: 'completed' } },
        { type: 'usage', data: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } },
        { type: 'reasoning_summary', data: { summary: '公开摘要，不含内部推理。' } },
        { type: 'approval', data: { external_id: 'runtime-fixture-1', approval_type: 'command', status: 'pending' } }
      ]
    }
  }, 202);
  const approval = await waitForApproval(project.project.id, turn.id);
  const waiting = await api(port, `/assist/v3/turns/${turn.id}`);
  assert.equal(waiting.status, 'waiting_approval');
  const decision = await api(port, `/approvals/runtime/${approval.id}/decision`, 'POST', {
    decision: 'approve_apply', revision: approval.revision, target_hash: approval.target_hash
  });
  assert.equal(decision.item.status, 'approved');
  const completed = await waitForTurn(turn.id, 'completed');
  assert.equal(completed.output_text, 'Agent worktree ready for review.');
  assert.ok(completed.worktree?.id);

  const eventText = await fetch(`http://127.0.0.1:${port}/assist/v3/turns/${turn.id}/events`).then((response) => response.text());
  const events = parseSse(eventText);
  for (const type of ['started', 'plan', 'command', 'file_change', 'test', 'mcp', 'search', 'usage', 'reasoning_summary', 'approval', 'completed']) assert.ok(events.some((item) => item.type === type), `typed event ${type}`);
  const cursor = events[2].sequence;
  const replayText = await fetch(`http://127.0.0.1:${port}/assist/v3/turns/${turn.id}/events`, { headers: { 'Last-Event-ID': String(cursor) } }).then((response) => response.text());
  assert.ok(parseSse(replayText).every((item) => item.sequence > cursor));

  const review = await api(port, `/assist/v3/turns/${turn.id}/review`);
  assert.equal(review.changed_files.some((item) => item.path === 'README.md'), true);
  assert.match(review.diff, /Assist V3 managed change/);
  assert.equal(normalize(fs.readFileSync(managedReadme, 'utf8')), '# Assist V3 baseline\n');
  assert.deepEqual(repositorySnapshot(source), sourceBefore);
  await api(port, `/assist/v3/turns/${turn.id}/review/viewed`, 'POST', { path: 'README.md' });
  const comment = await api(port, `/assist/v3/turns/${turn.id}/review/comments`, 'POST', { path: 'README.md', line: 1, body: '确认标题变更' }, 201);
  assert.equal(comment.action, 'line_comment');
  await api(port, `/assist/v3/turns/${turn.id}/review/apply`, 'POST', { target_hash: 'stale-target' }, 409, 'review_stale');
  const applied = await api(port, `/assist/v3/turns/${turn.id}/review/apply`, 'POST', { target_hash: review.target_hash });
  assert.equal(applied.worktree.status, 'applied');
  assert.equal(normalize(fs.readFileSync(managedReadme, 'utf8')), '# Assist V3 managed change\n');
  assert.equal(run('git', ['status', '--porcelain=v1'], project.managedRepo).stdout.trim(), '');

  const rollbackTurn = await api(port, `/assist/v3/sessions/${sessionId}/turns`, 'POST', {
    collaboration_mode: 'default', content: '创建一个随后撤销的批次', adapter: 'test',
    test_response: { message: 'rollback batch ready', files: [{ path: 'README.md', content: '# must be rolled back\n' }] }
  }, 202);
  await waitForTurn(rollbackTurn.id, 'completed');
  const rollbackReview = await api(port, `/assist/v3/turns/${rollbackTurn.id}/review`);
  const rolledBack = await api(port, `/assist/v3/turns/${rollbackTurn.id}/review/rollback`, 'POST', { target_hash: rollbackReview.target_hash });
  assert.equal(rolledBack.worktree.status, 'rolled_back');
  assert.equal(normalize(fs.readFileSync(managedReadme, 'utf8')), '# Assist V3 managed change\n');
  assert.deepEqual(repositorySnapshot(source), sourceBefore);
  console.log('V1.3 Assist worktree integration tests passed');
} finally {
  await server?.stop();
  cleanup(fixture.root);
}

async function waitForApproval(projectId, turnId) { for (let index = 0; index < 100; index++) { const items = await api(port, `/approvals?project_id=${projectId}&type=runtime`); const item = items.find((entry) => entry.turn_id === turnId && entry.status === 'pending'); if (item) return item; await delay(25); } throw new Error('runtime approval not created'); }
async function waitForTurn(turnId, status) { for (let index = 0; index < 120; index++) { const turn = await api(port, `/assist/v3/turns/${turnId}`); if (turn.status === status) return turn; if (['failed', 'stopped', 'interrupted'].includes(turn.status)) throw new Error(`turn ended as ${turn.status}: ${turn.error_code}`); await delay(25); } throw new Error(`turn did not reach ${status}`); }
function parseSse(text) { return text.split(/\n\n+/).filter((block) => block.includes('data: ')).map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data: ')).slice(6))); }
function run(command, args, cwd) { const result = spawnSync(command, args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result; }
function normalize(value) { return value.replaceAll('\r\n', '\n'); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
