import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v20-task-effects-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const { emptyState } = await import('../../apps/api/src/state.mjs');
  const { assetVersionConsumers, attestAssetVersionInState, ingestExecutionOutputsInState } =
    await import('../../apps/api/src/asset-attestation-service.mjs');
  const { normalizeTaskEffects } = await import('../../apps/api/src/task-effects.mjs');
  const { taskHandoffDiagnostics } = await import('../../apps/api/src/task-handoff.mjs');
  const { normalizeRunnerOutput, taskRunnerResultSchema } = await import('../../packages/shared/src/context-run.mjs');

  const { state, execution, outputs } = effectState(emptyState());
  const requiredEffect = inputEffect({
    inputKey: 'research_evidence',
    versionIds: ['version-evidence-a', 'version-evidence-b']
  });

  assert.throws(
    () => normalizeTaskEffects(state, execution, outputs, [], [], 'run-effects'),
    (error) => error.payload?.error === 'runner_required_input_effect_missing'
  );

  const optionalOmitted = normalizeTaskEffects(state, execution, outputs, [requiredEffect], [], 'run-effects');
  assert.deepEqual(optionalOmitted.aggregate, ['version-evidence-a', 'version-evidence-b']);
  assert.deepEqual(
    optionalOmitted.inputDispositions.map((item) => item.version_id),
    ['version-evidence-a', 'version-evidence-b']
  );
  assert.equal(
    optionalOmitted.inputDispositions.some((item) => item.version_id === 'version-optional'),
    false
  );

  assert.throws(
    () =>
      normalizeTaskEffects(
        state,
        execution,
        outputs,
        [inputEffect({ inputKey: 'research_evidence', versionIds: ['version-out-of-scope'] })],
        [],
        'run-effects'
      ),
    (error) =>
      error.payload?.error === 'runner_input_effect_scope_invalid' &&
      error.payload.invalid_version_ids.includes('version-out-of-scope')
  );
  assert.throws(
    () =>
      normalizeTaskEffects(
        state,
        execution,
        outputs,
        [inputEffect({ inputKey: 'research_evidence', versionIds: ['version-evidence-a'] })],
        [],
        'run-effects'
      ),
    (error) =>
      error.payload?.error === 'runner_required_input_effect_coverage_missing' &&
      error.payload.missing_version_ids.includes('version-evidence-b')
  );
  assert.throws(
    () =>
      normalizeTaskEffects(
        state,
        execution,
        outputs,
        [{ ...requiredEffect, output_keys: ['notes'] }],
        [],
        'run-effects'
      ),
    (error) =>
      error.payload?.error === 'runner_input_effect_output_scope_invalid' &&
      error.payload.invalid_output_keys.includes('notes')
  );

  const contextEffect = {
    document_version_id: 'cdv-runtime-read',
    effect: 'verification',
    output_keys: ['decision'],
    statement: 'The current context document verified the final decision boundary.',
    evidence_refs: ['context-node:ctx-runtime-read']
  };
  assert.throws(
    () => normalizeTaskEffects(state, execution, outputs, [requiredEffect], [contextEffect], null),
    (error) => error.payload?.error === 'runner_context_effect_read_receipt_required'
  );
  const withContextReceipt = normalizeTaskEffects(
    state,
    execution,
    outputs,
    [requiredEffect],
    [contextEffect],
    'run-effects'
  );
  assert.deepEqual(withContextReceipt.aggregateContext, ['cdv-runtime-read']);
  assert.deepEqual(withContextReceipt.selectionIds, ['csel-initial', 'csel-runtime-read']);

  const ingested = await ingestExecutionOutputsInState(state, {
    taskExecution: execution,
    outputs: [outputs[0]],
    declaredInputEffects: [requiredEffect],
    declaredContextEffects: [contextEffect],
    nodeRunId: 'run-effects',
    actorId: 'owner-effects'
  });
  assert.equal(execution.effects_schema_version, 'aiws.task_effects.v1');
  assert.deepEqual(execution.consumed_inputs, ['version-evidence-a', 'version-evidence-b']);
  assert.deepEqual(execution.consumed_context_document_versions, ['cdv-runtime-read']);
  assert.equal(
    execution.input_dispositions.some((item) => item.version_id === 'version-optional'),
    false
  );
  assert.equal(execution.status, 'awaiting_human');

  const created = ingested.outputs[0],
    manifest = created.version.provenance.handoff_manifest;
  assert.equal(manifest.schema_version, 'aiws.task_handoff.v2');
  assert.deepEqual(manifest.effects.inputs, [requiredEffect]);
  assert.deepEqual(manifest.effects.context, [contextEffect]);
  assert.equal(manifest.delivery.routes.length, 1);
  assert.deepEqual(manifest.delivery.routes[0], {
    route_type: 'task_input',
    producer_task_id: 'task-producer',
    output_key: 'decision',
    consumer_task_id: 'task-consumer',
    consumer_task_title: 'Implement accepted decision',
    input_key: 'decision_input',
    purpose: 'Constrain implementation to the accepted decision.',
    application_policy: 'required',
    target_output_keys: ['implementation']
  });

  await attestAssetVersionInState(state, {
    assetId: created.asset.id,
    versionId: created.version.id,
    expectedSha256: created.version.content_sha256,
    taskExecutionId: execution.id,
    outputKey: 'decision',
    decision: 'accepted',
    attestorType: 'human',
    attestorId: 'owner-effects'
  });
  assert.deepEqual(state.asset_relations.map((item) => item.source_asset_version_id).sort(), [
    'version-evidence-a',
    'version-evidence-b'
  ]);
  assert.equal(
    state.asset_relations.some((item) => item.source_asset_version_id === 'version-optional'),
    false
  );
  const consumers = assetVersionConsumers(state, 'version-evidence-a');
  assert.equal(consumers[0].consumption_status, 'applied');
  assert.equal(consumers[0].effects[0].statement, requiredEffect.statement);

  execution.status = 'completed';
  const diagnostics = taskHandoffDiagnostics(state, execution);
  assert.equal(diagnostics.schema_version, 'aiws.task_handoff_diagnostics.v2');
  assert.equal(diagnostics.handoff_status, 'ready');
  assert.equal(diagnostics.exported_outputs[0].route_count, 1);
  assert.equal(diagnostics.exported_outputs[0].effect_count, 2);
  assert.deepEqual(diagnostics.semantic_gaps, []);

  const schema = taskRunnerResultSchema(execution.context_snapshot);
  assert.deepEqual(schema.properties.schema_version.enum, ['aiws.task_runner_result.v3']);
  assert.deepEqual(schema.properties.input_effects.items.properties.input_key.enum, [
    'research_evidence',
    'optional_reference'
  ]);
  assert.deepEqual(schema.properties.input_effects.items.properties.version_ids.items.enum, [
    'version-evidence-a',
    'version-evidence-b',
    'version-optional'
  ]);
  const normalized = normalizeRunnerOutput(runnerResult([requiredEffect], [contextEffect]));
  assert.equal(normalized.parse_error, null);
  assert.equal(normalized.result.schema_version, 'aiws.task_runner_result.v3');
  const malformed = normalizeRunnerOutput(runnerResult([{ ...requiredEffect, statement: 'too short' }], []));
  assert.equal(malformed.parse_error, 'effect_aware_output_malformed');

  const legacy = effectState(emptyState()),
    legacyConsumed = ['version-evidence-a', 'version-evidence-b', 'version-optional'];
  const legacyOutput = {
    ...legacy.outputs[0],
    consumed_input_versions: legacyConsumed,
    consumed_context_document_versions: [],
    input_dispositions: [],
    context_dispositions: []
  };
  await ingestExecutionOutputsInState(legacy.state, {
    taskExecution: legacy.execution,
    outputs: [legacyOutput],
    declaredConsumedInputVersions: legacyConsumed,
    declaredConsumedContextDocumentVersions: [],
    actorId: 'owner-effects'
  });
  assert.deepEqual(legacy.execution.consumed_inputs, legacyConsumed);
  assert.equal(legacy.execution.effects_schema_version, undefined);

  console.log('V2.0 task effect, Context read receipt, handoff route, and Runner v3 tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function effectState(state) {
  state.projects.push({ id: 'project-effects' });
  state.workspaces.push({ id: 'workspace-effects', project_id: 'project-effects' });
  const outputSlots = [
    {
      key: 'decision',
      kind: 'asset',
      required: true,
      asset_type: 'DecisionAsset',
      acceptance_criteria: ['Decision incorporates the required evidence.'],
      confirmation_policy: 'human',
      handoff: true,
      purpose: 'Provide the constrained decision to implementation.'
    },
    {
      key: 'notes',
      kind: 'asset',
      required: false,
      asset_type: 'ResearchEvidenceAsset',
      acceptance_criteria: ['Optional notes are traceable.'],
      confirmation_policy: 'human',
      handoff: false,
      purpose: 'Retain optional notes without routing them.'
    }
  ];
  state.workflow_nodes.push(
    {
      id: 'task-producer',
      workflow_id: 'workflow-effects',
      parent_node_id: 'workstream-effects',
      workspace_id: 'workspace-effects',
      role: 'task',
      title: 'Make evidence-backed decision',
      output_slots: structuredClone(outputSlots),
      dependency_ids: []
    },
    {
      id: 'task-consumer',
      workflow_id: 'workflow-effects',
      parent_node_id: 'workstream-effects',
      workspace_id: 'workspace-effects',
      role: 'task',
      title: 'Implement accepted decision',
      dependency_ids: ['task-producer'],
      input_slots: [
        {
          key: 'decision_input',
          source: 'dependency',
          ref_id: 'task-producer',
          selector: 'decision',
          purpose: 'Constrain implementation to the accepted decision.',
          application_policy: 'required',
          target_output_keys: ['implementation']
        }
      ]
    }
  );
  const contract = {
    id: 'contract-effects',
    expected_outputs: structuredClone(outputSlots)
  };
  state.node_contracts.push(contract);
  const inputs = [
      {
        key: 'research_evidence',
        source: 'dependency',
        required: true,
        application_policy: 'required',
        purpose: 'Use both evidence versions to constrain the decision.',
        target_output_keys: ['decision'],
        coverage_policy: 'all',
        asset_versions: [
          { asset_id: 'asset-evidence-a', version_id: 'version-evidence-a' },
          { asset_id: 'asset-evidence-b', version_id: 'version-evidence-b' }
        ]
      },
      {
        key: 'optional_reference',
        source: 'asset',
        required: true,
        application_policy: 'optional',
        purpose: 'Use the reference only if it changes the decision.',
        target_output_keys: ['decision'],
        coverage_policy: 'all',
        asset_versions: [{ asset_id: 'asset-optional', version_id: 'version-optional' }]
      }
    ],
    execution = {
      id: 'execution-effects',
      project_id: 'project-effects',
      workflow_execution_id: 'workflow-execution-effects',
      task_id: 'task-producer',
      contract_id: contract.id,
      executor: 'manual',
      status: 'running',
      input_snapshot_hash: 'a'.repeat(64),
      context_snapshot: {
        schema_version: 'aiws.task_execution_context.v4',
        contract: structuredClone(contract),
        inputs,
        input_effect_obligations: inputs.map((input) => ({
          input_key: input.key,
          source: input.source,
          required: input.required,
          application_policy: input.application_policy,
          purpose: input.purpose,
          target_output_keys: input.target_output_keys,
          coverage_policy: input.coverage_policy,
          version_ids: input.asset_versions.map((item) => item.version_id)
        })),
        system_context: { context_selection_id: 'csel-initial', document_versions: [] }
      },
      output_bindings: [],
      acceptance_results: []
    };
  state.task_executions.push(execution);
  addContextReadReceipt(state, execution);
  return {
    state,
    execution,
    outputs: [taskOutput('decision', 'DecisionAsset'), taskOutput('notes', 'ResearchEvidenceAsset')]
  };
}

