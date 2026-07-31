import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { emptyState } from '../../apps/api/src/state.mjs';
import { materializeContextDocumentsInState } from '../../apps/api/src/context-projection.mjs';
import {
  canonicalStateHash,
  normalizeState21Defaults,
  validateState21
} from '../../apps/api/src/state-migration-v21.mjs';
import { canonicalJsonHash, isState22Sentinel } from '../../apps/api/src/state-migration-v22.mjs';
import * as release from '../../docker/release-volume-v22.mjs';
import {
  isRecoverableV22Transcript,
  V22_APP_IMAGE,
  V22_PROJECT,
  V22_RUNNER_IMAGE,
  V22_SCHEMA,
  V22_VERSION,
  v22AsyncEvalScript
} from '../../docker/v22-upgrade.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v22-release-')),
  source = path.join(root, 'aiws-data-v21'),
  target = path.join(root, 'aiws-data-v22');
try {
  fs.mkdirSync(path.join(source, 'data'), { recursive: true });
  fs.mkdirSync(path.join(source, 'vault'), { recursive: true });
  const state = emptyState();
  state.schema_version = 21;
  state.instance_owner_user_id = 'owner-v22-release';
  state.users.push({
    id: 'owner-v22-release',
    role: 'owner',
    auth_mode: 'test',
    migration_hash_fixture: { 2: 32, 10: 97 },
    historical_runner_image: 'aiws-codex-runner:1.10.0-codex-0.144.0'
  });
  normalizeState21Defaults(state, '2026-07-31T00:00:00.000Z');
  await materializeContextDocumentsInState(state, {
    maxJobs: 10_000,
    casRoot: path.join(source, 'cas')
  });
  validateState21(state);
  const sourceFile = path.join(source, 'data', 'state.json');
  fs.writeFileSync(sourceFile, `${JSON.stringify(state, null, 2)}\n`);
  fs.writeFileSync(
    `${sourceFile}.tmp`,
    `${JSON.stringify({ ...state, context_projector_status: { state: 'running', heartbeat_at: 'uncommitted' } }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(source, 'vault', 'credential.enc'), 'V22_RELEASE_SECRET_NEVER_COPY_TO_RECEIPT');
  const sourceBytes = fs.readFileSync(sourceFile),
    sourceHash = canonicalStateHash(state);
  assert.notEqual(sourceHash, canonicalJsonHash(state), 'numeric-key records exercise legacy source hashing');
  fs.cpSync(source, target, { recursive: true });
  const manifestRoot = path.join(root, 'migration-volume'),
    cloneManifest = path.join(manifestRoot, 'clone.manifest.json'),
    archiveSha256 = 'f'.repeat(64);
  fs.mkdirSync(manifestRoot, { recursive: true });
  const clone = await release.verifyClonedVolumeV22({
    sourceRoot: source,
    targetRoot: target,
    manifestPath: cloneManifest,
    archiveSha256,
    clock: () => new Date('2026-07-31T00:01:00.000Z')
  });
  assert.equal(clone.source_volume, 'aiws-data-v21');
  assert.equal(clone.target_volume, 'aiws-data-v22');

  const script = `(async () => {
    const state = await import(${JSON.stringify(new URL('../../apps/api/src/state.mjs', import.meta.url).href)});
    await state.ensureRuntime();
    const context = await import(${JSON.stringify(new URL('../../apps/api/src/context-service.mjs', import.meta.url).href)});
    const snapshot = await state.readStateSnapshot();
    const owner = snapshot.users.find((item) => item.id === snapshot.instance_owner_user_id) || snapshot.users.find((item) => item.role === 'owner');
    await context.rebuildContext({ req: { headers: { 'x-aiws-user-id': owner.id }, auth: { scopes: ['context:admin'] } } });
    await state.mutate((value) => {
      const key = process.env.V22_TEST_INTEGRATION_KEY || 'release-v22';
      if (!value.integration_statuses.some((item) => item.key === key))
        value.integration_statuses.push({ key, status: 'ready' });
    });
    await state.checkpointAndCloseState();
  })().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });`;
  for (let run = 0; run < 2; run += 1) {
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, AIWS_HOME: target, NODE_ENV: 'test' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  assert.equal(fs.readFileSync(sourceFile).equals(sourceBytes), true);
  assert.equal(canonicalStateHash(JSON.parse(sourceBytes)), sourceHash);
  assert.equal(isState22Sentinel(JSON.parse(fs.readFileSync(path.join(target, 'data', 'state.json'), 'utf8'))), true);
  assert.equal(fs.existsSync(path.join(target, 'data', 'state.json.tmp')), false);
  assert.equal(fs.existsSync(path.join(target, 'data', 'state-v22.sqlite')), true);
  assert.equal(fs.existsSync(path.join(target, 'data', '.context-index', 'minisearch-v2.json')), true);
  const accepted = await release.acceptVolumeMigrationV22({
    sourceRoot: source,
    targetRoot: target,
    cloneManifestPath: cloneManifest,
    archiveSha256,
    migrationVolume: 'aiws-v22-migration-test',
    clock: () => new Date('2026-07-31T00:02:00.000Z')
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.sqlite_authoritative, true);
  assert.equal(accepted.target_state.integrity, 'ok');
  assert.equal(accepted.context_index.schema_version, 'aiws.context_index.v2');
  assert.deepEqual(accepted.preservation.allowed_removed_paths, ['data/state.json.tmp']);
  assert.deepEqual(release.findLegacyOfficialRunnerReferences(state), []);
  assert.deepEqual(
    release.findLegacyOfficialRunnerReferences({
      codex_profiles: [{ image: 'aiws-codex-runner:2.1.0-codex-0.144.0' }],
      integration_statuses: []
    }),
    [{ path: 'codex_profiles.0.image', image: 'aiws-codex-runner:2.1.0-codex-0.144.0' }]
  );
  const postAcceptance = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AIWS_HOME: target,
      NODE_ENV: 'test',
      V22_TEST_INTEGRATION_KEY: 'post-accept-v22'
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000
  });
  assert.equal(postAcceptance.status, 0, postAcceptance.stderr || postAcceptance.stdout);
  const checked = await release.validateV22ReleaseTarget(target);
  assert.equal(checked.schema_version, 22);
  assert.equal(checked.writable, true);
  assert.equal(checked.source_preserved, true);
  assert.equal(
    checked.collection_counts.integration_statuses,
    accepted.target_state.collection_counts.integration_statuses + 1
  );
  const receiptText = fs.readFileSync(path.join(target, ...release.V22_RECEIPT_RELATIVE_PATH.split('/')), 'utf8');
  assert.equal(receiptText.includes('V22_RELEASE_SECRET_NEVER_COPY_TO_RECEIPT'), false);
  assert.throws(
    () => validateState21(JSON.parse(fs.readFileSync(path.join(target, 'data', 'state.json'), 'utf8'))),
    (error) => error.code === 'state_schema_not_21'
  );
  assert.equal(V22_VERSION, '2.2.0');
  assert.equal(V22_SCHEMA, 22);
  assert.equal(V22_PROJECT, 'aiws-v22');
  assert.equal(V22_APP_IMAGE, 'aiws-app:2.2.0');
  assert.equal(V22_RUNNER_IMAGE, 'aiws-codex-runner:2.2.0-codex-0.144.0');
  const compose = fs.readFileSync('compose.yml', 'utf8'),
    upgrade = fs.readFileSync('docker/v22-upgrade.mjs', 'utf8');
  for (const value of ['name: aiws-v22', 'aiws-data-v22', '/api/readyz', 'stop_grace_period: 30s'])
    assert.ok(compose.includes(value), value);
  for (const value of ['clone-verify-v22', 'accept-v22', 'check-v22', "source_mount_mode: 'readonly'"])
    assert.ok(upgrade.includes(value), value);
  assert.equal(upgrade.includes("'--input-type=module'"), false);
  assert.equal(upgrade.includes('context.refresh = migrateAndBuildContext(config)'), false);
  assert.ok(upgrade.includes("context.status = 'validating_reused_v22'"));
  assert.ok(upgrade.includes("V22_NODE_OPTIONS = '--max-old-space-size=4096'"));
  const evalProbe = spawnSync(
    process.execPath,
    ['-e', v22AsyncEvalScript("await Promise.resolve();process.stdout.write('ok')")],
    {
      encoding: 'utf8',
      windowsHide: true
    }
  );
  assert.equal(evalProbe.status, 0, evalProbe.stderr);
  assert.equal(evalProbe.stdout, 'ok');
  const failedTranscript = {
    version: V22_VERSION,
    schema: V22_SCHEMA,
    project: V22_PROJECT,
    port: 4317,
    source_volume: 'aiws-data-v21',
    target_volume: 'aiws-data-v22',
    disposition: 'clone',
    status: 'failed_v22_stopped_v21_restored',
    source_preserved: true
  };
  assert.equal(isRecoverableV22Transcript(failedTranscript), true);
  assert.equal(isRecoverableV22Transcript({ ...failedTranscript, acceptance: { accepted: true } }), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('V2.2 read-only V21 clone, idempotent SQLite migration, persistence and V21 refusal tests passed');
