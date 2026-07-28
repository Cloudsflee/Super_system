import { id, now } from '../../../packages/shared/index.mjs';
import { createAssetRecord, createImmutableAssetVersion, verifyAssetVersionPayload } from './asset-cas.mjs';
import { HttpError } from './http.mjs';
import { normalizeConsumedContextDocuments } from './task-context-consumption.mjs';
import {
  buildTaskHandoffManifest,
  normalizeDispositions,
  normalizeIdList,
  taskHandoffDiagnostics,
  taskHandoffRoutes
} from './task-handoff.mjs';
import { normalizeTaskEffects } from './task-effects.mjs';
import { recordAssetLineage } from './task-output-service.mjs';
import { acceptanceCriterionId } from '../../../packages/shared/src/task-contributions.mjs';
import { applyExecutionOutputUsage, updateAcceptedContributions } from './task-contribution-authority.mjs';
import { effectClaimAcceptanceResults, resolveAttestationEffectClaims } from './task-effect-claims.mjs';
import { executionOutputProvenance, executionOutputUsage } from './task-output-authority.mjs';

export const TRUSTED_VERIFIERS = Object.freeze(
  new Set([
    'repository_change_verifier',
    'repository_verify_verifier',
    'repository_integrate_verifier',
    'aiws_cas_verifier'
  ])
);

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
  const { task, project, contract, source } = resolveExecutionOutputScope(state, taskExecution, outputs),
    { effects, consumption, contextConsumption } = resolveExecutionOutputUsage(state, {
      taskExecution,
      source,
      declaredConsumedInputVersions,
      declaredInputDispositions,
      declaredConsumedContextDocumentVersions,
      declaredContextDispositions,
      declaredInputEffects,
      declaredContextEffects,
      nodeRunId
    }),
    created = await createExecutionOutputArtifacts(state, {
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

function resolveExecutionOutputScope(state, taskExecution, outputs) {
  const task = state.workflow_nodes.find((item) => item.id === taskExecution?.task_id && item.role === 'task'),
    project = state.projects.find((item) => item.id === taskExecution?.project_id),
    contract = state.node_contracts.find((item) => item.id === taskExecution?.contract_id);
  if (!taskExecution || !task || !project || !contract)
    throw new HttpError(404, { error: 'task_execution_scope_not_found' });
  if (!['running', 'verifying'].includes(taskExecution.status))
    throw new HttpError(409, { error: 'task_execution_not_accepting_output', status: taskExecution.status });
  const source = Array.isArray(outputs) ? outputs : [],
    duplicateKeys = duplicateValues(source.map((item) => clean(item?.output_key)));
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
  const outputByKey = new Map(options.source.map((item) => [clean(item?.output_key), item])),
    created = [];
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
  const usage = executionOutputUsage(slot.key, consumption, contextConsumption, effects),
    version = await createImmutableAssetVersion(state, {
      asset,
      payload: trustedPayloadForSlot(slot, output.payload, actualEvidence),
      title: asset.title,
      summary: asset.summary,
      evidenceRefs: evidenceRefs(actualEvidence, output),
      repositorySha: repositoryShaFor(slot, actualEvidence, output),
      provenance: executionOutputProvenance(taskExecution, slot.key, usage, effects),
      actorId,
      outputKey: slot.key
    }),
    handoffManifest = buildTaskHandoffManifest({
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

export async function attestAssetVersionInState(state, input) {
  const normalized = normalizeAttestationInput(input);
  const context = resolveAttestationContext(state, normalized);
  const { asset, version, execution, key, slot, confirmationPolicy } = context;
  await verifyAcceptedVersion(state, version, normalized.decision, normalized.casRoot);
  const existing = findExistingAttestation(state, context, normalized);
  if (existing) return { attestation: existing, asset, version, idempotent: true };
  const criteria = slot?.acceptance_criteria || asset.acceptance_criteria || [];
  const acceptanceResults = buildAcceptanceResults(criteria, version, normalized, {
    taskId: execution?.task_id || asset.node_id || null,
    outputKey: key || asset.output_key || version.output_key || null
  });
  const attestation = createAttestation(context, normalized, acceptanceResults);
  state.asset_attestations.push(attestation);
  updateAttestedAsset(asset, normalized);
  if (execution) updateAttestedExecution(state, context, normalized, attestation, criteria, acceptanceResults);
  return { attestation, asset, version, task_execution: execution, idempotent: false };
}

function normalizeAttestationInput(input) {
  return {
    ...input,
    taskExecutionId: input.taskExecutionId === undefined ? null : input.taskExecutionId,
    outputKey: input.outputKey === undefined ? null : input.outputKey,
    decision: input.decision === undefined ? 'accepted' : input.decision,
    attestorType: input.attestorType === undefined ? 'human' : input.attestorType,
    acceptedEffectClaimIds: normalizeIdList(input.acceptedEffectClaimIds),
    evidence: input.evidence === undefined ? {} : input.evidence,
    summary: input.summary === undefined ? '' : input.summary
  };
}

function resolveAttestationContext(state, input) {
  const {
    assetId,
    versionId,
    expectedSha256,
    taskExecutionId,
    outputKey,
    decision,
    attestorType,
    attestorId,
    evidence
  } = input;
  const asset = state.assets.find((item) => item.id === assetId),
    version = state.asset_versions.find((item) => item.id === versionId && item.asset_id === assetId);
  if (!asset || !version) throw new HttpError(404, { error: 'asset_version_not_found' });
  if (asset.current_version_id !== version.id)
    throw new HttpError(409, { error: 'asset_version_superseded', current_version_id: asset.current_version_id });
  if (!expectedSha256 || expectedSha256 !== version.content_sha256)
    throw new HttpError(409, {
      error: 'asset_version_hash_mismatch',
      expected_sha256: expectedSha256 || null,
      actual_sha256: version.content_sha256
    });
  if (!['accepted', 'rejected'].includes(decision))
    throw new HttpError(400, { error: 'asset_attestation_decision_invalid' });
  const execution = taskExecutionId ? state.task_executions.find((item) => item.id === taskExecutionId) : null;
  if (taskExecutionId && (!execution || asset.task_execution_id !== execution.id))
    throw new HttpError(409, { error: 'asset_task_execution_mismatch' });
  const key = outputKey || asset.output_key || version.output_key;
  const contract = execution ? state.node_contracts.find((item) => item.id === execution.contract_id) : null;
  const slot = contract?.expected_outputs?.find((item) => item.key === key) || null;
  const confirmationPolicy = slot?.confirmation_policy || asset.confirmation_policy || 'human';
  if (confirmationPolicy === 'system_evidence') {
    if (attestorType !== 'trusted_verifier' || !TRUSTED_VERIFIERS.has(attestorId))
      throw new HttpError(403, { error: 'trusted_verifier_required' });
    assertSystemEvidence(state, slot, asset, version, evidence, execution);
  } else if (attestorType !== 'human') throw new HttpError(403, { error: 'human_attestor_required' });
  if (attestorType === 'trusted_verifier' && !TRUSTED_VERIFIERS.has(attestorId))
    throw new HttpError(403, { error: 'trusted_verifier_unknown' });
  input.acceptedEffectClaimIds = resolveAttestationEffectClaims(execution, key, { ...input, outputVersion: version });
  return { asset, version, execution, key, slot, confirmationPolicy };
}

async function verifyAcceptedVersion(state, version, decision, casRoot) {
  if (decision !== 'accepted') return;
  const integrity = await verifyAssetVersionPayload(state, version, { casRoot });
  if (!integrity.ok) throw new HttpError(409, { error: 'asset_version_integrity_failed', reasons: integrity.reasons });
}

function findExistingAttestation(state, context, input) {
  const { version, execution, key } = context;
  return state.asset_attestations.find(
    (item) =>
      item.asset_version_id === version.id &&
      item.task_execution_id === (execution?.id || null) &&
      item.output_key === (key || null) &&
      item.attestor_type === input.attestorType &&
      item.attestor_id === input.attestorId &&
      item.decision === input.decision &&
      item.expected_sha256 === input.expectedSha256 &&
      JSON.stringify(item.accepted_effect_claim_ids || []) === JSON.stringify(input.acceptedEffectClaimIds || [])
  );
}

function buildAcceptanceResults(criteria, version, input, scope) {
  return criteria.map((criterion) => ({
    acceptance_criterion_id:
      scope.taskId && scope.outputKey ? acceptanceCriterionId(scope.taskId, scope.outputKey, criterion) : null,
    criterion,
    status: input.decision === 'accepted' ? 'accepted' : 'rejected',
    evidence_refs: version.evidence_refs || [],
    verified_by: input.attestorType === 'trusted_verifier' ? input.attestorId : null
  }));
}

function createAttestation(context, input, acceptanceResults) {
  const { asset, version, execution, key, confirmationPolicy } = context;
  return {
    id: id('aat'),
    asset_id: asset.id,
    asset_version_id: version.id,
    task_execution_id: execution?.id || null,
    output_key: key || null,
    decision: input.decision,
    confirmation_policy: confirmationPolicy,
    attestor_type: input.attestorType,
    attestor_id: input.attestorId,
    expected_sha256: input.expectedSha256,
    accepted_effect_claim_ids: [...(input.acceptedEffectClaimIds || [])],
    effect_acceptance_results: effectClaimAcceptanceResults(execution, key, {
      ...input,
      outputVersion: version
    }),
    acceptance_results: acceptanceResults,
    evidence: structuredClone(input.evidence || {}),
    summary: clean(input.summary, 4000),
    created_at: now()
  };
}

function updateAttestedAsset(asset, input) {
  Object.assign(asset, {
    status: input.decision === 'accepted' ? 'confirmed' : 'rejected',
    attestation_status: input.decision,
    confirmed_by_user_id: input.decision === 'accepted' && input.attestorType === 'human' ? input.attestorId : null,
    updated_at: now()
  });
}

function updateAttestedExecution(state, context, input, attestation, criteria, acceptanceResults) {
  const { asset, version, execution, key, slot, confirmationPolicy } = context;
  const outputBindings = (execution.output_bindings || []).filter((item) => item.key !== key);
  if (input.decision === 'accepted')
    outputBindings.push({
      key,
      asset_id: asset.id,
      version_id: version.id,
      asset_type: asset.asset_type,
      content_sha256: version.content_sha256,
      repository_sha: version.repository_sha || null,
      acceptance_criteria: criteria,
      confirmation_policy: confirmationPolicy,
      handoff: slot?.handoff !== false,
      consumer_hint: slot?.consumer_hint || null,
      handoff_manifest_sha256: version.provenance?.handoff_manifest_sha256 || null,
      accepted_effect_claim_ids: [...(attestation.accepted_effect_claim_ids || [])],
      attestation_id: attestation.id
    });
  execution.output_bindings = outputBindings;
  execution.acceptance_results = mergeAcceptanceResults(execution.acceptance_results, acceptanceResults, key);
  updateAcceptedContributions(execution);
  execution.updated_at = now();
  recordAssetLineage(state, execution.context_snapshot, execution.output_bindings, execution.id);
}

export function assetVersionDetails(state, versionId) {
  const version = state.asset_versions.find((item) => item.id === versionId),
    asset = state.assets.find((item) => item.id === version?.asset_id);
  if (!asset || !version) throw new HttpError(404, { error: 'asset_version_not_found' });
  const attestations = state.asset_attestations.filter((item) => item.asset_version_id === version.id);
  return {
    asset,
    version,
    attestations,
    lineage: assetVersionLineage(state, version.id),
    consumers: assetVersionConsumers(state, version.id)
  };
}

export function assetVersionConsumers(state, versionId) {
  const consumers = [];
  for (const execution of state.task_executions) {
    const inputs = execution.context_snapshot?.inputs || [];
    const matched = inputs.flatMap((item) => item.asset_versions || []).filter((item) => item.version_id === versionId);
    if (matched.length) {
      const effects = (execution.input_effects || []).filter((item) => (item.version_ids || []).includes(versionId)),
        acceptedEffectClaimIds = new Set(execution.accepted_effect_claim_ids || []),
        acceptedContributionIds = new Set(execution.accepted_contribution_ids || []),
        acceptedEffects = effects.filter((effect) =>
          effect.claim_id
            ? acceptedEffectClaimIds.has(effect.claim_id)
            : Boolean(effect.contribution_id && acceptedContributionIds.has(effect.contribution_id))
        ),
        contributionAware = execution.effects_schema_version === 'aiws.task_effects.v2',
        consumed = contributionAware
          ? acceptedEffects.length > 0
          : effects.length > 0 || (execution.consumed_inputs || []).includes(versionId);
      consumers.push({
        type: consumed ? 'task_execution' : 'task_execution_input',
        id: execution.id,
        workflow_execution_id: execution.workflow_execution_id,
        task_id: execution.task_id,
        status: execution.status,
        consumption_status: contributionAware
          ? acceptedEffects.length
            ? 'accepted_contribution'
            : effects.length
              ? 'structurally_verified'
              : 'prepared'
          : effects.length
            ? 'applied'
            : consumed
              ? 'consumed'
              : 'prepared',
        effects,
        input_keys: inputs
          .filter((item) => (item.asset_versions || []).some((version) => version.version_id === versionId))
          .map((item) => item.key)
      });
    }
  }
  for (const relation of assetVersionLineage(state, versionId).downstream) {
    const targetVersion = state.asset_versions.find((item) => item.id === relation.target_asset_version_id);
    const targetAsset = state.assets.find((item) => item.id === targetVersion?.asset_id);
    if (
      !targetAsset ||
      !/WorkstreamOutcome/i.test(targetAsset.asset_type) ||
      consumers.some((item) => item.type === 'workstream_outcome' && item.asset_version_id === targetVersion.id)
    )
      continue;
    consumers.push({
      type: 'workstream_outcome',
      id: targetAsset.id,
      asset_id: targetAsset.id,
      asset_version_id: targetVersion.id,
      workflow_execution_id:
        targetAsset.provenance_workflow_execution_id || targetVersion.provenance?.workflow_execution_id || null,
      workstream_id: targetAsset.node_id || targetVersion.provenance?.workstream_id || null,
      status: targetAsset.status,
      consumption_status: 'evidenced',
      input_keys: ['terminal_output_bindings']
    });
  }
  return consumers;
}

export function assetVersionLineage(state, versionId) {
  const relations = (state.asset_relations || []).map((relation) => normalizeOutcomeEvidenceRelation(state, relation)),
    known = new Set(relations.map(relationKey));
  for (const relation of inferredWorkstreamOutcomeRelations(state)) {
    const key = relationKey(relation);
    if (!known.has(key)) {
      known.add(key);
      relations.push(relation);
    }
  }
  return {
    upstream: relations.filter((item) => item.target_asset_version_id === versionId),
    downstream: relations.filter((item) => item.source_asset_version_id === versionId)
  };
}

function assertSystemEvidence(state, slot, asset, version, evidence, execution) {
  if (/WorkstreamOutcome/i.test(asset.asset_type)) {
    const terminalBindings = Array.isArray(evidence.terminal_output_bindings) ? evidence.terminal_output_bindings : [],
      handoffBindings = Array.isArray(evidence.handoff_output_bindings)
        ? evidence.handoff_output_bindings
        : terminalBindings;
    if (
      !evidence.workflow_execution_id ||
      !terminalBindings.length ||
      !handoffBindings.length ||
      evidence.external_snapshot_sha256 !== version.content_sha256
    )
      throw new HttpError(409, { error: 'workstream_outcome_evidence_incomplete' });
    if (
      terminalBindings.some((binding) => !acceptedOutputBinding(state, binding, evidence.workflow_execution_id)) ||
      handoffBindings.some(
        (binding) =>
          !terminalBindings.some(
            (candidate) => candidate.asset_id === binding.asset_id && candidate.version_id === binding.version_id
          )
      )
    )
      throw new HttpError(409, { error: 'workstream_outcome_source_invalid' });
    return;
  }
  if (!execution || execution.input_superseded)
    throw new HttpError(409, { error: 'system_evidence_execution_invalid' });
  const repositorySha = evidence.repository_sha || evidence.commit_sha || version.repository_sha;
  const commands = Array.isArray(evidence.commands)
    ? evidence.commands
    : Array.isArray(evidence.test_results)
      ? evidence.test_results
      : [];
  if (/TestReport|TestEvidence/i.test(asset.asset_type)) {
    if (!repositorySha || !commands.length) throw new HttpError(409, { error: 'test_evidence_incomplete' });
    if (
      commands.some(
        (item) => Number(item.exit_code) !== 0 || !item.command || !(item.log_sha256 || item.raw_log_sha256)
      )
    )
      throw new HttpError(409, { error: 'test_evidence_command_invalid' });
    if (
      commands.some(
        (item) => !state.asset_blobs.some((blob) => blob.sha256 === (item.log_sha256 || item.raw_log_sha256))
      )
    )
      throw new HttpError(409, { error: 'test_evidence_log_blob_missing' });
  } else if (/RepositoryVersion|CodeChange/i.test(asset.asset_type)) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(String(repositorySha || '')))
      throw new HttpError(409, { error: 'repository_evidence_sha_invalid' });
    if (
      (evidence.checkout_head && evidence.checkout_head !== repositorySha) ||
      (evidence.commit_sha && evidence.commit_sha !== repositorySha)
    )
      throw new HttpError(409, { error: 'repository_evidence_sha_mismatch' });
  } else if (!commands.length && !repositorySha && !evidence.external_snapshot_sha256)
    throw new HttpError(409, { error: 'system_evidence_incomplete' });
  if (slot && slot.confirmation_policy !== 'system_evidence')
    throw new HttpError(409, { error: 'system_evidence_policy_mismatch' });
}

function acceptedOutputBinding(state, binding, workflowExecutionId) {
  const asset = state.assets.find(
      (item) =>
        item.id === binding?.asset_id && item.current_version_id === binding?.version_id && item.status === 'confirmed'
    ),
    version = state.asset_versions.find(
      (item) =>
        item.id === binding?.version_id &&
        item.asset_id === asset?.id &&
        item.verification_status === 'verified' &&
        item.immutable === true
    ),
    attestation = state.asset_attestations.find(
      (item) =>
        item.asset_version_id === version?.id &&
        item.decision === 'accepted' &&
        (item.confirmation_policy !== 'system_evidence' || item.attestor_type === 'trusted_verifier')
    ),
    execution = asset?.task_execution_id
      ? state.task_executions.find((item) => item.id === asset.task_execution_id)
      : null;
  return Boolean(
    asset &&
    version &&
    attestation &&
    binding.key === (asset.output_key || version.output_key) &&
    binding.asset_type === asset.asset_type &&
    binding.content_sha256 === version.content_sha256 &&
    (!execution || execution.workflow_execution_id === workflowExecutionId)
  );
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
  if (/TestReport|TestEvidence/i.test(slot.asset_type))
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
  if (/RepositoryVersion|CodeChange|AcceptedRepository/i.test(slot.asset_type))
    return (
      evidence.repository_payload || {
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
      }
    );
  if (/DeliveryEvidence|Integration/i.test(slot.asset_type))
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
  return proposed;
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
  return result;
}
function inferredWorkstreamOutcomeRelations(state) {
  const relations = [];
  for (const attestation of state.asset_attestations || []) {
    if (attestation.decision !== 'accepted' || attestation.attestor_type !== 'trusted_verifier') continue;
    const targetVersion = state.asset_versions.find((item) => item.id === attestation.asset_version_id);
    const targetAsset = state.assets.find((item) => item.id === targetVersion?.asset_id);
    if (!targetAsset || !/WorkstreamOutcome/i.test(targetAsset.asset_type)) continue;
    for (const binding of attestation.evidence?.terminal_output_bindings || []) {
      const sourceVersion = state.asset_versions.find(
        (item) => item.id === binding.version_id && item.asset_id === binding.asset_id
      );
      const sourceAsset = state.assets.find((item) => item.id === sourceVersion?.asset_id);
      if (!sourceAsset || sourceVersion.id === targetVersion.id) continue;
      relations.push({
        id: `arl_inferred_${sourceVersion.id}_${targetVersion.id}`,
        relation_type: 'evidenced_by',
        source_asset_id: sourceAsset.id,
        source_asset_version_id: sourceVersion.id,
        target_asset_id: targetAsset.id,
        target_asset_version_id: targetVersion.id,
        input_snapshot_hash: null,
        execution_id: null,
        workflow_execution_id:
          attestation.evidence.workflow_execution_id || targetAsset.provenance_workflow_execution_id || null,
        inferred: true,
        created_at: attestation.created_at
      });
    }
  }
  return relations;
}

function normalizeOutcomeEvidenceRelation(state, relation) {
  if (relation.relation_type !== 'derived_from') return relation;
  const targetVersion = state.asset_versions.find((item) => item.id === relation.target_asset_version_id),
    targetAsset = state.assets.find((item) => item.id === targetVersion?.asset_id);
  return targetAsset && /WorkstreamOutcome/i.test(targetAsset.asset_type)
    ? { ...relation, relation_type: 'evidenced_by', legacy_relation_type: 'derived_from' }
    : relation;
}
function relationKey(item) {
  return `${item.relation_type}:${item.source_asset_version_id}:${item.target_asset_version_id}`;
}
function normalizeConsumedInputs(execution, outputs, declaredAggregate = null, declaredDispositions = null) {
  const inputs = execution.context_snapshot?.inputs || [],
    available = normalizeIdList(inputs.flatMap((item) => item.asset_versions || []).map((item) => item.version_id)),
    availableSet = new Set(available),
    policyByVersion = inputPolicies(inputs),
    required = available.filter((versionId) => policyByVersion.get(versionId)?.required),
    byOutput = new Map(),
    byOutputDispositions = new Map();
  for (const output of outputs) {
    const key = clean(output?.output_key),
      declared = validatedIdList(output?.consumed_input_versions, 'runner_consumed_inputs_invalid', {
        source: `output:${key || 'unknown'}`
      }),
      invalid = declared.filter((versionId) => !availableSet.has(versionId)),
      outputDispositions = validatedDispositions(
        output?.input_dispositions,
        'version_id',
        'runner_input_disposition_invalid',
        `output:${key || 'unknown'}`
      );
    if (invalid.length)
      throw new HttpError(409, {
        error: 'runner_consumed_inputs_mismatch',
        source: `output:${key || 'unknown'}`,
        available_version_ids: available,
        invalid_version_ids: invalid
      });
    assertDispositionScope(outputDispositions, 'version_id', availableSet, 'runner_input_disposition_mismatch', key);
    assertUsedDispositionConsistency(
      outputDispositions,
      'version_id',
      declared,
      'runner_input_disposition_mismatch',
      key
    );
    byOutput.set(key, declared);
    byOutputDispositions.set(key, mergeUsedDispositions(declared, outputDispositions, 'version_id'));
  }
  const aggregate = normalizeIdList([...byOutput.values()].flat()),
    aggregateSet = new Set(aggregate),
    topDispositions = validatedDispositions(
      declaredDispositions,
      'version_id',
      'runner_input_disposition_invalid',
      'aggregate'
    );
  assertDispositionScope(topDispositions, 'version_id', availableSet, 'runner_input_disposition_mismatch', 'aggregate');
  assertUsedDispositionConsistency(
    topDispositions,
    'version_id',
    aggregate,
    'runner_input_disposition_mismatch',
    'aggregate'
  );
  const dispositions = aggregateDispositions({
      ids: available,
      usedIds: aggregateSet,
      explicit: topDispositions,
      perOutput: byOutputDispositions,
      idKey: 'version_id'
    }),
    dispositionByVersion = new Map(dispositions.map((item) => [item.version_id, item])),
    mustUse = available.filter((versionId) => policyByVersion.get(versionId)?.mustUse),
    missingRequired = mustUse.filter((versionId) => !aggregateSet.has(versionId));
  if (missingRequired.length)
    throw new HttpError(409, {
      error: 'runner_required_inputs_unconsumed',
      required_version_ids: mustUse,
      missing_version_ids: missingRequired
    });
  const acknowledged = available.filter((versionId) => policyByVersion.get(versionId)?.explicit),
    missingDispositions = acknowledged.filter((versionId) => !dispositionByVersion.has(versionId));
  if (missingDispositions.length)
    throw new HttpError(409, {
      error: 'runner_input_disposition_required',
      missing_version_ids: missingDispositions
    });
  if (declaredAggregate !== null)
    assertConsumedSet(
      aggregate,
      validatedIdList(declaredAggregate, 'runner_consumed_inputs_invalid', { source: 'aggregate' }),
      'aggregate'
    );
  return {
    aggregate,
    byOutput,
    dispositions,
    byOutputDispositions,
    required,
    missingDispositions,
    semanticGaps: dispositions
      .filter((item) => item.disposition === 'not_used' && policyByVersion.get(item.version_id)?.mustUse)
      .map((item) => ({ code: 'must_use_input_not_used', version_id: item.version_id }))
  };
}
function assertConsumedSet(expected, actual, source) {
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index]))
    throw new HttpError(409, {
      error: 'runner_consumed_inputs_mismatch',
      source,
      expected_version_ids: expected,
      actual_version_ids: actual
    });
}

