import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { api, cleanup, createConfirmedProject, makeFixture, repositorySnapshot, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v13-assist-lifecycle-');
const source = path.join(fixture.root, 'external-repo');
fs.mkdirSync(source);
run('git', ['init'], source); run('git', ['config', 'user.email', 'assist-lifecycle@example.test'], source); run('git', ['config', 'user.name', 'Assist Lifecycle'], source);
fs.writeFileSync(path.join(source, 'README.md'), '# Assist lifecycle baseline\n', 'utf8');
fs.writeFileSync(path.join(source, 'blob.bin'), Buffer.from([0, 1, 2, 255]));
run('git', ['add', '.'], source); run('git', ['commit', '-m', 'baseline'], source);
const sourceBefore = repositorySnapshot(source);
const port = 4601;
let server;
try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const project = await createConfirmedProject({ baseUrl: `http://127.0.0.1:${port}`, title: 'Assist lifecycle', goal: '验证完整 Assist V3 生命周期', source });
  const mainSession = project.draft.assist_session.id;
  const managedReadme = path.join(project.managedRepo, 'README.md');
  const managedBaseline = fs.readFileSync(managedReadme);

  await api(port, '/codex/auth/device/start', 'POST', { adapter: 'test' });
  const baseProfile = await api(port, '/codex/profiles', 'POST', { name: 'Assist Base', provider: 'openai', model: 'gpt-base', reasoning: 'medium', mounts: [] }, 201);
  const catalogState = readState();
  catalogState.codex_profiles.find((item) => item.id === baseProfile.id).model_catalog = [
    { id: 'gpt-base', model: 'gpt-base', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
    { id: 'gpt-review', model: 'gpt-review', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }] },
    { id: 'gpt-review-2', model: 'gpt-review-2', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] }
  ];
  fs.writeFileSync(path.join(fixture.home, 'data', 'state.json'), JSON.stringify(catalogState, null, 2), 'utf8');
  const savedConfiguration = await api(port, '/assist/v3/configurations', 'POST', { base_profile_id: baseProfile.id, name: 'Fast review', model: 'gpt-review', reasoning: 'low' }, 201);
  assert.equal(savedConfiguration.base_profile_id, baseProfile.id);
  assert.equal(savedConfiguration.model, 'gpt-review');
  await api(port, '/assist/v3/configurations', 'POST', { base_profile_id: baseProfile.id, name: 'Unsafe', model: 'gpt-review', reasoning: 'low', base_url: 'https://override.invalid' }, 400, 'unsupported_assist_configuration_field');
  await api(port, `/assist/v3/sessions/${mainSession}/turns`, 'POST', { adapter: 'test', mode: 'ask', content: 'invalid model', model: '../invalid model' }, 400, 'invalid_assist_model');
  await api(port, `/assist/v3/sessions/${mainSession}/turns`, 'POST', { adapter: 'test', mode: 'ask', content: 'invalid reasoning', reasoning: 'not valid' }, 400, 'invalid_assist_reasoning');

  const fileAttachment = await api(port, `/assist/v3/sessions/${mainSession}/attachments`, 'POST', { kind: 'monaco_file', path: 'README.md', title: 'Current Monaco file' }, 201);
  const selection = await api(port, `/assist/v3/sessions/${mainSession}/attachments`, 'POST', { kind: 'selection', path: 'README.md', text: 'Assist lifecycle baseline', title: 'Current selection', selection: { start_line: 1, start_column: 3, end_line: 1, end_column: 28 } }, 201);
  const binary = await api(port, `/assist/v3/sessions/${mainSession}/attachments`, 'POST', { kind: 'project_file', path: 'blob.bin', title: 'Unknown binary' }, 201);
  assert.equal(fileAttachment.model_policy, 'injectable');
  assert.equal(selection.selection.start_line, 1);
  assert.equal(binary.model_policy, 'artifact_only');
  await api(port, `/assist/v3/sessions/${mainSession}/attachments`, 'POST', { kind: 'project_file', path: '../outside' }, 400, 'invalid_attachment_path');
  await api(port, `/assist/v3/sessions/${mainSession}/attachments`, 'POST', { kind: 'artifact', size_bytes: 26 * 1024 * 1024 }, 413, 'attachment_too_large');

  const contextual = await createTurn(mainSession, { mode: 'plan', content: 'Plan with attached context', attachment_ids: [fileAttachment.id, selection.id, binary.id], test_response: { message: 'plan completed', events: [{ type: 'reasoning_summary', data: { summary: 'public summary', internal_reasoning: 'PRIVATE_REASONING_SENTINEL' } }] } });
  const contextualDone = await waitTurn(contextual.id, 'completed');
  assert.equal(contextualDone.attachments.length, 3);
  const contextState = readState();
  const pack = contextState.context_packs.find((item) => item.id === contextualDone.context_pack_id);
  const sufficiency = contextState.context_sufficiency_checks.find((item) => item.id === pack.sufficiency_check_id);
  assert.equal(pack.receiver_type, 'assist_turn');
  assert.equal(pack.memory_manifest.authority, 'confirmed_only');
  assert.equal(sufficiency.status, 'sufficient');
  assert.equal(JSON.stringify(await api(port, `/assist/v3/turns/${contextual.id}`)).includes('PRIVATE_REASONING_SENTINEL'), false);
  assert.equal(fs.readFileSync(path.join(fixture.home, 'data', 'state.json'), 'utf8').includes('PRIVATE_REASONING_SENTINEL'), false);

  const pageEdit = await createTurn(mainSession, { mode: 'ask', content: '填写当前简报', configuration_id: savedConfiguration.id, model: 'gpt-review-2', reasoning: 'xhigh', view_context: { route: `/projects/${project.project.id}/onboarding`, surface: { revision: 'r1', fields: [{ id: 'brief.goal', label: '核心目标', risk: 'low' }] } }, test_response: { message: '已生成简报草稿，请审查。' } });
  const pageEditDone = await waitTurn(pageEdit.id, 'completed');
  assert.equal(pageEditDone.model, 'gpt-review-2');
  assert.equal(pageEditDone.reasoning, 'xhigh');
  assert.equal(pageEditDone.output_text, '已生成简报草稿，请审查。');
  assert.equal(pageEditDone.actions.length, 0, 'legacy output-tag actions are not materialized');

  const readOnly = await createTurn(mainSession, { mode: 'plan', content: 'Must remain read only', test_response: { message: 'invalid', files: [{ path: 'README.md', content: '# forbidden\n' }] } });
  const readOnlyFailed = await waitTurn(readOnly.id, 'failed');
  assert.equal(readOnlyFailed.error_code, 'test_adapter_read_only_violation');
  assert.equal(normalize(fs.readFileSync(managedReadme, 'utf8')), '# Assist lifecycle baseline\n');
  const orphanApprovalId = 'rap_failed_turn_fixture';
  const orphanState = readState();
  orphanState.runtime_approvals.push({ id: orphanApprovalId, project_id: project.project.id, session_id: mainSession, turn_id: readOnly.id, approval_type: 'command', request: { command: 'node --version' }, status: 'pending', attention_state: 'interrupting', revision: 1, target_hash: 'orphan-target', created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() });
  fs.writeFileSync(path.join(fixture.home, 'data', 'state.json'), JSON.stringify(orphanState, null, 2), 'utf8');

  const first = await createTurn(mainSession, { mode: 'ask', content: 'first queued turn', test_response: { message: 'first complete', delay_ms: 250 } });
  await waitTurn(first.id, 'running');
  const queued = await api(port, `/assist/v3/sessions/${mainSession}/follow-ups`, 'POST', { adapter: 'test', behavior: 'queue', content: 'queued follow-up', test_response: { message: 'queued complete' } }, 202);
  assert.equal(queued.parent_turn_id, first.id);
  assert.equal(queued.follow_up_kind, 'queue');
  await waitTurn(first.id, 'completed'); await waitTurn(queued.id, 'completed');

  const steering = await createTurn(mainSession, { mode: 'ask', content: 'long turn to steer', test_response: { message: 'should interrupt', delay_ms: 1200 } });
  await waitTurn(steering.id, 'running');
  const steered = await api(port, `/assist/v3/sessions/${mainSession}/follow-ups`, 'POST', { adapter: 'test', behavior: 'steer', content: 'steer now', test_response: { message: 'steered complete' } }, 202);
  await waitTurn(steering.id, 'interrupted'); await waitTurn(steered.id, 'completed');

  const interrupting = await createTurn(mainSession, { mode: 'plan', content: 'long plan to interrupt', test_response: { message: 'should interrupt', delay_ms: 1200 } });
  await waitTurn(interrupting.id, 'running');
  const interruptedBy = await api(port, `/assist/v3/sessions/${mainSession}/interrupt`, 'POST', { adapter: 'test', content: 'replace current plan', test_response: { message: 'interrupt follow-up complete' } }, 202);
  await waitTurn(interrupting.id, 'interrupted'); await waitTurn(interruptedBy.id, 'completed');

  const stopping = await createTurn(mainSession, { mode: 'ask', content: 'stop me', test_response: { message: 'too late', delay_ms: 1200 } });
  await waitTurn(stopping.id, 'running');
  await api(port, `/assist/v3/sessions/${mainSession}/archive`, 'POST', {}, 409, 'assist_session_running');
  await api(port, `/assist/v3/turns/${stopping.id}/stop`, 'POST', { reason: 'test_stop' });
  await waitTurn(stopping.id, 'stopped');
  const retried = await api(port, `/assist/v3/turns/${stopping.id}/retry`, 'POST', { adapter: 'test', test_response: { message: 'retry complete' } }, 202);
  assert.equal(retried.retry_of_turn_id, stopping.id);
  await waitTurn(retried.id, 'completed');

  const approvalTurn = await createTurn(mainSession, { mode: 'ask', content: 'request runtime permission', test_response: { message: 'must not complete', events: [{ type: 'approval', data: { external_id: 'reject-me', approval_type: 'command', status: 'pending' } }] } });
  const approval = await waitApproval(approvalTurn.id);
  const rejected = await api(port, `/approvals/runtime/${approval.id}/decision`, 'POST', { decision: 'reject', revision: approval.revision, target_hash: approval.target_hash, reason: 'test rejection' });
  assert.equal(rejected.item.status, 'rejected');
  assert.equal((await api(port, `/approvals/runtime/${approval.id}/decision`, 'POST', { decision: 'reject', revision: rejected.item.revision, target_hash: rejected.item.target_hash })).idempotent, true);
  await waitTurn(approvalTurn.id, 'failed');

  await api(port, `/assist/v3/sessions/${mainSession}/fork`, 'POST', { from_turn_id: contextual.id, title: 'Legacy fake Fork must fail' }, 409, 'assist_native_fork_source_required');
  const forked = await newSession(project.project.id, 'Independent lifecycle thread');
  await api(port, `/assist/v3/sessions/${forked.id}/rename`, 'POST', { title: 'Renamed fork' });
  await api(port, `/assist/v3/sessions/${forked.id}/pin`, 'POST', { pinned: true });
  const searched = await api(port, '/assist/v3/sessions?search=Renamed%20fork&pinned=true');
  assert.equal(searched.some((item) => item.id === forked.id), true);
  await api(port, `/assist/v3/sessions/${forked.id}/archive`, 'POST', {});
  assert.equal((await api(port, '/assist/v3/sessions?archived=only')).some((item) => item.id === forked.id), true);
  await api(port, `/assist/v3/sessions/${forked.id}/restore`, 'POST', {});

  const sessionA = await newSession(project.project.id, 'Concurrent A');
  const sessionB = await newSession(project.project.id, 'Concurrent B');
  const turnA = await createTurn(sessionA.id, { collaboration_mode: 'default', content: 'change A', test_response: { delay_ms: 300, message: 'A ready', files: [{ path: 'README.md', content: '# Concurrent A\n' }] } });
  await waitTurn(turnA.id, 'running');
  const turnB = await createTurn(sessionB.id, { collaboration_mode: 'default', content: 'change B', test_response: { delay_ms: 200, message: 'B ready', files: [{ path: 'README.md', content: '# Concurrent B\n' }] } });
  const doneA = await waitTurn(turnA.id, 'completed'), doneB = await waitTurn(turnB.id, 'completed');
  assert.notEqual(doneA.worktree.id, doneB.worktree.id);
  const reviewA = await api(port, `/assist/v3/turns/${turnA.id}/review`), reviewB = await api(port, `/assist/v3/turns/${turnB.id}/review`);
  await api(port, `/assist/v3/turns/${turnB.id}/review/request-changes`, 'POST', { target_hash: reviewB.target_hash, summary: 'Verify conflict protection' });
  await api(port, `/assist/v3/turns/${turnA.id}/review/apply`, 'POST', { target_hash: reviewA.target_hash });
  await api(port, `/assist/v3/turns/${turnB.id}/review/apply`, 'POST', { target_hash: reviewB.target_hash }, 409, 'review_base_changed');
  await api(port, `/assist/v3/turns/${turnB.id}/review/rollback`, 'POST', { target_hash: reviewB.target_hash });
  const restoreSession = await newSession(project.project.id, 'Restore baseline');
  const restoreTurn = await createTurn(restoreSession.id, { collaboration_mode: 'default', content: 'restore baseline', test_response: { message: 'restore ready', files: [{ path: 'README.md', content: '# Assist lifecycle baseline\n' }] } });
  await waitTurn(restoreTurn.id, 'completed');
  const restoreReview = await api(port, `/assist/v3/turns/${restoreTurn.id}/review`);
  await api(port, `/assist/v3/turns/${restoreTurn.id}/review/apply`, 'POST', { target_hash: restoreReview.target_hash });
  assert.equal(normalize(fs.readFileSync(managedReadme, 'utf8')), '# Assist lifecycle baseline\n');

  fs.appendFileSync(managedReadme, 'dirty baseline\n');
  const dirty = await createTurn(sessionA.id, { collaboration_mode: 'default', content: 'must reject dirty baseline', test_response: { message: 'not reached' } });
  const dirtyFailed = await waitTurn(dirty.id, 'failed');
  assert.equal(dirtyFailed.error_code, 'worktree_dirty_baseline');
  assert.equal(dirtyFailed.worktree, null);
  fs.writeFileSync(managedReadme, managedBaseline);

  const restarting = await createTurn(sessionA.id, { collaboration_mode: 'default', content: 'survive service restart safely', test_response: { message: 'must be interrupted', delay_ms: 2000 } });
  const runningBeforeRestart = await waitTurn(restarting.id, 'running');
  assert.ok(runningBeforeRestart.worktree?.id);
  await server.stop();
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const recoveredAfterRestart = await waitTurn(restarting.id, 'interrupted');
  assert.equal(recoveredAfterRestart.error_code, 'service_restarted');
  const repairedApproval = readState().runtime_approvals.find((item) => item.id === orphanApprovalId);
  assert.equal(repairedApproval.status, 'cancelled');
  assert.equal(repairedApproval.attention_state, 'resolved');
  assert.equal(recoveredAfterRestart.worktree.id, runningBeforeRestart.worktree.id);
  assert.equal(fs.existsSync(readState().worktrees.find((item) => item.id === recoveredAfterRestart.worktree.id).path), true);
  const restartReview = await api(port, `/assist/v3/turns/${restarting.id}/review`);
  await api(port, `/assist/v3/turns/${restarting.id}/review/rollback`, 'POST', { target_hash: restartReview.target_hash });
  assert.deepEqual(repositorySnapshot(source), sourceBefore);
  console.log('V1.3 Assist lifecycle integration tests passed');
} finally {
  await server?.stop();
  cleanup(fixture.root);
}

