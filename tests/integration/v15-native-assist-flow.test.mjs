import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { api, cleanup, createConfirmedProject, makeFixture, repositorySnapshot, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v15-native-assist-');
const source = path.join(fixture.root, 'source'); fs.mkdirSync(source);
git(source, ['init']); git(source, ['config', 'user.name', 'V1.5 Native']); git(source, ['config', 'user.email', 'v15-native@example.test']);
fs.writeFileSync(path.join(source, 'README.md'), '# V1.5 native baseline\n'); git(source, ['add', '.']); git(source, ['commit', '-m', 'baseline']);
const sourceBefore = repositorySnapshot(source);
const fakeCodex = path.resolve('tests/fixtures/fake-codex-app-server-v15.mjs');
const serverEnv = { AIWS_CODEX_BIN: fakeCodex, AIWS_CODEX_VERSION: '0.144.0' };
const stateFile = path.join(fixture.home, 'data', 'state.json');
const port = 4615;
let server;

try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch, env: serverEnv });
  const project = await createConfirmedProject({ baseUrl: `http://127.0.0.1:${port}`, title: 'HIDDEN_V15_PROJECT_CONTEXT', goal: 'HIDDEN_V15_GOAL', source });
  const sessionId = project.draft.assist_session.id;
  await api(port, '/codex/auth/device/start', 'POST', { adapter: 'test' });
  const profile = await api(port, '/codex/profiles', 'POST', { name: 'Native fixture', provider: 'openai', model: 'gpt-initial', reasoning: 'high', mounts: [] }, 201);
  const state = readState();
  for (const item of state.codex_profiles) item.is_active = item.id === profile.id;
  Object.assign(state.codex_profiles.find((item) => item.id === profile.id), { kind: 'host', timeout_ms: 20_000, model_catalog: null, model_catalog_required: true });
  state.integration_statuses = state.integration_statuses.filter((item) => item.key !== 'codex_capabilities');
  writeState(state);

  const catalog = await api(port, `/assist/v3/models?profile_id=${encodeURIComponent(profile.id)}`);
  assert.equal(catalog.source, 'codex_model_list');
  assert.deepEqual(catalog.models[0].supportedReasoningEfforts.map((item) => item.reasoningEffort), ['max', 'ultra']);
  const configuration = await api(port, '/assist/v3/configurations', 'POST', { base_profile_id: profile.id, name: 'Native ultra', model: 'gpt-v15-native', reasoning: 'ultra' }, 201);

  const setGoal = await api(port, `/assist/v3/sessions/${sessionId}/goal`, 'PUT', { objective: 'Complete the native V1.5 flow', tokenBudget: 12000, configuration_id: configuration.id });
  assert.equal(setGoal.goal.objective, 'Complete the native V1.5 flow'); assert.equal(setGoal.goal.tokenBudget, 12000);
  const fetchedGoal = await api(port, `/assist/v3/sessions/${sessionId}/goal`);
  assert.equal(fetchedGoal.goal.status, 'active'); assert.equal(fetchedGoal.goal.tokensUsed, 17);
  const pausedGoal = await api(port, `/assist/v3/sessions/${sessionId}/goal`, 'PUT', { status: 'paused' });
  assert.equal(pausedGoal.goal.status, 'paused');

  const plan = await api(port, `/assist/v3/sessions/${sessionId}/turns`, 'POST', {
    collaboration_mode: 'plan', content: 'ASK_INPUT native plan', configuration_id: configuration.id
  }, 202);
  const waiting = await waitForTurn(plan.id, (item) => item.status === 'waiting_user_input' && item.user_inputs?.length);
  assert.equal(waiting.code_access, 'read_only'); assert.equal(waiting.user_inputs[0].item_id, 'native-question-v15');
  await api(port, `/assist/v3/turns/${plan.id}/user-input/native-question-v15/respond`, 'POST', { answers: { choice: { answers: ['alpha'] } } });
  const planned = await waitForTurn(plan.id, (item) => item.status === 'completed');
  assert.match(planned.output_text, /native input answer:alpha/);
  const planEvents = readState().assist_events.filter((item) => item.turn_id === plan.id);
  assert.equal(planEvents.some((item) => item.type === 'plan'), true);
  assert.equal(planEvents.some((item) => item.type === 'reasoning_summary'), true);

  const staleState = readState();
  staleState.assist_sessions.find((item) => item.id === sessionId).codex_thread_id = 'missing-native-thread';
  writeState(staleState);
  const recoveredTurn = await api(port, `/assist/v3/sessions/${sessionId}/turns`, 'POST', { collaboration_mode: 'default', content: 'RECOVER_STALE_THREAD', configuration_id: configuration.id }, 202);
  const recoveredDone = await waitForTurn(recoveredTurn.id, (item) => item.status === 'completed');
  assert.equal(recoveredDone.codex_thread_id, 'fake-native-thread-v15');
  const recoveryEvents = readState().assist_events.filter((item) => item.turn_id === recoveredTurn.id);
  assert.equal(recoveryEvents.some((item) => item.type === 'status' && item.data.status === 'thread_recreated'), true);

  const pageTurn = await api(port, `/assist/v3/sessions/${sessionId}/turns`, 'POST', {
    collaboration_mode: 'default', content: 'PAGE_TOOL commit semantic field', configuration_id: configuration.id,
    view_context: { route: `/projects/${project.project.id}/brief`, browser_instance_id: 'browser-v15', surface: { id: 'brief-v15', revision: 'surface-v15-r1', fields: [{ id: 'brief.goal', label: 'Goal', risk: 'low' }] } }
  }, 202);
  const pendingOperation = await waitForOperation(sessionId, (item) => item.turn_id === pageTurn.id && item.status === 'pending');
  const execution = await api(port, `/assist/v3/operations/${pendingOperation.id}/claim`, 'POST', { browser_instance_id: 'browser-v15' });
  assert.equal(execution.value, 'native tool value');
  await api(port, `/assist/v3/operations/${pendingOperation.id}/result`, 'POST', {
    browser_instance_id: 'browser-v15', route: `/projects/${project.project.id}/brief`, surface_revision: 'surface-v15-r1', ok: true, persisted: true,
    before: 'old value', after: 'native tool value', current: 'native tool value'
  });
  const pageDone = await waitForTurn(pageTurn.id, (item) => item.status === 'completed');
  assert.match(pageDone.output_text, /native page tool committed/); assert.ok(pageDone.change_batch_id);
  const inverse = await api(port, `/assist/v3/operations/${pendingOperation.id}/undo`, 'POST', { force: false }, 202);
  await api(port, `/assist/v3/operations/${inverse.id}/claim`, 'POST', { browser_instance_id: 'browser-v15' });
  const inverseDone = await api(port, `/assist/v3/operations/${inverse.id}/result`, 'POST', {
    browser_instance_id: 'browser-v15', route: `/projects/${project.project.id}/brief`, surface_revision: 'surface-v15-r1', ok: true, persisted: true,
    before: 'native tool value', after: 'old value', current: 'old value'
  });
  assert.equal(inverseDone.status, 'committed'); assert.equal(inverseDone.inverse_of, pendingOperation.id);

  const firstWrite = await createAdaptedTurn(sessionId, { collaboration_mode: 'default', content: 'write first file', files: [{ path: 'FIRST.txt', content: 'first\n' }] });
  const firstDone = await waitForTurn(firstWrite.id, (item) => item.status === 'completed');
  const secondWrite = await createAdaptedTurn(sessionId, { collaboration_mode: 'default', content: 'write second file', files: [{ path: 'SECOND.txt', content: 'second\n' }] });
  const secondDone = await waitForTurn(secondWrite.id, (item) => item.status === 'completed');
  assert.equal(firstDone.change_batch_id, pageDone.change_batch_id); assert.equal(secondDone.change_batch_id, pageDone.change_batch_id);
  const forbiddenPlan = await createAdaptedTurn(sessionId, { collaboration_mode: 'plan', content: 'plan must not write', files: [{ path: 'FORBIDDEN.txt', content: 'forbidden\n' }] });
  const forbiddenDone = await waitForTurn(forbiddenPlan.id, (item) => item.status === 'failed');
  assert.equal(forbiddenDone.error_code, 'test_adapter_read_only_violation');
  const review = await api(port, `/assist/v3/change-batches/${pageDone.change_batch_id}/review`);
  assert.equal(review.changed_files.some((item) => item.path === 'FIRST.txt'), true);
  assert.equal(review.changed_files.some((item) => item.path === 'SECOND.txt'), true);
  assert.equal(review.checkpoints.length >= 6, true);
  const applied = await api(port, `/assist/v3/change-batches/${pageDone.change_batch_id}/review/apply`, 'POST', { target_hash: review.target_hash });
  assert.equal(applied.batch.status, 'applied'); assert.ok(applied.project_commit);
  assert.equal(normalize(fs.readFileSync(path.join(project.managedRepo, 'FIRST.txt'), 'utf8')), 'first\n');
  assert.equal(normalize(fs.readFileSync(path.join(project.managedRepo, 'SECOND.txt'), 'utf8')), 'second\n');
  assert.equal(fs.existsSync(path.join(project.managedRepo, 'FORBIDDEN.txt')), false);
  assert.equal(git(project.managedRepo, ['status', '--porcelain=v1']).stdout.trim(), '');

  const protocol = fs.readFileSync(path.join(profile.codex_home, 'fake-protocol.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const starts = protocol.filter((item) => item.direction === 'from_aiws' && item.message.method === 'turn/start').map((item) => item.message.params);
  const pageStart = starts.find((item) => item.input?.[0]?.text?.includes('PAGE_TOOL'));
  assert.equal(pageStart.input[0].text, 'PAGE_TOOL commit semantic field');
  assert.equal(JSON.stringify(pageStart.input).includes('HIDDEN_V15_PROJECT_CONTEXT'), false);
  assert.equal(JSON.stringify(pageStart.additionalContext).includes('HIDDEN_V15_PROJECT_CONTEXT'), true);
  const restartTurn = await api(port, `/assist/v3/sessions/${sessionId}/turns`, 'POST', { collaboration_mode: 'plan', content: 'ASK_INPUT cancel on restart', configuration_id: configuration.id }, 202);
  await waitForTurn(restartTurn.id, (item) => item.status === 'waiting_user_input');
  await server.stop(); server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch, env: serverEnv });
  const recovered = await waitForTurn(restartTurn.id, (item) => item.status === 'interrupted');
  assert.equal(recovered.error_code, 'service_restarted'); assert.equal(recovered.user_inputs[0].status, 'cancelled');
  assert.equal((await api(port, `/assist/v3/sessions/${sessionId}/goal`)).goal.status, 'paused');
  assert.deepEqual(await api(port, `/assist/v3/sessions/${sessionId}/goal`, 'DELETE'), { goal: null });
  assert.deepEqual(repositorySnapshot(source), sourceBefore);
  console.log('V1.5 native Assist integration tests passed');
} finally {
  await server?.stop(); if (process.env.AIWS_KEEP_V15_FIXTURE !== '1') cleanup(fixture.root); else console.error(`fixture:${fixture.root}`);
}

function readState() { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
function writeState(value) { fs.writeFileSync(stateFile, JSON.stringify(value, null, 2)); }
function createAdaptedTurn(sessionId, input) { return api(port, `/assist/v3/sessions/${sessionId}/turns`, 'POST', { adapter: 'test', test_response: { message: 'adapted complete', files: input.files }, ...input }, 202); }
async function waitForTurn(id, predicate) { for (let count = 0; count < 240; count++) { const item = await api(port, `/assist/v3/turns/${id}`); if (predicate(item)) return item; await delay(25); } throw new Error(`turn_timeout:${id}`); }
async function waitForOperation(sessionId, predicate) { for (let count = 0; count < 240; count++) { const items = await api(port, `/assist/v3/operations?session_id=${encodeURIComponent(sessionId)}`); const item = items.find(predicate); if (item) return item; await delay(25); } throw new Error('operation_timeout'); }
function git(cwd, args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result; }
function normalize(value) { return value.replaceAll('\r\n', '\n'); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
