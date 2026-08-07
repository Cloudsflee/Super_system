import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { fixture, mutate, request } from './helpers.mjs';

test('terminal approval, real PTY, cursor replay, redaction, CAS artifact and orphan recovery', async () => {
  const env = await fixture();
  const sockets = new Set();
  try {
    const projectResponse = await mutate(env.base, '/api/v1/projects', { name: 'Terminal fixture' }, 'terminal-project');
    const project = projectResponse.json;
    fs.writeFileSync(path.join(env.home, 'projects', project.id, 'README.md'), '# terminal fixture\n', 'utf8');

    const capabilities = await request(env.base, '/api/v1/terminals/capabilities');
    assert.equal(capabilities.response.status, 200);
    assert.equal(capabilities.json.available, true);
    const runtime = capabilities.json.default_runtime;
    assert.equal(capabilities.json[runtime].available, true);

    const missingApproval = await mutate(env.base, '/api/v1/terminals', { project_id: project.id, runtime }, 'terminal-no-approval');
    assert.equal(missingApproval.response.status, 403);
    assert.equal(missingApproval.json.error.code, 'terminal_approval_required');

    const credentialSecret = 'terminal-secret-sentinel-123456';
    const credential = await mutate(env.base, '/api/v1/credentials', {
      provider: 'codex', label: 'Terminal redaction fixture', secret: credentialSecret
    }, 'terminal-secret');
    assert.equal(credential.response.status, 201);

    const approval = await mutate(env.base, `/api/v1/projects/${project.id}/approvals`, {
      action: 'terminal.open', request: { runtime }, ttl_seconds: 600
    }, 'terminal-approval');
    await mutate(env.base, `/api/v1/approvals/${approval.json.id}/decision`, { decision: 'approved' }, 'terminal-approve');
    const opened = await mutate(env.base, '/api/v1/terminals', {
      project_id: project.id, approval_id: approval.json.id, runtime, cols: 96, rows: 26
    }, 'terminal-open');
    assert.equal(opened.response.status, 201);
    assert.equal(opened.json.status, 'ready');
    assert.equal(opened.json.cwd, '');

    const reused = await mutate(env.base, '/api/v1/terminals', {
      project_id: project.id, approval_id: approval.json.id, runtime
    }, 'terminal-reuse-approval');
    assert.equal(reused.response.status, 409);
    assert.equal(reused.json.error.code, 'terminal_write_locked');

    const first = await connect(env.base, opened.json.id, 0);
    sockets.add(first.socket);
    await first.waitFor((messages) => messages.some((message) => message.type === 'status' && message.session?.status === 'running'));
    first.send({ type: 'resize', cols: 83, rows: 21 });
    await first.waitFor((messages) => messages.some((message) => message.type === 'ack' && message.action === 'resize'));
    first.send({ type: 'input', data: 'echo AIWS_TERMINAL_READY\r' });
    await first.waitForOutput('AIWS_TERMINAL_READY');
    first.send({ type: 'input', data: `echo ${credentialSecret.slice(0, 18)}` });
    first.send({ type: 'input', data: `${credentialSecret.slice(18)}\r` });
    await first.waitForOutput('[redacted]');
    assert.equal(first.output().includes(credentialSecret), false);
    const replayFrom = Math.max(0, ...first.messages.filter((message) => Number.isInteger(message.cursor)).map((message) => message.cursor)) - 2;
    await first.close();
    sockets.delete(first.socket);

    const second = await connect(env.base, opened.json.id, replayFrom);
    sockets.add(second.socket);
    await second.waitFor((messages) => messages.some((message) => message.type === 'output' && message.replay === true));
    assert.equal(second.output().includes(credentialSecret), false);
    second.send({ type: 'input', data: 'exit 0\r' });
    const exit = await second.waitFor((messages) => messages.find((message) => message.type === 'exit'));
    assert.equal(exit.session.status, 'exited');
    assert.equal(exit.session.exit_code, 0);
    assert.ok(exit.session.artifact_asset_id);
    await second.close();
    sockets.delete(second.socket);

    const settled = await request(env.base, `/api/v1/terminals/${opened.json.id}`);
    assert.equal(settled.json.status, 'exited');
    assert.match(settled.json.output_sha256, /^[a-f0-9]{64}$/);
    assert.equal(settled.json.output_preview.includes(credentialSecret), false);
    const artifact = await fetch(`${env.base}/api/v1/assets/${settled.json.artifact_asset_id}/content`);
    const artifactText = await artifact.text();
    assert.equal(artifact.status, 200);
    assert.match(artifactText, /AIWS_TERMINAL_READY/);
    assert.equal(artifactText.includes(credentialSecret), false);

    const events = await request(env.base, `/api/v1/terminals/${opened.json.id}/events?after=0`);
    assert.ok(events.json.some((event) => event.type === 'terminal.opened'));
    assert.ok(events.json.some((event) => event.type === 'terminal.started'));
    assert.ok(events.json.some((event) => event.type === 'terminal.closed'));
    assert.equal(JSON.stringify(events.json).includes(credentialSecret), false);
    const sse = await fetch(`${env.base}/api/v1/terminals/${opened.json.id}/events`, { headers: { accept: 'text/event-stream', 'Last-Event-ID': String(events.json.at(-2).cursor) } });
    assert.match(await sse.text(), /event: terminal\.closed/);

    const nextApproval = await mutate(env.base, `/api/v1/projects/${project.id}/approvals`, { action: 'terminal.open', ttl_seconds: 600 }, 'terminal-orphan-approval');
    await mutate(env.base, `/api/v1/approvals/${nextApproval.json.id}/decision`, { decision: 'approved' }, 'terminal-orphan-approve');
    const next = await mutate(env.base, '/api/v1/terminals', { project_id: project.id, approval_id: nextApproval.json.id, runtime }, 'terminal-orphan-open');
    await env.app.database.run("UPDATE terminal_sessions SET status='running' WHERE id=?", [next.json.id]);
    assert.equal(await env.app.domain.terminals.recover(), 1);
    const orphaned = await request(env.base, `/api/v1/terminals/${next.json.id}`);
    assert.equal(orphaned.json.status, 'orphaned');
    assert.equal(orphaned.json.error_code, 'terminal_process_lost');

    const databaseBytes = fs.readFileSync(path.join(env.home, 'data', 'state.sqlite'));
    assert.equal(databaseBytes.includes(Buffer.from(credentialSecret)), false);
  } finally {
    for (const socket of sockets) socket.close();
    await env.close();
  }
});

