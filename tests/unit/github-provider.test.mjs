import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync, createHmac } from 'node:crypto';
import test from 'node:test';
import { createGithubAppJwt, verifyGithubWebhook } from '../../apps/api/src/modules/setup/github-service.mjs';

test('GitHub App JWT is short-lived RS256 with the App id claim', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = createGithubAppJwt({ appId: '12345', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), issuedAt: Date.parse('2026-08-10T00:00:00.000Z') });
  const [header, payload, signature] = jwt.split('.');
  const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  const parsedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.deepEqual(parsedHeader, { alg: 'RS256', typ: 'JWT' });
  assert.equal(parsedPayload.iss, '12345');
  assert.equal(parsedPayload.exp - parsedPayload.iat, 9 * 60 + 60);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true);
});

test('GitHub webhook HMAC uses the raw body', () => {
  const secret = 'github-webhook-secret-fixture';
  const raw = Buffer.from('{"action":"created"}');
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(verifyGithubWebhook(secret, raw, signature), true);
  assert.equal(verifyGithubWebhook(secret, Buffer.from('{"action":"changed"}'), signature), false);
});
