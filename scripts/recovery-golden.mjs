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
import { assertIntakeSourceStable } from '../apps/api/src/modules/project/service.mjs';
import { manifestDirectory, probeRepositorySource } from '../apps/api/src/modules/repository/adapter.mjs';
import { eventually, fixture, mutate, request } from '../tests/integration/helpers.mjs';

const root = process.cwd();
const mode = process.argv[2] || 'verify';
const requestedBatch = process.argv[3] || null;
const V23_SOURCE_COMMIT = 'e18dc0b';
const V23_FIXTURE = path.join(root, 'tests', 'golden', 'v23', 'r0-r1.json');
const R2_FIXTURE = path.join(root, 'tests', 'golden', 'r2', 'identity-setup.json');
const R3_FIXTURE = path.join(root, 'tests', 'golden', 'r3', 'project-repository.json');
const R2_SOURCE_FILES = Object.freeze([
  'packages/contracts/src/codex-device-auth.mjs',
  'apps/api/src/modules/setup/codex-discovery.mjs',
  'apps/api/src/modules/setup/codex-service.mjs',
  'apps/api/src/modules/setup/service.mjs',
  'apps/api/src/modules/setup/github-service.mjs'
]);
const R3_SOURCE_FILES = Object.freeze([
  'apps/api/src/command-registry.mjs',
  'apps/api/src/http-body.mjs',
  'apps/api/src/http.mjs',
  'apps/api/src/modules/operations/service.mjs',
  'apps/api/src/modules/project/repository.mjs',
  'apps/api/src/modules/project/service.mjs',
  'apps/api/src/modules/repository/adapter.mjs',
  'apps/api/src/modules/repository/repository.mjs',
  'apps/api/src/modules/repository/service.mjs'
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
  'r2-identity-setup': { fixture: R2_FIXTURE, kind: 'r2' },
  'r3-project-repository': { fixture: R3_FIXTURE, kind: 'r3' }
});

if (mode === 'extract') await extract(requestedBatch);
else if (mode === 'verify') await verify(requestedBatch);
else throw new Error(`unknown_golden_mode:${mode}`);

