import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { fixture, mutate, request } from './helpers.mjs';

test('GitHub webhook verifies raw HMAC and deduplicates delivery ids', async () => {
  const env = await fixture();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  try {
    const key = await mutate(env.base, '/api/v1/credentials', { kind: 'github_app_private_key', label: 'Webhook App key', secret: privateKeyPem }, 'github-webhook-key');
    const secret = 'github-webhook-secret-fixture';
    const webhook = await mutate(env.base, '/api/v1/credentials', { kind: 'github_webhook_secret', label: 'Webhook secret', secret }, 'github-webhook-secret');
    const app = await mutate(env.base, '/api/v1/github/apps', {
      label: 'Webhook App', app_id: '12345', client_id: 'Iv1.fixture',
      private_key_ref: key.json.id, webhook_secret_ref: webhook.json.id
    }, 'github-webhook-app');
    assert.equal(app.response.status, 201);
    const raw = Buffer.from(JSON.stringify({ action: 'created', app: { id: 12345 }, installation: { id: 67890 } }));
    const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    const headers = {
      'content-type': 'application/json',
      'x-github-delivery': 'delivery-fixture-1',
      'x-github-event': 'installation',
      'x-hub-signature-256': signature
    };
    const first = await request(env.base, '/api/v1/integrations/github/webhook', { method: 'POST', headers, body: JSON.parse(raw.toString('utf8')) });
    assert.equal(first.response.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.status, 'accepted');
    const duplicate = await request(env.base, '/api/v1/integrations/github/webhook', { method: 'POST', headers, body: JSON.parse(raw.toString('utf8')) });
    assert.equal(duplicate.response.status, 200);
    assert.deepEqual(duplicate.json, first.json);
    const bad = await request(env.base, '/api/v1/integrations/github/webhook', { method: 'POST', headers: { ...headers, 'x-github-delivery': 'delivery-fixture-2', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, body: JSON.parse(raw.toString('utf8')) });
    assert.equal(bad.response.status, 401);
    assert.equal(bad.json.error.code, 'github_webhook_signature_invalid');
  } finally { await env.close(); }
});
