import { createAssetRecord, createImmutableAssetVersion } from './asset-cas.mjs';
import { attestAssetVersionInState } from './asset-attestation-domain.mjs';
import { normalizeConsumedInputs } from './asset-consumption-normalization.mjs';
import { HttpError } from './http.mjs';
import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { normalizeConsumedContextDocuments } from './task-context-consumption.mjs';
import { applyExecutionOutputUsage } from './task-contribution-authority.mjs';
import { normalizeTaskEffects } from './task-effects.mjs';
import { buildTaskHandoffManifest, taskHandoffDiagnostics, taskHandoffRoutes } from './task-handoff.mjs';
import { executionOutputProvenance, executionOutputUsage } from './task-output-authority.mjs';

export async function ingestExecutionOutputsInState(
  state,
  {
    taskExecution,
    outputs,
    declaredConsumedInputVersions = null,
    declaredInputDispositions = null,
    declaredConsumedContextDocumentVersions = null,
    declaredContextDispositions = null,
    declaredInputEffects = null,
    declaredContextEffects = null,
    nodeRunId = null,
    actorId = null,
    verifierId = null,
    actualEvidence = {}
  }
) {
  const { task, project, contract, source } = resolveExecutionOutputScope(state, taskExecution, outputs);
  const { effects, consumption, contextConsumption } = resolveExecutionOutputUsage(state, {
    taskExecution,
    source,
    declaredConsumedInputVersions,
    declaredInputDispositions,
    declaredConsumedContextDocumentVersions,
    declaredContextDispositions,
    declaredInputEffects,
    declaredContextEffects,
    nodeRunId
  });
  const created = await createExecutionOutputArtifacts(state, {
    taskExecution,
    task,
    project,
    contract,
    source,
    consumption,
    contextConsumption,
    effects,
    actorId,
    actualEvidence
  });
  applyExecutionOutputUsage(taskExecution, consumption, contextConsumption, effects);
  await attestSystemEvidenceOutputs(state, taskExecution, created, verifierId, actualEvidence);
  const human = created.filter(({ slot }) => slot.confirmation_policy === 'human');
  if (human.length) taskExecution.status = 'awaiting_human';
  taskExecution.handoff_diagnostics = taskHandoffDiagnostics(state, taskExecution);
  return executionOutputResult(created, taskExecution, human);
}

function resolveExecutionOutputScope(state, taskExecution, outputs) {
  const task = state.workflow_nodes.find((item) => item.id === taskExecution?.task_id && item.role === 'task');
  const project = state.projects.find((item) => item.id === taskExecution?.project_id);
  const contract = state.node_contracts.find((item) => item.id === taskExecution?.contract_id);
  if (!taskExecution || !task || !project || !contract)
    throw new HttpError(404, { error: 'task_execution_scope_not_found' });
  if (!['running', 'verifying'].includes(taskExecution.status))
    throw new HttpError(409, { error: 'task_execution_not_accepting_output', status: taskExecution.status });
  const source = Array.isArray(outputs) ? outputs : [];
  const duplicateKeys = duplicateValues(source.map((item) => clean(item?.output_key)));
  if (duplicateKeys.length)
    throw new HttpError(400, { error: 'runner_output_key_duplicate', output_keys: duplicateKeys });
  return { task, project, contract, source };
}

function resolveExecutionOutputUsage(
  state,
  {
    taskExecution,
    source,
    declaredConsumedInputVersions,
    declaredInputDispositions,
    declaredConsumedContextDocumentVersions,
    declaredContextDispositions,
    declaredInputEffects,
    declaredContextEffects,
    nodeRunId
  }
) {
  const effectAware =
    ['aiws.task_execution_context.v4', 'aiws.task_execution_context.v5'].includes(
      taskExecution.context_snapshot?.schema_version
    ) &&
    (declaredInputEffects !== null || declaredContextEffects !== null);
  if (effectAware) {
    const effects = normalizeTaskEffects(
      state,
      taskExecution,
      source,
      declaredInputEffects,
      declaredContextEffects,
      nodeRunId
    );
    return {
      effects,
      consumption: effectInputConsumption(effects),
      contextConsumption: effectContextConsumption(effects)
    };
  }
  return {
    effects: null,
    consumption: normalizeConsumedInputs(
      taskExecution,
      source,
      declaredConsumedInputVersions,
      declaredInputDispositions
    ),
    contextConsumption: normalizeConsumedContextDocuments(
      state,
      taskExecution,
      source,
      declaredConsumedContextDocumentVersions,
      declaredContextDispositions,
      nodeRunId
    )
  };
}

