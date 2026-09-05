import { createHash, createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
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
import { eventually, fixture, mutate, onboardProject, request } from '../tests/integration/helpers.mjs';
import { resolveGitCommit, verifyPinnedSourceFiles } from './lib/git-blob.mjs';

const root = process.cwd();
const V23_SOURCE_COMMIT = 'e18dc0b';
const V23_FIXTURE = path.join(root, 'tests', 'golden', 'v23', 'r0-r1.json');
const R2_FIXTURE = path.join(root, 'tests', 'golden', 'r2', 'identity-setup.json');
const R3_FIXTURE = path.join(root, 'tests', 'golden', 'r3', 'project-repository.json');
const R4_FIXTURE = path.join(root, 'tests', 'golden', 'r4', 'workflow-generation-critic.json');
const R5_FIXTURE = path.join(root, 'tests', 'golden', 'r5', 'context-projection-mcp.json');
const R5_SOURCE_PROOF_COMMIT = '250bb44f5264fd7f262d2c8e6f5a174b3f58f266';
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
const R4_SOURCE_FILES = Object.freeze([
  'apps/api/src/command-registry.mjs',
  'apps/api/src/domain.mjs',
  'apps/api/src/http.mjs',
  'apps/api/src/migrations/004-workflow-generation-critic.mjs',
  'apps/api/src/modules/operations/service.mjs',
  'apps/api/src/modules/workflow/repository.mjs',
  'apps/api/src/modules/workflow/service.mjs',
  'apps/api/src/modules/workflow/validator.mjs'
]);
const R5_SOURCE_FILES = Object.freeze([
  'apps/api/src/command-registry.mjs',
  'apps/api/src/domain.mjs',
  'apps/api/src/http.mjs',
  'apps/api/src/migrations/index.mjs',
  'apps/api/src/migrations/005-context-projection-mcp.mjs',
  'apps/api/src/modules/context/adapters.mjs',
  'apps/api/src/modules/context/index.mjs',
  'apps/api/src/modules/context/index-runtime.mjs',
  'apps/api/src/modules/context/pack.mjs',
  'apps/api/src/modules/context/projection-worker.mjs',
  'apps/api/src/modules/context/repository.mjs',
  'apps/api/src/modules/context/selection.mjs',
  'apps/api/src/modules/context/service.mjs',
  'apps/api/src/modules/mcp/http.mjs',
  'apps/api/src/modules/mcp/public-tools.mjs',
  'apps/api/src/modules/query-registry.mjs',
  'scripts/mcp-stdio.mjs'
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
  'r3-project-repository': { fixture: R3_FIXTURE, kind: 'r3' },
  'r4-workflow-generation-critic': { fixture: R4_FIXTURE, kind: 'r4' },
  'r5-context-projection-mcp': { fixture: R5_FIXTURE, kind: 'r5' }
});

export async function main(argv = process.argv.slice(2)) {
  const mode = argv[0] || 'verify';
  const requestedBatch = argv[1] || null;
  if (mode === 'extract') await extract(requestedBatch);
  else if (mode === 'verify') await verify(requestedBatch);
  else throw new Error(`unknown_golden_mode:${mode}`);
}

async function extract(batchName = null) {
  const names = selectBatches(batchName);
  const results = [];
  for (const name of names) {
    const config = batches[name];
    if (config.kind === 'v23') results.push(await extractV23(config.fixture));
    else if (config.kind === 'r2') results.push(await extractR2(config.fixture));
    else if (config.kind === 'r3') results.push(await extractR3(config.fixture));
    else if (config.kind === 'r4') results.push(await extractR4(config.fixture));
    else results.push(await extractR5(config.fixture));
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

async function extractR4(fixturePath) {
  const sourceCommit = runGit(['rev-parse', 'HEAD']).stdout.trim();
  const sourceFiles = R4_SOURCE_FILES.map((file) => ({ path: file, sha256: sha256(fs.readFileSync(path.join(root, file))) }));
  const contracts = await replayR4Contracts();
  const payload = {
    schema_version: 'aiws.v3.r4_golden.v1',
    source_commit: sourceCommit,
    extraction: { mode: 'ephemeral_deterministic_fixture', executed_runtime: true, network: 'loopback_only' },
    source_files: sourceFiles,
    contracts
  };
  const fixture = { ...payload, fixture_sha256: sha256(JSON.stringify(payload)) };
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  return { batch: 'r4-workflow-generation-critic', fixture: relative(fixturePath), fixture_sha256: fixture.fixture_sha256, contracts: contracts.length, cases: contractCaseCount(contracts) };
}

async function extractR5(fixturePath) {
  const sourceCommit = runGit(['rev-parse', 'HEAD']).stdout.trim();
  const sourceFiles = R5_SOURCE_FILES.map((file) => ({ path: file, sha256: sha256(fs.readFileSync(path.join(root, file))) }));
  const contracts = await replayR5Contracts();
  const payload = {
    schema_version: 'aiws.v3.r5_golden.v1',
    source_commit: sourceCommit,
    extraction: { mode: 'ephemeral_deterministic_fixture', executed_runtime: true, network: 'loopback_only' },
    source_files: sourceFiles,
    contracts
  };
  const fixture = { ...payload, fixture_sha256: sha256(JSON.stringify(payload)) };
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  return { batch: 'r5-context-projection-mcp', fixture: relative(fixturePath), fixture_sha256: fixture.fixture_sha256, contracts: contracts.length, cases: contractCaseCount(contracts) };
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
  if (config.kind === 'r3') return verifyR3(config.fixture);
  if (config.kind === 'r4') return verifyR4(config.fixture);
  return verifyR5(config.fixture);
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
  const sourceDrift = [];
  for (const source of fixture.source_files || []) {
    const currentSource = fs.readFileSync(path.join(root, source.path));
    let baselineHash = '';
    try { baselineHash = sha256(runGit(['show', `${fixture.source_commit}:${source.path}`]).stdout); } catch { /* R3 source files were captured from the then-working tree. */ }
    if (baselineHash !== source.sha256 && sha256(currentSource) !== source.sha256) sourceDrift.push(source.path);
  }
  const serialized = JSON.stringify(fixture);
  if (/(?:source_locator|managed_relative_path|local_path|remote_url)/i.test(serialized)) throw new Error('r3_golden_private_path_exposed');
  const actual = await replayR3Contracts();
  if (JSON.stringify(actual) !== JSON.stringify(fixture.contracts)) throw new Error('r3_golden_behavior_mismatch');
  return { batch: 'r3-project-repository', fixture: relative(fixturePath), fixture_sha256: recorded, contracts: fixture.contracts.length, cases: contractCaseCount(fixture.contracts), source_drift: sourceDrift };
}

async function verifyR4(fixturePath) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const { fixture_sha256: recorded, ...payload } = fixture;
  if (fixture.schema_version !== 'aiws.v3.r4_golden.v1' || fixture.extraction?.mode !== 'ephemeral_deterministic_fixture' || fixture.extraction?.executed_runtime !== true || fixture.extraction?.network !== 'loopback_only') throw new Error('r4_golden_identity_invalid');
  if (sha256(JSON.stringify(payload)) !== recorded) throw new Error('r4_golden_checksum_invalid');
  const sourceDrift = [];
  for (const source of fixture.source_files || []) {
    const currentHash = sha256(fs.readFileSync(path.join(root, source.path)));
    let committedHash = '';
    try { committedHash = sha256(runGit(['show', `${fixture.source_commit}:${source.path}`]).stdout); } catch { /* A new R4 source may only exist in the captured working tree. */ }
    if (currentHash !== source.sha256 && committedHash !== source.sha256) sourceDrift.push(source.path);
  }
  const serialized = JSON.stringify(fixture);
  if (/(?:source_locator|managed_relative_path|local_path|remote_url|prompt|candidate_json|input_snapshot_json)/i.test(serialized)) throw new Error('r4_golden_private_input_exposed');
  const actual = await replayR4Contracts();
  if (JSON.stringify(actual) !== JSON.stringify(fixture.contracts)) throw new Error('r4_golden_behavior_mismatch');
  return { batch: 'r4-workflow-generation-critic', fixture: relative(fixturePath), fixture_sha256: recorded, contracts: fixture.contracts.length, cases: contractCaseCount(fixture.contracts), source_drift: sourceDrift };
}

export async function verifyR5(fixturePath) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const { fixture_sha256: recorded, ...payload } = fixture;
  if (fixture.schema_version !== 'aiws.v3.r5_golden.v1' || fixture.extraction?.mode !== 'ephemeral_deterministic_fixture' || fixture.extraction?.executed_runtime !== true || fixture.extraction?.network !== 'loopback_only') throw new Error('r5_golden_identity_invalid');
  if (sha256(JSON.stringify(payload)) !== recorded) throw new Error('r5_golden_checksum_invalid');
  const extractionBase = resolveGitCommit(root, fixture.source_commit);
  const proofCommit = resolveGitCommit(root, R5_SOURCE_PROOF_COMMIT);
  if (runGit(['merge-base', '--is-ancestor', extractionBase, proofCommit]).status !== 0) throw new Error('r5_golden_source_proof_lineage_invalid');
  const sourceProof = verifyPinnedSourceFiles({
    root,
    sourceCommit: proofCommit,
    sourceFiles: fixture.source_files,
    errorPrefix: 'r5_golden_source_unverifiable'
  });
  const serialized = JSON.stringify(fixture);
  if (/(?:local_path|remote_url|cas_path|index_path|authorization|private_body|document_text)/i.test(serialized)) throw new Error('r5_golden_private_input_exposed');
  const actual = await replayR5Contracts();
  if (JSON.stringify(actual) !== JSON.stringify(fixture.contracts)) throw new Error('r5_golden_behavior_mismatch');
  return {
    batch: 'r5-context-projection-mcp', fixture: relative(fixturePath), fixture_sha256: recorded,
    source_commit: extractionBase, source_proof_commit: proofCommit, source_drift: sourceProof.source_drift,
    contracts: fixture.contracts.length, cases: contractCaseCount(fixture.contracts)
  };
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

async function replayR4Contracts() {
  let env;
  try {
    env = await quietFixture();
    const projectId = await r4GoldenProject(env, 'primary');
    const originalDraft = (await request(env.base, `/api/v1/projects/${projectId}/workflow-draft`)).json;
    const validGraph = {
      name: 'R4 golden workflow',
      workstreams: [
        {
          id: 'analysis',
          tasks: [{ id: 'inspect', goal: 'Inspect', outputs: ['artifacts/analysis.json'], acceptance: ['analysis exists'] }]
        },
        {
          id: 'delivery', deps: ['analysis'],
          tasks: [{ id: 'implement', goal: 'Implement', deps: ['inspect'], inputs: ['artifacts/analysis.json'], outputs: ['artifacts/result.json'], acceptance: ['tests pass'] }]
        }
      ]
    };
    const validDraft = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-draft`, {
      expected_revision: originalDraft.revision, graph: validGraph
    }, 'r4-golden-valid-draft', 'PATCH');
    goldenRequire(validDraft.response.status === 201 && validDraft.json.revision === 2, 'r4_valid_draft');

    const crossScope = structuredClone(validGraph);
    crossScope.workstreams[1].deps = [];
    const crossScopeResult = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-draft`, {
      expected_revision: validDraft.json.revision, graph: crossScope
    }, 'r4-golden-cross-scope', 'PATCH');
    const cycle = structuredClone(validGraph);
    cycle.workstreams[0].deps = ['delivery'];
    const cycleResult = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-draft`, {
      expected_revision: validDraft.json.revision, graph: cycle
    }, 'r4-golden-cycle', 'PATCH');
    const duplicateOutput = structuredClone(validGraph);
    duplicateOutput.workstreams[1].tasks[0].outputs = ['artifacts/analysis.json'];
    const duplicateResult = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-draft`, {
      expected_revision: validDraft.json.revision, graph: duplicateOutput
    }, 'r4-golden-duplicate-output', 'PATCH');

    const layout = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-draft/layouts`, {
      expected_revision: 0,
      draft_revision: validDraft.json.revision,
      nodes: [
        { id: 'analysis', position: { x: 20, y: 40 } },
        { id: 'inspect', position: { x: 60, y: 120 } },
        { id: 'delivery', position: { x: 420, y: 40 } },
        { id: 'implement', position: { x: 460, y: 120 } }
      ],
      viewport: { x: 0, y: 0, zoom: 1 }
    }, 'r4-golden-layout');
    const generated = await r4GoldenGeneration(env, projectId, 'success');
    const generationEvents = (await request(env.base, `/api/v1/workflow-generations/${generated.state.id}/events`)).json;
    const applied = await mutate(env.base, `/api/v1/workflow-proposals/${generated.state.proposal.id}/apply`, {
      async: true
    }, 'r4-golden-apply');
    const applyOperation = await goldenWaitOperation(env.base, applied.json.operation_id);
    const applyReplay = await mutate(env.base, `/api/v1/workflow-proposals/${generated.state.proposal.id}/apply`, {
      async: true
    }, 'r4-golden-apply-replay');
    const initialWorkflows = (await request(env.base, `/api/v1/projects/${projectId}/workflows`)).json;
    const initialContracts = (await request(env.base, `/api/v1/projects/${projectId}/node-contracts?workflow_revision=${applyOperation.result.workflow_revision}`)).json;
    goldenRequire(applyOperation.status === 'completed' && initialWorkflows[0].revision === 1, 'r4_initial_apply');

    const execution = await mutate(env.base, `/api/v1/projects/${projectId}/executions`, {}, 'r4-golden-execution');
    goldenRequire(execution.response.status === 201, 'r4_execution');
    await env.app.database.run("UPDATE task_attempts SET status='completed',finished_at=? WHERE execution_id=? AND task_id='inspect'", ['2026-08-13T00:00:00.000Z', execution.json.id]);
    const beforeReplanInspect = initialWorkflows[0].tasks.find((task) => task.id === 'inspect');
    const replan = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-generations/replan`, {
      provider: 'fixture', async: true
    }, 'r4-golden-replan');
    const replanState = await r4GoldenWaitGeneration(env.base, replan.json.generation_id);
    const replanApply = await mutate(env.base, `/api/v1/workflow-proposals/${replanState.proposal.id}/apply`, {
      async: true
    }, 'r4-golden-replan-apply');
    const replanOperation = await goldenWaitOperation(env.base, replanApply.json.operation_id);
    const replannedWorkflows = (await request(env.base, `/api/v1/projects/${projectId}/workflows`)).json;
    const afterReplanInspect = replannedWorkflows[0].tasks.find((task) => task.id === 'inspect');
    goldenRequire(replanOperation.status === 'completed' && replannedWorkflows[0].revision === 2, 'r4_replan_apply');

    const criticProjectId = await r4GoldenProject(env, 'critic', {
      objective: 'Critic golden', feature: 'unmapped golden feature', acceptance: ['tests pass']
    });
    const rejected = await r4GoldenGeneration(env, criticProjectId, 'critic');
    const unavailableProjectId = await r4GoldenProject(env, 'unavailable');
    const unavailable = await r4GoldenGeneration(env, unavailableProjectId, 'unavailable', { provider: 'unavailable' });

    const cancelProjectId = await r4GoldenProject(env, 'cancel');
    const cancelStarted = await mutate(env.base, `/api/v1/projects/${cancelProjectId}/workflow-generations`, {
      provider: 'fixture', fixture_delay_ms: 800, async: true
    }, 'r4-golden-cancel-start');
    await eventually(
      async () => (await request(env.base, `/api/v1/workflow-generations/${cancelStarted.json.generation_id}`)).json,
      (value) => value.phase === 'running',
      5_000
    );
    const cancelOperationBefore = (await request(env.base, `/api/v1/operations/${cancelStarted.json.operation_id}`)).json;
    const cancelReceipt = await mutate(env.base, `/api/v1/workflow-generations/${cancelStarted.json.generation_id}/cancel`, {
      expected_revision: cancelOperationBefore.revision
    }, 'r4-golden-cancel-action');
    const cancelledState = await r4GoldenWaitGeneration(env.base, cancelStarted.json.generation_id);
    const retry = await mutate(env.base, `/api/v1/workflow-generations/${cancelledState.id}/retry`, {
      provider: 'fixture', async: true
    }, 'r4-golden-retry');
    const retryState = await r4GoldenWaitGeneration(env.base, retry.json.generation_id);
    const interrupted = await env.app.domain.operationService.create({
      kind: 'workflow.generate', resourceType: 'workflow_generation', resourceId: 'wgen_r4_golden_missing'
    });
    await env.app.domain.recover();
    const interruptedState = await env.app.domain.operationService.get(interrupted.operation_id);

    const staleProjectId = await r4GoldenProject(env, 'stale');
    const staleDraft = (await request(env.base, `/api/v1/projects/${staleProjectId}/workflow-draft`)).json;
    await mutate(env.base, `/api/v1/projects/${staleProjectId}/workflow-draft/layouts`, {
      expected_revision: 0, draft_revision: staleDraft.revision, nodes: [], viewport: { x: 0, y: 0, zoom: 1 }
    }, 'r4-golden-stale-layout-one');
    const staleGeneration = await r4GoldenGeneration(env, staleProjectId, 'stale');
    const newerLayout = await mutate(env.base, `/api/v1/projects/${staleProjectId}/workflow-draft/layouts`, {
      expected_revision: 1, draft_revision: staleDraft.revision, nodes: [], viewport: { x: 20, y: 20, zoom: 1 }
    }, 'r4-golden-stale-layout-two');
    const staleApply = await mutate(env.base, `/api/v1/workflow-proposals/${staleGeneration.state.proposal.id}/apply`, {}, 'r4-golden-stale-apply');

    const eventTypesAfterApply = (await request(env.base, `/api/v1/workflow-generations/${generated.state.id}/events`)).json.map((event) => event.type);
    return [
      {
        id: 'workflow-two-level-validation', feature_id: 'REC-D5-WORKFLOW-006', cases: [
          {
            id: 'canonical-two-level-draft',
            output: {
              status: validDraft.response.status,
              hierarchy_mode: validDraft.json.hierarchy_mode,
              revision: validDraft.json.revision,
              workstream_count: validDraft.json.graph.workstreams.length,
              task_count: validDraft.json.graph.tasks.length,
              graph_hidden: !Object.hasOwn(validDraft.json, 'graph_json')
            }
          },
          { id: 'dependency-scope', output: { status: crossScopeResult.response.status, error_code: crossScopeResult.json.error.code } },
          { id: 'graph-cycle', output: { status: cycleResult.response.status, error_code: cycleResult.json.error.code } },
          { id: 'duplicate-output', output: { status: duplicateResult.response.status, error_code: duplicateResult.json.error.code } }
        ]
      },
      {
        id: 'generation-critic-apply-replan', feature_id: 'REC-D6-GENERATION-007', cases: [
          {
            id: 'generate-critic-apply-idempotently',
            output: {
              layout_status: layout.response.status,
              layout_revision: layout.json.revision,
              queued_status: generated.started.response.status,
              phase_before_apply: generated.state.phase,
              critic_status: generated.state.critic.status,
              candidate_hash_valid: /^[a-f0-9]{64}$/.test(generated.state.candidate_hash),
              proposal_hash_valid: /^[a-f0-9]{64}$/.test(generated.state.proposal.proposal_hash),
              event_types_before_apply: generationEvents.map((event) => event.type),
              event_types_after_apply: eventTypesAfterApply,
              public_events_redacted: !JSON.stringify(generationEvents).includes('tests pass'),
              apply_operation_status: applyOperation.status,
              workflow_revision: applyOperation.result.workflow_revision,
              replay_same_revision: applyReplay.json.workflow_revision === applyOperation.result.workflow_revision,
              contract_count: initialContracts.length,
              contract_payload_hidden: initialContracts.every((contract) => !Object.hasOwn(contract, 'contract_json'))
            }
          },
          {
            id: 'replan-preserves-completed-node',
            output: {
              generation_mode: replanState.mode,
              generation_phase: replanState.phase,
              apply_operation_status: replanOperation.status,
              workflow_revision: replannedWorkflows[0].revision,
              revision_advanced_once: replannedWorkflows[0].revision === initialWorkflows[0].revision + 1,
              completed_node_preserved: JSON.stringify(beforeReplanInspect) === JSON.stringify(afterReplanInspect)
            }
          }
        ]
      },
      {
        id: 'generation-failure-and-rejection', feature_id: 'REC-D6-GENERATION-007', cases: [
          {
            id: 'critic-rejection',
            output: {
              phase: rejected.state.phase,
              error_code: rejected.state.error_code,
              critic_status: rejected.state.critic.status,
              proposal_absent: rejected.state.proposal == null
            }
          },
          {
            id: 'provider-unavailable',
            output: { phase: unavailable.state.phase, error_code: unavailable.state.error_code, operation_status: unavailable.operation.status }
          }
        ]
      },
      {
        id: 'generation-cancel-retry-recovery', feature_id: 'REC-D6-GENERATION-007', cases: [
          {
            id: 'cancel-and-retry-attempt',
            output: {
              cancel_status: cancelReceipt.response.status,
              cancelled_phase: cancelledState.phase,
              retry_status: retry.response.status,
              retry_phase: retryState.phase,
              retry_attempt: retryState.attempt,
              retry_linked: retryState.retry_of_generation_id === cancelledState.id
            }
          },
          {
            id: 'restart-interruption',
            output: { operation_status: interruptedState.status, error_code: interruptedState.error_code }
          }
        ]
      },
      {
        id: 'proposal-stale-revision', feature_id: 'REC-D5-WORKFLOW-006', cases: [{
          id: 'layout-revision-drift',
          output: {
            latest_layout_revision: newerLayout.json.revision,
            apply_status: staleApply.response.status,
            error_code: staleApply.json.error.code,
            current_layout_revision: staleApply.json.error.details.current_layout_revision
          }
        }]
      }
    ];
  } finally {
    await env?.close().catch(() => undefined);
  }
}