function inputPolicies(inputs) {
  const result = new Map();
  for (const input of inputs || []) {
    const explicit = ['must_use', 'must_acknowledge', 'available'].includes(input?.consumption_policy),
      policy = explicit ? input.consumption_policy : input.required !== false ? 'must_use' : 'available';
    for (const version of input.asset_versions || []) {
      if (typeof version?.version_id !== 'string' || !version.version_id.trim()) continue;
      const versionId = version.version_id.trim(),
        current = result.get(versionId);
      result.set(versionId, {
        policy: current?.mustUse || policy === 'must_use' ? 'must_use' : policy,
        required: Boolean(current?.required || input.required !== false),
        explicit: Boolean(current?.explicit || explicit),
        mustUse: Boolean(current?.mustUse || policy === 'must_use')
      });
    }
  }
  return result;
}

function validatedIdList(values, error, detail = {}) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new HttpError(400, { error, ...detail });
  if (values.some((value) => value != null && value !== '' && typeof value !== 'string'))
    throw new HttpError(400, { error, ...detail });
  return normalizeIdList(values);
}

function validatedDispositions(values, idKey, error, source) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new HttpError(400, { error, source });
  const seen = new Set();
  for (const item of values) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item[idKey] !== 'string' ||
      !item[idKey].trim() ||
      !['used', 'not_used'].includes(item.disposition) ||
      (item.disposition === 'not_used' && !clean(item.reason, 1000)) ||
      seen.has(item[idKey].trim())
    )
      throw new HttpError(400, { error, source });
    seen.add(item[idKey].trim());
  }
  return normalizeDispositions(values, idKey);
}

