import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeCursor } from '../../apps/api/src/clean/cursor.mjs';
import { close, closeServer, json, listen, open, sessionHeaders } from './helpers.mjs';

const ORIGIN = 'http://127.0.0.1:5174';

test('project JSON replay is scoped, redacted, continuous and cursor-bound', async () => {
  const state = await open();
  const network = await listen(state.runtime);
  try {
    const projectA = await state.runtime.project.createProject({ name: 'P9 A', idempotency_key: 'p9-events-project-a' }, state.principal);
    await state.runtime.project.createProject({ name: 'P9 B', idempotency_key: 'p9-events-project-b' }, state.principal);
    await state.runtime.events.append({
      aggregateType: 'p9_fixture', aggregateId: 'p9-a-tail', aggregateRevision: 1,
      actorId: state.principal.actorId, projectId: projectA.id, type: 'operation.fixture',
      data: { token: 'must-not-leak', state: 'tail' }
    });

    const base = `${network.base}/api/v2/events?project_id=${encodeURIComponent(projectA.id)}`;
    const full = await json(await fetch(base, { headers: sessionHeaders(state.proof, { origin: ORIGIN }) }));
    assert.equal(full.response.status, 200, JSON.stringify(full.body));
    assert.equal(full.response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(full.response.headers.get('access-control-allow-credentials'), 'true');
    assert.match(full.response.headers.get('vary') || '', /Origin/i);
    assert.equal(full.body.data.project_id, projectA.id);
    assert.equal(full.body.data.has_more, false);
    assert.ok(full.body.data.events.length >= 2);
    assert.ok(full.body.data.events.every((event) => event.project_id === projectA.id));
    assert.doesNotMatch(JSON.stringify(full.body), /must-not-leak/);
    for (let index = 0; index < full.body.data.events.length; index += 1) {
      const event = full.body.data.events[index];
      const expected = index === 0 ? 0 : full.body.data.events[index - 1].sequence;
      assert.equal(event.previous_project_sequence, expected);
    }
    assert.ok(full.body.data.events.some((event) => event.previous_project_sequence > 0 && event.sequence - event.previous_project_sequence > 1), 'another project must create only a global sequence hole');

    const first = await json(await fetch(`${base}&limit=1`, { headers: sessionHeaders(state.proof) }));
    assert.equal(first.body.data.has_more, true);
    const second = await json(await fetch(`${base}&limit=1&cursor=${encodeURIComponent(first.body.data.next_cursor)}`, { headers: sessionHeaders(state.proof) }));
    assert.equal(second.response.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.data.events[0].previous_project_sequence, first.body.data.events[0].sequence);

    const projectB = await state.runtime.project.createProject({ name: 'P9 C', idempotency_key: 'p9-events-project-c' }, state.principal);
    const wrongScope = await json(await fetch(`${network.base}/api/v2/events?project_id=${encodeURIComponent(projectB.id)}&cursor=${encodeURIComponent(first.body.data.next_cursor)}`, { headers: sessionHeaders(state.proof) }));
    assert.equal(wrongScope.response.status, 400);
    assert.equal(wrongScope.body.error.code, 'cursor_scope_mismatch');

    const expired = encodeCursor({
      actorId: state.principal.actorId,
      projectId: projectA.id,
      stream: 'events',
      sequence: 0,
      query: { operation_id: null, aggregate_type: null, aggregate_id: null },
      expiresAt: '2000-01-01T00:00:00.000Z',
      secret: state.runtime.config.cursorSecret
    });
    const expiredResult = await json(await fetch(`${base}&cursor=${encodeURIComponent(expired)}`, { headers: sessionHeaders(state.proof) }));
    assert.equal(expiredResult.response.status, 410);
    assert.equal(expiredResult.body.error.code, 'cursor_expired');

    const forcedJson = await fetch(`${base}&format=json`, { headers: sessionHeaders(state.proof, { accept: 'text/event-stream' }) });
    assert.match(forcedJson.headers.get('content-type') || '', /application\/json/);
    forcedJson.body?.cancel();
  } finally {
    await closeServer(network.server);
    await close(state);
  }
});

test('SSE uses global ids, Last-Event-ID precedence and disconnects after ACL revocation', async () => {
  const state = await open();
  const network = await listen(state.runtime);
  try {
    const project = await state.runtime.project.createProject({ name: 'P9 SSE', idempotency_key: 'p9-sse-project' }, state.principal);
    await state.runtime.events.append({ aggregateType: 'p9_fixture', aggregateId: 'p9-sse-event', aggregateRevision: 1, actorId: state.principal.actorId, projectId: project.id, type: 'operation.fixture', data: { state: 'ready' } });
    const base = `${network.base}/api/v2/events?project_id=${encodeURIComponent(project.id)}`;
    const page = await json(await fetch(`${base}&limit=1`, { headers: sessionHeaders(state.proof) }));
    const all = await json(await fetch(base, { headers: sessionHeaders(state.proof) }));
    const expectedFirst = all.body.data.events[0].sequence;

    const precedence = await openSse(`${base}&cursor=${encodeURIComponent(page.body.data.next_cursor)}`, state.proof, { 'Last-Event-ID': '0' });
    assert.match(precedence.text, new RegExp(`id: ${expectedFirst}\\n`));
    assert.ok(precedence.ids.every((value) => Number.isInteger(value) && value > 0));
    precedence.abort();

    const active = await openSse(`${base}&cursor=${encodeURIComponent(all.body.data.next_cursor)}`, state.proof);
    assert.match(active.text, /: heartbeat/);
    state.runtime.db.run("UPDATE project_memberships SET status='revoked' WHERE project_id=? AND actor_id=?", [project.id, state.principal.actorId]);
    assert.equal(state.runtime.authorization.authorize(state.principal, 'read', project.id, { resource: 'events' }).allowed, false);
    await state.runtime.events.append({ aggregateType: 'p9_fixture', aggregateId: 'p9-after-revoke', aggregateRevision: 1, actorId: state.principal.actorId, projectId: project.id, type: 'operation.fixture', data: { state: 'revoked' } });
    const closed = await Promise.race([
      active.reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('sse_acl_disconnect_timeout')), 2000))
    ]);
    assert.equal(closed.done, true);
  } finally {
    await closeServer(network.server);
    await close(state);
  }
});