async function replayR5Contracts() {
  let env;
  try {
    env = await quietFixture();
    const created = await mutate(env.base, '/api/v1/projects', { name: 'R5 golden project' }, 'r5-golden-project');
    await onboardProject(env.base, created, { content: { objective: 'Project deterministic context', acceptance: ['sealed pack'] }, keyPrefix: 'r5-golden-onboard' });
    const workflow = await mutate(env.base, `/api/v1/projects/${created.json.id}/workflows`, {
      name: 'R5 golden workflow', tasks: [{ id: 'inspect', title: 'Inspect', level: 1, deps: [], mode: 'read', outputs: ['analysis.json'], acceptance: ['analysis exists'] }]
    }, 'r5-golden-workflow');
    goldenRequire(workflow.response.status === 201, 'r5_workflow');
    const source = await mutate(env.base, `/api/v1/projects/${created.json.id}/context/sources`, { kind: 'note', title: 'Golden signal', content: 'private fixture body excluded from golden output' }, 'r5-golden-source');
    const projection = await mutate(env.base, `/api/v1/projects/${created.json.id}/context/rebuild`, {}, 'r5-golden-rebuild');
    goldenRequire(projection.response.status === 201 && projection.json.job.status === 'completed', 'r5_projection');
    const leaf = projection.json.map.nodes.find((node) => node.source_id === source.json.id);
    goldenRequire(Boolean(leaf), 'r5_leaf');
    const beforeVersions = Number((await env.app.database.get('SELECT count(*) AS count FROM context_document_versions')).count);
    const repeated = await mutate(env.base, `/api/v1/projects/${created.json.id}/context/rebuild`, {}, 'r5-golden-rebuild-repeat');
    const repeatedLeaf = repeated.json.map.nodes.find((node) => node.source_id === source.json.id);
    const afterVersions = Number((await env.app.database.get('SELECT count(*) AS count FROM context_document_versions')).count);

    const initialPolicy = (await request(env.base, `/api/v1/projects/${created.json.id}/context/policy`)).json;
    const policy = await mutate(env.base, `/api/v1/projects/${created.json.id}/context/policy`, { expected_revision: initialPolicy.revision, policy: { pinned_node_ids: [leaf.id], excluded_node_ids: [] } }, 'r5-golden-policy', 'PATCH');
    const selection = await mutate(env.base, `/api/v1/projects/${created.json.id}/context/selections`, { node_ids: [leaf.id], token_budget: 2048, retrieval_plan: { strategy: 'minisearch_deterministic', token_budget: 2048 } }, 'r5-golden-selection');
    const pack = await mutate(env.base, `/api/v1/projects/${created.json.id}/context/packs`, { selection_id: selection.json.id, schema_version: 'aiws.context_pack.v5' }, 'r5-golden-pack');
    goldenRequire(pack.response.status === 201, 'r5_pack');

    const indexFile = path.join(env.home, 'context-index', `${encodeURIComponent(created.json.id)}.json`);
    fs.writeFileSync(indexFile, '{ invalid index');
    const recoveredSearch = await request(env.base, `/api/v1/projects/${created.json.id}/context/search?q=Golden`);
    const recoveredStatus = await request(env.base, `/api/v1/projects/${created.json.id}/context/status`);
    const version = await env.app.database.get('SELECT id,cas_hash FROM context_document_versions WHERE id=?', [leaf.current_document_version_id]);
    const casFile = path.join(env.home, 'cas', version.cas_hash.slice(0, 2), version.cas_hash);
    const casBytes = fs.readFileSync(casFile);
    fs.rmSync(casFile);
    const unavailable = await request(env.base, `/api/v1/projects/${created.json.id}/context/nodes/${leaf.id}`);
    fs.mkdirSync(path.dirname(casFile), { recursive: true });
    fs.writeFileSync(casFile, casBytes);

    const client = await mutate(env.base, '/api/v1/mcp/clients', { name: 'R5 golden stdio', transport: 'stdio', scope: { project_ids: [created.json.id], tools: ['project.get'] }, ttl_seconds: 3600 }, 'r5-golden-client');
    const httpList = await request(env.base, '/api/v1/mcp', { method: 'POST', key: 'r5-golden-http-list', headers: { 'x-aiws-mcp-token': client.json.token }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
    const httpRead = await request(env.base, '/api/v1/mcp', { method: 'POST', key: 'r5-golden-http-read', headers: { 'x-aiws-mcp-token': client.json.token }, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'project.get', arguments: { project_id: created.json.id } } } });
    const bridge = await r5GoldenBridge(env.base, client.json.token, [
      { jsonrpc: '2.0', id: 11, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'r5-golden', version: '1' } } },
      { jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'project.get', arguments: { project_id: created.json.id } } }
    ]);

    const cancelJobId = 'cpj_r5_golden_cancel';
    const timestamp = '2026-08-16T00:00:00.000Z';
    await env.app.database.run('INSERT INTO context_projection_jobs(id,project_id,status,cursor,created_at,updated_at) VALUES(?,?,?,?,?,?)', [cancelJobId, created.json.id, 'queued', '', timestamp, timestamp]);
    const cancelled = await mutate(env.base, `/api/v1/projects/${created.json.id}/context/jobs/${cancelJobId}/cancel`, { expected_revision: 1 }, 'r5-golden-cancel');
    const retried = await mutate(env.base, `/api/v1/projects/${created.json.id}/context/jobs/${cancelJobId}/retry`, { expected_revision: cancelled.json.revision }, 'r5-golden-retry');
    const retryOperation = await goldenWaitOperation(env.base, retried.json.operation_id);
    const retryJob = (await request(env.base, `/api/v1/projects/${created.json.id}/context/jobs/${retried.json.resource_id}`)).json;
    const operationEvents = (await request(env.base, `/api/v1/operations/${retried.json.operation_id}/events`)).json;
    const jobEvents = (await request(env.base, `/api/v1/projects/${created.json.id}/context/jobs/${cancelJobId}/events?after=0`)).json;
    const driftJobId = 'cpj_r5_golden_drift';
    await env.app.database.run('INSERT INTO context_projection_jobs(id,project_id,status,cursor,input_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [driftJobId, created.json.id, 'running', '0', 'f'.repeat(64), timestamp, timestamp]);
    await env.app.domain.contextService.recover();
    const driftJob = (await request(env.base, `/api/v1/projects/${created.json.id}/context/jobs/${driftJobId}`)).json;

    const scopeRequest = await mutate(env.base, '/api/v1/mcp/scopes/requests', { project_id: created.json.id, scope: { project_ids: [created.json.id], tools: ['project.get'] }, ttl_seconds: 1800 }, 'r5-golden-scope-request');
    const grant = await mutate(env.base, `/api/v1/mcp/scopes/requests/${scopeRequest.json.id}/grant`, { expected_revision: scopeRequest.json.revision }, 'r5-golden-scope-grant');
    const grantRead = await request(env.base, '/api/v1/mcp', { method: 'POST', key: 'r5-golden-grant-read', headers: { 'x-aiws-mcp-token': grant.json.token }, body: { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'project.get', arguments: { project_id: created.json.id } } } });
    const revoked = await mutate(env.base, `/api/v1/mcp/scopes/grants/${grant.json.id}/revoke`, { expected_revision: grant.json.revision }, 'r5-golden-scope-revoke');
    const revokedRead = await request(env.base, '/api/v1/mcp', { method: 'POST', key: 'r5-golden-revoked-read', headers: { 'x-aiws-mcp-token': grant.json.token }, body: { jsonrpc: '2.0', id: 22, method: 'tools/list', params: {} } });
    await env.app.database.run('UPDATE mcp_clients SET expires_at=? WHERE id=?', ['2020-01-01T00:00:00.000Z', client.json.id]);
    const expiredRead = await request(env.base, '/api/v1/mcp', { method: 'POST', key: 'r5-golden-expired-read', headers: { 'x-aiws-mcp-token': client.json.token }, body: { jsonrpc: '2.0', id: 23, method: 'tools/list', params: {} } });
    const publicClients = await request(env.base, '/api/v1/mcp/clients');

    return [
      { id: 'context-tree-version', feature_id: 'REC-D9-CONTEXT-017', cases: [{ id: 'stable-uri-version-reuse', output: { map_schema: projection.json.map.schema_version, root_uri_stable: projection.json.map.root_uri === repeated.json.map.root_uri, uri_stable: leaf.uri === repeatedLeaf.uri, ordered: projection.json.map.nodes.map((node) => node.uri).every((uri, index, rows) => index === 0 || rows[index - 1].localeCompare(uri) <= 0), version_reused: beforeVersions === afterVersions, edge_count_positive: projection.json.map.edges.length > 0 } }] },
      { id: 'selection-policy-pack-v5', feature_id: 'REC-D9-CONTEXT-017', cases: [{ id: 'pin-select-seal', output: { policy_status: policy.response.status, policy_revision: policy.json.revision, selection_schema: selection.json.schema_version, selection_hash_valid: /^[a-f0-9]{64}$/.test(selection.json.selection_hash), pack_schema: pack.json.pack.schema_version, pack_hash_valid: /^[a-f0-9]{64}$/.test(pack.json.pack_hash), brief_revision: pack.json.pack.memory_manifest.brief_revision, workflow_revision: pack.json.pack.memory_manifest.workflow_revision, outcome_hash_valid: /^[a-f0-9]{64}$/.test(pack.json.pack.outcome_contract_hash), rubric_hash_valid: /^[a-f0-9]{64}$/.test(pack.json.pack.quality_rubric_hash) } }] },
      { id: 'projection-index-recovery', feature_id: 'REC-D9-PROJECTION-018', cases: [{ id: 'damaged-index-and-missing-cas', output: { search_status: recoveredSearch.response.status, search_found: recoveredSearch.json.some((item) => item.node_id === leaf.id), index_status: recoveredStatus.json.index.status, unavailable_status: unavailable.response.status, unavailable_code: unavailable.json.error.code, unavailable_reason: unavailable.json.error.details.reason } }] },
      { id: 'mcp-http-stdio-equivalence', feature_id: 'REC-D4-MCP-004', cases: [{ id: 'schema-and-structured-output', output: { initialize_protocol: bridge[0].result.protocolVersion, tool_schema_equal: JSON.stringify(bridge[1].result.tools) === JSON.stringify(httpList.json.result.tools), structured_equal: JSON.stringify(bridge[2].result.structuredContent) === JSON.stringify(httpRead.json.result.structuredContent), operation_receipt_shape: ['operation_id', 'status', 'cursor', 'revision'].every((field) => Object.hasOwn(retried.json, field)) } }] },
      { id: 'operation-cursor-cancel-recovery', feature_id: 'REC-D9-PROJECTION-018', cases: [{ id: 'cancel-retry-interruption', output: { cancel_status: cancelled.response.status, cancelled_phase: cancelled.json.phase, retry_status: retried.response.status, retry_operation_status: retryOperation.status, retry_attempt: retryJob.attempt, retry_linked: retryJob.retry_of_job_id === cancelJobId, operation_events: operationEvents.map((event) => event.type), event_cursor_monotonic: jobEvents.every((event, index) => index === 0 || jobEvents[index - 1].cursor < event.cursor), interrupted_status: driftJob.status, interrupted_code: driftJob.error_code } }] },
      { id: 'scope-grant-revoke-expiry', feature_id: 'REC-D4-SCOPE-016', cases: [{ id: 'explicit-lifecycle', output: { request_status: scopeRequest.json.status, grant_status: grant.response.status, scoped_read_status: grantRead.response.status, revoke_status: revoked.response.status, revoked_read_status: revokedRead.response.status, revoked_error: revokedRead.json.error.code, expired_read_status: expiredRead.response.status, expired_error: expiredRead.json.error.code, credential_hidden: !JSON.stringify(publicClients.json).includes(client.json.token) && !JSON.stringify(await env.app.domain.listMcpScopes(created.json.id)).includes(grant.json.token) } }] }
    ];
  } finally {
    await env?.close().catch(() => undefined);
  }
}

