import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { emptyState } from '../../apps/api/src/state.mjs';
import { normalizeState20Defaults, validateState20 } from '../../apps/api/src/state-migration-v20.mjs';
import {
  V21_OUTCOME_COLLECTIONS,
  canonicalStateHash,
  migrateState20To21,
  migrateStateFileToV21,
  normalizeState21Defaults,
  sha256,
  validateState21
} from '../../apps/api/src/state-migration-v21.mjs';

const timestamp = '2026-07-30T00:00:00.000Z';
const source = schema20Fixture();
const sourceHash = canonicalStateHash(source);
const migrated = migrateState20To21(source, { timestamp });
assert.equal(migrated.from_version, 20);
assert.equal(migrated.to_version, 21);
assert.equal(migrated.state.schema_version, 21);
assert.equal(canonicalStateHash(source), sourceHash);
assert.equal(migrated.active_legacy_derived, 1);
assert.equal(migrated.legacy_unassessed, 1);
assert.equal(migrated.state.workflow_executions.find((item) => item.id === 'wex-active').release_eligible, false);
assert.equal(
  migrated.state.workflow_executions.find((item) => item.id === 'wex-history').completion_status,
  'legacy_unassessed'
);
assert.equal(
  migrated.state.outcome_evaluations.some((item) => item.workflow_execution_id === 'wex-history'),
  false
);
assert.equal(
  migrated.state.outcome_requirements.filter((item) => item.workflow_execution_id === 'wex-active').length,
  1
);
assert.equal(migrated.state.task_executions[0].failure.code, 'legacy_runner_failed');
assert.equal(migrated.state.integration_statuses[0].image, 'aiws-codex-runner:2.1.0-codex-0.144.0');
validateState21(migrated.state);

const draftState = structuredClone(migrated.state);
draftState.workflows.push({
  id: 'workflow-draft',
  project_id: 'project',
  title: 'Unconfirmed draft',
  status: 'active',
  workflow_revision: 1,
  planning_quality: 'legacy_unverified'
});
normalizeState21Defaults(draftState, timestamp);
validateState21(draftState);
const partialProtocolState = structuredClone(draftState);
partialProtocolState.workflows.at(-1).outcome_contract = structuredClone(migrated.state.workflows[0].outcome_contract);
normalizeState21Defaults(partialProtocolState, timestamp);
assert.throws(
  () => validateState21(partialProtocolState),
  (error) => error.code === 'workflow_outcome_protocol_pair_invalid'
);
const confirmedWithoutProtocols = structuredClone(draftState);
confirmedWithoutProtocols.workflows.at(-1).planning_quality = 'verified';
normalizeState21Defaults(confirmedWithoutProtocols, timestamp);
assert.throws(
  () => validateState21(confirmedWithoutProtocols),
  (error) => error.code === 'workflow_outcome_protocols_required'
);

const repeated = migrateState20To21(migrated.state, { timestamp: '2026-07-30T01:00:00.000Z' });
assert.equal(repeated.migrated, false);
assert.equal(repeated.state.outcome_requirements.length, migrated.state.outcome_requirements.length);
assert.equal(repeated.state.workflow_executions[1].completion_status, 'legacy_unassessed');
assert.throws(
  () => validateState20(structuredClone(migrated.state)),
  (error) => error.code === 'state_schema_not_20'
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v21-migration-'));
try {
  const stateFile = path.join(root, 'state.json');
  fs.writeFileSync(stateFile, `${JSON.stringify(source, null, 2)}\n`);
  const original = fs.readFileSync(stateFile);
  const committed = await migrateStateFileToV21(stateFile, {
    backupDirectory: path.join(root, 'committed'),
    clock: () => new Date(timestamp)
  });
  assert.equal(committed.manifest.status, 'committed');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).schema_version, 21);
  assert.equal(fs.readFileSync(committed.backup_path).equals(original), true);
  assert.equal(committed.manifest.original_sha256, sha256(original));

  const rollbackFile = path.join(root, 'rollback.json');
  fs.writeFileSync(rollbackFile, original);
  await assert.rejects(
    () =>
      migrateStateFileToV21(rollbackFile, {
        backupDirectory: path.join(root, 'rolled-back'),
        clock: () => new Date('2026-07-30T02:00:00.000Z'),
        afterReplace: () => {
          const error = new Error('injected_post_replace_failure');
          error.code = 'injected_post_replace_failure';
          throw error;
        }
      }),
    (error) => error.code === 'injected_post_replace_failure'
  );
  assert.equal(fs.readFileSync(rollbackFile).equals(original), true);
  const rollbackManifest = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        'rolled-back',
        fs.readdirSync(path.join(root, 'rolled-back')).find((name) => name.endsWith('.manifest.json'))
      ),
      'utf8'
    )
  );
  assert.equal(rollbackManifest.status, 'rolled_back');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('V2.1 schema 20 migration, legacy assessment, source preservation and rollback tests passed');

function schema20Fixture() {
  const value = emptyState();
  for (const collection of V21_OUTCOME_COLLECTIONS) delete value[collection];
  value.schema_version = 20;
  value.instance_owner_user_id = 'owner';
  value.users.push({ id: 'owner', role: 'owner', auth_mode: 'test' });
  value.projects.push({
    id: 'project',
    title: 'Migration fixture',
    status: 'active',
    owner_user_id: 'owner',
    lifecycle_operation: null
  });
  value.workflows.push({
    id: 'workflow',
    project_id: 'project',
    title: 'Legacy workflow',
    status: 'active',
    version: 1,
    workflow_revision: 1,
    created_at: timestamp,
    updated_at: timestamp
  });
  value.workflow_nodes.push(
    {
      id: 'workstream',
      workflow_id: 'workflow',
      project_id: 'project',
      role: 'workstream',
      parent_node_id: null,
      type: 'workstream',
      title: 'Legacy workstream',
      status: 'ready',
      order_index: 0,
      dependencies: [],
      created_at: timestamp,
      updated_at: timestamp
    },
    {
      id: 'task',
      workflow_id: 'workflow',
      project_id: 'project',
      role: 'task',
      parent_node_id: 'workstream',
      type: 'task',
      title: 'Legacy task',
      status: 'ready',
      order_index: 0,
      dependencies: [],
      created_at: timestamp,
      updated_at: timestamp
    }
  );
  value.workflow_executions.push(
    {
      id: 'wex-active',
      project_id: 'project',
      workflow_id: 'workflow',
      workflow_revision: 1,
      status: 'running',
      frontier: [],
      waiting_reasons: [],
      started_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp
    },
    {
      id: 'wex-history',
      project_id: 'project',
      workflow_id: 'workflow',
      workflow_revision: 1,
      status: 'completed',
      frontier: [],
      waiting_reasons: [],
      started_at: timestamp,
      completed_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp
    }
  );
  value.task_executions.push({
    id: 'tex-active',
    workflow_execution_id: 'wex-active',
    project_id: 'project',
    workflow_id: 'workflow',
    task_id: 'task',
    workstream_id: 'workstream',
    attempt: 1,
    task_revision: 1,
    status: 'failed',
    error_code: 'legacy_runner_failed',
    retry_class: 'deterministic',
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: timestamp
  });
  value.integration_statuses.push({
    id: 'integration-codex',
    key: 'codex_docker',
    status: 'ready',
    image: 'aiws-codex-runner:2.0.0-codex-0.144.0',
    updated_at: timestamp
  });
  normalizeState20Defaults(value, timestamp);
  validateState20(value);
  return value;
}
