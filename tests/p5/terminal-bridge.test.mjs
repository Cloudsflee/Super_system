import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../../apps/api/src/clean/canonical.mjs';
import { start as startBridge } from '../../apps/windows-native-bridge/server.mjs';
import { close, createAssistPrerequisites, createProject, createWorkspace, open } from './helpers.mjs';

class FakePtyProcess {
  constructor() { this.dataListeners = []; this.exitListeners = []; this.writes = []; }
  onData(listener) { this.dataListeners.push(listener); }
  onExit(listener) { this.exitListeners.push(listener); }
  write(value) { this.writes.push(String(value)); }
  resize(cols, rows) { this.size = { cols, rows }; }
  emit(value) { for (const listener of this.dataListeners) listener(value); }
  kill() { for (const listener of this.exitListeners.splice(0)) listener({ exitCode: 0 }); }
}

test('Terminal consumes one approval, replays by idempotency and persists redacted cursor output', async () => {
  const children = [];
  const state = await open({ pty: { spawn: () => { const child = new FakePtyProcess(); children.push(child); return child; } } });
  try {
    const project = await createProject(state, 'terminal');
    const { workspace } = await createWorkspace(state, project, 'terminal');
    const approval = await state.runtime.assist.createApproval({
      project_id: project.id, action: 'terminal.open', request: { workspace_id: workspace.id },
      expected_revision: 0, idempotency_key: 'p5-terminal-approval-key'
    }, state.principal);
    await state.runtime.assist.decideApproval(approval.approval.id, {
      decision: 'approved', expected_revision: approval.approval.revision,
      idempotency_key: 'p5-terminal-decision-key'
    }, state.principal);
    const request = {
      project_id: project.id, workspace_id: workspace.id, approval_id: approval.approval.id,
      runtime: process.platform === 'win32' ? 'windows_native' : 'linux_native',
      expected_revision: 0, idempotency_key: 'p5-terminal-open-key'
    };
    const opened = await state.runtime.terminal.open(request, state.principal);
    const replayed = await state.runtime.terminal.open(request, state.principal);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.terminal.id, opened.terminal.id);
    assert.equal(children.length, 1);

    children[0].emit('prefix sk-');
    children[0].emit(`abcdefghijklmnop suffix ${state.root}\n`);
    let terminal = state.runtime.terminal.get(opened.terminal.id, state.principal);
    await state.runtime.terminal.input(terminal.id, { client_sequence: 1, expected_revision: terminal.revision, data: 'echo ok\n' }, state.principal);
    terminal = state.runtime.terminal.get(terminal.id, state.principal);
    await assert.rejects(() => state.runtime.terminal.resize(terminal.id, { client_sequence: 2, expected_revision: terminal.revision + 1, cols: 100, rows: 30, idempotency_key: 'p5-terminal-resize-conflict' }, state.principal), (error) => error.code === 'revision_conflict');
    assert.equal(state.runtime.terminal.get(terminal.id, state.principal).last_client_sequence, 1);
    const resizeRequest = { client_sequence: 2, expected_revision: terminal.revision, cols: 100, rows: 30, idempotency_key: 'p5-terminal-resize-key' };
    const resized = await state.runtime.terminal.resize(terminal.id, resizeRequest, state.principal);
    const resizeReplay = await state.runtime.terminal.resize(terminal.id, resizeRequest, state.principal);
    assert.equal(resizeReplay.replayed, true);
    assert.equal(resizeReplay.cursor, resized.cursor);
    terminal = state.runtime.terminal.get(terminal.id, state.principal);
    const stopRequest = { client_sequence: 3, expected_revision: terminal.revision, idempotency_key: 'p5-terminal-stop-key' };
    await state.runtime.terminal.stop(terminal.id, stopRequest, state.principal);
    assert.equal((await state.runtime.terminal.stop(terminal.id, stopRequest, state.principal)).replayed, true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    terminal = state.runtime.terminal.get(terminal.id, state.principal);
    const replay = state.runtime.terminal.eventsFor(terminal.id, { cursor: 0 }, state.principal);
    const output = replay.events.filter((event) => event.type === 'terminal.output').map((event) => event.data.chunk).join('');
    assert.equal(terminal.status, 'stopped');
    assert.equal(output.includes('abcdefghijklmnop'), false);
    assert.equal(output.includes(state.root), false);
    assert.match(output, /\[redacted\]/);
    assert.equal(state.runtime.operations.get(opened.operation.operation_id, { actorId: state.principal.actorId }).status, 'succeeded');
    assert.equal(state.runtime.db.get('SELECT status FROM repository_workspaces WHERE id=?', [workspace.id]).status, 'released');
    assert.equal(state.runtime.db.integrity().semantic.valid, true);
  } finally { await close(state); }
});