function effectInputConsumption(effects) {
  return {
    aggregate: effects.aggregate,
    byOutput: effects.byOutput,
    dispositions: effects.inputDispositions,
    byOutputDispositions: effects.byOutputDispositions
  };
}

function effectContextConsumption(effects) {
  return {
    aggregate: effects.aggregateContext,
    byOutput: effects.byOutputContext,
    dispositions: effects.contextDispositions,
    byOutputDispositions: effects.byOutputContextDispositions,
    selectionId: effects.selectionId,
    selectionIds: effects.selectionIds,
    selectionIdsByOutput: effects.selectionIdsByOutput
  };
}

async function createExecutionOutputArtifacts(state, options) {
  const outputByKey = new Map(options.source.map((item) => [clean(item?.output_key), item]));
  const created = [];
  for (const slot of options.contract.expected_outputs || []) {
    const output = outputByKey.get(slot.key);
    validateExecutionOutput(slot, output);
    if (!output) continue;
    created.push(await createExecutionOutputArtifact(state, { ...options, slot, output }));
  }
  return created;
}

function validateExecutionOutput(slot, output) {
  if (!output) {
    if (slot.required !== false)
      throw new HttpError(409, { error: 'runner_required_output_missing', output_key: slot.key });
    return;
  }
  if (!output.payload || typeof output.payload !== 'object')
    throw new HttpError(400, { error: 'runner_typed_payload_required', output_key: slot.key });
  if (output.asset_type && output.asset_type !== slot.asset_type)
    throw new HttpError(409, {
      error: 'runner_output_asset_type_mismatch',
      output_key: slot.key,
      expected: slot.asset_type,
      actual: output.asset_type
    });
}

async function createExecutionOutputArtifact(
  state,
  { taskExecution, task, project, slot, output, consumption, contextConsumption, effects, actorId, actualEvidence }
) {
  const asset = createAssetRecord({
    projectId: project.id,
    workspaceId: task.workspace_id,
    taskId: task.id,
    taskExecutionId: taskExecution.id,
    assetType: slot.asset_type,
    title: clean(output.title, 200) || `${task.title} ${slot.key}`,
    summary: clean(output.summary, 4000),
    outputKey: slot.key,
    actorId
  });
  Object.assign(asset, {
    acceptance_criteria: [...(slot.acceptance_criteria || [])],
    confirmation_policy: slot.confirmation_policy,
    execution_type: 'task_execution',
    execution_id: taskExecution.id
  });
  state.assets.push(asset);
  const usage = executionOutputUsage(slot.key, consumption, contextConsumption, effects);
  const version = await createImmutableAssetVersion(state, {
    asset,
    payload: trustedPayloadForSlot(slot, output.payload, actualEvidence),
    title: asset.title,
    summary: asset.summary,
    evidenceRefs: evidenceRefs(actualEvidence, output),
    repositorySha: repositoryShaFor(slot, actualEvidence, output),
    provenance: executionOutputProvenance(taskExecution, slot.key, usage, effects),
    actorId,
    outputKey: slot.key
  });
  const handoffManifest = buildTaskHandoffManifest({
    taskExecution,
    task,
    output,
    asset,
    version,
    slot,
    consumedInputVersions: usage.inputs,
    inputDispositions: usage.inputDispositions,
    consumedContextDocumentVersions: usage.context,
    contextDispositions: usage.contextDispositions,
    contextSelectionId: contextConsumption.selectionId,
    inputEffects: usage.inputEffects,
    contextEffects: usage.contextEffects,
    routes: effects ? taskHandoffRoutes(state, task, slot) : undefined,
    unresolvedQuestions: output.unresolved_questions,
    limitations: output.limitations
  });
  version.provenance.handoff_manifest = handoffManifest;
  version.provenance.handoff_manifest_sha256 = handoffManifest.manifest_sha256;
  return { asset, version, slot };
}

