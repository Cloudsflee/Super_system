import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  parseCodexDeviceAuthLine,
  parseCodexDeviceAuthOutput
} from '../../packages/contracts/src/codex-device-auth.mjs';
import { CodexService, runSevenStageProbe } from '../../apps/api/src/modules/setup/codex-service.mjs';
import { qualityReviewMediaKind } from '../../apps/api/src/modules/quality/media-contract.mjs';
import {
  GithubService,
  createGithubAppJwt,
  verifyGithubWebhook
} from '../../apps/api/src/modules/setup/github-service.mjs';

const snapshot = Object.freeze({
  profile_id: 'cdp_boundary_fixture',
  profile_revision: 2,
  profile_hash: 'a'.repeat(64)
});

test('media classification golden covers type, extension, generic, and excluded inputs', () => {
  const cases = [
    ['notes.md', 'text/markdown', true, 'text'],
    ['data.json', 'application/json', true, 'json'],
    ['diagram.svg', 'image/svg+xml', true, 'xml'],
    ['image.png', 'image/png', true, 'image'],
    ['report.pdf', 'application/pdf', true, 'pdf'],
    ['document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', true, 'docx'],
    ['workbook.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true, 'xlsx'],
    ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', true, 'out_of_scope'],
    ['clip.mp4', 'video/mp4', true, 'out_of_scope'],
    ['bundle.zip', 'application/octet-stream', true, 'out_of_scope'],
    ['unknown.bin', 'application/octet-stream', false, 'probe'],
    ['fallback.xml', 'application/x-custom', true, 'xml'],
    ['photo.jpg', 'application/x-custom', true, 'image'],
    ['plain.txt', 'application/x-custom', true, 'text'],
    ['unknown.bin', 'application/x-custom', true, 'out_of_scope']
  ];
  for (const [filePath, mediaType, hasBody, expected] of cases) {
    assert.equal(qualityReviewMediaKind(filePath, mediaType, { hasBody }), expected, `${filePath}:${mediaType}`);
  }
});

test('Device Auth public parser handles status and hostile URL boundaries', () => {
  assert.equal(parseCodexDeviceAuthLine(''), null);
  assert.equal(parseCodexDeviceAuthLine('ordinary provider output'), null);
  assert.deepEqual(parseCodexDeviceAuthLine('Open https://auth.example.test/device), now'), {
    type: 'verification',
    verification_url: 'https://auth.example.test/device',
    user_code: null,
    status: 'waiting_for_user'
  });
  assert.deepEqual(parseCodexDeviceAuthLine('Use HTTP://user:pass@auth.example.test and code abcd-efgh'), {
    type: 'verification',
    verification_url: null,
    user_code: 'ABCD-EFGH',
    status: 'waiting_for_user'
  });
  assert.equal(parseCodexDeviceAuthLine('authentication complete').status, 'authorized');
  assert.equal(parseCodexDeviceAuthLine('request timed out').status, 'expired');
  assert.equal(parseCodexDeviceAuthLine('request denied').status, 'cancelled');
  assert.equal(parseCodexDeviceAuthLine('login failure').status, 'failed');
  assert.deepEqual(parseCodexDeviceAuthOutput(null), {
    verification_url: null,
    user_code: null,
    status: 'starting'
  });
  assert.deepEqual(parseCodexDeviceAuthOutput('https://auth.example.test/device\nWXYZ-1234\nlogin successful'), {
    verification_url: 'https://auth.example.test/device',
    user_code: 'WXYZ-1234',
    status: 'authorized'
  });
});

test('Codex seven-stage Probe maps every provider boundary to stable results', async () => {
  const invalid = await runSevenStageProbe({ broker: {}, snapshot: null, credential: '' });
  assert.equal(invalid.error_code, 'codex_configuration_invalid');
  assert.equal(invalid.checks.at(-1).status, 'skipped');

  const cancelled = await runSevenStageProbe({ broker: {}, snapshot, credential: '', signal: { aborted: true } });
  assert.equal(cancelled.error_code, 'codex_probe_cancelled');

  const unavailable = await runSevenStageProbe({
    broker: { probe: async () => { throw new Error('raw runtime failure'); } },
    snapshot,
    credential: ''
  });
  assert.equal(unavailable.error_code, 'codex_runtime_unavailable');

  const stableRuntime = await runSevenStageProbe({
    broker: { probe: async () => ({ ready: false, error: 'codex_runtime_busy' }) },
    snapshot,
    credential: ''
  });
  assert.equal(stableRuntime.error_code, 'codex_runtime_busy');

  const fallback = await runSevenStageProbe({
    broker: {
      probe: async () => ({ ready: true }),
      codexProbe: async () => ({ status: 'available' })
    },
    snapshot,
    credential: 'ephemeral'
  });
  assert.equal(fallback.status, 'available');
  assert.equal(fallback.checks.every((item) => item.status === 'passed'), true);

  const transport = await runSevenStageProbe({
    broker: {
      probe: async () => ({ ready: true }),
      codexProfileProbe: async () => { const error = new Error('raw'); error.code = 'codex_transport_timeout'; throw error; }
    },
    snapshot,
    credential: 'ephemeral'
  });
  assert.equal(transport.error_code, 'codex_transport_timeout');

  const booleanChecks = await runSevenStageProbe({
    broker: {
      probe: async () => ({ ready: true }),
      codexProfileProbe: async () => ({
        checks: ['transport', 'protocol', 'model', 'inference'].map((phase) => ({ phase, passed: true }))
      })
    },
    snapshot,
    credential: 'ephemeral'
  });
  assert.equal(booleanChecks.status, 'available');
});

test('Codex service rejects stale profile selections and routes external cancellation', async () => {
  const current = { id: 'cdp_current', revision: 3, is_active: true };
  const cancellations = [];
  const service = new CodexService({
    config: {},
    broker: {
      codexDeviceAuthStatus: async (id) => ({ operation_id: id, status: 'running' }),
      cancelCodexDeviceAuth: async (id) => { cancellations.push(id); return { status: 'cancelled' }; }
    },
    setup: {
      repository: {
        activeCodexProfile: async () => current,
        codexProfile: async () => null
      }
    },
    operations: { create: async (value) => value }
  });

  await assert.rejects(() => service.probe({ profile_id: 'cdp_missing' }), hasCode('not_found'));
  await assert.rejects(() => service.probe({ expected_revision: 'bad' }), hasCode('expected_revision_required'));
  await assert.rejects(() => service.runProbe('cdp_missing', 3, {}, {}), hasCode('codex_profile_stale'));
  assert.equal(await service.resumeOperation({ kind: 'other', external_ref: 'da_fixture' }), false);
  assert.equal(await service.resumeOperation({ kind: 'codex.device_auth', external_ref: '' }), false);
  const resume = await service.resumeOperation({ kind: 'codex.device_auth', external_ref: 'da_fixture', resource_id: 'cred_fixture', actor: 'usr_local_owner' });
  assert.equal(typeof resume, 'function');
  await service.cancelExternal('other', 'da_fixture');
  await service.cancelExternal('codex.device_auth', 'da_fixture');
  assert.deepEqual(cancellations, ['da_fixture']);
});

test('Codex device-auth timeout cancels the Broker job and revokes its pending credential', async () => {
  let revoked = false;
  let cancelled = false;
  let ticks = 0;
  const service = new CodexService({
    config: {},
    clock: () => (ticks++ === 0 ? 0 : 30_000),
    broker: { cancelCodexDeviceAuth: async () => { cancelled = true; } },
    setup: {
      repository: { credential: async () => ({ id: 'cred_pending', status: 'pending', revision: 1 }) },
      revokeCredential: async () => { revoked = true; }
    },
    operations: {}
  });
  await assert.rejects(
    () => service.runDeviceAuth('cred_pending', { timeout_ms: 30_000 }, {}, { ensureActive() {} }, 'da_timeout_fixture'),
    hasCode('device_auth_timeout')
  );
  assert.equal(cancelled, true);
  assert.equal(revoked, true);
});

test('GitHub request adapter maps transport and HTTP failures to stable codes', async () => {
  const serviceFor = (fetchImpl) => new GithubService({
    config: { githubAppApiRoot: 'http://github.fixture///' },
    setup: {},
    operations: {},
    fetchImpl
  });

  await assert.rejects(
    () => serviceFor(async () => { throw new Error('socket details'); }).request('GET', '/app', { token: 'token' }),
    hasCode('github_api_unavailable')
  );
  await assert.rejects(
    () => serviceFor(async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }).request('GET', '/app', { token: 'token' }),
    hasCode('github_request_timeout')
  );

  for (const [status, code] of [
    [401, 'github_auth_failed'],
    [403, 'github_permission_missing'],
    [404, 'github_resource_missing'],
    [429, 'github_rate_limited'],
    [500, 'github_api_unavailable'],
    [422, 'github_api_failed']
  ]) {
    const service = serviceFor(async () => json({ message: 'provider detail' }, status));
    await assert.rejects(() => service.request('GET', '/app', { token: 'token' }), hasCode(code));
  }

  const controller = new AbortController();
  const success = serviceFor(async (_url, options) => {
    assert.equal(options.body, '{}');
    assert.match(options.authorization || options.headers.authorization, /^Bearer /);
    return new Response('not-json', { status: 200 });
  });
  assert.deepEqual(await success.request('POST', '/app', {
    token: 'installation-token', installationToken: true, body: {}, signal: controller.signal
  }), {});
});

