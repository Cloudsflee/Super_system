import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const image = process.env.AIWS_APP_IMAGE || 'aiws-app:1.7.0';
const testRunId = String(process.env.AIWS_TEST_RUN_ID || `standalone-${process.pid}`).replace(/[^a-zA-Z0-9_.-]/g, '-');
const suffix = `${process.pid}-${Date.now()}`;
const source = `aiws-v17-release-source-${suffix}`;
const target = `aiws-v17-release-target-${suffix}`;
const migration = `aiws-v17-release-migration-${suffix}`;
const invalidSource = `aiws-v17-release-invalid-source-${suffix}`;
const invalidTarget = `aiws-v17-release-invalid-target-${suffix}`;
const volumes = [source, target, migration, invalidSource, invalidTarget];

try {
  docker(['info', '--format', '{{.ServerVersion}}']);
  docker(['image', 'inspect', image]);
  for (const volume of volumes) docker(['volume', 'create', '--label', 'aiws.owner=aiws-v17-release-test', '--label', `aiws.test_run=${testRunId}`, volume]);
  seedSchema15(source);
  const sourceStateSha = stateSha(source);

  docker([
    'run', '--rm', '--entrypoint', 'python3',
    '--mount', `type=volume,src=${source},dst=/source,readonly`,
    '--mount', `type=volume,src=${migration},dst=/migration`,
    image, '/opt/aiws/backup_archive.py', 'create', '/source', '/migration/source.tar.gz'
  ]);
  docker([
    'run', '--rm', '--entrypoint', 'python3',
    '--mount', `type=volume,src=${migration},dst=/migration,readonly`,
    image, '/opt/aiws/backup_archive.py', 'validate', '/migration/source.tar.gz'
  ]);
  const archiveSha = docker([
    'run', '--rm', '--entrypoint', 'sh',
    '--mount', `type=volume,src=${migration},dst=/migration,readonly`,
    image, '-c', 'sha256sum /migration/source.tar.gz | cut -d" " -f1'
  ], { capture: true });
  docker([
    'run', '--rm', '--entrypoint', 'python3',
    '--mount', `type=volume,src=${migration},dst=/migration,readonly`,
    '--mount', `type=volume,src=${target},dst=/target`,
    image, '/opt/aiws/backup_archive.py', 'extract', '/migration/source.tar.gz', '/target'
  ]);
  docker([
    'run', '--rm', '--entrypoint', 'node',
    '--mount', `type=volume,src=${source},dst=/source,readonly`,
    '--mount', `type=volume,src=${target},dst=/target,readonly`,
    '--mount', `type=volume,src=${migration},dst=/migration`,
    image, '/app/docker/release_volume.mjs', 'clone-verify-v17',
    '/source', '/target', '/migration/clone.manifest.json', archiveSha, source, target
  ]);
  assert.equal(volumeFileExists(target, '/target/codex-homes/profile-one/tmp/cache'), false, 'Codex tmp cache is excluded');

  ensureRuntime(target, true);
  const accepted = JSON.parse(docker([
    'run', '--rm', '--entrypoint', 'node',
    '--mount', `type=volume,src=${source},dst=/source,readonly`,
    '--mount', `type=volume,src=${target},dst=/target`,
    '--mount', `type=volume,src=${migration},dst=/migration,readonly`,
    image, '/app/docker/release_volume.mjs', 'accept-v17', 'migrated',
    '/target', '/source', '/migration/clone.manifest.json', archiveSha, migration, source, target
  ], { capture: true }));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.target_state.schema_version, 16);
  assert.equal(accepted.target_state.collection_counts.project_briefs, 1);
  assert.equal(accepted.target_state.collection_counts.workflow_drafts, 1);
  assert.equal(accepted.schema_migration.from_schema, 15);
  assert.equal(accepted.schema_migration.to_schema, 16);
  assert.equal(accepted.schema_migration.migrated_briefs, 1);
  assert.equal(JSON.parse(checkTarget(target)).accepted, true);
  assert.equal(stateSha(source), sourceStateSha, 'schema 15 source volume remains byte-for-byte unchanged');
  assert.equal(readState(source).schema_version, 15);
  const targetState = readState(target);
  assert.equal(targetState.schema_version, 16);
  assert.equal(targetState.project_briefs[0].content.schema_version, 2);
  assert.equal(targetState.workflow_drafts.length, 1);
  assert.equal(targetState.codex_profiles[0].image, 'aiws-codex-runner:1.7.0-codex-0.144.0');

  writeVolumeFile(target, '/target/idempotent-sentinel', 'preserve');
  const acceptedStateSha = stateSha(target);
  ensureRuntime(target, true);
  assert.equal(readVolumeFile(target, '/target/idempotent-sentinel'), 'preserve', 'repeated startup does not overwrite the target volume');
  assert.equal(stateSha(target), acceptedStateSha, 'repeated startup does not rewrite accepted state');

  seedInvalid(invalidSource);
  copyVolume(invalidSource, invalidTarget);
  writeVolumeFile(invalidTarget, '/target/failed-migration-sentinel', 'preserve');
  const invalidSourceSha = stateSha(invalidSource);
  const invalidTargetSha = stateSha(invalidTarget);
  ensureRuntime(invalidTarget, false);
  assert.equal(stateSha(invalidSource), invalidSourceSha, 'failed migration leaves the source volume unchanged');
  assert.equal(stateSha(invalidTarget), invalidTargetSha, 'failed migration restores the target state');
  assert.equal(readVolumeFile(invalidTarget, '/target/failed-migration-sentinel'), 'preserve', 'failed migration keeps the target volume');

  console.log('V1.7 Docker release volume flow tests passed');
} finally {
  for (const volume of volumes.reverse()) docker(['volume', 'rm', '-f', volume], { allowFailure: true });
}