function createTurn(sessionId, body) { return api(port, `/assist/v3/sessions/${sessionId}/turns`, 'POST', { adapter: 'test', ...body }, 202); }
function newSession(projectId, title) { return api(port, '/assist/v3/sessions', 'POST', { project_id: projectId, scope_type: 'project', scope_id: projectId, title }, 201); }
async function waitTurn(turnId, status) { for (let attempt = 0; attempt < 160; attempt++) { const turn = await api(port, `/assist/v3/turns/${turnId}`); if (turn.status === status) return turn; if (['completed', 'failed', 'stopped', 'interrupted'].includes(turn.status)) throw new Error(`${turnId} reached ${turn.status} (${turn.error_code || 'no_error_code'}) instead of ${status}`); await delay(25); } throw new Error(`${turnId} did not reach ${status}`); }
async function waitApproval(turnId) { for (let attempt = 0; attempt < 120; attempt++) { const items = await api(port, '/approvals?type=runtime'); const item = items.find((entry) => entry.turn_id === turnId && entry.status === 'pending'); if (item) return item; await delay(25); } throw new Error('runtime approval did not appear'); }
function readState() { return JSON.parse(fs.readFileSync(path.join(fixture.home, 'data', 'state.json'), 'utf8')); }
function run(command, args, cwd) { const result = spawnSync(command, args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); }
function normalize(value) { return value.replaceAll('\r\n', '\n'); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
