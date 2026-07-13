import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { api, cleanup, createConfirmedProject, makeFixture, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v15-host-bridge-'), source = path.join(fixture.root, 'source'); fs.mkdirSync(source);
git(source, ['init']); git(source, ['config', 'user.name', 'Bridge Flow']); git(source, ['config', 'user.email', 'bridge-flow@example.test']);
fs.writeFileSync(path.join(source, 'README.md'), '# bridge baseline\n'); git(source, ['add', '.']); git(source, ['commit', '-m', 'baseline']);
const port = 4616;
let server, bridgeSocket, terminalSocket;

class FakeBridge {
  constructor(root) { this.root = path.join(root, 'fake-windows'); this.serverFrames = []; this.transfer = null; this.workspace = null; this.waiters = []; }
  attach(ws) { this.ws = ws; ws.on('message', (raw) => { const item = JSON.parse(String(raw)); this.serverFrames.push(item); void this.handle(item).then(() => this.flush()); }); }
  waitFor(predicate) { const found = this.serverFrames.find(predicate); if (found) return Promise.resolve(found); return new Promise((resolve, reject) => this.waiters.push({ predicate, resolve, reject, deadline: Date.now() + 20_000 })); }
  flush() { for (const item of [...this.waiters]) { const found = this.serverFrames.find(item.predicate); if (found) { this.waiters.splice(this.waiters.indexOf(item), 1); item.resolve(found); } else if (Date.now() > item.deadline) item.reject(new Error('fake_bridge_timeout')); } }
  send(value) { this.ws.send(JSON.stringify(value)); }
  async handle(item) {
    if (item.type === 'workspace_begin') { fs.mkdirSync(this.root, { recursive: true }); this.transfer = { ...item, chunks: [] }; return; }
    if (item.type === 'workspace_chunk') { assert.equal(item.sequence, this.transfer.chunks.length); this.transfer.chunks.push(Buffer.from(item.chunk, 'base64')); return; }
    if (item.type === 'workspace_end') return this.importWorkspace();
    if (item.type === 'terminal_start') { assert.ok(this.workspace); this.send({ type: 'terminal_started', session_id: item.session_id }); return; }
    if (item.type === 'terminal_input' && item.data.includes('finish')) return this.finishTerminal(item.session_id);
  }
  async importWorkspace() {
    const bytes = Buffer.concat(this.transfer.chunks); assert.equal(bytes.length, this.transfer.total_bytes); assert.equal(sha(bytes), this.transfer.sha256);
    const bundle = path.join(this.root, 'incoming.bundle'), repo = path.join(this.root, 'repo'); fs.writeFileSync(bundle, bytes); fs.rmSync(repo, { recursive: true, force: true }); fs.mkdirSync(repo);
    git(repo, ['init']); git(repo, ['fetch', '--no-tags', bundle, `${this.transfer.bundle_ref}:refs/remotes/aiws/import`]); git(repo, ['checkout', '-B', 'aiws', 'refs/remotes/aiws/import']);
    assert.equal(git(repo, ['rev-parse', 'HEAD']).stdout.trim(), this.transfer.head_commit); this.workspace = { repo, base: this.transfer.head_commit };
    this.send({ type: 'workspace_ready', session_id: this.transfer.session_id, transfer_id: this.transfer.transfer_id, cwd: repo, base_commit: this.transfer.base_commit, head_commit: this.transfer.head_commit });
  }
  async finishTerminal(sessionId) {
    fs.writeFileSync(path.join(this.workspace.repo, 'WINDOWS.txt'), 'changed on Windows bridge\n'); git(this.workspace.repo, ['add', '-A']); git(this.workspace.repo, ['-c', 'user.name=Fake Bridge', '-c', 'user.email=fake@bridge.invalid', 'commit', '-m', 'windows change']);
    const head = git(this.workspace.repo, ['rev-parse', 'HEAD']).stdout.trim(), bundle = path.join(this.root, 'return.bundle'); git(this.workspace.repo, ['bundle', 'create', bundle, 'refs/heads/aiws']);
    const bytes = fs.readFileSync(bundle), transferId = 'return_fake_v15'; this.send({ type: 'terminal_output', session_id: sessionId, data: 'WINDOWS:READY\r\n' });
    this.send({ type: 'workspace_return_begin', session_id: sessionId, transfer_id: transferId, base_commit: this.workspace.base, head_commit: head, total_bytes: bytes.length, sha256: sha(bytes) });
    for (let offset = 0, sequence = 0; offset < bytes.length; offset += 512 * 1024, sequence++) this.send({ type: 'workspace_return_chunk', session_id: sessionId, transfer_id: transferId, sequence, chunk: bytes.subarray(offset, offset + 512 * 1024).toString('base64') });
    this.send({ type: 'workspace_return_end', session_id: sessionId, transfer_id: transferId }); this.send({ type: 'terminal_exit', session_id: sessionId, exit_code: 0 });
  }
}

try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const project = await createConfirmedProject({ baseUrl: `http://127.0.0.1:${port}`, title: 'Windows Bridge Flow', goal: 'round trip', source });
  await api(port, '/codex/auth/device/start', 'POST', { adapter: 'test' });
  const profile = await api(port, '/codex/profiles', 'POST', { name: 'Bridge profile', provider: 'openai', model: 'gpt-bridge', reasoning: 'high', mounts: [] }, 201);
  const pairing = await api(port, '/assist/v3/host-bridge/pairing', 'POST', {});
  const exchanged = await api(port, '/assist/v3/host-bridge/pairing', 'POST', { action: 'exchange', pairing_code: pairing.pairing_code, protocol_version: 1, bridge_version: '1.5.0', device_name: 'Fake Windows' }, 201);
  await api(port, '/assist/v3/host-bridge/pairing', 'POST', { action: 'exchange', pairing_code: pairing.pairing_code, protocol_version: 1, bridge_version: '1.5.0' }, 401, 'host_bridge_pairing_invalid_or_expired');

  const fake = new FakeBridge(fixture.root);
  bridgeSocket = new WebSocket(`ws://127.0.0.1:${port}/api/assist/v3/host-bridge/ws?device_id=${encodeURIComponent(exchanged.device.id)}`, { headers: { Authorization: `Bearer ${exchanged.credential}` } });
  fake.attach(bridgeSocket);
  await onceOpen(bridgeSocket);
  bridgeSocket.send(JSON.stringify({ type: 'hello', protocol_version: 1, bridge_version: '1.5.0', capabilities: { os: 'windows', arch: 'amd64', conpty: true, codex_available: true, codex_version: 'codex-cli 0.144.0', code_page: 'utf-8' } }));
  await fake.waitFor((item) => item.type === 'hello_ack');
  const capability = await api(port, '/assist/v3/terminal-capabilities');
  assert.equal(capability.windows_bridge.available, true); assert.equal(capability.windows_bridge.device_id, exchanged.device.id);

  const terminal = await api(port, '/assist/v3/terminal-sessions', 'POST', { project_id: project.project.id, assist_session_id: project.draft.assist_session.id, profile_id: profile.id, runtime: 'windows_bridge', cols: 100, rows: 30 }, 201);
  assert.equal(terminal.runtime, 'windows_bridge'); assert.ok(terminal.change_batch_id);
  terminalSocket = new WebSocket(`ws://127.0.0.1:${port}/api/assist/v3/terminal-sessions/${terminal.id}/ws`);
  const terminalMessages = []; terminalSocket.on('message', (raw) => terminalMessages.push(JSON.parse(String(raw))));
  await onceOpen(terminalSocket);
  await waitFor(() => terminalMessages.some((item) => item.type === 'status' && item.session?.status === 'connected'));
  await fake.waitFor((item) => item.type === 'terminal_start' && item.session_id === terminal.id);
  assert.equal(fake.serverFrames.some((item) => JSON.stringify(item).includes(exchanged.credential)), false);
  assert.equal(fake.serverFrames.some((item) => /api[_-]?key|oauth|authorization/i.test(JSON.stringify(item))), false);

  const competing = await api(port, `/assist/v3/sessions/${project.draft.assist_session.id}/turns`, 'POST', { adapter: 'test', collaboration_mode: 'default', content: 'must lose Windows write lock', test_response: { message: 'must not write', files: [{ path: 'LOCKED.txt', content: 'no\n' }] } }, 202);
  const locked = await waitTurn(competing.id, 'failed');
  assert.equal(locked.error_code, 'assist_change_batch_locked');
  terminalSocket.send(JSON.stringify({ type: 'input', data: 'finish\r' }));
  await waitFor(() => terminalMessages.some((item) => item.type === 'output' && item.data.includes('WINDOWS:READY')));
  const exit = await waitForValue(() => terminalMessages.find((item) => item.type === 'exit'));
  assert.equal(exit.session.status, 'exited'); assert.equal(exit.session.exit_code, 0);
  const settled = await api(port, `/assist/v3/terminal-sessions/${terminal.id}`);
  assert.ok(settled.artifact_file_ref_id); assert.match(settled.output_preview, /WINDOWS:READY/);
  const review = await api(port, `/assist/v3/change-batches/${terminal.change_batch_id}/review`);
  assert.equal(review.changed_files.some((item) => item.path === 'WINDOWS.txt'), true);
  assert.equal(review.checkpoints.some((item) => item.source === 'windows_cli' && item.phase === 'before'), true);
  assert.equal(review.checkpoints.some((item) => item.source === 'windows_cli' && item.phase === 'after'), true);
  await api(port, `/assist/v3/change-batches/${terminal.change_batch_id}/review/apply`, 'POST', { target_hash: review.target_hash });
  assert.equal(normalize(fs.readFileSync(path.join(project.managedRepo, 'WINDOWS.txt'), 'utf8')), 'changed on Windows bridge\n');
  assert.equal(fs.existsSync(path.join(project.managedRepo, 'LOCKED.txt')), false);
  const stateText = fs.readFileSync(path.join(fixture.home, 'data', 'state.json'), 'utf8');
  assert.equal(stateText.includes(exchanged.credential), false); assert.equal(stateText.includes(pairing.pairing_code), false);
  assert.ok(fake.serverFrames.some((item) => item.type === 'workspace_return_ack'));
  console.log('V1.5 Windows Host Bridge integration tests passed');
} finally {
  terminalSocket?.close(); bridgeSocket?.close(); await server?.stop(); if (process.env.AIWS_KEEP_BRIDGE_FIXTURE === '1') console.error(`fixture:${fixture.root}`); else cleanup(fixture.root);
}

async function waitTurn(id, status) { return waitForValue(async () => { const item = await api(port, `/assist/v3/turns/${id}`); return item.status === status ? item : null; }); }
async function waitFor(predicate) { await waitForValue(() => predicate() ? true : null); }
async function waitForValue(producer) { for (let count = 0; count < 400; count++) { const value = await producer(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 25)); } throw new Error('condition_timeout'); }
function onceOpen(ws) { return ws.readyState === WebSocket.OPEN ? Promise.resolve() : new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); }
function git(cwd, args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`); return result; }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function normalize(value) { return value.replaceAll('\r\n', '\n'); }
