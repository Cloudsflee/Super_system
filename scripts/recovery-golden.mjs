import { createHash, createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCodexDeviceAuthOutput } from '../packages/contracts/src/codex-device-auth.mjs';
import { runSevenStageProbe } from '../apps/api/src/modules/setup/codex-service.mjs';
import { discoveryRevisionFixture } from '../apps/api/src/modules/setup/codex-discovery.mjs';
import { SetupService } from '../apps/api/src/modules/setup/service.mjs';
import { createGithubAppJwt, verifyGithubWebhook } from '../apps/api/src/modules/setup/github-service.mjs';
import { qualityReviewMediaKind as v3QualityReviewMediaKind } from '../apps/api/src/modules/quality/media-contract.mjs';

const root = process.cwd();
const mode = process.argv[2] || 'verify';
const requestedBatch = process.argv[3] || null;
const V23_SOURCE_COMMIT = 'e18dc0b';
const V23_FIXTURE = path.join(root, 'tests', 'golden', 'v23', 'r0-r1.json');
const R2_FIXTURE = path.join(root, 'tests', 'golden', 'r2', 'identity-setup.json');
const R2_SOURCE_FILES = Object.freeze([
  'packages/contracts/src/codex-device-auth.mjs',
  'apps/api/src/modules/setup/codex-discovery.mjs',
  'apps/api/src/modules/setup/codex-service.mjs',
  'apps/api/src/modules/setup/service.mjs',
  'apps/api/src/modules/setup/github-service.mjs'
]);
const mediaCases = Object.freeze([
  { id: 'markdown', input: { file_path: 'notes.md', media_type: 'text/markdown', has_body: true } },
  { id: 'json', input: { file_path: 'data.json', media_type: 'application/json', has_body: true } },
  { id: 'svg', input: { file_path: 'diagram.svg', media_type: 'image/svg+xml', has_body: true } },
  { id: 'png', input: { file_path: 'image.png', media_type: 'image/png', has_body: true } },
  { id: 'pdf', input: { file_path: 'report.pdf', media_type: 'application/pdf', has_body: true } },
  { id: 'docx', input: { file_path: 'document.docx', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', has_body: true } },
  { id: 'xlsx', input: { file_path: 'workbook.xlsx', media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', has_body: true } },
  { id: 'pptx-excluded', input: { file_path: 'slides.pptx', media_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', has_body: true } },
  { id: 'video-excluded', input: { file_path: 'clip.mp4', media_type: 'video/mp4', has_body: true } },
  { id: 'archive-excluded', input: { file_path: 'bundle.zip', media_type: 'application/octet-stream', has_body: true } },
  { id: 'generic-body', input: { file_path: 'unknown.bin', media_type: 'application/octet-stream', has_body: true } },
  { id: 'generic-probe', input: { file_path: 'unknown.bin', media_type: 'application/octet-stream', has_body: false } }
]);

const batches = Object.freeze({
  'v23-r0-r1': { fixture: V23_FIXTURE, kind: 'v23' },
  'r2-identity-setup': { fixture: R2_FIXTURE, kind: 'r2' }
});

if (mode === 'extract') await extract(requestedBatch);
else if (mode === 'verify') await verify(requestedBatch);
else throw new Error(`unknown_golden_mode:${mode}`);

async function extract(batchName = null) {
  const names = selectBatches(batchName);
  const results = [];
  for (const name of names) {
    const config = batches[name];
    results.push(config.kind === 'v23' ? await extractV23(config.fixture) : await extractR2(config.fixture));
  }
  process.stdout.write(`${JSON.stringify({ status: 'extracted', batches: results }, null, 2)}\n`);
}

async function extractV23(fixturePath) {
  const worktree = path.join(os.tmpdir(), `aiws-v23-golden-${process.pid}-${randomUUID()}`);
  const sourcePath = 'apps/api/src/quality-review-media.mjs';
  runGit(['worktree', 'add', '--detach', worktree, V23_SOURCE_COMMIT]);
  try {
    const resolvedCommit = runGit(['-C', worktree, 'rev-parse', 'HEAD']).stdout.trim();
    if (resolvedCommit !== runGit(['rev-parse', V23_SOURCE_COMMIT]).stdout.trim()) throw new Error('golden_source_commit_mismatch');
    if (runGit(['-C', worktree, 'status', '--porcelain']).stdout) throw new Error('golden_worktree_not_clean');
    const sourceFile = path.join(worktree, sourcePath);
    const sourceSha256 = sha256(fs.readFileSync(sourceFile));
    const source = await import(`${pathToFileURL(sourceFile).href}?golden=${randomUUID()}`);
    const cases = mediaCases.map(({ id, input }) => ({ id, input, output: source.qualityReviewMediaKind(input.file_path, input.media_type, { hasBody: input.has_body }) }));
    if (runGit(['-C', worktree, 'status', '--porcelain']).stdout) throw new Error('golden_source_worktree_modified');
    const payload = {
      schema_version: 'aiws.v3.v23_golden.v1', source_commit: V23_SOURCE_COMMIT,
      extraction: { mode: 'detached_read_only_worktree', executed_runtime: false },
      source_files: [{ path: sourcePath, sha256: sourceSha256 }],
      contracts: [{ id: 'quality-media-classification', feature_id: 'REC-D9-QUALITY-020', cases }]
    };
    const fixture = { ...payload, fixture_sha256: sha256(JSON.stringify(payload)) };
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
    return { batch: 'v23-r0-r1', fixture: relative(fixturePath), fixture_sha256: fixture.fixture_sha256, cases: cases.length };
  } finally {
    const removed = spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (removed.status !== 0) fs.rmSync(worktree, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf8', windowsHide: true });
  }
}

async function extractR2(fixturePath) {
  const sourceCommit = runGit(['rev-parse', 'HEAD']).stdout.trim();
  const sourceFiles = R2_SOURCE_FILES.map((file) => ({ path: file, sha256: sha256(fs.readFileSync(path.join(root, file))) }));
  const probeSnapshot = { profile_id: 'cdp_golden', profile_revision: 1, profile_hash: 'a'.repeat(64) };
  const probe = await runSevenStageProbe({
    broker: {
      probe: async () => ({ ready: true }),
      codexProfileProbe: async () => ({ status: 'available', checks: ['transport', 'protocol', 'model', 'inference'].map((phase) => ({ phase, status: 'passed' })) })
    },
    snapshot: probeSnapshot,
    credential: 'fixture-secret'
  });
  const deviceInput = 'Open https://auth.example.test/device and enter ABCD-EFGH\nSuccessfully logged in';
  const device = { input: deviceInput, output: parseCodexDeviceAuthOutput(deviceInput) };
  const discovery = {
    expected_revision: discoveryRevisionFixture({ source: 'codex-home', revision: 1 }),
    current_revision: discoveryRevisionFixture({ source: 'codex-home', revision: 2 }),
    stale_status: 'discovery_source_stale'
  };
  const setup = {
    blocked: await goldenSetupState(false),
    ready: await goldenSetupState(true)
  };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = createGithubAppJwt({ appId: '12345', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), issuedAt: Date.parse('2026-08-10T00:00:00.000Z') });
  const [header, encodedClaims, encodedSignature] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
  const body = Buffer.from('{"action":"created"}');
  const webhookSecret = 'r2-golden-webhook-secret';
  const signature = `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`;
  const permissions = [
    { id: 'ready', value: { metadata: 'read', contents: 'write', pull_requests: 'write' }, ready: true },
    { id: 'missing-contents', value: { metadata: 'read', pull_requests: 'write' }, ready: false },
    { id: 'missing-metadata', value: { contents: 'write', pull_requests: 'write' }, ready: false }
  ];
  const payload = {
    schema_version: 'aiws.v3.r2_golden.v1', source_commit: sourceCommit,
    extraction: { mode: 'current_read_only_contracts', executed_runtime: false }, source_files: sourceFiles,
    contracts: [
      { id: 'codex-device-auth-public-output', feature_id: 'REC-D2-SETUP-002', cases: [device] },
      { id: 'codex-discovery-stale-revision', feature_id: 'REC-D2-SETUP-002', cases: [discovery] },
      { id: 'codex-seven-stage-probe', feature_id: 'REC-D2-SETUP-002', cases: [{ snapshot: probeSnapshot, output: probe }] },
      { id: 'setup-state-machine', feature_id: 'REC-D2-SETUP-002', cases: [setup] },
      { id: 'github-app-jwt', feature_id: 'REC-D2-SETUP-002', cases: [{ header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')), claims, signature_length: encodedSignature.length }] },
      { id: 'github-permissions', feature_id: 'REC-D2-SETUP-002', cases: permissions },
      { id: 'github-webhook-hmac', feature_id: 'REC-D2-SETUP-002', cases: [{ body_sha256: sha256(body), valid: verifyGithubWebhook(webhookSecret, body, signature), tampered: verifyGithubWebhook(webhookSecret, Buffer.from('{"action":"changed"}'), signature) }] }
    ]
  };
  const fixture = { ...payload, fixture_sha256: sha256(JSON.stringify(payload)) };
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  return { batch: 'r2-identity-setup', fixture: relative(fixturePath), fixture_sha256: fixture.fixture_sha256, contracts: payload.contracts.length };
}

async function verify(batchName = null) {
  const names = selectBatches(batchName);
  const results = [];
  for (const name of names) results.push(await configureVerify(name));
  const v23 = results.find((item) => item.batch === 'v23-r0-r1');
  process.stdout.write(`${JSON.stringify({ status: 'passed', batches: results, fixture_sha256: v23?.fixture_sha256, cases: v23?.cases, batch_count: results.length }, null, 2)}\n`);
}

async function configureVerify(name) {
  const config = batches[name];
  return config.kind === 'v23' ? verifyV23(config.fixture) : await verifyR2(config.fixture);
}

function verifyV23(fixturePath) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const { fixture_sha256: recorded, ...payload } = fixture;
  if (fixture.schema_version !== 'aiws.v3.v23_golden.v1' || fixture.source_commit !== V23_SOURCE_COMMIT) throw new Error('golden_fixture_identity_invalid');
  if (sha256(JSON.stringify(payload)) !== recorded) throw new Error('golden_fixture_checksum_invalid');
  if (fixture.extraction?.mode !== 'detached_read_only_worktree' || fixture.extraction?.executed_runtime !== false) throw new Error('golden_extraction_policy_invalid');
  const contract = fixture.contracts.find((item) => item.id === 'quality-media-classification');
  if (!contract?.cases?.length) throw new Error('golden_contract_missing');
  const failures = contract.cases.filter((item) => v3QualityReviewMediaKind(item.input.file_path, item.input.media_type, { hasBody: item.input.has_body }) !== item.output);
  if (failures.length) throw new Error(`golden_behavior_mismatch:${failures.map((item) => item.id).join(',')}`);
  return { batch: 'v23-r0-r1', fixture: relative(fixturePath), fixture_sha256: recorded, cases: contract.cases.length };
}

async function verifyR2(fixturePath) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const { fixture_sha256: recorded, ...payload } = fixture;
  if (fixture.schema_version !== 'aiws.v3.r2_golden.v1' || fixture.extraction?.mode !== 'current_read_only_contracts' || fixture.extraction?.executed_runtime !== false) throw new Error('r2_golden_identity_invalid');
  if (sha256(JSON.stringify(payload)) !== recorded) throw new Error('r2_golden_checksum_invalid');
  for (const source of fixture.source_files || []) if (sha256(fs.readFileSync(path.join(root, source.path))) !== source.sha256) throw new Error(`r2_golden_source_changed:${source.path}`);
  const contract = (id) => fixture.contracts.find((item) => item.id === id)?.cases || [];
  const device = contract('codex-device-auth-public-output')[0];
  if (!device || JSON.stringify(parseCodexDeviceAuthOutput(device.input)).includes('fixture-secret') || JSON.stringify(parseCodexDeviceAuthOutput(device.input)) !== JSON.stringify(device.output)) throw new Error('r2_device_golden_mismatch');
  const discovery = contract('codex-discovery-stale-revision')[0];
  if (!discovery || discovery.expected_revision === discovery.current_revision || discovery.stale_status !== 'discovery_source_stale') throw new Error('r2_discovery_golden_mismatch');
  const probe = contract('codex-seven-stage-probe')[0];
  const probeResult = await runSevenStageProbe({ broker: { probe: async () => ({ ready: true }), codexProfileProbe: async () => ({ status: 'available', checks: ['transport', 'protocol', 'model', 'inference'].map((phase) => ({ phase, status: 'passed' })) }) }, snapshot: probe.snapshot, credential: 'fixture-secret' });
  if (JSON.stringify(probeResult) !== JSON.stringify(probe.output)) throw new Error('r2_probe_golden_mismatch');
  const setup = contract('setup-state-machine')[0];
  if (!setup || JSON.stringify(await goldenSetupState(false)) !== JSON.stringify(setup.blocked) || JSON.stringify(await goldenSetupState(true)) !== JSON.stringify(setup.ready)) throw new Error('r2_setup_golden_mismatch');
  const jwt = contract('github-app-jwt')[0];
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const generated = createGithubAppJwt({ appId: '12345', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), issuedAt: Date.parse('2026-08-10T00:00:00.000Z') });
  const [encodedHeader, encodedClaims, signature] = generated.split('.');
  const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
  if (JSON.stringify(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'))) !== JSON.stringify(jwt.header) || claims.iss !== jwt.claims.iss || claims.exp - claims.iat !== jwt.claims.exp - jwt.claims.iat || signature.length !== jwt.signature_length) throw new Error('r2_jwt_golden_mismatch');
  const permissions = contract('github-permissions');
  for (const item of permissions) if (permissionReady(item.value) !== item.ready) throw new Error(`r2_permissions_golden_mismatch:${item.id}`);
  const webhook = contract('github-webhook-hmac')[0];
  const body = Buffer.from('{"action":"created"}');
  const secret = 'r2-golden-webhook-secret';
  const signatureValue = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  if (!webhook || sha256(body) !== webhook.body_sha256 || verifyGithubWebhook(secret, body, signatureValue) !== webhook.valid || verifyGithubWebhook(secret, Buffer.from('{"action":"changed"}'), signatureValue) !== webhook.tampered) throw new Error('r2_webhook_golden_mismatch');
  return { batch: 'r2-identity-setup', fixture: relative(fixturePath), fixture_sha256: recorded, contracts: fixture.contracts.length };
}

async function goldenSetupState(ready) {
  const digest = `sha256:${'f'.repeat(64)}`;
  const owner = { id: 'usr_local_owner', display_name: 'Golden owner', locale: 'en-US', timezone: 'UTC', status: 'active', revision: 1 };
  const credentials = ready ? [{ id: 'cred_golden', provider: 'codex', kind: 'codex_api_key', status: 'active', origin: 'vault', revision: 1, secret_ref: 'vault:golden' }] : [];
  const profile = ready ? { id: 'cdp_golden', revision: 1, is_active: true, credential_status: 'active', probe_status: 'available', config_hash: 'a'.repeat(64), credential_ref: 'cred_golden', current_credential_revision: 1, runner_digest: digest, label: 'Golden profile', provider: 'openai', model: 'gpt-5.5', base_url: '', wire_api: 'responses', reasoning: 'medium', timeout_ms: 30000 } : null;
  const app = ready ? { id: 'gha_golden', revision: 1, status: 'verified', private_key_status: 'active', webhook_status: 'active', private_key_revision: 1, webhook_revision: 1, probe_status: 'available', app_id: '12345' } : null;
  const installation = ready ? { id: 'ghi_golden', app_config_id: app.id, revision: 1, status: 'available', permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' }, repositories: [] } : null;
  const repositories = ready ? [{ id: 'ghr_golden', installation_id: installation.id, revision: 1, selected: true, github_id: '9001', full_name: 'fixture/repository' }] : [];
  const service = Object.create(SetupService.prototype);
  service.config = { runnerDigest: digest };
  service.runtimeId = 'r2-golden-runtime';
  service.identity = { account: async () => owner };
  service.expireCredentials = async () => [];
  service.repository = {
    setup: async () => ({ id: 'setup_singleton', completed_at: ready ? '2026-08-10T00:00:00.000Z' : null, revision: 7 }),
    credentials: async () => credentials,
    codexProfiles: async () => profile ? [profile] : [],
    githubApps: async () => app ? [app] : [],
    githubInstallations: async (appId) => installation && (!appId || appId === app.id) ? [installation] : [],
      githubRepositories: async (installationId) => installationId
        ? repositories.filter((row) => row.installation_id === installationId)
        : repositories
  };
  service.listGithubApps = SetupService.prototype.listGithubApps.bind(service);
  if (profile) profile.probe_hash = service.codexProbeHash(profile);
  if (app) app.probe_hash = service.githubProbeHash(app, [installation], repositories);
  const state = await service.setupState();
  return { status: state.status, complete: state.complete, can_complete: state.can_complete, revision: state.revision, checks: state.checks, blockers: state.blockers };
}

function permissionReady(value) {
  return value?.metadata === 'read' && value?.contents === 'write' && value?.pull_requests === 'write';
}

function selectBatches(name) {
  if (!name) return Object.keys(batches);
  if (!Object.hasOwn(batches, name)) throw new Error(`unknown_golden_batch:${name}`);
  return [name];
}

function runGit(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`golden_git_failed:${args.join(' ')}:${result.stderr.trim()}`);
  return result;
}

function relative(file) { return path.relative(root, file).replaceAll('\\', '/'); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
