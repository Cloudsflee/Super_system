import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v110-attestation-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const { assetVersionDetails, attestAssetVersionInState, ingestExecutionOutputsInState } =
    await import('../../apps/api/src/asset-attestation-service.mjs');
  const { createAssetRecord, createImmutableAssetVersion, registerCasBlob } =
    await import('../../apps/api/src/asset-cas.mjs');
  const { emptyState } = await import('../../apps/api/src/state.mjs');
  const state = emptyState();
  state.projects.push({ id: 'project-1' });
  state.workspaces.push({ id: 'workspace-1', project_id: 'project-1' });
  state.workflow_nodes.push({ id: 'task-1', role: 'task', workspace_id: 'workspace-1', title: 'Verify and decide' });
  state.node_contracts.push({
    id: 'contract-1',
    expected_outputs: [
      {
        key: 'test_report',
        asset_type: 'TestReportAsset',
        required: true,
        confirmation_policy: 'system_evidence',
        acceptance_criteria: ['Tests pass']
      },
      {
        key: 'decision',
        asset_type: 'DecisionAsset',
        required: true,
        confirmation_policy: 'human',
        acceptance_criteria: ['Decision accepted']
      },
      {
        key: 'integration_evidence',
        asset_type: 'IntegrationEvidenceAsset',
        required: true,
        confirmation_policy: 'system_evidence',
        acceptance_criteria: ['PR merged']
      }
    ]
  });
  const execution = {
    id: 'tex-1',
    project_id: 'project-1',
    workflow_execution_id: 'wex-1',
    task_id: 'task-1',
    contract_id: 'contract-1',
    executor: 'repository_verify',
    status: 'running',
    input_snapshot_hash: 'a'.repeat(64),
    context_snapshot: { inputs: [] },
    output_bindings: [],
    acceptance_results: []
  };
  state.task_executions.push(execution);
  const log = await registerCasBlob(state, 'test passed', { mediaType: 'text/plain; charset=utf-8' });
  const evidence = {
    repository_sha: 'b'.repeat(40),
    checkout_head: 'b'.repeat(40),
    commands: [{ command: 'node --test', exit_code: 0, status: 'passed', log_sha256: log.sha256 }]
  };
  const outputs = [
    output('test_report', 'TestReportAsset', {
      payload_kind: 'test_report',
      media_type: 'application/json',
      content: {}
    }),
    output('decision', 'DecisionAsset', {
      payload_kind: 'text',
      media_type: 'text/plain; charset=utf-8',
      content: 'Ship it.'
    }),
    output('integration_evidence', 'IntegrationEvidenceAsset', {
      payload_kind: 'json',
      media_type: 'application/json',
      content: {}
    })
  ];
  const ingested = await ingestExecutionOutputsInState(state, {
    taskExecution: execution,
    outputs,
    actorId: 'owner',
    verifierId: 'repository_verify_verifier',
    actualEvidence: evidence
  });
  assert.equal(execution.status, 'awaiting_human');
  assert.deepEqual(execution.output_bindings.map((item) => item.key).sort(), ['integration_evidence', 'test_report']);
  assert.equal(ingested.awaiting_human.length, 1);
  const pending = ingested.awaiting_human[0],
    pendingAsset = state.assets.find((item) => item.id === pending.asset_id);
  await assert.rejects(
    () =>
      attestAssetVersionInState(state, {
        assetId: pending.asset_id,
        versionId: pending.version_id,
        expectedSha256: '0'.repeat(64),
        taskExecutionId: execution.id,
        outputKey: 'decision',
        decision: 'accepted',
        attestorType: 'human',
        attestorId: 'owner'
      }),
    (error) => error.payload?.error === 'asset_version_hash_mismatch'
  );
  await attestAssetVersionInState(state, {
    assetId: pending.asset_id,
    versionId: pending.version_id,
    expectedSha256: pending.content_sha256,
    taskExecutionId: execution.id,
    outputKey: 'decision',
    decision: 'accepted',
    attestorType: 'human',
    attestorId: 'owner'
  });
  assert.equal(pendingAsset.status, 'confirmed');
  assert.deepEqual(execution.output_bindings.map((item) => item.key).sort(), [
    'decision',
    'integration_evidence',
    'test_report'
  ]);
  const testBinding = execution.output_bindings.find((item) => item.key === 'test_report');
  const integrationBinding = execution.output_bindings.find((item) => item.key === 'integration_evidence');
  assert.equal(
    state.asset_versions.find((item) => item.id === integrationBinding.version_id).repository_sha,
    evidence.repository_sha
  );
  await assert.rejects(
    () =>
      attestAssetVersionInState(state, {
        assetId: testBinding.asset_id,
        versionId: testBinding.version_id,
        expectedSha256: testBinding.content_sha256,
        taskExecutionId: execution.id,
        outputKey: 'test_report',
        decision: 'accepted',
        attestorType: 'trusted_verifier',
        attestorId: 'model_report',
        evidence
      }),
    (error) => error.payload?.error === 'trusted_verifier_required'
  );

  const outcomeAsset = createAssetRecord({
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    taskId: 'workstream-1',
    assetType: 'WorkstreamOutcomeAsset',
    title: 'Outcome',
    outputKey: 'workstream_outcome',
    actorId: 'owner'
  });
  Object.assign(outcomeAsset, { confirmation_policy: 'system_evidence', provenance_workflow_execution_id: 'wex-1' });
  state.assets.push(outcomeAsset);
  const outcomeVersion = await createImmutableAssetVersion(state, {
    asset: outcomeAsset,
    payload: {
      payload_kind: 'json',
      media_type: 'application/json',
      content: { terminal_output_bindings: [integrationBinding] }
    },
    actorId: 'owner'
  });
  await attestAssetVersionInState(state, {
    assetId: outcomeAsset.id,
    versionId: outcomeVersion.id,
    expectedSha256: outcomeVersion.content_sha256,
    outputKey: 'workstream_outcome',
    decision: 'accepted',
    attestorType: 'trusted_verifier',
    attestorId: 'aiws_cas_verifier',
    evidence: {
      workflow_execution_id: 'wex-1',
      terminal_output_bindings: [integrationBinding],
      external_snapshot_sha256: outcomeVersion.content_sha256
    }
  });
  assert.equal(
    assetVersionDetails(state, outcomeVersion.id).lineage.upstream.some(
      (item) => item.source_asset_version_id === integrationBinding.version_id && item.inferred === true
    ),
    true
  );
  const integrationDetails = assetVersionDetails(state, integrationBinding.version_id);
  assert.equal(
    integrationDetails.lineage.downstream.some((item) => item.target_asset_version_id === outcomeVersion.id),
    true
  );
  assert.equal(
    integrationDetails.consumers.some(
      (item) => item.type === 'workstream_outcome' && item.asset_version_id === outcomeVersion.id
    ),
    true
  );

  const invalid = structuredClone(execution);
  Object.assign(invalid, { id: 'tex-invalid', status: 'running', output_bindings: [], acceptance_results: [] });
  state.task_executions.push(invalid);
  await assert.rejects(
    () =>
      ingestExecutionOutputsInState(state, {
        taskExecution: invalid,
        outputs: [outputs[0]],
        verifierId: 'repository_verify_verifier',
        actualEvidence: { repository_sha: 'b'.repeat(40), commands: [] }
      }),
    (error) =>
      error.payload?.error === 'runner_required_output_missing' || error.payload?.error === 'test_evidence_incomplete'
  );
  const aggregateInvalid = structuredClone(execution);
  Object.assign(aggregateInvalid, {
    id: 'tex-invalid-aggregate',
    status: 'running',
    output_bindings: [],
    acceptance_results: []
  });
  state.task_executions.push(aggregateInvalid);
  await assert.rejects(
    () =>
      ingestExecutionOutputsInState(state, {
        taskExecution: aggregateInvalid,
        outputs,
        declaredConsumedInputVersions: ['ctx-not-an-asset-version'],
        verifierId: 'repository_verify_verifier',
        actualEvidence: evidence
      }),
    (error) => error.payload?.error === 'runner_consumed_inputs_mismatch' && error.payload?.source === 'aggregate'
  );
  console.log('V1.10 attestation, trusted verifier, and atomic binding unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function output(outputKey, assetType, payload) {
  return {
    output_key: outputKey,
    asset_type: assetType,
    title: outputKey,
    summary: outputKey,
    payload,
    evidence_refs: [],
    consumed_input_versions: []
  };
}
