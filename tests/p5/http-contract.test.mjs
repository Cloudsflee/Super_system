import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { start as startCleanServer } from '../../apps/api/clean-server.mjs';
import { close, closeServer, createAssistPrerequisites, createProject, createWorkspace, listen, open, waitForOperation } from './helpers.mjs';

function headers(proof, key, revision) {
  return {
    cookie: `aiws_session=${proof}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'Idempotency-Key': key,
    'X-Expected-Revision': String(revision)
  };
}

async function json(response) {
  const body = await response.json();
  return { response, body };
}

test('P5 HTTP uses one v2 envelope, strict mutation headers and operation receipts', async () => {
  const state = await open();
  const { server, base } = await listen(state.runtime);
  try {
    const project = await createProject(state, 'http-contract');
    const prerequisites = await createAssistPrerequisites(state, project, 'http-contract');
    const listed = await json(await fetch(`${base}/api/v2/assist/sessions?project_id=${project.id}`, { headers: { cookie: `aiws_session=${state.proof}` } }));
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.meta.api_version, '2');
    assert.ok(Array.isArray(listed.body.data.sessions));
    assert.match(listed.body.meta.etag, /^rev-/);

    const created = await json(await fetch(`${base}/api/v2/assist/sessions`, {
      method: 'POST',
      headers: headers(state.proof, 'p5-http-session-key', 0),
      body: JSON.stringify({ project_id: project.id, scope: 'project', scope_id: project.id, context_pack_id: prerequisites.pack.id, profile_id: prerequisites.profile.id })
    }));
    assert.equal(created.response.status, 201);
    assert.equal(created.body.data.session.scope, 'project');
    assert.equal(created.response.headers.get('idempotency-key'), null);
    assert.match(created.response.headers.get('etag'), /^rev-1-/);

    const session = created.body.data.session;
    const replay = await json(await fetch(`${base}/api/v2/assist/sessions`, {
      method: 'POST',
      headers: headers(state.proof, 'p5-http-session-key', 0),
      body: JSON.stringify({ project_id: project.id, scope: 'project', scope_id: project.id, context_pack_id: prerequisites.pack.id, profile_id: prerequisites.profile.id })
    }));
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.data.replayed, true);

    const missingHeader = await json(await fetch(`${base}/api/v2/assist/sessions/${session.id}/pause`, {
      method: 'POST',
      headers: { cookie: `aiws_session=${state.proof}`, 'content-type': 'application/json', 'Idempotency-Key': 'p5-http-pause-key' },
      body: '{}'
    }));
    assert.equal(missingHeader.response.status, 400);
    assert.equal(missingHeader.body.error.code, 'expected_revision_required');

    const turn = await json(await fetch(`${base}/api/v2/assist/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: headers(state.proof, 'p5-http-turn-key', session.revision),
      body: JSON.stringify({ message: 'HTTP turn', fixture: { assistant: 'done' } })
    }));
    assert.equal(turn.response.status, 202);
    assert.ok(['queued', 'running', 'succeeded'].includes(turn.body.data.status));
    const operation = await waitForOperation(state.runtime, turn.body.data.operation_id, state.principal.actorId);
    assert.equal(operation.status, 'succeeded');

    const unknown = await json(await fetch(`${base}/api/v2/assist/sessions?project_id=${project.id}&unexpected=1`, { headers: { cookie: `aiws_session=${state.proof}` } }));
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.body.error.code, 'unknown_field');
  } finally {
    await closeServer(server);
    await close(state);
  }
});

test('P5 attachment content supports negotiated binary and JSON representations', async () => {
  const state = await open();
  const { server, base } = await listen(state.runtime);
  try {
    const project = await createProject(state, 'http-attachment');
    const content = Buffer.from('binary attachment body');
    const created = await json(await fetch(`${base}/api/v2/projects/${project.id}/attachments`, {
      method: 'POST',
      headers: headers(state.proof, 'p5-http-attachment-key', 0),
      body: JSON.stringify({ filename: 'body.txt', media_type: 'text/plain', content_base64: content.toString('base64') })
    }));
    assert.equal(created.response.status, 201);
    const id = created.body.data.attachment.id;
    const binary = await fetch(`${base}/api/v2/attachments/${id}/content`, { headers: { cookie: `aiws_session=${state.proof}`, accept: 'application/octet-stream' } });
    assert.equal(binary.status, 200);
    assert.equal(binary.headers.get('content-type'), 'text/plain');
    assert.deepEqual(Buffer.from(await binary.arrayBuffer()), content);
    const preview = await json(await fetch(`${base}/api/v2/attachments/${id}/preview`, { headers: { cookie: `aiws_session=${state.proof}`, accept: 'application/json' } }));
    assert.equal(preview.response.status, 200);
    assert.equal(Buffer.from(preview.body.data.content_base64, 'base64').toString(), content.toString());
  } finally {
    await closeServer(server);
    await close(state);
  }
});