test('GitHub Probe reports each failed stage without leaking provider diagnostics', async () => {
  const app = { id: 'gha_fixture', app_id: '12345', revision: 1, private_key_ref: 'cred_key' };
  const readyPermissions = { metadata: 'read', contents: 'write', pull_requests: 'write' };

  async function run({ appResult, installations = [], repositories = [], remoteRepositories = { total_count: 1 }, jwtError = null }) {
    let recorded;
    const setup = {
      repository: {
        githubInstallations: async () => installations,
        githubRepositories: async () => repositories
      },
      recordGithubProbe: async (_id, _revision, result) => { recorded = result; }
    };
    const service = new GithubService({ config: {}, setup, operations: {}, fetchImpl: async () => json({}) });
    service.appJwt = async () => {
      if (jwtError) throw jwtError;
      return 'fixture-jwt';
    };
    service.installationToken = async () => 'installation-token';
    service.request = async (_method, path) => path === '/app' ? appResult : remoteRepositories;
    const result = await service.runProbe(app, 1, { signal: undefined });
    assert.deepEqual(result.checks, recorded.checks);
    return result;
  }

  const rawError = new Error('raw provider diagnostic');
  const jwt = await run({ jwtError: rawError });
  assert.equal(jwt.error_code, 'github_probe_failed');
  assert.equal(jwt.checks[0].phase, 'jwt');

  const mismatch = await run({ appResult: { id: 999, slug: '' } });
  assert.equal(mismatch.error_code, 'github_app_mismatch');
  assert.equal(mismatch.checks[1].phase, 'app');

  const missingInstallation = await run({ appResult: { id: 12345, slug: 'fixture-app' } });
  assert.equal(missingInstallation.error_code, 'github_installation_missing');

  const missingPermission = await run({
    appResult: { id: 12345, slug: 'fixture-app' },
    installations: [{ status: 'available', permissions: { metadata: 'read' } }]
  });
  assert.equal(missingPermission.error_code, 'github_permission_missing');

  const missingRepository = await run({
    appResult: { id: 12345, slug: 'fixture-app' },
    installations: [{ status: 'available', installation_id: '67890', permissions: readyPermissions }],
    repositories: [],
    remoteRepositories: { total_count: 0 }
  });
  assert.equal(missingRepository.error_code, 'github_repository_missing');
  assert.equal(missingRepository.checks.at(-1).status, 'failed');
});