function seedSchema15(volume) {
  const script = `
    import fs from 'node:fs';
    import { V15_COLLECTIONS } from './apps/api/src/state-migration-v15.mjs';
    const root = '/volume';
    fs.mkdirSync(root + '/data/migrations', { recursive: true });
    fs.mkdirSync(root + '/vault', { recursive: true });
    fs.mkdirSync(root + '/codex-homes/profile-one/tmp', { recursive: true });
    const state = { schema_version: 15, ...Object.fromEntries(V15_COLLECTIONS.map((key) => [key, []])) };
    state.users = [{ id: 'owner-one', role: 'owner' }];
    state.projects = [{ id: 'project-one', title: 'Release', goal: 'Ship', status: 'draft' }];
    state.project_intakes = [{ id: 'intake-one', project_id: 'project-one', mode: 'brainstorm', context_sources: [], answers: { goal: 'Ship' }, revision: 1 }];
    state.project_briefs = [{ id: 'brief-one', project_id: 'project-one', version: 1, status: 'draft', content: { goal: 'Ship', users: ['Owner'], scope: { in: ['Brief'], out: [] }, features: ['Brief'], constraints: [], milestones: [], acceptance_criteria: ['Works'], risks: [], open_questions: [] } }];
    state.assist_sessions = [{ id: 'session-one', version: 3, project_id: 'project-one', scope_type: 'project', scope_id: 'project-one', forked_from_session_id: null, codex_thread_id: null }];
    state.assist_turns = [{ id: 'turn-one', session_id: 'session-one', project_id: 'project-one', status: 'completed' }];
    state.codex_profiles = [{ id: 'profile-one', kind: 'docker', image: 'aiws-codex-runner:1.6.0-codex-0.144.0', status: 'validated' }];
    fs.writeFileSync(root + '/data/state.json', JSON.stringify(state, null, 2) + '\\n');
    fs.writeFileSync(root + '/vault/credential.enc', 'ciphertext');
    fs.writeFileSync(root + '/codex-homes/profile-one/tmp/cache', 'transient');
    fs.symlinkSync('vault/credential.enc', root + '/credential-link');
  `;
  docker(['run', '--rm', '--entrypoint', 'node', '--mount', `type=volume,src=${volume},dst=/volume`, image, '--input-type=module', '-e', script]);
}

function seedInvalid(volume) {
  const script = `const fs=require('node:fs');fs.mkdirSync('/volume/data',{recursive:true});fs.writeFileSync('/volume/data/state.json',JSON.stringify({schema_version:999})+'\\n')`;
  docker(['run', '--rm', '--entrypoint', 'node', '--mount', `type=volume,src=${volume},dst=/volume`, image, '-e', script]);
}

function copyVolume(from, to) {
  docker(['run', '--rm', '--entrypoint', 'sh', '--mount', `type=volume,src=${from},dst=/source,readonly`, '--mount', `type=volume,src=${to},dst=/target`, image, '-c', 'cp -a /source/. /target/']);
}

function ensureRuntime(volume, expectSuccess) {
  const script = `import { ensureRuntime } from './apps/api/src/state.mjs'; await ensureRuntime();`;
  const result = raw(['run', '--rm', '--entrypoint', 'node', '-e', 'AIWS_HOME=/var/lib/aiws', '--mount', `type=volume,src=${volume},dst=/var/lib/aiws`, image, '--input-type=module', '-e', script]);
  assert.equal(result.status === 0, expectSuccess, String(result.stderr || '').slice(-1000));
}

function checkTarget(volume) {
  return docker(['run', '--rm', '--entrypoint', 'node', '--mount', `type=volume,src=${volume},dst=/target,readonly`, image, '/app/docker/release_volume.mjs', 'check-v17', '/target', volume], { capture: true });
}

function stateSha(volume) {
  return docker(['run', '--rm', '--entrypoint', 'sh', '--mount', `type=volume,src=${volume},dst=/volume,readonly`, image, '-c', 'sha256sum /volume/data/state.json | cut -d" " -f1'], { capture: true });
}

function readState(volume) {
  return JSON.parse(docker(['run', '--rm', '--entrypoint', 'sh', '--mount', `type=volume,src=${volume},dst=/volume,readonly`, image, '-c', 'cat /volume/data/state.json'], { capture: true }));
}

function volumeFileExists(volume, file) {
  return raw(['run', '--rm', '--entrypoint', 'sh', '--mount', `type=volume,src=${volume},dst=/target,readonly`, image, '-c', `test -e ${file}`]).status === 0;
}

function writeVolumeFile(volume, file, content) {
  docker(['run', '--rm', '--entrypoint', 'sh', '--mount', `type=volume,src=${volume},dst=/target`, image, '-c', `printf %s ${content} > ${file}`]);
}

function readVolumeFile(volume, file) {
  return docker(['run', '--rm', '--entrypoint', 'sh', '--mount', `type=volume,src=${volume},dst=/target,readonly`, image, '-c', `cat ${file}`], { capture: true });
}

function docker(args, { capture = false, allowFailure = false } = {}) {
  const result = raw(args, capture);
  if (result.status !== 0 && !allowFailure) throw new Error(`docker ${args.join(' ')} failed: ${String(result.stderr || '').slice(-2000)}`);
  return capture ? String(result.stdout || '').trim() : '';
}

function raw(args, capture = true) {
  const labeled = args[0] === 'run' ? ['run', '--label', `aiws.test_run=${testRunId}`, ...args.slice(1)] : args;
  return spawnSync('docker', labeled, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', windowsHide: true });
}