function connect(base, sessionId, after) {
  return new Promise((resolve, reject) => {
    const url = `${base.replace(/^http/, 'ws')}/api/v1/terminals/${encodeURIComponent(sessionId)}/ws?after=${after}`;
    const socket = new WebSocket(url, { headers: { Origin: base } });
    const messages = [];
    const timer = setTimeout(() => reject(new Error('terminal websocket open timeout')), 5_000);
    socket.on('message', (raw) => {
      try { messages.push(JSON.parse(String(raw))); } catch { /* Protocol errors are asserted by timeouts. */ }
    });
    socket.once('open', () => {
      clearTimeout(timer);
      resolve({
        socket,
        messages,
        send(value) { socket.send(JSON.stringify(value)); },
        output() { return messages.filter((message) => message.type === 'output').map((message) => message.data).join(''); },
        waitFor(predicate) { return waitForMessages(messages, predicate); },
        waitForOutput(marker) { return waitForMessages(messages, (items) => items.filter((message) => message.type === 'output').map((message) => message.data).join('').includes(marker)); },
        close() {
          return new Promise((done) => {
            if (socket.readyState === WebSocket.CLOSED) return done();
            socket.once('close', done);
            socket.close();
          });
        }
      });
    });
    socket.once('error', reject);
  });
}

async function waitForMessages(messages, predicate) {
  for (let count = 0; count < 300; count += 1) {
    const result = predicate(messages);
    if (result) return result === true ? messages : result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`terminal message timeout: ${JSON.stringify(messages.slice(-8))}`);
}
