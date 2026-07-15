import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateState15To16 } from '../../apps/api/src/state-migration-v16.mjs';
import { acceptVolumeMigrationV17, selectTargetVolume, stateAudit, validateV17ReleaseTarget, verifyClonedVolumeV17, V17_SOURCE_VOLUME, V17_TARGET_VOLUME } from '../../docker/release_volume.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v17-release-'));
const source = path.join(root, 'source'), target = path.join(root, 'target'), migration = path.join(root, 'migration');
const cloneManifest = path.join(migration, 'clone.manifest.json'), archiveSha = 'b'.repeat(64);

try {
  seedSource(source); fs.cpSync(source, target, { recursive: true }); fs.mkdirSync(migration, { recursive: true });
  const sourceBefore = await stateAudit(source);
  const clone = await verifyClonedVolumeV17({ sourceRoot: source, targetRoot: target, manifestPath: cloneManifest, archiveSha256: archiveSha });
  assert.equal(clone.source_volume, V17_SOURCE_VOLUME); assert.equal(clone.target_volume, V17_TARGET_VOLUME); assert.equal(clone.source_state.schema_version, 15);

  const sourceState = JSON.parse(fs.readFileSync(path.join(source, 'data', 'state.json'), 'utf8'));
  const migrated = migrateState15To16(sourceState, { timestamp: '2026-07-14T01:00:00.000Z' });
  const migratedBytes = `${JSON.stringify(migrated.state, null, 2)}\n`;
  fs.writeFileSync(path.join(target, 'data', 'state.json'), migratedBytes);
  fs.writeFileSync(path.join(target, 'data', 'migrations', 'state-schema15-test.manifest.json'), `${JSON.stringify({
    status: 'committed', from_schema: 15, to_schema: 16, original_sha256: sourceBefore.state_sha256,
    original_state_hash: sourceBefore.state_canonical_hash, migrated_sha256: sha256(migratedBytes), migrated_state_hash: (await stateAudit(target)).state_canonical_hash,
    migrated_briefs: migrated.migrated_briefs, created_workflow_drafts: migrated.created_workflow_drafts,
    normalized_runner_profiles: migrated.normalized_runner_profiles, staled_runner_probes: migrated.staled_runner_probes
  }, null, 2)}\n`);

  const receipt = await acceptVolumeMigrationV17({ mode: 'migrated', sourceRoot: source, targetRoot: target, cloneManifestPath: cloneManifest, archiveSha256: archiveSha, migrationVolume: 'v17-migration-test' });
  assert.equal(receipt.accepted, true); assert.equal(receipt.target_state.schema_version, 16); assert.equal(receipt.schema_migration.from_schema, 15); assert.equal(receipt.schema_migration.to_schema, 16);
  assert.equal(receipt.schema_migration.migrated_briefs, 1); assert.equal(receipt.schema_migration.created_workflow_drafts, 1);
  assert.equal((await validateV17ReleaseTarget(target)).accepted, true);
  assert.equal((await stateAudit(source)).state_sha256, sourceBefore.state_sha256, 'V1.6 source remains unchanged');
  const targetState = JSON.parse(fs.readFileSync(path.join(target, 'data', 'state.json'), 'utf8'));
  assert.equal(targetState.codex_profiles[0].image, 'aiws-codex-runner:1.7.0-codex-0.144.0');
  assert.equal(targetState.project_briefs[0].content.schema_version, 2); assert.equal(targetState.workflow_drafts.length, 1);

  const stateFile = path.join(target, 'data', 'state.json'), accepted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  for (const [collection, id] of [['projects', 'project-after'], ['assist_sessions', 'session-after'], ['assist_turns', 'turn-after'], ['codex_profiles', 'profile-after'], ['project_briefs', 'brief-after']]) accepted[collection].push({ ...accepted[collection].at(-1), id, ...(collection === 'assist_sessions' ? { forked_from_session_id: null } : {}) });
  fs.writeFileSync(stateFile, `${JSON.stringify(accepted, null, 2)}\n`);
  assert.equal((await validateV17ReleaseTarget(target)).accepted, true, 'post-migration records are allowed');
  accepted.project_briefs = accepted.project_briefs.filter((item) => item.id !== 'brief-one'); fs.writeFileSync(stateFile, `${JSON.stringify(accepted, null, 2)}\n`);
  await assert.rejects(() => validateV17ReleaseTarget(target), /accepted_record_ids_missing/);

  assert.equal(selectTargetVolume({ targetExists: false, targetEmpty: true, sourceExists: true, sourceEmpty: false }), 'clone');
  assert.equal(selectTargetVolume({ targetExists: true, targetEmpty: false, sourceExists: true, sourceEmpty: false }), 'reuse');
  const powershell = fs.readFileSync(path.join(process.cwd(), 'scripts', 'aiws.ps1'), 'utf8'), posix = fs.readFileSync(path.join(process.cwd(), 'scripts', 'aiws.sh'), 'utf8');
  for (const script of [powershell, posix]) { assert.ok(script.includes('aiws-data-v16')); assert.ok(script.includes('aiws-data-v17')); assert.ok(script.includes('aiws-app:1.7.0')); assert.ok(script.includes('aiws-codex-runner:1.7.0-codex-0.144.0')); assert.ok(script.includes('v17-release.mjs')); }
  const orchestrator = fs.readFileSync(path.join(process.cwd(), 'docker', 'release_orchestrator.mjs'), 'utf8');
  assert.equal(orchestrator.includes('accepted_fresh_after_discard'), false, 'V1.7 never auto-discards a failed migration');
  assert.ok(orchestrator.includes("health.version !== '1.7.0'")); assert.ok(orchestrator.includes('health.schema_version !== 16'));
  console.log('V1.7 release volume unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function seedSource(directory) {
  fs.mkdirSync(path.join(directory, 'data', 'migrations'), { recursive: true }); fs.mkdirSync(path.join(directory, 'vault'), { recursive: true }); fs.mkdirSync(path.join(directory, 'codex-homes', 'profile-one'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'vault', 'credential.enc'), 'encrypted-v16-sentinel'); fs.writeFileSync(path.join(directory, 'codex-homes', 'profile-one', 'config.toml'), 'model = "unit"\n');
  const state = {
    schema_version: 15, users: [{ id: 'owner-one', role: 'owner' }],
    projects: [{ id: 'project-one', title: 'Project', goal: 'Ship', status: 'draft' }],
    project_intakes: [{ id: 'intake-one', project_id: 'project-one', mode: 'brainstorm', context_sources: [], answers: { goal: 'Ship' }, revision: 1 }],
    project_briefs: [{ id: 'brief-one', project_id: 'project-one', version: 1, status: 'draft', content: { goal: 'Ship', users: [], scope: { in: ['Brief'], out: [] }, features: ['Brief'], constraints: [], milestones: [], acceptance_criteria: ['Works'], risks: [], open_questions: [] } }],
    assist_sessions: [{ id: 'session-one', version: 3, project_id: 'project-one', scope_type: 'project', scope_id: 'project-one', forked_from_session_id: null, codex_thread_id: null }],
    assist_turns: [{ id: 'turn-one', session_id: 'session-one', project_id: 'project-one', status: 'completed' }], attachments: [],
    codex_profiles: [{ id: 'profile-one', kind: 'docker', image: 'aiws-codex-runner:1.6.0-codex-0.144.0', status: 'validated' }], integration_statuses: [],
    assist_configurations: [], assist_change_batches: [], assist_checkpoints: [], assist_operations: [], runtime_user_inputs: [], host_bridge_devices: []
  };
  fs.writeFileSync(path.join(directory, 'data', 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