async function attestSystemEvidenceOutputs(state, taskExecution, created, verifierId, actualEvidence) {
  for (const item of created.filter(({ slot }) => slot.confirmation_policy === 'system_evidence'))
    await attestAssetVersionInState(state, {
      assetId: item.asset.id,
      versionId: item.version.id,
      expectedSha256: item.version.content_sha256,
      taskExecutionId: taskExecution.id,
      outputKey: item.slot.key,
      decision: 'accepted',
      attestorType: 'trusted_verifier',
      attestorId: verifierId,
      evidence: evidenceForRecord(actualEvidence)
    });
}

function executionOutputResult(created, taskExecution, human) {
  return {
    outputs: created.map(({ asset, version }) => ({ asset, version })),
    output_bindings: taskExecution.output_bindings,
    awaiting_human: human.map(({ asset, version, slot }) => ({
      asset_id: asset.id,
      version_id: version.id,
      output_key: slot.key,
      content_sha256: version.content_sha256
    }))
  };
}

function repositoryShaFor(slot, evidence, output) {
  if (
    !/RepositoryVersion|CodeChange|TestReport|TestEvidence|AcceptedRepository|DeliveryEvidence|Integration/i.test(
      slot.asset_type
    )
  )
    return output.repository_sha || null;
  return evidence.repository_sha || evidence.commit_sha || output.repository_sha || null;
}

function trustedPayloadForSlot(slot, proposed, evidence) {
  if (slot.confirmation_policy !== 'system_evidence') return proposed;
  if (/TestReport|TestEvidence/i.test(slot.asset_type)) return trustedTestReportPayload(evidence);
  if (/RepositoryVersion|CodeChange|AcceptedRepository/i.test(slot.asset_type))
    return evidence.repository_payload || trustedRepositoryPayload(evidence);
  if (/DeliveryEvidence/i.test(slot.asset_type) && evidence.deployment_payload) return evidence.deployment_payload;
  if (/DeliveryEvidence|Integration/i.test(slot.asset_type)) return trustedIntegrationPayload(evidence);
  return proposed;
}

function trustedTestReportPayload(evidence) {
  return {
    payload_kind: 'test_report',
    media_type: 'application/json',
    content: {
      schema_version: 'aiws.test_report.v1',
      repository_sha: evidence.repository_sha || null,
      commands: structuredClone(evidence.commands || evidence.test_results || []),
      verifier: 'aiws'
    }
  };
}

function trustedRepositoryPayload(evidence) {
  return {
    payload_kind: 'json',
    media_type: 'application/json',
    content: {
      schema_version: 'aiws.repository_version.v1',
      repository_sha: evidence.repository_sha || evidence.commit_sha || null,
      previous_sha: evidence.previous_sha || null,
      checkout_head: evidence.checkout_head || null,
      changed_files: structuredClone(evidence.changed_files || []),
      verifier: 'aiws'
    }
  };
}

function trustedIntegrationPayload(evidence) {
  return {
    payload_kind: 'json',
    media_type: 'application/json',
    content: {
      schema_version: 'aiws.integration_evidence.v1',
      pull_request: structuredClone(evidence.pull_request || evidence.pr || null),
      repository_sha: evidence.repository_sha || null,
      verifier: 'aiws'
    }
  };
}

function evidenceRefs(actual, output) {
  return [
    ...new Set([
      ...(output.evidence_refs || []),
      ...(actual.evidence_refs || []),
      ...(actual.commit_sha ? [`commit:${actual.commit_sha}`] : []),
      ...(actual.commands || actual.test_results || [])
        .map((item) => (item.log_sha256 ? `cas:${item.log_sha256}` : null))
        .filter(Boolean)
    ])
  ];
}

function evidenceForRecord(value) {
  const result = structuredClone(value || {});
  delete result.repository_payload;
  delete result.raw_payload;
  delete result.deployment_payload;
  return result;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (!value || seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
