import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, mutate, request } from './helpers.mjs';

test('HTTP identity authenticates Bearer sessions and never persists issued tokens', async () => {
  const env = await fixture();
  try {
    const account = await request(env.base, '/api/v1/account');
    assert.equal(account.response.status, 200);
    assert.equal(account.json.id, 'usr_local_owner');

    const updated = await request(env.base, '/api/v1/account', {
      method: 'PATCH',
      key: 'identity-account-update',
      headers: { 'x-aiws-actor': 'forged-actor' },
      body: {
        expected_revision: account.json.revision,
        display_name: 'Workspace Owner',
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai'
      }
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.json.display_name, 'Workspace Owner');

    const created = await mutate(env.base, '/api/v1/sessions', { ttl_seconds: 3600 }, 'identity-session-once');
    assert.equal(created.response.status, 201);
    assert.match(created.json.token, /^[A-Za-z0-9_-]{40,}$/);
    const stored = await env.app.database.get('SELECT token_hash FROM sessions WHERE id=?', [created.json.id]);
    assert.equal(stored.token_hash.includes(created.json.token), false);
    const idempotency = await env.app.database.get("SELECT response_json FROM idempotency_keys WHERE scope='POST:/api/v1/sessions' AND key='identity-session-once'");
    assert.equal(idempotency.response_json.includes(created.json.token), false);
    assert.equal(JSON.parse(idempotency.response_json).token_issued, false);

    const replay = await mutate(env.base, '/api/v1/sessions', { ttl_seconds: 3600 }, 'identity-session-once');
    assert.equal(replay.response.status, 201);
    assert.equal(replay.json.token, undefined);
    assert.equal(replay.json.token_issued, false);

    const authenticated = await request(env.base, '/api/v1/account', {
      headers: { authorization: `Bearer ${created.json.token}`, 'x-aiws-actor': 'forged-actor' }
    });
    assert.equal(authenticated.response.status, 200);

    const revoked = await mutate(env.base, `/api/v1/sessions/${created.json.id}/revoke`, {
      expected_revision: created.json.revision
    }, 'identity-session-revoke');
    assert.equal(revoked.response.status, 200);
    const rejected = await request(env.base, '/api/v1/account', {
      headers: { authorization: `Bearer ${created.json.token}` }
    });
    assert.equal(rejected.response.status, 401);
    assert.equal(rejected.json.error.code, 'session_revoked');

    const audit = await env.app.database.query("SELECT actor FROM audit_events WHERE action='account.updated'");
    assert.deepEqual(audit.map((row) => row.actor), ['usr_local_owner']);
  } finally { await env.close(); }
});

test('business mutations are gated while reads and Setup remain available', async () => {
  const env = await fixture({ setupGateBypass: false });
  try {
    const setup = await request(env.base, '/api/v1/setup');
    assert.equal(setup.response.status, 200);
    assert.equal(setup.json.status, 'blocked');
    const projects = await request(env.base, '/api/v1/projects');
    assert.equal(projects.response.status, 200);
    const blocked = await mutate(env.base, '/api/v1/projects', { name: 'Blocked project' }, 'identity-gated-project');
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.json.error.code, 'setup_not_ready');
    assert.equal(blocked.json.error.details.revision, setup.json.revision);
    assert.deepEqual(blocked.json.error.details.blockers, setup.json.blockers);
  } finally { await env.close(); }
});