async function extract(batchName = null) {
  const names = selectBatches(batchName);
  const results = [];
  for (const name of names) {
    const config = batches[name];
    if (config.kind === 'v23') results.push(await extractV23(config.fixture));
    else if (config.kind === 'r2') results.push(await extractR2(config.fixture));
    else results.push(await extractR3(config.fixture));
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

async function extractR3(fixturePath) {
  const sourceCommit = runGit(['rev-parse', 'HEAD']).stdout.trim();
  const sourceFiles = R3_SOURCE_FILES.map((file) => ({ path: file, sha256: sha256(fs.readFileSync(path.join(root, file))) }));
  const contracts = await replayR3Contracts();
  const payload = {
    schema_version: 'aiws.v3.r3_golden.v1',
    source_commit: sourceCommit,
    extraction: { mode: 'ephemeral_local_runtime', executed_runtime: true, network: 'loopback_only' },
    source_files: sourceFiles,
    contracts
  };
  const fixture = { ...payload, fixture_sha256: sha256(JSON.stringify(payload)) };
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  return { batch: 'r3-project-repository', fixture: relative(fixturePath), fixture_sha256: fixture.fixture_sha256, contracts: contracts.length, cases: contractCaseCount(contracts) };
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
  if (config.kind === 'v23') return verifyV23(config.fixture);
  if (config.kind === 'r2') return verifyR2(config.fixture);
  return verifyR3(config.fixture);
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

async function verifyR3(fixturePath) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const { fixture_sha256: recorded, ...payload } = fixture;
  if (fixture.schema_version !== 'aiws.v3.r3_golden.v1' || fixture.extraction?.mode !== 'ephemeral_local_runtime' || fixture.extraction?.executed_runtime !== true || fixture.extraction?.network !== 'loopback_only') throw new Error('r3_golden_identity_invalid');
  if (sha256(JSON.stringify(payload)) !== recorded) throw new Error('r3_golden_checksum_invalid');
  for (const source of fixture.source_files || []) if (sha256(fs.readFileSync(path.join(root, source.path))) !== source.sha256) throw new Error(`r3_golden_source_changed:${source.path}`);
  const serialized = JSON.stringify(fixture);
  if (/(?:source_locator|managed_relative_path|local_path|remote_url)/i.test(serialized)) throw new Error('r3_golden_private_path_exposed');
  const actual = await replayR3Contracts();
  if (JSON.stringify(actual) !== JSON.stringify(fixture.contracts)) throw new Error('r3_golden_behavior_mismatch');
  return { batch: 'r3-project-repository', fixture: relative(fixturePath), fixture_sha256: recorded, contracts: fixture.contracts.length, cases: contractCaseCount(fixture.contracts) };
}

async function replayR3Contracts() {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r3-golden-source-'));
  fs.writeFileSync(path.join(sourceRoot, 'README.md'), '# R3 golden source\n', 'utf8');
  fs.mkdirSync(path.join(sourceRoot, 'src'));
  fs.writeFileSync(path.join(sourceRoot, 'src', 'fixture.txt'), 'stable\n', 'utf8');
  const originalSourceHash = manifestDirectory(sourceRoot).hash;
  let env;
  try {
    env = await quietFixture({ config: { projectImportRoots: [sourceRoot] } });
    const createInput = {
      name: 'R3 golden project',
      description: 'Deterministic Project and Repository contract',
      repository: { source: { kind: 'local', path: sourceRoot } }
    };
    const created = await mutate(env.base, '/api/v1/projects', createInput, 'r3-golden-create');
    const createReplay = await mutate(env.base, '/api/v1/projects', createInput, 'r3-golden-create');
    goldenRequire(created.response.status === 201 && createReplay.response.status === 201, 'create_status');
    goldenRequire(created.json.id === createReplay.json.id, 'create_idempotency');

    const initialIntakeId = created.json.intake.id;
    const cancelled = await mutate(env.base, `/api/v1/intakes/${initialIntakeId}/cancel`, {
      expected_revision: created.json.intake.revision
    }, 'r3-golden-cancel');
    goldenRequire(cancelled.response.status === 202 && cancelled.json.status === 'cancelled', 'cancel_state');
    const resumed = await mutate(env.base, `/api/v1/intakes/${initialIntakeId}/resume`, {
      expected_revision: cancelled.json.revision
    }, 'r3-golden-resume');
    goldenRequire(resumed.response.status === 202, 'resume_receipt');
    const resumeOperation = await goldenWaitOperation(env.base, resumed.json.operation_id);
    const ready = (await request(env.base, `/api/v1/projects/${created.json.id}`)).json;
    goldenRequire(resumeOperation.status === 'completed' && ready.intake.status === 'ready', 'resume_completion');

    const retryDraft = await mutate(env.base, '/api/v1/projects', { name: 'R3 golden retry' }, 'r3-golden-retry-create');
    goldenRequire(retryDraft.response.status === 201, 'retry_create');
    await env.app.database.run("UPDATE project_intakes SET status='failed',attempt=1,revision=revision+1,error_code='repository_probe_failed',updated_at=? WHERE id=?", ['2026-08-11T00:00:00.000Z', retryDraft.json.intake.id]);
    await env.app.database.run("UPDATE projects SET onboarding_state='failed',revision=revision+1,updated_at=? WHERE id=?", ['2026-08-11T00:00:00.000Z', retryDraft.json.id]);
    const failed = (await request(env.base, `/api/v1/projects/${retryDraft.json.id}`)).json;
    const retried = await mutate(env.base, `/api/v1/intakes/${failed.intake.id}/retry`, {
      expected_revision: failed.intake.revision
    }, 'r3-golden-retry');
    goldenRequire(retried.response.status === 202, 'retry_receipt');
    const retryOperation = await goldenWaitOperation(env.base, retried.json.operation_id);
    const retryReady = (await request(env.base, `/api/v1/projects/${retryDraft.json.id}`)).json;
    goldenRequire(retryOperation.status === 'completed' && retryReady.intake.status === 'ready', 'retry_completion');

    const firstBrief = await mutate(env.base, `/api/v1/projects/${created.json.id}/briefs`, {
      content: { objective: 'Superseded preview' }
    }, 'r3-golden-brief-first');
    const secondBrief = await mutate(env.base, `/api/v1/projects/${created.json.id}/briefs`, {
      content: { objective: 'Confirmed preview', acceptance: ['R3 verified'] }
    }, 'r3-golden-brief-second');
    const beforeConfirm = (await request(env.base, `/api/v1/projects/${created.json.id}`)).json;
    const staleConfirm = await mutate(env.base, `/api/v1/projects/${created.json.id}/briefs/${firstBrief.json.revision}/confirm`, {
      expected_revision: beforeConfirm.revision,
      intake_revision: beforeConfirm.intake.revision
    }, 'r3-golden-stale-confirm');
    goldenRequire(staleConfirm.response.status === 409 && staleConfirm.json.error?.code === 'revision_conflict', 'stale_confirm');
    const confirmed = await mutate(env.base, `/api/v1/projects/${created.json.id}/briefs/${secondBrief.json.revision}/confirm`, {
      expected_revision: beforeConfirm.revision,
      intake_revision: beforeConfirm.intake.revision
    }, 'r3-golden-confirm');
    goldenRequire(confirmed.response.status === 200 && confirmed.json.status === 'active', 'brief_confirm');
    const confirmReplay = await mutate(env.base, `/api/v1/projects/${created.json.id}/briefs/${secondBrief.json.revision}/confirm`, {
      expected_revision: beforeConfirm.revision,
      intake_revision: beforeConfirm.intake.revision
    }, 'r3-golden-confirm-replay');
    goldenRequire(confirmReplay.response.status === 200 && confirmReplay.json.revision === confirmed.json.revision, 'brief_confirm_idempotency');

    const lines = (await request(env.base, `/api/v1/projects/${created.json.id}/repository-lines`)).json;
    const checkoutLine = lines.find((line) => line.line_kind === 'managed_checkout');
    goldenRequire(checkoutLine && lines.length === 3, 'repository_lines');
    const checkout = path.join(env.home, 'projects', created.json.id);
    const displaced = path.join(env.home, '.r3-golden-displaced');
    fs.renameSync(checkout, displaced);
    const probe = await mutate(env.base, `/api/v1/repository-lines/${checkoutLine.id}/probe`, {
      expected_revision: checkoutLine.revision
    }, 'r3-golden-line-probe');
    const failedProbe = await goldenWaitOperation(env.base, probe.json.operation_id);
    const faultedLine = (await request(env.base, `/api/v1/repository-lines/${checkoutLine.id}`)).json;
    goldenRequire(failedProbe.status === 'failed' && faultedLine.fault_code === 'repository_line_fault', 'line_fault');
    fs.renameSync(displaced, checkout);
    const recovered = await mutate(env.base, `/api/v1/repository-lines/${checkoutLine.id}/recover`, {
      expected_revision: faultedLine.revision
    }, 'r3-golden-line-recover');
    const recoveryOperation = await goldenWaitOperation(env.base, recovered.json.operation_id);
    const recoveredLine = (await request(env.base, `/api/v1/repository-lines/${checkoutLine.id}`)).json;
    goldenRequire(recoveryOperation.status === 'completed' && recoveredLine.status === 'ready' && !recoveredLine.fault_code, 'line_recovery');

    const interrupted = await env.app.domain.operationService.create({
      kind: 'repository.probe', resourceType: 'repository_line', resourceId: checkoutLine.id
    });
    await env.app.database.run("UPDATE repository_lines SET locked_by_operation_id=?,operation_id=?,status='busy',revision=revision+1 WHERE id=?", [interrupted.operation_id, interrupted.operation_id, checkoutLine.id]);
    await env.app.domain.recover();
    const interruptedOperation = await env.app.domain.operationService.get(interrupted.operation_id);
    const interruptedLine = (await request(env.base, `/api/v1/repository-lines/${checkoutLine.id}`)).json;
    goldenRequire(interruptedOperation.error_code === 'operation_interrupted' && interruptedLine.fault_code === 'repository_line_interrupted', 'restart_recovery');
    const restartRecovered = await mutate(env.base, `/api/v1/repository-lines/${checkoutLine.id}/recover`, {
      expected_revision: interruptedLine.revision
    }, 'r3-golden-restart-recover');
    const restartRecoveryOperation = await goldenWaitOperation(env.base, restartRecovered.json.operation_id);
    const finalLine = (await request(env.base, `/api/v1/repository-lines/${checkoutLine.id}`)).json;
    goldenRequire(restartRecoveryOperation.status === 'completed' && finalLine.status === 'ready', 'restart_line_recovery');

    let lifecycleProject = (await request(env.base, `/api/v1/projects/${created.json.id}`)).json;
    const archived = await mutate(env.base, `/api/v1/projects/${created.json.id}/archive`, {
      expected_revision: lifecycleProject.revision
    }, 'r3-golden-archive');
    const archiveOperation = await goldenWaitOperation(env.base, archived.json.operation_id);
    lifecycleProject = (await request(env.base, `/api/v1/projects/${created.json.id}`)).json;
    const archivedStatus = lifecycleProject.status;
    const trashed = await mutate(env.base, `/api/v1/projects/${created.json.id}/trash`, {
      expected_revision: lifecycleProject.revision
    }, 'r3-golden-trash');
    const trashOperation = await goldenWaitOperation(env.base, trashed.json.operation_id);
    lifecycleProject = (await request(env.base, `/api/v1/projects/${created.json.id}`)).json;
    const trashedStatus = lifecycleProject.status;
    const restored = await mutate(env.base, `/api/v1/projects/${created.json.id}/restore`, {
      expected_revision: lifecycleProject.revision
    }, 'r3-golden-restore');
    const restoreOperation = await goldenWaitOperation(env.base, restored.json.operation_id);
    lifecycleProject = (await request(env.base, `/api/v1/projects/${created.json.id}`)).json;
    const restoredStatus = lifecycleProject.status;
    const reTrashed = await mutate(env.base, `/api/v1/projects/${created.json.id}/trash`, {
      expected_revision: lifecycleProject.revision
    }, 'r3-golden-retrash');
    await goldenWaitOperation(env.base, reTrashed.json.operation_id);
    lifecycleProject = (await request(env.base, `/api/v1/projects/${created.json.id}`)).json;
    const purgeMismatch = await mutate(env.base, `/api/v1/projects/${created.json.id}/purge`, {
      expected_revision: lifecycleProject.revision,
      confirm_name: 'mismatched project'
    }, 'r3-golden-purge-mismatch');
    const purged = await mutate(env.base, `/api/v1/projects/${created.json.id}/purge`, {
      expected_revision: lifecycleProject.revision,
      confirm_name: lifecycleProject.name
    }, 'r3-golden-purge');
    const purgeOperation = await goldenWaitOperation(env.base, purged.json.operation_id);
    const purgedRead = await request(env.base, `/api/v1/projects/${created.json.id}`);
    const lifecycleSourceHash = manifestDirectory(sourceRoot).hash;
    goldenRequire([archiveOperation, trashOperation, restoreOperation, purgeOperation].every((operation) => operation.status === 'completed'), 'lifecycle_operations');
    goldenRequire(purgeMismatch.response.status === 409 && purgedRead.response.status === 404 && lifecycleSourceHash === originalSourceHash, 'lifecycle_integrity');

    const sourceBeforeDrift = await probeRepositorySource({ kind: 'local', path: sourceRoot }, env.app.config);
    assertIntakeSourceStable(sourceBeforeDrift, sourceBeforeDrift);
    fs.writeFileSync(path.join(sourceRoot, 'README.md'), '# R3 golden source changed\n', 'utf8');
    const sourceAfterDrift = await probeRepositorySource({ kind: 'local', path: sourceRoot }, env.app.config);
    let driftError = null;
    try { assertIntakeSourceStable(sourceBeforeDrift, sourceAfterDrift); }
    catch (error) { driftError = { code: error.code, status: error.status, source_kind: error.details?.source_kind }; }
    goldenRequire(driftError?.code === 'intake_source_changed', 'source_drift');

    return [
      {
        id: 'project-create-idempotency', feature_id: 'REC-D5-PROJECT-005', cases: [{
          id: 'same-key-replay',
          input: { name: createInput.name, mode: 'existing', source_kind: 'local' },
          output: {
            first_status: created.response.status, replay_status: createReplay.response.status,
            same_project_id: created.json.id === createReplay.json.id, project_status: created.json.status,
            project_revision: created.json.revision, intake_status: created.json.intake.status,
            brief_revision: created.json.brief.revision, workflow_source_brief_revision: created.json.workflow_draft.source_brief_revision
          }
        }]
      },
      {
        id: 'intake-recovery', feature_id: 'REC-D5-PROJECT-005', cases: [
          {
            id: 'cancel-resume',
            output: {
              cancelled_status: cancelled.json.status, receipt_status: resumed.json.status,
              operation_status: resumeOperation.status, same_intake_id: ready.intake.id === initialIntakeId,
              ready_status: ready.intake.status, attempt: ready.intake.attempt,
              revision_advanced: ready.intake.revision > cancelled.json.revision
            }
          },
          {
            id: 'failed-retry',
            output: {
              prior_status: failed.intake.status, prior_error_code: failed.intake.error_code,
              receipt_status: retried.json.status, operation_status: retryOperation.status,
              same_intake_id: retryReady.intake.id === failed.intake.id,
              ready_status: retryReady.intake.status, attempt: retryReady.intake.attempt
            }
          }
        ]
      },
      {
        id: 'brief-confirmation', feature_id: 'REC-D5-PROJECT-005', cases: [{
          id: 'stale-and-idempotent-confirm',
          output: {
            stale_status: staleConfirm.response.status, stale_error_code: staleConfirm.json.error.code,
            stale_current_revision: staleConfirm.json.error.details.current_revision,
            latest_revision: secondBrief.json.revision, confirmed_status: confirmed.json.status,
            onboarding_state: confirmed.json.onboarding_state,
            confirmed_brief_revision: confirmed.json.confirmed_brief_revision,
            workflow_source_brief_revision: confirmed.json.workflow_draft.source_brief_revision,
            replay_status: confirmReplay.response.status,
            replay_preserved_project_revision: confirmReplay.json.revision === confirmed.json.revision
          }
        }]
      },
      {
        id: 'repository-line-recovery', feature_id: 'REC-D7-REPOSITORY-014', cases: [
          {
            id: 'probe-fault-recover',
            output: {
              line_kinds: lines.map((line) => line.line_kind).toSorted(),
              probe_operation_status: failedProbe.status, probe_error_code: failedProbe.error_code,
              fault_status: faultedLine.status, fault_code: faultedLine.fault_code,
              recovery_operation_status: recoveryOperation.status,
              recovered_status: recoveredLine.status, recovered_fault_code: recoveredLine.fault_code
            }
          },
          {
            id: 'restart-interruption-recover',
            output: {
              interrupted_operation_status: interruptedOperation.status,
              interrupted_operation_error: interruptedOperation.error_code,
              interrupted_line_status: interruptedLine.status,
              interrupted_line_fault: interruptedLine.fault_code,
              recovery_operation_status: restartRecoveryOperation.status,
              final_line_status: finalLine.status, final_fault_code: finalLine.fault_code
            }
          }
        ]
      },
      {
        id: 'project-lifecycle', feature_id: 'REC-D5-PROJECT-005', cases: [{
          id: 'archive-trash-restore-purge',
          output: {
            archive_operation_status: archiveOperation.status, archived_status: archivedStatus,
            trash_operation_status: trashOperation.status, trashed_status: trashedStatus,
            restore_operation_status: restoreOperation.status, restored_status: restoredStatus,
            purge_mismatch_status: purgeMismatch.response.status,
            purge_mismatch_error: purgeMismatch.json.error.code,
            purge_operation_status: purgeOperation.status, purged_read_status: purgedRead.response.status,
            external_source_unchanged: lifecycleSourceHash === originalSourceHash
          }
        }]
      },
      {
        id: 'repository-source-drift', feature_id: 'REC-D7-REPOSITORY-014', cases: [{
          id: 'local-manifest-changed',
          output: {
            hash_changed: sourceBeforeDrift.hash !== sourceAfterDrift.hash,
            revision_changed: sourceBeforeDrift.revision !== sourceAfterDrift.revision,
            error_code: driftError.code, error_status: driftError.status, source_kind: driftError.source_kind
          }
        }]
      }
    ];
  } finally {
    await env?.close().catch(() => undefined);
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
}

async function quietFixture(options) {
  const originalWrite = process.stdout.write;
  process.stdout.write = function filteredRuntimeBanner(chunk, ...args) {
    if (/^AIWS (?:runner-broker |3\.0\.0 )listening on /.test(String(chunk))) return true;
    return originalWrite.call(this, chunk, ...args);
  };
  try { return await fixture(options); }
  finally { process.stdout.write = originalWrite; }
}

async function goldenWaitOperation(base, operationId) {
  return eventually(
    async () => (await request(base, `/api/v1/operations/${operationId}`)).json,
    (operation) => ['completed', 'failed', 'cancelled'].includes(operation.status),
    10_000
  );
}

function goldenRequire(condition, label) {
  if (!condition) throw new Error(`r3_golden_setup_failed:${label}`);
}

function contractCaseCount(contracts) {
  return contracts.reduce((count, contract) => count + (contract.cases?.length || 0), 0);
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