test('GitHub discovery and repository sync preserve blocked state reasons', async () => {
  const app = { id: 'gha_fixture', app_id: '12345', revision: 4, private_key_ref: 'cred_key' };
  const readyPermissions = { metadata: 'read', contents: 'write', pull_requests: 'write' };
  const emitted = [];
  let discovered;
  let synced;
  let installation = {
    id: 'ghi_fixture', app_config_id: app.id, installation_id: '67890', revision: 2,
    permissions: readyPermissions
  };
  const setup = {
    repository: {
      githubApp: async (id) => id === app.id ? app : null,
      githubInstallation: async (id) => id === installation.id ? installation : null,
      discoverGithubInstallations: async (value) => { discovered = value; },
      syncGithubRepositories: async (value) => { synced = value; }
    }
  };
  const operations = {
    create: async (spec) => spec.executor({
      signal: undefined,
      emit: async (type, data) => { emitted.push({ type, data }); }
    })
  };
  const service = new GithubService({ config: {}, setup, operations, fetchImpl: async () => json({}) });
  service.appJwt = async () => 'fixture-jwt';
  service.installationToken = async () => 'installation-token';
  service.paginate = async (requestPath) => requestPath === '/app/installations' ? [
    { id: 67890, account: { login: 'ready' }, permissions: readyPermissions },
    { id: 67891, account: { login: 'suspended' }, permissions: readyPermissions, suspended_at: '2026-08-10T00:00:00Z' },
    { id: 67892, account: { login: 'blocked' }, permissions: { metadata: 'read' } }
  ] : [];

  const discovery = await service.discoverInstallations(app.id, { expected_revision: 4 });
  assert.deepEqual(discovery.installations.map((item) => item.status), ['available', 'revoked', 'blocked']);
  assert.equal(discovered.installations[1].errorCode, 'github_installation_suspended');
  assert.equal(emitted.length, 3);

  service.paginate = async () => [];
  const noRepositories = await service.syncRepositories(installation.id, { expected_revision: 2 });
  assert.equal(noRepositories.status, 'blocked');
  assert.equal(synced.errorCode, 'github_repository_missing');

  installation = { ...installation, permissions: { metadata: 'read' } };
  service.paginate = async () => [{ id: 9001, full_name: 'fixture/repository', private: true }];
  const noPermissions = await service.syncRepositories(installation.id, { expected_revision: 2 });
  assert.equal(noPermissions.status, 'blocked');
  assert.equal(synced.errorCode, 'github_permission_missing');

  service.paginate = async () => [{ id: 'bad', full_name: 'invalid' }];
  await assert.rejects(() => service.syncRepositories(installation.id, { expected_revision: 2 }), hasCode('github_repository_invalid'));
  await assert.rejects(() => service.discoverInstallations('missing', { expected_revision: 1 }), hasCode('not_found'));
  await assert.rejects(() => service.syncRepositories('missing', { expected_revision: 1 }), hasCode('not_found'));
});

