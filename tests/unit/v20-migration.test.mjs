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
assert.equal(V20_SOURCE_COLLECTIONS.length, 84);
for (const collection of [
  'outcome_requirements',
  'outcome_evaluations',
  'outcome_waivers',
  'execution_stage_checkpoints'
])
  assert.equal(V20_SOURCE_COLLECTIONS.includes(collection), false, collection);
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
  asset_versions: [
    {
      id: 'version-effect-migration',
      provenance: {
        authority_status: 'structurally_verified',
        declared_consumed_inputs: ['version-b', null, 'version-a'],
        structurally_verified_inputs: ['version-b', null, 'version-a'],
        declared_context_document_versions: ['context-version', null],
        structurally_verified_context_document_versions: ['context-version', null],
        structurally_verified_input_dispositions: [
          { version_id: 'version-a', disposition: 'used', reason: 'Applied to output.' }
        ],
        structurally_verified_context_dispositions: [
          { document_version_id: 'context-version', disposition: 'used', reason: 'Verified output.' }
        ],
        input_effects: [
          {
            claim_id: 'ec_111111111111111111111111',
            input_key: ' evidence ',
            version_ids: [null, 'version-b', 'version-a', 'version-a'],
            effect: 'constraint',
            output_keys: ['decision', null, 'decision'],
            statement: '  Evidence constrained the migrated decision.  ',
            evidence_refs: ['ref-b', null, 'ref-a'],
            source_receipts: ['asset_version:version-b', 'asset_version:version-a'],
            verification_status: 'structurally_verified',
            unknown_field: 'remove-me'
          }
        ]
      }
    }
  ],
  node_runs: [
    {
      id: 'run-effect-migration',
      result_json: {
        schema_version: 'aiws.task_runner_result.v3',
        input_effects: [],
        context_effects: [
          {
            document_version_id: ' context-version ',
            version_ids: ['not-valid-on-context'],
            effect: 'verification',
            output_keys: ['decision'],
            statement: '  Context verified the migrated decision.  ',
            evidence_refs: [],
            unknown_field: true
          }
        ]
      }
    }
  ],
  task_executions: [
    {
      id: 'execution-null-consumption',
      consumed_inputs: [null, '', runtimeAsset.version.id],
      consumed_context_document_versions: [null, '', 'context-version-valid'],
      context_selection_ids: [null, '', 'selection-valid'],
      structurally_verified_context_document_versions: [null, '', 'context-version-valid'],
      accepted_effect_claim_ids: [null, '', 'ec_111111111111111111111111'],
      accepted_contribution_ids: [null, '', 'ic_111111111111111111111111'],
      effect_claim_statuses: [
        {
          claim_id: ' ec_111111111111111111111111 ',
          source_type: 'input',
          input_key: ' evidence ',
          document_version_id: '',
          contribution_id: ' ic_111111111111111111111111 ',
          output_keys: ['decision', null],
          criterion_ids: ['criterion-a', null],
          status: 'accepted',
          unknown_field: true
        }
      ],
      contribution_statuses: [
        {
          contribution_id: ' ic_111111111111111111111111 ',
          status: 'accepted',
          output_keys: ['decision'],
          criterion_ids: ['criterion-a'],
          version_ids: ['version-a'],
          claim_ids: ['ec_111111111111111111111111'],
          accepted_claim_ids: ['ec_111111111111111111111111'],
          accepted_criterion_ids: ['criterion-a'],
          missing_criterion_ids: [],
          source_receipts: ['asset_version:version-a'],
          evidence_refs: ['ref-a'],
          unknown_field: true
        }
      ],
      output_bindings: [
        {
          key: 'decision',
          accepted_effect_claim_ids: [null, 'ec_111111111111111111111111']
        }
      ],
      input_dispositions: [
        { version_id: null, disposition: 'used', reason: null },
        { version_id: runtimeAsset.version.id, disposition: 'used', reason: null }
      ],
      context_dispositions: [
        { document_version_id: null, disposition: 'not_used', reason: 'invalid' },
        { document_version_id: 'context-version-valid', disposition: 'not_used', reason: 'Not used.' }
      ],
      input_effects: [
        {
          claim_id: 'ec_111111111111111111111111',
          input_key: ' evidence ',
          version_ids: [null, 'version-a'],
          effect: 'basis',
          output_keys: ['decision', ''],
          statement: '  Evidence formed the decision basis.  ',
          evidence_refs: [null, 'receipt-a']
        },
        { input_key: null, effect: 'basis', output_keys: [], statement: 'invalid', evidence_refs: [] }
      ],
      context_effects: []
    }
  ],
  asset_attestations: [
    {
      id: 'attestation-effect-migration',
      accepted_effect_claim_ids: [null, 'ec_111111111111111111111111'],
      effect_acceptance_results: [
        {
          claim_id: ' ec_111111111111111111111111 ',
          status: 'accepted',
          source_type: 'input',
          input_key: ' evidence ',
          document_version_id: '',
          contribution_id: ' ic_111111111111111111111111 ',
          source_receipts: [null, 'asset_version:version-a'],
          output_key: ' decision ',
          output_version_id: ' version-output ',
          output_content_sha256: ` ${'a'.repeat(64)} `,
          criterion_ids: [null, 'criterion-a'],
          output_evidence_refs: [null, 'commit:abc'],
          attestor_type: 'trusted_verifier',
          attestor_id: ' verifier '
        }
      ]
    }
  ],
  asset_relations: [
    {
      id: 'relation-effect-migration',
      criterion_ids: [null, 'criterion-a'],
      source_receipts: [null, 'asset_version:version-a'],
      output_evidence_refs: [null, 'commit:abc'],
      effect_claim_id: ' ec_111111111111111111111111 ',
      attestation_id: ' attestation-effect-migration '
    }
  ]
};
normalizeTaskHandoffDefaultsV20(dirtyHandoffState);
const cleanedExecution = dirtyHandoffState.task_executions[0];
assert.deepEqual(cleanedExecution.consumed_inputs, [runtimeAsset.version.id]);
assert.deepEqual(cleanedExecution.consumed_context_document_versions, ['context-version-valid']);
assert.deepEqual(cleanedExecution.context_selection_ids, ['selection-valid']);
assert.deepEqual(cleanedExecution.structurally_verified_context_document_versions, ['context-version-valid']);
assert.deepEqual(cleanedExecution.accepted_effect_claim_ids, ['ec_111111111111111111111111']);
assert.deepEqual(cleanedExecution.accepted_contribution_ids, ['ic_111111111111111111111111']);
assert.deepEqual(cleanedExecution.output_bindings[0].accepted_effect_claim_ids, ['ec_111111111111111111111111']);
assert.deepEqual(cleanedExecution.effect_claim_statuses, [
  {
    claim_id: 'ec_111111111111111111111111',
    source_type: 'input',
    input_key: 'evidence',
    document_version_id: null,
    contribution_id: 'ic_111111111111111111111111',
    output_keys: ['decision'],
    criterion_ids: ['criterion-a'],
    status: 'accepted'
  }
]);
assert.equal(cleanedExecution.contribution_statuses[0].status, 'accepted');
assert.deepEqual(cleanedExecution.contribution_statuses[0].accepted_criterion_ids, ['criterion-a']);
assert.deepEqual(cleanedExecution.input_dispositions, [
  { version_id: runtimeAsset.version.id, disposition: 'used', reason: null }
]);
assert.deepEqual(cleanedExecution.context_dispositions, [
  { document_version_id: 'context-version-valid', disposition: 'not_used', reason: 'Not used.' }
]);
assert.deepEqual(cleanedExecution.input_effects, [
  {
    claim_id: 'ec_111111111111111111111111',
    input_key: 'evidence',
    version_ids: ['version-a'],
    effect: 'basis',
    output_keys: ['decision'],
    statement: 'Evidence formed the decision basis.',
    evidence_refs: ['receipt-a']
  }
]);
assert.deepEqual(dirtyHandoffState.asset_versions[0].provenance.input_effects[0], {
  claim_id: 'ec_111111111111111111111111',
  input_key: 'evidence',
  version_ids: ['version-a', 'version-b'],
  effect: 'constraint',
  output_keys: ['decision'],
  statement: 'Evidence constrained the migrated decision.',
  evidence_refs: ['ref-a', 'ref-b'],
  source_receipts: ['asset_version:version-a', 'asset_version:version-b'],
  verification_status: 'structurally_verified'
});
assert.deepEqual(dirtyHandoffState.asset_versions[0].provenance.structurally_verified_inputs, [
  'version-a',
  'version-b'
]);
assert.equal(dirtyHandoffState.asset_versions[0].provenance.authority_status, 'structurally_verified');
assert.deepEqual(dirtyHandoffState.asset_attestations[0].accepted_effect_claim_ids, ['ec_111111111111111111111111']);
assert.equal(dirtyHandoffState.asset_attestations[0].effect_acceptance_results[0].output_key, 'decision');
assert.deepEqual(dirtyHandoffState.asset_attestations[0].effect_acceptance_results[0].output_evidence_refs, [
  'commit:abc'
]);
assert.equal(dirtyHandoffState.asset_relations[0].effect_claim_id, 'ec_111111111111111111111111');
assert.equal(dirtyHandoffState.asset_relations[0].attestation_id, 'attestation-effect-migration');
assert.deepEqual(dirtyHandoffState.asset_relations[0].output_evidence_refs, ['commit:abc']);
assert.deepEqual(dirtyHandoffState.node_runs[0].result_json.context_effects[0], {
  document_version_id: 'context-version',
  effect: 'verification',
  output_keys: ['decision'],
  statement: 'Context verified the migrated decision.',
  evidence_refs: []
});
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
