import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeAssetFromCandidate } from '../../packages/shared/index.mjs';
import {
  V20_SOURCE_COLLECTIONS,
  migrateState19To20,
  migrateStateFileToV20,
  normalizeState20Defaults,
  normalizeTaskHandoffDefaultsV20,
  validateState20
} from '../../apps/api/src/state-migration-v20.mjs';

const timestamp = '2026-07-26T00:00:00.000Z';
const source = Object.fromEntries(V20_SOURCE_COLLECTIONS.map((name) => [name, []]));
source.schema_version = 19;
source.users.push({ id: 'owner-v20-migration', role: 'owner', auth_mode: 'test' });
source.instance_owner_user_id = 'owner-v20-migration';
source.projects.push({
  id: 'project-v20-migration',
  title: '迁移项目',
  status: 'active',
  owner_user_id: 'owner-v20-migration',
  created_by_user_id: 'owner-v20-migration',
  lifecycle_operation: null
});
source.integration_statuses.push(
  {
    key: 'codex_docker',
    status: 'ready',
    image: 'aiws-codex-runner:1.10.0-codex-0.144.0',
    updated_at: timestamp
  },
  { key: 'codex_probe', profile_id: 'profile-a', status: 'failed' },
  { key: 'codex_probe', profile_id: 'profile-b', status: 'ready' }
);

const migrated = migrateState19To20(source, { timestamp });
assert.equal(migrated.from_version, 19);
assert.equal(migrated.to_version, 20);
assert.equal(migrated.state.schema_version, 20);
assert.equal(
  migrated.state.context_nodes.filter((node) => node.source_collection === 'integration_statuses').length,
  3
);
assert.equal(migrated.state.context_projection_coverage.warnings.length, 0);
assert.equal(migrated.context_projection_jobs, migrated.state.context_nodes.length);
assert.equal(
  migrated.state.integration_statuses.find((item) => item.key === 'codex_docker').image,
  'aiws-codex-runner:2.0.0-codex-0.144.0'
);
validateState20(migrated.state);

const repeated = migrateState19To20(migrated.state, { timestamp: '2026-07-26T01:00:00.000Z' });
assert.equal(repeated.migrated, false);
assert.deepEqual(
  repeated.state.context_nodes.map((node) => node.id),
  migrated.state.context_nodes.map((node) => node.id)
);

const runtimeState = structuredClone(repeated.state);
const runtimeAsset = makeAssetFromCandidate(
  { title: '运行期资产', summary: '验证 V19 默认值在 schema 20 中继续生效。' },
  {
    projectId: 'project-v20-migration',
    workspaceId: null,
    nodeId: null,
    runId: 'runtime-v20',
    actorId: 'owner-v20-migration'
  }
);
runtimeState.assets.push(runtimeAsset.asset);
runtimeState.asset_versions.push(runtimeAsset.version);
const outcomeAsset = makeAssetFromCandidate(
  { title: '成果节点验收收据', summary: '旧关系语义兼容。', asset_type: 'WorkstreamOutcomeAsset' },
  {
    projectId: 'project-v20-migration',
    workspaceId: null,
    nodeId: null,
    runId: 'outcome-v20',
    actorId: 'owner-v20-migration'
  }
);
outcomeAsset.asset.asset_type = 'WorkstreamOutcomeAsset';
runtimeState.assets.push(outcomeAsset.asset);
runtimeState.asset_versions.push(outcomeAsset.version);
runtimeState.asset_relations.push({
  id: 'relation-legacy-outcome',
  relation_type: 'derived_from',
  source_asset_id: runtimeAsset.asset.id,
  source_asset_version_id: runtimeAsset.version.id,
  target_asset_id: outcomeAsset.asset.id,
  target_asset_version_id: outcomeAsset.version.id,
  created_at: timestamp
});
const dirtyHandoffState = {
  asset_versions: [],
  node_runs: [],
  task_executions: [
    {
      id: 'execution-null-consumption',
      consumed_inputs: [null, '', runtimeAsset.version.id],
      consumed_context_document_versions: [null, '', 'context-version-valid'],
      context_selection_ids: [null, '', 'selection-valid'],
      input_dispositions: [
        { version_id: null, disposition: 'used', reason: null },
        { version_id: runtimeAsset.version.id, disposition: 'used', reason: null }
      ],
      context_dispositions: [
        { document_version_id: null, disposition: 'not_used', reason: 'invalid' },
        { document_version_id: 'context-version-valid', disposition: 'not_used', reason: 'Not used.' }
      ]
    }
  ]
};
normalizeTaskHandoffDefaultsV20(dirtyHandoffState);
const cleanedExecution = dirtyHandoffState.task_executions[0];
assert.deepEqual(cleanedExecution.consumed_inputs, [runtimeAsset.version.id]);
assert.deepEqual(cleanedExecution.consumed_context_document_versions, ['context-version-valid']);
assert.deepEqual(cleanedExecution.context_selection_ids, ['selection-valid']);
assert.deepEqual(cleanedExecution.input_dispositions, [
  { version_id: runtimeAsset.version.id, disposition: 'used', reason: null }
]);
assert.deepEqual(cleanedExecution.context_dispositions, [
  { document_version_id: 'context-version-valid', disposition: 'not_used', reason: 'Not used.' }
]);
normalizeState20Defaults(runtimeState, '2026-07-26T01:30:00.000Z');
assert.match(runtimeAsset.version.content_sha256, /^[a-f0-9]{64}$/);
assert.equal(runtimeAsset.version.size_bytes, Buffer.byteLength(runtimeAsset.version.body, 'utf8'));
assert.equal(runtimeAsset.version.manifest.schema_version, 'aiws.asset_manifest.v1');
assert.equal(runtimeAsset.version.immutable, true);
assert.equal(runtimeState.asset_relations[0].relation_type, 'evidenced_by');
validateState20(runtimeState);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v20-migration-'));
try {
  const stateFile = path.join(root, 'state.json');
  fs.writeFileSync(stateFile, `${JSON.stringify(source, null, 2)}\n`);
  const committed = await migrateStateFileToV20(stateFile, {
    backupDirectory: path.join(root, 'migrations'),
    clock: () => new Date(timestamp)
  });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).schema_version, 20);
  assert.equal(committed.manifest.status, 'committed');
  assert.ok(fs.existsSync(committed.backup_path));
  assert.ok(fs.existsSync(committed.manifest_path));

  const rollbackFile = path.join(root, 'rollback.json');
  const original = `${JSON.stringify(source, null, 2)}\n`;
  fs.writeFileSync(rollbackFile, original);
  await assert.rejects(
    () =>
      migrateStateFileToV20(rollbackFile, {
        backupDirectory: path.join(root, 'rollback-migrations'),
        clock: () => new Date('2026-07-26T02:00:00.000Z'),
        afterReplace: () => {
          const error = new Error('rollback probe');
          error.code = 'rollback_probe';
          throw error;
        }
      }),
    (error) => error.code === 'rollback_probe'
  );
  assert.equal(fs.readFileSync(rollbackFile, 'utf8'), original);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('V2.0 schema migration, idempotency, backup, and rollback tests passed');
