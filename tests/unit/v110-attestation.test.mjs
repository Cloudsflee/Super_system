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
  state.context_nodes.push(
    {
      id: 'ctx-required',
      source_hash: 'source-required',
      current_version_id: 'cdv-required'
    },
    {
      id: 'ctx-optional',
      source_hash: 'source-optional',
      current_version_id: 'cdv-optional'
    }
  );
  state.context_document_versions.push(
    {
      id: 'cdv-required',
      node_id: 'ctx-required',
      source_hash: 'source-required',
      content_sha256: '1'.repeat(64)
    },
    {
      id: 'cdv-optional',
      node_id: 'ctx-optional',
      source_hash: 'source-optional',
      content_sha256: '2'.repeat(64)
    }
  );
  state.context_selections.push({
    id: 'csel-execution',
    included: [
      { node_id: 'ctx-required', document_version_id: 'cdv-required', content_sha256: '1'.repeat(64) },
      { node_id: 'ctx-optional', document_version_id: 'cdv-optional', content_sha256: '2'.repeat(64) }
    ]
  });
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
    context_snapshot: {
      inputs: [
        {
          key: 'required_evidence',
          required: true,
          asset_versions: [{ asset_id: 'asset-input-required', version_id: 'version-input-required' }]
        },
        {
          key: 'optional_decision',
          required: false,
          asset_versions: [{ asset_id: 'asset-input-optional', version_id: 'version-input-optional' }]
        }
      ],
      system_context: {
        context_selection_id: 'csel-execution',
        document_versions: [
          {
            node_id: 'ctx-required',
            document_version_id: 'cdv-required',
            content_sha256: '1'.repeat(64),
            required: true
          },
          {
            node_id: 'ctx-optional',
            document_version_id: 'cdv-optional',
            content_sha256: '2'.repeat(64),
            required: false
          }
        ]
      }
    },
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
    output(
      'test_report',
      'TestReportAsset',
      { payload_kind: 'test_report', media_type: 'application/json', content: {} },
      ['version-input-required'],
      ['cdv-required']
    ),
    output(
      'decision',
      'DecisionAsset',
      { payload_kind: 'text', media_type: 'text/plain; charset=utf-8', content: 'Ship it.' },
      ['version-input-optional'],
      ['cdv-optional']
    ),
    output(
      'integration_evidence',
      'IntegrationEvidenceAsset',
      { payload_kind: 'json', media_type: 'application/json', content: {} },
      ['version-input-required'],
      []
    )
  ];
  const ingested = await ingestExecutionOutputsInState(state, {
    taskExecution: execution,
    outputs,
    declaredConsumedContextDocumentVersions: ['cdv-required', 'cdv-optional'],
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
  const decisionBinding = execution.output_bindings.find((item) => item.key === 'decision');
  assert.deepEqual(execution.consumed_inputs, ['version-input-optional', 'version-input-required']);
  assert.equal(execution.context_selection_id, 'csel-execution');
  assert.deepEqual(execution.context_selection_ids, ['csel-execution']);
  assert.deepEqual(execution.consumed_context_document_versions, ['cdv-optional', 'cdv-required']);
  assert.deepEqual(state.asset_versions.find((item) => item.id === testBinding.version_id).provenance.consumed_inputs, [
    'version-input-required'
  ]);
  assert.deepEqual(
    state.asset_versions.find((item) => item.id === decisionBinding.version_id).provenance.consumed_inputs,
    ['version-input-optional']
  );
  assert.deepEqual(state.asset_versions.find((item) => item.id === testBinding.version_id).provenance, {
    ...state.asset_versions.find((item) => item.id === testBinding.version_id).provenance,
    context_selection_id: 'csel-execution',
    context_selection_ids: ['csel-execution'],
    consumed_context_document_versions: ['cdv-required']
  });
  assert.deepEqual(
    state.asset_relations.map((item) => `${item.source_asset_version_id}:${item.target_asset_version_id}`).sort(),
    [
      `version-input-optional:${decisionBinding.version_id}`,
      `version-input-required:${integrationBinding.version_id}`,
      `version-input-required:${testBinding.version_id}`
    ].sort()
  );
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
      (item) =>
        item.type === 'workstream_outcome' &&
        item.asset_version_id === outcomeVersion.id &&
        item.consumption_status === 'evidenced'
    ),
    true
  );
  assert.equal(
    integrationDetails.lineage.downstream.some(
      (item) => item.target_asset_version_id === outcomeVersion.id && item.relation_type === 'evidenced_by'
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
  const invalidContext = structuredClone(execution);
  Object.assign(invalidContext, {
    id: 'tex-invalid-context',
    status: 'running',
    output_bindings: [],
    acceptance_results: []
  });
  state.task_executions.push(invalidContext);
  const invalidContextOutputs = structuredClone(outputs);
  invalidContextOutputs[0].consumed_context_document_versions = ['cdv-not-selected'];
  await assert.rejects(
    () =>
      ingestExecutionOutputsInState(state, {
        taskExecution: invalidContext,
        outputs: invalidContextOutputs,
        declaredConsumedContextDocumentVersions: ['cdv-not-selected', 'cdv-optional'],
        verifierId: 'repository_verify_verifier',
        actualEvidence: evidence
      }),
    (error) => error.payload?.error === 'runner_consumed_context_mismatch'
  );
  const requiredContextUnconsumed = structuredClone(execution);
  Object.assign(requiredContextUnconsumed, {
    id: 'tex-required-context-unconsumed',
    status: 'running',
    output_bindings: [],
    acceptance_results: []
  });
  state.task_executions.push(requiredContextUnconsumed);
  const contextUnconsumedOutputs = structuredClone(outputs);
  for (const item of contextUnconsumedOutputs) item.consumed_context_document_versions = [];
  await assert.rejects(
    () =>
      ingestExecutionOutputsInState(state, {
        taskExecution: requiredContextUnconsumed,
        outputs: contextUnconsumedOutputs,
        declaredConsumedContextDocumentVersions: [],
        verifierId: 'repository_verify_verifier',
        actualEvidence: evidence
      }),
    (error) =>
      error.payload?.error === 'runner_required_context_unconsumed' &&
      error.payload.missing_document_version_ids.includes('cdv-required')
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
  const requiredUnconsumed = structuredClone(execution);
  Object.assign(requiredUnconsumed, {
    id: 'tex-required-unconsumed',
    status: 'running',
    output_bindings: [],
    acceptance_results: []
  });
  state.task_executions.push(requiredUnconsumed);
  const unconsumedOutputs = structuredClone(outputs);
  for (const item of unconsumedOutputs) item.consumed_input_versions = [];
  await assert.rejects(
    () =>
      ingestExecutionOutputsInState(state, {
        taskExecution: requiredUnconsumed,
        outputs: unconsumedOutputs,
        verifierId: 'repository_verify_verifier',
        actualEvidence: evidence
      }),
    (error) =>
      error.payload?.error === 'runner_required_inputs_unconsumed' &&
      error.payload.missing_version_ids.includes('version-input-required')
  );

  state.context_nodes.push({
    id: 'ctx-runtime-read',
    source_hash: 'source-runtime-read',
    current_version_id: 'cdv-runtime-read'
  });
  state.context_document_versions.push({
    id: 'cdv-runtime-read',
    node_id: 'ctx-runtime-read',
    source_hash: 'source-runtime-read',
    content_sha256: '3'.repeat(64)
  });
  const runtimeContextExecution = structuredClone(execution);
  Object.assign(runtimeContextExecution, {
    id: 'tex-runtime-read',
    status: 'running',
    output_bindings: [],
    acceptance_results: [],
    context_selection_ids: [],
    consumed_context_document_versions: []
  });
  state.task_executions.push(runtimeContextExecution);
  state.node_runs.push({
    id: 'run-runtime-read',
    project_id: 'project-1',
    task_execution_id: runtimeContextExecution.id
  });
  state.mcp_clients.push({
    id: 'mcp-runtime-read',
    kind: 'internal_codex',
    status: 'revoked',
    context_binding: {
      schema_version: 'aiws.mcp_context_binding.v1',
      project_id: 'project-1',
      run_id: 'run-runtime-read',
      task_execution_id: runtimeContextExecution.id,
      context_selection_id: 'csel-execution'
    }
  });
  state.context_selections.push({
    id: 'csel-runtime-read',
    project_id: 'project-1',
    created_at: '2026-01-01T00:00:01.000Z',
    included: [
      {
        node_id: 'ctx-runtime-read',
        document_version_id: 'cdv-runtime-read',
        content_sha256: '3'.repeat(64)
      }
    ],
    runtime_context: {
      schema_version: 'aiws.context_runtime_selection.v1',
      purpose: 'mcp_read',
      mcp_client_id: 'mcp-runtime-read',
      run_id: 'run-runtime-read',
      task_execution_id: runtimeContextExecution.id,
      initial_context_selection_id: 'csel-execution',
      read_node_id: 'ctx-runtime-read',
      read_document_version_id: 'cdv-runtime-read'
    }
  });
  const runtimeContextOutputs = structuredClone(outputs);
  runtimeContextOutputs.find((item) => item.output_key === 'decision').consumed_context_document_versions = [
    'cdv-optional',
    'cdv-runtime-read'
  ];
  const runtimeIngested = await ingestExecutionOutputsInState(state, {
    taskExecution: runtimeContextExecution,
    outputs: runtimeContextOutputs,
    declaredConsumedContextDocumentVersions: ['cdv-optional', 'cdv-required', 'cdv-runtime-read'],
    nodeRunId: 'run-runtime-read',
    verifierId: 'repository_verify_verifier',
    actualEvidence: evidence
  });
  assert.deepEqual(runtimeContextExecution.context_selection_ids, ['csel-execution', 'csel-runtime-read']);
  const runtimeDecision = runtimeIngested.outputs.find((item) => item.asset.output_key === 'decision');
  assert.deepEqual(runtimeDecision.version.provenance.context_selection_ids, ['csel-execution', 'csel-runtime-read']);
  assert.deepEqual(runtimeDecision.version.provenance.consumed_context_document_versions, [
    'cdv-optional',
    'cdv-runtime-read'
  ]);

  const searchOnlyExecution = structuredClone(execution);
  Object.assign(searchOnlyExecution, {
    id: 'tex-search-only',
    status: 'running',
    output_bindings: [],
    acceptance_results: []
  });
  state.task_executions.push(searchOnlyExecution);
  state.node_runs.push({ id: 'run-search-only', project_id: 'project-1', task_execution_id: searchOnlyExecution.id });
  state.mcp_clients.push({
    id: 'mcp-search-only',
    kind: 'internal_codex',
    status: 'revoked',
    context_binding: {
      schema_version: 'aiws.mcp_context_binding.v1',
      project_id: 'project-1',
      run_id: 'run-search-only',
      task_execution_id: searchOnlyExecution.id,
      context_selection_id: 'csel-execution'
    }
  });
  state.context_selections.push({
    id: 'csel-search-only',
    project_id: 'project-1',
    included: [
      {
        node_id: 'ctx-runtime-read',
        document_version_id: 'cdv-runtime-read',
        content_sha256: '3'.repeat(64)
      }
    ],
    runtime_context: {
      schema_version: 'aiws.context_runtime_selection.v1',
      purpose: 'mcp_search',
      mcp_client_id: 'mcp-search-only',
      run_id: 'run-search-only',
      task_execution_id: searchOnlyExecution.id,
      initial_context_selection_id: 'csel-execution'
    }
  });
  await assert.rejects(
    () =>
      ingestExecutionOutputsInState(state, {
        taskExecution: searchOnlyExecution,
        outputs: runtimeContextOutputs,
        declaredConsumedContextDocumentVersions: ['cdv-optional', 'cdv-required', 'cdv-runtime-read'],
        nodeRunId: 'run-search-only',
        verifierId: 'repository_verify_verifier',
        actualEvidence: evidence
      }),
    (error) =>
      error.payload?.error === 'runner_consumed_context_mismatch' &&
      error.payload.invalid_document_version_ids.includes('cdv-runtime-read')
  );

  const staleRuntimeExecution = structuredClone(execution);
  Object.assign(staleRuntimeExecution, {
    id: 'tex-stale-runtime-read',
    status: 'running',
    output_bindings: [],
    acceptance_results: []
  });
  state.task_executions.push(staleRuntimeExecution);
  state.node_runs.push({
    id: 'run-stale-runtime-read',
    project_id: 'project-1',
    task_execution_id: staleRuntimeExecution.id
  });
  state.mcp_clients.push({
    id: 'mcp-stale-runtime-read',
    kind: 'internal_codex',
    status: 'revoked',
    context_binding: {
      schema_version: 'aiws.mcp_context_binding.v1',
      project_id: 'project-1',
      run_id: 'run-stale-runtime-read',
      task_execution_id: staleRuntimeExecution.id,
      context_selection_id: 'csel-execution'
    }
  });
  state.context_selections.push({
    id: 'csel-stale-runtime-read',
    project_id: 'project-1',
    included: [
      {
        node_id: 'ctx-runtime-read',
        document_version_id: 'cdv-runtime-read',
        content_sha256: '3'.repeat(64)
      }
    ],
    runtime_context: {
      schema_version: 'aiws.context_runtime_selection.v1',
      purpose: 'mcp_read',
      mcp_client_id: 'mcp-stale-runtime-read',
      run_id: 'run-stale-runtime-read',
      task_execution_id: staleRuntimeExecution.id,
      initial_context_selection_id: 'csel-execution',
      read_node_id: 'ctx-runtime-read',
      read_document_version_id: 'cdv-runtime-read'
    }
  });
  state.context_nodes.find((item) => item.id === 'ctx-runtime-read').current_version_id = 'cdv-runtime-read-new';
  await assert.rejects(
    () =>
      ingestExecutionOutputsInState(state, {
        taskExecution: staleRuntimeExecution,
        outputs: runtimeContextOutputs,
        declaredConsumedContextDocumentVersions: ['cdv-optional', 'cdv-required', 'cdv-runtime-read'],
        nodeRunId: 'run-stale-runtime-read',
        verifierId: 'repository_verify_verifier',
        actualEvidence: evidence
      }),
    (error) => error.payload?.error === 'runner_context_document_stale'
  );
  state.context_nodes.find((item) => item.id === 'ctx-runtime-read').current_version_id = 'cdv-runtime-read';

  const staleContextExecution = structuredClone(execution);
  Object.assign(staleContextExecution, {
    id: 'tex-stale-context',
    status: 'running',
    output_bindings: [],
    acceptance_results: []
  });
  state.task_executions.push(staleContextExecution);
  state.context_nodes.find((item) => item.id === 'ctx-required').current_version_id = 'cdv-required-new';
  await assert.rejects(
    () =>
      ingestExecutionOutputsInState(state, {
        taskExecution: staleContextExecution,
        outputs,
        declaredConsumedContextDocumentVersions: ['cdv-required', 'cdv-optional'],
        verifierId: 'repository_verify_verifier',
        actualEvidence: evidence
      }),
    (error) => error.payload?.error === 'runner_required_context_stale'
  );
  console.log('V1.10 attestation, trusted verifier, and atomic binding unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function output(outputKey, assetType, payload, consumedInputVersions = [], consumedContextVersions = []) {
  return {
    output_key: outputKey,
    asset_type: assetType,
    title: outputKey,
    summary: outputKey,
    payload,
    evidence_refs: [],
    consumed_input_versions: consumedInputVersions,
    consumed_context_document_versions: consumedContextVersions
  };
}
