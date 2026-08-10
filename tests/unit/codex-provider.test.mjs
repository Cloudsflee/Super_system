import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodexDeviceAuthOutput } from '../../packages/contracts/src/codex-device-auth.mjs';
import { runSevenStageProbe } from '../../apps/api/src/modules/setup/codex-service.mjs';

const snapshot = {
  profile_id: 'cdp_fixture1234',
  profile_revision: 3,
  profile_hash: 'a'.repeat(64),
  provider: 'openai',
  model: 'gpt-5.5',
  base_url: '',
  wire_api: 'responses',
  reasoning: 'medium',
  timeout_ms: 30000,
  auth_kind: 'api_key',
  credential_ref: 'cred_fixture1234',
  credential_revision: 2,
  runner_digest: `sha256:${'b'.repeat(64)}`
};

test('Device Auth parser exposes only public verification fields', () => {
  const parsed = parseCodexDeviceAuthOutput([
    'Open https://auth.example.test/device and enter ABCD-EFGH',
    'access_token=secret-token-value',
    'Successfully logged in'
  ].join('\n'));
  assert.deepEqual(parsed, {
    verification_url: 'https://auth.example.test/device',
    user_code: 'ABCD-EFGH',
    status: 'authorized'
  });
  assert.equal(JSON.stringify(parsed).includes('secret-token-value'), false);
});

test('Codex Probe always reports the seven stable stages', async () => {
  const broker = {
    probe: async () => ({ ready: true, executor: 'docker' }),
    codexProfileProbe: async () => ({
      status: 'available',
      checks: ['transport', 'protocol', 'model', 'inference'].map((phase) => ({ phase, status: 'passed' }))
    })
  };
  const result = await runSevenStageProbe({ broker, snapshot, credential: 'fixture-secret' });
  assert.equal(result.status, 'available');
  assert.deepEqual(result.checks.map((item) => `${item.phase}:${item.status}`), [
    'configuration:passed', 'runtime:passed', 'binding:passed', 'transport:passed',
    'protocol:passed', 'model:passed', 'inference:passed'
  ]);

  broker.codexProfileProbe = async () => ({
    status: 'unavailable',
    checks: [
      { phase: 'transport', status: 'passed' },
      { phase: 'protocol', status: 'failed', error_code: 'raw provider diagnostic' }
    ]
  });
  const failed = await runSevenStageProbe({ broker, snapshot, credential: 'fixture-secret' });
  assert.equal(failed.error_code, 'codex_protocol_failed');
  assert.equal(failed.checks.find((item) => item.phase === 'model').status, 'skipped');
});