test('credentialed CORS echoes only an exact configured origin and preflight skips authentication', async () => {
  const state = await open();
  const network = await listen(state.runtime);
  try {
    const preflight = await fetch(`${network.base}/api/v2/events`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Content-Type, Last-Event-ID'
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET');
    assert.match(preflight.headers.get('access-control-allow-headers') || '', /last-event-id/);

    const unauthenticated = await json(await fetch(`${network.base}/api/v2/events?project_id=missing`, { headers: { origin: ORIGIN } }));
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.response.headers.get('access-control-allow-origin'), ORIGIN);

    const deniedOrigin = await json(await fetch(`${network.base}/api/v2/events?project_id=missing`, { headers: { origin: 'http://127.0.0.1:5175' } }));
    assert.equal(deniedOrigin.response.status, 403);
    assert.equal(deniedOrigin.body.error.code, 'cors_origin_denied');
    assert.equal(deniedOrigin.response.headers.get('access-control-allow-origin'), null);

    const deniedMethod = await json(await fetch(`${network.base}/api/v2/events`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } }));
    assert.equal(deniedMethod.response.status, 403);
    assert.equal(deniedMethod.body.error.code, 'cors_method_denied');

    const deniedHeader = await json(await fetch(`${network.base}/api/v2/events`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'X-Actor-Id' } }));
    assert.equal(deniedHeader.response.status, 403);
    assert.equal(deniedHeader.body.error.code, 'cors_headers_denied');
  } finally {
    await closeServer(network.server);
    await close(state);
  }
});

async function openSse(url, proof, extraHeaders = {}) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: sessionHeaders(proof, { accept: 'text/event-stream', origin: ORIGIN, ...extraHeaders }),
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(': heartbeat')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return {
    response,
    reader,
    text,
    ids: [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1])),
    abort() { controller.abort(); void reader.cancel().catch(() => {}); }
  };
}