async function r4GoldenProject(env, suffix, content = { objective: 'R4 golden workflow', acceptance: ['tests pass'] }) {
  const created = await mutate(env.base, '/api/v1/projects', { name: `R4 golden ${suffix}` }, `r4-golden-${suffix}-project`);
  goldenRequire(created.response.status === 201, `r4_${suffix}_project`);
  await onboardProject(env.base, created, { content, keyPrefix: `r4-golden-${suffix}-onboard` });
  return created.json.id;
}

async function r4GoldenGeneration(env, projectId, suffix, input = {}) {
  const started = await mutate(env.base, `/api/v1/projects/${projectId}/workflow-generations`, {
    provider: 'fixture', async: true, ...input
  }, `r4-golden-${suffix}-generate`);
  goldenRequire(started.response.status === 202, `r4_${suffix}_generation_start`);
  const state = await r4GoldenWaitGeneration(env.base, started.json.generation_id);
  const operation = await goldenWaitOperation(env.base, started.json.operation_id);
  return { started, state, operation };
}

async function r4GoldenWaitGeneration(base, generationId) {
  return eventually(
    async () => (await request(base, `/api/v1/workflow-generations/${generationId}`)).json,
    (generation) => ['completed', 'rejected', 'failed', 'cancelled'].includes(generation.phase),
    10_000
  );
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

/**
 * Exercise the real stdio bridge while keeping the Golden fixture free of
 * transport credentials and machine-specific details. Responses are matched
 * by request id. The MCP SDK may emit protocol notifications alongside
 * responses, so arrival order is not a stable response index.
 */
async function r5GoldenBridge(base, token, messages) {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'mcp-stdio.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      AIWS_MCP_URL: `${base}/api/v1/mcp`,
      AIWS_MCP_TOKEN: token
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const requestedIds = messages.map((message) => message.id);
  const responses = new Map();
  let stdoutBuffer = '';
  let stderr = '';
  let settled = false;
  let timer;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) error.message = `${error.message}${stderr ? `: ${stderr.trim().slice(0, 160)}` : ''}`;
    error ? rejectPromise(error) : resolvePromise(value);
  };
  let resolvePromise;
  let rejectPromise;
  const completion = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const parseOutput = () => {
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line);
        if (requestedIds.includes(response?.id)) responses.set(response.id, response);
      }
      catch { finish(new Error('mcp_stdio_invalid_json')); return; }
    }
    if (responses.size >= messages.length) {
      const ordered = requestedIds.map((id) => responses.get(id));
      const failed = ordered.find((response) => response?.error);
      if (failed) {
        const detail = [failed.id, failed.error?.code, failed.error?.data?.code, failed.error?.message]
          .filter((value) => value != null && value !== '').map((value) => String(value).replace(/[\r\n:]+/g, '_')).join(':');
        finish(new Error(`mcp_stdio_rpc_error:${detail || 'unknown'}`));
      }
      else finish(null, ordered);
    }
  };
  child.stdout.on('data', (chunk) => { stdoutBuffer += String(chunk); parseOutput(); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.on('error', (error) => finish(error));
  child.on('close', (code) => {
    if (!settled && responses.size < messages.length) finish(new Error(`mcp_stdio_exit_${code ?? 'unknown'}:${responses.size}/${messages.length}`));
  });
  timer = setTimeout(() => finish(new Error('mcp_stdio_timeout')), 10_000);
  try {
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
    return await completion;
  } finally {
    if (!child.killed) child.kill();
  }
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

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked && invoked === import.meta.url) await main();
