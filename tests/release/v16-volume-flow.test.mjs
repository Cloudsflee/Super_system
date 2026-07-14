import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const image = process.env.AIWS_APP_IMAGE || 'aiws-app:1.6.0';
const suffix = `${process.pid}-${Date.now()}`;
const source = `aiws-release-source-${suffix}`;
const target = `aiws-release-target-${suffix}`;
const migration = `aiws-release-migration-${suffix}`;
const invalidSource = `aiws-release-invalid-source-${suffix}`;
const invalidTarget = `aiws-release-invalid-target-${suffix}`;
const volumes = [source, target, migration, invalidSource, invalidTarget];

try {
  docker(['info', '--format', '{{.ServerVersion}}']);
  docker(['image', 'inspect', image]);
  for (const volume of volumes) docker(['volume', 'create', '--label', 'aiws.owner=aiws-v16-release-test', volume]);
  seedSchema14(source);

  docker(['run', '--rm', '--entrypoint', 'python3', '--mount', `type=volume,src=${source},dst=/source,readonly`, '--mount', `type=volume,src=${migration},dst=/migration`, image, '/opt/aiws/backup_archive.py', 'create', '/source', '/migration/source.tar.gz']);
  docker(['run', '--rm', '--entrypoint', 'python3', '--mount', `type=volume,src=${migration},dst=/migration,readonly`, image, '/opt/aiws/backup_archive.py', 'validate', '/migration/source.tar.gz']);
  const archiveSha = docker(['run', '--rm', '--entrypoint', 'sh', '--mount', `type=volume,src=${migration},dst=/migration,readonly`, image, '-c', 'sha256sum /migration/source.tar.gz | cut -d" " -f1'], { capture: true });
  docker(['run', '--rm', '--entrypoint', 'python3', '--mount', `type=volume,src=${migration},dst=/migration,readonly`, '--mount', `type=volume,src=${target},dst=/target`, image, '/opt/aiws/backup_archive.py', 'extract', '/migration/source.tar.gz', '/target']);
  docker(['run', '--rm', '--entrypoint', 'node', '--mount', `type=volume,src=${source},dst=/source,readonly`, '--mount', `type=volume,src=${target},dst=/target,readonly`, '--mount', `type=volume,src=${migration},dst=/migration`, image, '/app/docker/release_volume.mjs', 'clone-verify', '/source', '/target', '/migration/clone.manifest.json', archiveSha, source, target]);
  assert.equal(volumeFileExists(target, '/target/codex-homes/profile-one/tmp/cache'), false, 'Codex tmp cache is excluded');

  ensureRuntime(target, true);
  const accepted = JSON.parse(docker(['run', '--rm', '--entrypoint', 'node', '--mount', `type=volume,src=${source},dst=/source,readonly`, '--mount', `type=volume,src=${target},dst=/target`, '--mount', `type=volume,src=${migration},dst=/migration,readonly`, image, '/app/docker/release_volume.mjs', 'accept', 'migrated', '/target', '/source', '/migration/clone.manifest.json', archiveSha, migration, source, target], { capture: true }));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.target_state.schema_version, 15);
  assert.equal(accepted.target_state.collection_counts.projects, 1);
  assert.equal(accepted.target_state.collection_counts.assist_sessions, 1);
  assert.equal(accepted.target_state.collection_counts.assist_turns, 1);
  assert.equal(accepted.target_state.collection_counts.codex_profiles, 2);
  assert.equal(accepted.schema_migration.normalized_runner_profiles.includes('profile-one'), true);
  assert.equal(JSON.parse(checkTarget(target)).accepted, true);

  writeVolumeFile(target, '/target/idempotent-sentinel', 'preserve');
  ensureRuntime(target, true);
  assert.equal(readVolumeFile(target, '/target/idempotent-sentinel'), 'preserve', 'repeated startup does not overwrite the target volume');

  seedInvalid(invalidSource);
  copyVolume(invalidSource, invalidTarget);
  const sourceShaBefore = stateSha(invalidSource);
  ensureRuntime(invalidTarget, false);
  assert.equal(stateSha(invalidSource), sourceShaBefore, 'failed migration leaves the source volume unchanged');

  docker(['volume', 'rm', invalidTarget]);
  docker(['volume', 'create', '--label', 'aiws.owner=aiws-v16-release-test', invalidTarget]);
  ensureRuntime(invalidTarget, true);
  const discarded = JSON.parse(docker(['run', '--rm', '--entrypoint', 'node', '--mount', `type=volume,src=${invalidTarget},dst=/target`, image, '/app/docker/release_volume.mjs', 'accept', 'discarded_unmigratable', '/target', '-', '-', '-', '-', invalidSource, invalidTarget], { capture: true }));
  assert.equal(discarded.mode, 'discarded_unmigratable');
  assert.equal(JSON.parse(checkTarget(invalidTarget)).schema_version, 15);
  console.log('V1.6 Docker release volume flow tests passed');
} finally {
  for (const volume of volumes.reverse()) docker(['volume', 'rm', '-f', volume], { allowFailure: true });
}

function seedSchema14(volume) {
  const script = `
    import fs from 'node:fs'; import { V14_COLLECTIONS } from './apps/api/src/state-migration-v14.mjs';
    const root='/volume'; fs.mkdirSync(root+'/data/migrations',{recursive:true}); fs.mkdirSync(root+'/vault',{recursive:true}); fs.mkdirSync(root+'/codex-homes/profile-one/tmp',{recursive:true});
    const state={schema_version:14,...Object.fromEntries(V14_COLLECTIONS.map(k=>[k,[]]))};
    state.projects=[{id:'project-one',title:'Release'}]; state.assist_sessions=[{id:'assist-one',version:3,forked_from_session_id:null,codex_thread_id:'thread-one'}]; state.assist_turns=[{id:'turn-one',session_id:'assist-one'}];
    state.codex_profiles=[{id:'profile-one',kind:'docker',image:'aiws-codex-runner:1.5.0-codex-0.144.0',status:'validated'},{id:'profile-custom',kind:'docker',image:'registry.example/custom:latest',status:'validated'}];
    state.integration_statuses=[{key:'codex_probe',profile_id:'profile-one',status:'ready'}];
    fs.writeFileSync(root+'/data/state.json',JSON.stringify(state,null,2)+'\\n'); fs.writeFileSync(root+'/vault/credential.enc','ciphertext'); fs.writeFileSync(root+'/codex-homes/profile-one/tmp/cache','transient'); fs.symlinkSync('vault/credential.enc',root+'/credential-link');
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
  return docker(['run', '--rm', '--entrypoint', 'node', '--mount', `type=volume,src=${volume},dst=/target,readonly`, image, '/app/docker/release_volume.mjs', 'check-purge', '/target', volume], { capture: true });
}

function stateSha(volume) {
  return docker(['run', '--rm', '--entrypoint', 'sh', '--mount', `type=volume,src=${volume},dst=/volume,readonly`, image, '-c', 'sha256sum /volume/data/state.json | cut -d" " -f1'], { capture: true });
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
  return spawnSync('docker', args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', windowsHide: true });
}