function addContextReadReceipt(state, execution) {
  state.context_nodes.push({
    id: 'ctx-runtime-read',
    source_hash: 'context-source-hash',
    current_version_id: 'cdv-runtime-read'
  });
  state.context_document_versions.push({
    id: 'cdv-runtime-read',
    node_id: 'ctx-runtime-read',
    source_hash: 'context-source-hash',
    content_sha256: 'b'.repeat(64)
  });
  state.context_selections.push(
    { id: 'csel-initial', project_id: execution.project_id, included: [] },
    {
      id: 'csel-runtime-read',
      project_id: execution.project_id,
      created_at: '2026-07-28T00:00:01.000Z',
      included: [
        {
          node_id: 'ctx-runtime-read',
          document_version_id: 'cdv-runtime-read',
          content_sha256: 'b'.repeat(64)
        }
      ],
      runtime_context: {
        schema_version: 'aiws.context_runtime_selection.v1',
        purpose: 'mcp_read',
        mcp_client_id: 'mcp-effects',
        session_id: 'session-effects',
        run_id: 'run-effects',
        task_execution_id: execution.id,
        initial_context_selection_id: 'csel-initial',
        read_node_id: 'ctx-runtime-read',
        read_document_version_id: 'cdv-runtime-read'
      }
    }
  );
  state.node_runs.push({
    id: 'run-effects',
    project_id: execution.project_id,
    task_execution_id: execution.id
  });
  state.mcp_clients.push({
    id: 'mcp-effects',
    kind: 'internal_codex',
    context_binding: {
      schema_version: 'aiws.mcp_context_binding.v1',
      project_id: execution.project_id,
      session_id: 'session-effects',
      run_id: 'run-effects',
      task_execution_id: execution.id,
      context_selection_id: 'csel-initial'
    }
  });
}

function inputEffect({ inputKey, versionIds }) {
  return {
    input_key: inputKey,
    version_ids: versionIds,
    effect: 'constraint',
    output_keys: ['decision'],
    statement: 'Both evidence versions constrained the final decision and ruled out the unsupported option.',
    evidence_refs: ['evidence:comparison']
  };
}

function taskOutput(outputKey, assetType) {
  return {
    output_key: outputKey,
    asset_type: assetType,
    title: outputKey,
    summary: `${outputKey} summary`,
    payload: {
      payload_kind: 'text',
      media_type: 'text/plain; charset=utf-8',
      content: `${outputKey} body`,
      files: []
    },
    evidence_refs: [],
    purpose: `Deliver ${outputKey}.`,
    consumer_hint: '',
    unresolved_questions: [],
    limitations: []
  };
}

function runnerResult(inputEffects, contextEffects) {
  return {
    schema_version: 'aiws.task_runner_result.v3',
    status: 'succeeded',
    summary: 'Effect-aware result.',
    input_effects: inputEffects,
    context_effects: contextEffects,
    outputs: [taskOutput('decision', 'DecisionAsset')],
    synthetic_fallback: false,
    warnings: []
  };
}