test('P5 terminal HTTP route keeps revision and replay cursor contracts', async () => {
  const children = [];
  class FakePty {
    onData(fn) { this.data = fn; }
    onExit(fn) { this.exit = fn; }
    write() {}
    resize() {}
    kill() { this.exit?.({ exitCode: 0 }); }
  }
  const state = await open({ pty: { spawn: () => { const child = new FakePty(); children.push(child); return child; } } });
  const { server, base } = await listen(state.runtime);
  try {
    const project = await createProject(state, 'http-terminal');
    const { workspace } = await createWorkspace(state, project, 'http-terminal');
    const approval = await state.runtime.assist.createApproval({ project_id: project.id, action: 'terminal.open', request: { workspace_id: workspace.id }, expected_revision: 0, idempotency_key: 'p5-http-terminal-approval' }, state.principal);
    const decided = await state.runtime.assist.decideApproval(approval.approval.id, { decision: 'approved', expected_revision: approval.approval.revision, idempotency_key: 'p5-http-terminal-decision' }, state.principal);
    const opened = await json(await fetch(`${base}/api/v2/terminals`, {
      method: 'POST',
      headers: headers(state.proof, 'p5-http-terminal-open', 0),
      body: JSON.stringify({ project_id: project.id, workspace_id: workspace.id, approval_id: approval.approval.id, runtime: process.platform === 'win32' ? 'windows_native' : 'linux_native' })
    }));
    assert.equal(opened.response.status, 201);
    assert.ok(children.length === 1);
    const terminal = opened.body.data.terminal;
    const event = await json(await fetch(`${base}/api/v2/terminals/${terminal.id}/events?cursor=0`, { headers: { cookie: `aiws_session=${state.proof}` } }));
    assert.equal(event.response.status, 200);
    assert.ok(Array.isArray(event.body.data.events));
    const conflict = await json(await fetch(`${base}/api/v2/terminals/${terminal.id}/resize`, { method: 'POST', headers: headers(state.proof, 'p5-http-terminal-resize', terminal.revision + 1), body: JSON.stringify({ client_sequence: 1, cols: 100, rows: 30 }) }));
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, 'revision_conflict');
    await fetch(`${base}/api/v2/terminals/${terminal.id}/stop`, { method: 'POST', headers: headers(state.proof, 'p5-http-terminal-stop', terminal.revision), body: JSON.stringify({ client_sequence: 1 }) });
    void decided;
  } finally {
    await closeServer(server);
    await close(state);
  }
});

test('P5 terminal WebSocket upgrades, replays cursor and acknowledges sequenced input', async () => {
  const children = [];
  class FakePty {
    onData(fn) { this.data = fn; }
    onExit(fn) { this.exit = fn; }
    write(value) { this.lastWrite = String(value); }
    resize() {}
    kill() { this.exit?.({ exitCode: 0 }); }
    emit(value) { this.data?.(value); }
  }
  const state = await open({ pty: { spawn: () => { const child = new FakePty(); children.push(child); return child; } } });
  let running;
  try {
    const project = await createProject(state, 'http-ws');
    const { workspace } = await createWorkspace(state, project, 'http-ws');
    const approval = await state.runtime.assist.createApproval({
      project_id: project.id, action: 'terminal.open', request: { workspace_id: workspace.id },
      expected_revision: 0, idempotency_key: 'p5-http-ws-approval'
    }, state.principal);
    await state.runtime.assist.decideApproval(approval.approval.id, {
      decision: 'approved', expected_revision: approval.approval.revision, idempotency_key: 'p5-http-ws-decision'
    }, state.principal);
    const opened = await state.runtime.terminal.open({
      project_id: project.id, workspace_id: workspace.id, approval_id: approval.approval.id,
      runtime: process.platform === 'win32' ? 'windows_native' : 'linux_native', expected_revision: 0,
      idempotency_key: 'p5-http-ws-open'
    }, state.principal);
    const terminal = opened.terminal;
    running = await startCleanServer({ runtime: state.runtime });
    const port = running.server.address().port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v2/terminals/${terminal.id}/ws?cursor=0`, {
      headers: { Cookie: `aiws_session=${state.proof}` }
    });
    const messages = [];
    ws.on('message', (value) => messages.push(JSON.parse(value.toString('utf8'))));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(messages.some((message) => message.type === 'status'));
    children[0].emit(`ws output ${'x'.repeat(600)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(messages.some((message) => message.type === 'output' && message.data.includes('ws output')));
    const current = state.runtime.terminal.get(terminal.id, state.principal);
    ws.send(JSON.stringify({ type: 'input', revision: current.revision, client_sequence: current.last_client_sequence + 1, data: 'echo ws\n' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(messages.some((message) => message.type === 'ack' && message.action === 'input'));
    ws.close();
    await new Promise((resolve) => ws.once('close', resolve));
  } finally {
    if (running) await running.close();
    else state.runtime.close();
    await closeServer(null);
    // The server owns the runtime after start(); remove only the fixture root.
    const fs = await import('node:fs');
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});
