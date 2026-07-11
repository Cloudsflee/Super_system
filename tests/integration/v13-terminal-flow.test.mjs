import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { api, cleanup, createConfirmedProject, makeFixture, repositorySnapshot, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v13-terminal-');
const source = path.join(fixture.root, 'external-repo');
fs.mkdirSync(source);
run('git', ['init'], source);
run('git', ['config', 'user.email', 'terminal@example.test'], source);
run('git', ['config', 'user.name', 'Terminal Test'], source);
fs.writeFileSync(path.join(source, 'README.md'), '# Terminal baseline\n', 'utf8');
run('git', ['add', '.'], source);
run('git', ['commit', '-m', 'init'], source);
const sourceBefore = repositorySnapshot(source);
const port = await freePort();
let server;
let terminalId;
const openTerminalIds = new Set();

try {
  server = await startApi({
    port, home: fixture.home, ccSwitch: fixture.ccSwitch,
    env: { AIWS_CODEX_BIN: process.execPath, NODE_REPL_HISTORY: '' }
  });
  const project = await createConfirmedProject({
    baseUrl: `http://127.0.0.1:${port}`,
    title: 'Terminal PTY', goal: '验证真实 PTY 闭环', source
  });
  const profile = installHostProfile(fixture.home);
  const capability = await api(port, '/assist/v3/terminal-capabilities');
  assert.equal(capability.available, true);
  assert.equal(capability.transport, 'node-pty+websocket');

  const terminal = await api(port, '/assist/v3/terminal-sessions', 'POST', {
    project_id: project.project.id,
    assist_session_id: project.draft.assist_session.id,
    profile_id: profile.id,
    cols: 100,
    rows: 28
  }, 201);
  terminalId = terminal.id;
  openTerminalIds.add(terminal.id);
  assert.equal(terminal.runtime, 'host');
  assert.equal(terminal.status, 'ready');

  const first = await connect(port, terminal.id);
  await first.waitFor((messages) => messages.some((item) => item.type === 'status' && item.session?.status === 'connected'));
  first.send({ type: 'ping' });
  await first.waitFor((messages) => messages.some((item) => item.type === 'pong'));
  first.send({ type: 'resize', cols: 77, rows: 19 });
  first.send({ type: 'input', data: "console.log(['AIWS','READY','OK'].join(':'))\r" });
  await first.waitForOutput('AIWS:READY:OK');

  first.send({ type: 'input', data: "require('node:fs').writeFileSync('CANCEL.txt'," });
  await first.waitForOutput('CANCEL.txt');
  first.send({ type: 'signal', signal: 'SIGINT' });
  await delay(100);
  assert.equal(fs.existsSync(path.join(worktreePath(fixture.home, terminal.worktree_id), 'CANCEL.txt')), false);

  await first.close();
  const second = await connect(port, terminal.id);
  await second.waitFor((messages) => messages.some((item) => item.type === 'output' && item.replay === true && item.data.includes('AIWS:READY:OK')));
  second.send({
    type: 'input',
    data: "require('node:fs').writeFileSync('README.md','# Terminal managed change\\n');console.log(['AIWS','WRITE','OK'].join(':'))\r"
  });
  await second.waitForOutput('AIWS:WRITE:OK');
  second.send({ type: 'input', data: `console.log(['AIWS','HOME',process.env.CODEX_HOME===${JSON.stringify(profile.codex_home)}?'OK':'BAD'].join(':'))\r` });
  await second.waitForOutput('AIWS:HOME:OK');
  second.send({ type: 'input', data: "console.log(process.env.OPENAI_API_KEY)\r" });
  await second.waitForOutput('***MASKED***');
  second.send({ type: 'input', data: "console.log('AIWS:LONG:BEGIN'+'x'.repeat(32000)+':END')\r" });
  await second.waitForOutput(':END');
  second.send({ type: 'input', data: 'process.exit(0)\r' });
  const exited = await second.waitFor((messages) => messages.find((item) => item.type === 'exit'));
  assert.equal(exited.session.status, 'exited');
  assert.equal(exited.session.exit_code, 0);

  const settled = await api(port, `/assist/v3/terminal-sessions/${terminal.id}`);
  assert.ok(settled.artifact_file_ref_id);
  assert.equal(settled.output_truncated, true);
  assert.ok(settled.output_preview.length <= 30000);
  assert.equal(settled.output_preview.includes(profile.secret), false);
  const state = readFixtureState(fixture.home);
  const artifact = state.file_refs.find((item) => item.id === settled.artifact_file_ref_id);
  assert.ok(artifact && fs.existsSync(artifact.absolute_path));
  assert.equal(artifact.meta.complete, true);
  const terminalLog = fs.readFileSync(artifact.absolute_path, 'utf8');
  assert.match(terminalLog, /AIWS:READY:OK/);
  assert.match(terminalLog, /AIWS:WRITE:OK/);
  assert.match(terminalLog, /AIWS:LONG:BEGIN/);
  assert.match(terminalLog, /:END/);
  assert.equal(terminalLog.includes(profile.secret), false);
  assert.equal(fs.readFileSync(statePath(fixture.home), 'utf8').includes(profile.secret), false);

  const review = await api(port, `/assist/v3/terminal-sessions/${terminal.id}/review`);
  assert.equal(review.changed_files.some((item) => item.path === 'README.md'), true);
  assert.match(review.diff, /Terminal managed change/);
  const applied = await api(port, `/assist/v3/terminal-sessions/${terminal.id}/review/apply`, 'POST', { target_hash: review.target_hash });
  assert.equal(normalize(fs.readFileSync(path.join(project.managedRepo, 'README.md'), 'utf8')), '# Terminal managed change\n');
  await api(port, `/assist/v3/terminal-sessions/${terminal.id}/review/rollback`, 'POST', { target_hash: applied.worktree.applied_target_hash });
  assert.equal(normalize(fs.readFileSync(path.join(project.managedRepo, 'README.md'), 'utf8')), '# Terminal baseline\n');
  assert.deepEqual(repositorySnapshot(source), sourceBefore);
  openTerminalIds.delete(terminal.id);

  const failedTerminal = await api(port, '/assist/v3/terminal-sessions', 'POST', { project_id: project.project.id, assist_session_id: project.draft.assist_session.id, profile_id: profile.id }, 201);
  openTerminalIds.add(failedTerminal.id);
  const failedSocket = await connect(port, failedTerminal.id);
  await failedSocket.waitFor((messages) => messages.some((item) => item.type === 'status' && item.session?.status === 'connected'));
  failedSocket.send({ type: 'input', data: 'process.exit(7)\r' });
  const abnormal = await failedSocket.waitFor((messages) => messages.find((item) => item.type === 'exit'));
  assert.equal(abnormal.session.status, 'failed');
  assert.equal(abnormal.session.exit_code, 7);
  const failedSettled = await api(port, `/assist/v3/terminal-sessions/${failedTerminal.id}`);
  assert.ok(failedSettled.artifact_file_ref_id);
  await api(port, `/assist/v3/terminal-sessions/${failedTerminal.id}/review/rollback`, 'POST', {});
  openTerminalIds.delete(failedTerminal.id);

  const stoppedTerminal = await api(port, '/assist/v3/terminal-sessions', 'POST', { project_id: project.project.id, assist_session_id: project.draft.assist_session.id, profile_id: profile.id }, 201);
  openTerminalIds.add(stoppedTerminal.id);
  const stoppedSocket = await connect(port, stoppedTerminal.id);
  await stoppedSocket.waitFor((messages) => messages.some((item) => item.type === 'status' && item.session?.status === 'connected'));
  const stopped = await api(port, `/assist/v3/terminal-sessions/${stoppedTerminal.id}/stop`, 'POST', {});
  assert.equal(stopped.status, 'stopped');
  await stoppedSocket.close();
  await api(port, `/assist/v3/terminal-sessions/${stoppedTerminal.id}/review/rollback`, 'POST', {});
  openTerminalIds.delete(stoppedTerminal.id);
  terminalId = null;
  console.log('V1.3 Terminal PTY integration tests passed');
} finally {
  if (terminalId) await api(port, `/assist/v3/terminal-sessions/${terminalId}/stop`, 'POST').catch(() => undefined);
  for (const id of openTerminalIds) await api(port, `/assist/v3/terminal-sessions/${id}/stop`, 'POST').catch(() => undefined);
  await server?.stop();
  cleanup(fixture.root);
}

function installHostProfile(home) {
  const state = readFixtureState(home), codexHome = path.join(home, 'codex-homes', 'terminal-test');
  fs.mkdirSync(codexHome, { recursive: true });
  const secret = 'terminal-secret-sentinel-v13';
  const secretId = 'terminal_test_credential';
  fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
  fs.writeFileSync(path.join(home, 'vault', `${secretId}.secret`), secret, 'utf8');
  state.integration_statuses = state.integration_statuses.filter((item) => item.key !== 'codex_auth');
  state.integration_statuses.push({ key: 'codex_auth', status: 'authenticated', provider: 'openai', auth_mode: 'api_key', refs: { credential: `vault:${secretId}` }, updated_at: new Date().toISOString() });
  for (const item of state.codex_profiles) item.is_active = false;
  const profile = { id: 'cdx_terminal_host', name: 'Terminal Host', kind: 'host', provider: 'openai', model: 'test-model', reasoning: 'medium', status: 'validated', is_active: true, codex_home: codexHome, mounts: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  state.codex_profiles.push(profile);
  fs.writeFileSync(statePath(home), JSON.stringify(state, null, 2), 'utf8');
  return { ...profile, secret };
}
function readFixtureState(home) { return JSON.parse(fs.readFileSync(statePath(home), 'utf8')); }
function statePath(home) { return path.join(home, 'data', 'state.json'); }
function worktreePath(home, id) { return readFixtureState(home).worktrees.find((item) => item.id === id).path; }
function connect(port, id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/assist/v3/terminal-sessions/${id}/ws`), messages = [];
    const timer = setTimeout(() => reject(new Error('terminal websocket did not open')), 5000);
    ws.on('open', () => { clearTimeout(timer); resolve({
      send: (value) => ws.send(JSON.stringify(value)),
      close: () => new Promise((done) => { if (ws.readyState === WebSocket.CLOSED) return done(); ws.once('close', done); ws.close(); }),
      waitFor: (predicate) => waitForMessages(messages, predicate),
      waitForOutput: (marker) => waitForMessages(messages, (items) => output(items).includes(marker))
    }); });
    ws.on('message', (raw) => { try { messages.push(JSON.parse(String(raw))); } catch {} });
    ws.on('error', reject);
  });
}
async function waitForMessages(messages, predicate) { for (let i = 0; i < 200; i++) { const result = predicate(messages); if (result) return result === true ? messages : result; await delay(25); } throw new Error(`terminal message timeout: ${JSON.stringify(messages.slice(-5))}`); }
function output(messages) { return messages.filter((item) => item.type === 'output').map((item) => item.data).join(''); }
function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); }); }
function run(command, args, cwd) { const result = spawnSync(command, args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); }
function normalize(value) { return value.replaceAll('\r\n', '\n'); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