function assertDispositionScope(dispositions, idKey, availableSet, error, source) {
  const invalid = dispositions.map((item) => item[idKey]).filter((value) => !availableSet.has(value));
  if (invalid.length) throw new HttpError(409, { error, source: source || 'aggregate', invalid_ids: invalid });
}

function assertUsedDispositionConsistency(dispositions, idKey, usedIds, error, source) {
  const used = new Set(usedIds),
    invalid = dispositions.filter((item) => (item.disposition === 'used') !== used.has(item[idKey]));
  if (invalid.length)
    throw new HttpError(409, {
      error,
      source: source || 'aggregate',
      inconsistent_ids: invalid.map((item) => item[idKey])
    });
}

function mergeUsedDispositions(usedIds, dispositions, idKey) {
  const byId = new Map(dispositions.map((item) => [item[idKey], item]));
  for (const value of usedIds)
    if (!byId.has(value))
      byId.set(value, {
        [idKey]: value,
        disposition: 'used',
        reason: 'Declared as used by this output.'
      });
  return [...byId.values()].sort((left, right) => left[idKey].localeCompare(right[idKey]));
}

function aggregateDispositions({ ids, usedIds, explicit, perOutput, idKey }) {
  const explicitById = new Map(explicit.map((item) => [item[idKey], item])),
    outputValues = [...perOutput.values()].flat(),
    outputById = new Map();
  for (const item of outputValues) {
    const values = outputById.get(item[idKey]) || [];
    values.push(item);
    outputById.set(item[idKey], values);
  }
  const result = [];
  for (const value of ids) {
    if (usedIds.has(value)) {
      const declaration = explicitById.get(value) || outputById.get(value)?.find((item) => item.disposition === 'used');
      result.push({
        [idKey]: value,
        disposition: 'used',
        reason: declaration?.reason || 'Declared as used by at least one output.'
      });
      continue;
    }
    const declaration =
      explicitById.get(value) || outputById.get(value)?.find((item) => item.disposition === 'not_used');
    if (declaration) result.push(declaration);
  }
  return result.sort((left, right) => left[idKey].localeCompare(right[idKey]));
}

function mergeAcceptanceResults(current, values, outputKey) {
  return [
    ...(current || []).filter((item) => item.output_key !== outputKey),
    ...values.map((item) => ({ ...item, output_key: outputKey }))
  ];
}
function duplicateValues(values) {
  const seen = new Set(),
    duplicates = new Set();
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