test('Windows Bridge pairing shares one secret, rejects nonce replay, rotates and revokes both stores', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'p5-bridge-test-'));
  const bridgeRoot = path.join(root, 'bridge');
  const bridge = await startBridge({ port: 0, stateRoot: bridgeRoot });
  const state = await open({ config: { bridgeUrl: bridge.url } });
  try {
    const paired = await state.runtime.bridge.pair({ label: 'Local Bridge', expected_revision: 0, idempotency_key: 'p5-bridge-pair-key' }, state.principal);
    const replayed = await state.runtime.bridge.pair({ label: 'Local Bridge', expected_revision: 0, idempotency_key: 'p5-bridge-pair-key' }, state.principal);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.device.id, paired.device.id);
    const row = state.runtime.db.get('SELECT * FROM bridge_devices WHERE id=?', [paired.device.id]);
    const secret = state.runtime.vault.read(row.shared_secret_ref);
    assert.equal(secret.length, 32);
    const secretRef = row.shared_secret_ref.replace(/^vault:/, '');
    const protectedFile = path.join(bridgeRoot, `${secretRef}.protected`);
    assert.equal(fs.existsSync(protectedFile), true);
    assert.equal(fs.readFileSync(protectedFile).includes(secret), false);

    const body = { probe: true };
    const timestamp = String(Date.now());
    const nonce = 'fixed_nonce_value_123456';
    const bodyHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
    const signature = createHmac('sha256', secret).update(`${timestamp}\n${nonce}\n${bodyHash}`).digest('hex');
    const headers = { 'content-type': 'application/json', 'x-aiws-secret-ref': secretRef, 'x-aiws-timestamp': timestamp, 'x-aiws-nonce': nonce, 'x-aiws-signature': signature };
    assert.equal((await fetch(`${bridge.url}/v1/probe`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 200);
    assert.equal((await fetch(`${bridge.url}/v1/probe`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 409);

    const firstProbe = await state.runtime.bridge.probe(paired.device.id, { expected_revision: paired.device.revision, idempotency_key: 'p5-bridge-probe-one' }, state.principal);
    const probeReplay = await state.runtime.bridge.probe(paired.device.id, { expected_revision: paired.device.revision, idempotency_key: 'p5-bridge-probe-one' }, state.principal);
    assert.equal(probeReplay.replayed, true);
    const rotated = await state.runtime.bridge.rotate(paired.device.id, { expected_revision: firstProbe.device.revision, idempotency_key: 'p5-bridge-rotate-key' }, state.principal);
    const secondProbe = await state.runtime.bridge.probe(paired.device.id, { expected_revision: rotated.device.revision, idempotency_key: 'p5-bridge-probe-two' }, state.principal);
    const revoked = await state.runtime.bridge.revoke(paired.device.id, { expected_revision: secondProbe.device.revision, idempotency_key: 'p5-bridge-revoke-key' }, state.principal);
    assert.equal(revoked.device.status, 'revoked');
    assert.equal(fs.existsSync(protectedFile), false);
    assert.equal(state.runtime.vault.has(row.shared_secret_ref), false);
    assert.equal(state.runtime.db.integrity().semantic.valid, true);
  } finally {
    await close(state);
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Assist Terminal approvals bind project, workspace revision and session, then return one operation reference', async () => {
  const children = [];
  const state = await open({ pty: { spawn: () => { const child = new FakePtyProcess(); children.push(child); return child; } } });
  try {
    const project = await createProject(state, 'assist-terminal');
    const foreignProject = await createProject(state, 'assist-terminal-foreign');
    const { workspace } = await createWorkspace(state, project, 'assist-terminal');
    const { pack, profile } = await createAssistPrerequisites(state, project, 'assist-terminal');
    const { session } = await state.runtime.assist.createSession({ project_id: project.id, scope: 'project', scope_id: project.id, context_pack_id: pack.id, profile_id: profile.id, idempotency_key: 'assist-terminal-session' }, state.principal);
    const runtime = process.platform === 'win32' ? 'windows_native' : 'linux_native';
    const { approval } = await state.runtime.assist.createApproval({ project_id: project.id, action: 'terminal.open', request: { workspace_id: workspace.id, assist_session_id: session.id, runtime, cwd: '', cols: 120, rows: 32, command: 'echo fixture' }, expected_revision: workspace.revision, idempotency_key: 'assist-terminal-approval' }, state.principal);
    const input = { project_id: project.id, workspace_id: workspace.id, assist_session_id: session.id, approval_id: approval.id, runtime, cwd: '', cols: 120, rows: 32, expected_revision: workspace.revision, idempotency_key: 'assist-terminal-open' };
    await assert.rejects(() => state.runtime.terminal.open(input, state.principal), (error) => error.code === 'approval_required');
    const decision = { decision: 'approved', expected_revision: approval.revision, idempotency_key: 'assist-terminal-approve' };
    await state.runtime.assist.decideApproval(approval.id, decision, state.principal);
    assert.equal((await state.runtime.assist.decideApproval(approval.id, decision, state.principal)).replayed, true);
    await assert.rejects(() => state.runtime.terminal.open({ ...input, expected_revision: workspace.revision + 1 }, state.principal), (error) => error.code === 'revision_conflict');
    await assert.rejects(() => state.runtime.terminal.open({ ...input, assist_session_id: null }, state.principal), (error) => error.code === 'approval_request_mismatch');
    await assert.rejects(() => state.runtime.terminal.open({ ...input, cwd: 'other' }, state.principal), (error) => error.code === 'approval_request_mismatch');
    const foreignApproval = await state.runtime.assist.createApproval({ project_id: foreignProject.id, action: 'terminal.open', request: { assist_session_id: session.id }, expected_revision: 0, idempotency_key: 'assist-terminal-foreign-approval' }, state.principal);
    await state.runtime.assist.decideApproval(foreignApproval.approval.id, { decision: 'approved', expected_revision: 1, idempotency_key: 'assist-terminal-foreign-decision' }, state.principal);
    const foreignWorkspace = await createWorkspace(state, foreignProject, 'assist-terminal-foreign');
    await assert.rejects(() => state.runtime.terminal.open({ ...input, project_id: foreignProject.id, workspace_id: foreignWorkspace.workspace.id, approval_id: foreignApproval.approval.id, expected_revision: 0, idempotency_key: 'assist-terminal-foreign-open' }, state.principal), (error) => error.code === 'assist_session_mismatch');
    assert.equal(children.length, 0);
    const opened = await state.runtime.terminal.open(input, state.principal);
    assert.equal((await state.runtime.terminal.open(input, state.principal)).replayed, true);
    assert.equal(opened.terminal.assist_session_id, session.id);
    assert.equal(children.length, 1);
    assert.equal(state.runtime.db.get("SELECT aggregate_id FROM operation_links WHERE operation_id=? AND aggregate_type='assist_session'", [opened.operation.operation_id]).aggregate_id, session.id);
    assert.equal(children[0].writes.length, 0);
    children[0].emit(`result sk-abcdefghijklmnop ${state.root}\n`);
    children[0].kill();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const terminal = state.runtime.terminal.get(opened.terminal.id, state.principal);
    assert.equal(terminal.exit_code, 0);
    assert.equal(terminal.output_preview.includes('abcdefghijklmnop'), false);
    assert.equal(terminal.output_preview.includes(state.root), false);
    const referenceInput = { reference_type: 'operation', reference_id: terminal.operation_id, reference_hash: terminal.output_sha256, expected_revision: session.revision, idempotency_key: 'assist-terminal-reference' };
    await assert.rejects(() => state.runtime.assist.createReference(session.id, { ...referenceInput, reference_hash: 'invalid' }, state.principal), (error) => error.code === 'schema_invalid');
    const linked = await state.runtime.assist.createReference(session.id, referenceInput, state.principal);
    assert.equal(linked.references[0].reference_id, terminal.operation_id);
    assert.equal(linked.references[0].reference_hash, terminal.output_sha256);
    assert.equal((await state.runtime.assist.createReference(session.id, referenceInput, state.principal)).replayed, true);
    await assert.rejects(() => state.runtime.assist.createReference(session.id, { ...referenceInput, idempotency_key: 'assist-terminal-reference-stale' }, state.principal), (error) => error.code === 'revision_conflict');
    assert.equal(state.runtime.db.integrity().semantic.valid, true);
  } finally { await close(state); }
});