test('GitHub webhook treats a concurrent UNIQUE insert as an idempotent replay', async () => {
  const secret = 'webhook-concurrent-secret';
  const rawBody = Buffer.from(JSON.stringify({ action: 'created', app: { id: 12345 } }));
  const signature = `sha256=${(await import('node:crypto')).createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const receipt = { delivery_id: 'delivery-concurrent', status: 'accepted' };
  let reads = 0;
  const service = new GithubService({
    config: {},
    setup: {
      credentialSecret: async () => secret,
      repository: {
        githubApps: async () => [{ id: 'gha_fixture', app_id: '12345', webhook_secret_ref: 'cred_webhook' }],
        webhookDelivery: async () => (reads++ ? { body_sha256: (await import('../../apps/api/src/crypto.mjs')).sha256(rawBody), receipt } : null),
        insertWebhookDelivery: async () => { throw new Error('UNIQUE constraint failed: github_webhook_deliveries.delivery_id'); }
      }
    },
    operations: {}
  });
  const replay = await service.webhook(rawBody, {
    'x-github-delivery': 'delivery-concurrent',
    'x-github-event': 'installation',
    'x-hub-signature-256': signature
  });
  assert.deepEqual(replay, receipt);
});

test('GitHub JWT and webhook helpers reject malformed cryptographic inputs', () => {
  assert.throws(() => createGithubAppJwt({ appId: '0', privateKey: 'bad' }), hasCode('github_app_invalid'));
  assert.throws(() => createGithubAppJwt({ appId: '12345', privateKey: 'bad' }), hasCode('github_private_key_invalid'));
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.throws(() => createGithubAppJwt({
    appId: '12345',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' })
  }), hasCode('github_private_key_invalid'));
  assert.equal(verifyGithubWebhook('secret', Buffer.from('{}'), 'invalid'), false);
});

function hasCode(code) {
  return (error) => error?.code === code;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
