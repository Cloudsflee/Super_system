import { id, now } from '../../../packages/shared/index.mjs';
import { createAssetRecord, createImmutableAssetVersion, verifyAssetVersionPayload } from './asset-cas.mjs';
import { HttpError } from './http.mjs';
import { recordAssetLineage } from './task-output-service.mjs';

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
    declaredConsumedContextDocumentVersions = null,
    nodeRunId = null,
    actorId = null,
    verifierId = null,
    actualEvidence = {}
  }
) {
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
  const consumption = normalizeConsumedInputs(taskExecution, source, declaredConsumedInputVersions),
    contextConsumption = normalizeConsumedContextDocuments(
      state,
      taskExecution,
      source,
      declaredConsumedContextDocumentVersions,
      nodeRunId
    );
  const created = [];
  for (const slot of contract.expected_outputs || []) {
    const output = source.find((item) => clean(item.output_key) === slot.key);
    if (!output) {
      if (slot.required !== false)
        throw new HttpError(409, { error: 'runner_required_output_missing', output_key: slot.key });
      continue;
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
    const repositorySha = repositoryShaFor(slot, actualEvidence, output);
    const version = await createImmutableAssetVersion(state, {
      asset,
      payload: trustedPayloadForSlot(slot, output.payload, actualEvidence),
      title: asset.title,
      summary: asset.summary,
      evidenceRefs: evidenceRefs(actualEvidence, output),
      repositorySha,
      provenance: {
        source: 'task_execution',
        workflow_execution_id: taskExecution.workflow_execution_id,
        task_execution_id: taskExecution.id,
        executor: taskExecution.executor,
        output_key: slot.key,
        input_snapshot_hash: taskExecution.input_snapshot_hash,
        consumed_inputs: consumption.byOutput.get(slot.key) || [],
        context_selection_id: contextConsumption.selectionId,
        context_selection_ids: contextConsumption.selectionIdsByOutput.get(slot.key) || [],
        consumed_context_document_versions: contextConsumption.byOutput.get(slot.key) || []
      },
      actorId,
      outputKey: slot.key
    });
    created.push({ asset, version, slot });
  }
  taskExecution.consumed_inputs = consumption.aggregate;
  taskExecution.context_selection_id = contextConsumption.selectionId;
  taskExecution.context_selection_ids = contextConsumption.selectionIds;
  taskExecution.consumed_context_document_versions = contextConsumption.aggregate;
  taskExecution.status = 'verifying';
  taskExecution.updated_at = now();

  for (const item of created.filter(({ slot }) => slot.confirmation_policy === 'system_evidence')) {
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
  const human = created.filter(({ slot }) => slot.confirmation_policy === 'human');
  if (human.length) taskExecution.status = 'awaiting_human';
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

export async function attestAssetVersionInState(state, input) {
  const normalized = normalizeAttestationInput(input);
  const context = resolveAttestationContext(state, normalized);
  const { asset, version, execution, key, slot, confirmationPolicy } = context;
  await verifyAcceptedVersion(state, version, normalized.decision, normalized.casRoot);
  const existing = findExistingAttestation(state, context, normalized);
  if (existing) return { attestation: existing, asset, version, idempotent: true };
  const criteria = slot?.acceptance_criteria || asset.acceptance_criteria || [];
  const acceptanceResults = buildAcceptanceResults(criteria, version, normalized);
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
      item.expected_sha256 === input.expectedSha256
  );
}

function buildAcceptanceResults(criteria, version, input) {
  return criteria.map((criterion) => ({
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
  const { asset, version, execution, key, confirmationPolicy } = context;
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
      attestation_id: attestation.id
    });
  execution.output_bindings = outputBindings;
  execution.acceptance_results = mergeAcceptanceResults(execution.acceptance_results, acceptanceResults, key);
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
      const consumed = (execution.consumed_inputs || []).includes(versionId);
      consumers.push({
        type: consumed ? 'task_execution' : 'task_execution_input',
        id: execution.id,
        workflow_execution_id: execution.workflow_execution_id,
        task_id: execution.task_id,
        status: execution.status,
        consumption_status: consumed ? 'consumed' : 'prepared',
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
function normalizeConsumedInputs(execution, outputs, declaredAggregate = null) {
  const available = [
      ...new Set(
        (execution.context_snapshot?.inputs || [])
          .flatMap((item) => item.asset_versions || [])
          .map((item) => item.version_id)
      )
    ].sort(),
    availableSet = new Set(available),
    required = [
      ...new Set(
        (execution.context_snapshot?.inputs || [])
          .filter((item) => item.required !== false)
          .flatMap((item) => item.asset_versions || [])
          .map((item) => item.version_id)
      )
    ].sort(),
    byOutput = new Map();
  for (const output of outputs) {
    const key = clean(output?.output_key),
      declared = [
        ...new Set(Array.isArray(output?.consumed_input_versions) ? output.consumed_input_versions : [])
      ].sort(),
      invalid = declared.filter((versionId) => !availableSet.has(versionId));
    if (invalid.length)
      throw new HttpError(409, {
        error: 'runner_consumed_inputs_mismatch',
        source: `output:${key || 'unknown'}`,
        available_version_ids: available,
        invalid_version_ids: invalid
      });
    byOutput.set(key, declared);
  }
  const aggregate = [...new Set([...byOutput.values()].flat())].sort(),
    missingRequired = required.filter((versionId) => !aggregate.includes(versionId));
  if (missingRequired.length)
    throw new HttpError(409, {
      error: 'runner_required_inputs_unconsumed',
      required_version_ids: required,
      missing_version_ids: missingRequired
    });
  if (declaredAggregate !== null)
    assertConsumedSet(
      aggregate,
      [...new Set(Array.isArray(declaredAggregate) ? declaredAggregate : [])].sort(),
      'aggregate'
    );
  return { aggregate, byOutput };
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

function normalizeConsumedContextDocuments(state, execution, outputs, declaredAggregate = null, nodeRunId = null) {
  const context = execution.context_snapshot || {},
    selectionId = context.system_context?.context_selection_id || null,
    entries = context.system_context?.document_versions || [],
    declarationProvided =
      declaredAggregate !== null ||
      outputs.some((output) => Object.hasOwn(output || {}, 'consumed_context_document_versions')),
    byOutput = new Map(outputs.map((output) => [clean(output?.output_key), []])),
    selectionIdsByOutput = new Map(outputs.map((output) => [clean(output?.output_key), []]));
  if (!declarationProvided) return { aggregate: [], byOutput, selectionId, selectionIds: [], selectionIdsByOutput };
  const { availableByVersion, staleDynamicVersions } = availableContextDocumentVersions(
      state,
      execution,
      nodeRunId,
      selectionId,
      entries
    ),
    aggregate = normalizeOutputContextConsumption({
      state,
      outputs,
      selectionId,
      availableByVersion,
      staleDynamicVersions,
      byOutput,
      selectionIdsByOutput
    });
  assertRequiredContextConsumption(entries, aggregate);
  assertDeclaredContextAggregate(aggregate, declaredAggregate);
  const selectionIds = orderedContextSelectionIds(
    state,
    new Set([...selectionIdsByOutput.values()].flat()),
    selectionId
  );
  return { aggregate, byOutput, selectionId, selectionIds, selectionIdsByOutput };
}

function availableContextDocumentVersions(state, execution, nodeRunId, selectionId, entries) {
  const selection = state.context_selections.find((item) => item.id === selectionId);
  if (!selection || (selection.project_id && selection.project_id !== execution.project_id))
    throw new HttpError(409, { error: 'runner_context_selection_invalid', context_selection_id: selectionId });
  const includedByVersion = new Map((selection.included || []).map((item) => [item.document_version_id, item])),
    availableByVersion = new Map(),
    staleDynamicVersions = new Map();
  addInitialContextDocumentVersions(state, entries, selectionId, includedByVersion, availableByVersion);
  addRuntimeContextDocumentVersions(state, execution, nodeRunId, selectionId, availableByVersion, staleDynamicVersions);
  return { availableByVersion, staleDynamicVersions };
}

function addInitialContextDocumentVersions(state, entries, selectionId, includedByVersion, availableByVersion) {
  for (const entry of entries) {
    const included = includedByVersion.get(entry.document_version_id),
      version = state.context_document_versions.find((item) => item.id === entry.document_version_id),
      node = state.context_nodes.find((item) => item.id === entry.node_id);
    if (
      !included ||
      !version ||
      included.node_id !== entry.node_id ||
      version.node_id !== entry.node_id ||
      included.content_sha256 !== entry.content_sha256 ||
      version.content_sha256 !== entry.content_sha256
    )
      throw new HttpError(409, {
        error: 'runner_context_selection_invalid',
        context_selection_id: selectionId,
        document_version_id: entry.document_version_id
      });
    if (
      entry.required === true &&
      (!node || node.current_version_id !== version.id || node.source_hash !== version.source_hash)
    )
      throw new HttpError(409, {
        error: 'runner_required_context_stale',
        node_id: entry.node_id,
        document_version_id: entry.document_version_id,
        current_document_version_id: node?.current_version_id || null
      });
    availableByVersion.set(entry.document_version_id, {
      node_id: entry.node_id,
      content_sha256: entry.content_sha256,
      selection_ids: [selectionId],
      source: 'initial'
    });
  }
}

function addRuntimeContextDocumentVersions(
  state,
  execution,
  nodeRunId,
  selectionId,
  availableByVersion,
  staleDynamicVersions
) {
  for (const runtimeSelection of runtimeReadSelections(state, execution, nodeRunId, selectionId)) {
    const runtime = runtimeSelection.runtime_context,
      version = state.context_document_versions.find(
        (item) => item.id === runtime.read_document_version_id && item.node_id === runtime.read_node_id
      ),
      node = state.context_nodes.find((item) => item.id === runtime.read_node_id),
      included = runtimeSelection.included?.find(
        (item) => item.node_id === runtime.read_node_id && item.document_version_id === runtime.read_document_version_id
      );
    if (!version || !node || !included || included.content_sha256 !== version.content_sha256) continue;
    if (node.current_version_id !== version.id || node.source_hash !== version.source_hash) {
      staleDynamicVersions.set(version.id, {
        node_id: node.id,
        current_document_version_id: node.current_version_id || null
      });
      continue;
    }
    const existing = availableByVersion.get(version.id);
    if (existing?.source === 'initial') continue;
    if (existing) existing.selection_ids.push(runtimeSelection.id);
    else
      availableByVersion.set(version.id, {
        node_id: node.id,
        content_sha256: version.content_sha256,
        selection_ids: [runtimeSelection.id],
        source: 'runtime_read'
      });
  }
}

function normalizeOutputContextConsumption({
  state,
  outputs,
  selectionId,
  availableByVersion,
  staleDynamicVersions,
  byOutput,
  selectionIdsByOutput
}) {
  const available = [...availableByVersion.keys()].sort(),
    availableSet = new Set(available);
  for (const output of outputs) {
    const key = clean(output?.output_key);
    if (!Array.isArray(output?.consumed_context_document_versions))
      throw new HttpError(409, { error: 'runner_consumed_context_declaration_required', output_key: key || null });
    const declared = [...new Set(output.consumed_context_document_versions)].sort(),
      invalid = declared.filter((versionId) => !availableSet.has(versionId));
    const stale = invalid.find((versionId) => staleDynamicVersions.has(versionId));
    if (stale) {
      const detail = staleDynamicVersions.get(stale);
      throw new HttpError(409, {
        error: 'runner_context_document_stale',
        node_id: detail.node_id,
        document_version_id: stale,
        current_document_version_id: detail.current_document_version_id
      });
    }
    if (invalid.length)
      throw new HttpError(409, {
        error: 'runner_consumed_context_mismatch',
        source: `output:${key || 'unknown'}`,
        available_document_version_ids: available,
        invalid_document_version_ids: invalid
      });
    byOutput.set(key, declared);
    selectionIdsByOutput.set(
      key,
      orderedContextSelectionIds(
        state,
        new Set(declared.flatMap((versionId) => availableByVersion.get(versionId)?.selection_ids || [])),
        selectionId
      )
    );
  }
  return [...new Set([...byOutput.values()].flat())].sort();
}

function assertRequiredContextConsumption(entries, aggregate) {
  const required = [
      ...new Set(entries.filter((item) => item.required === true).map((item) => item.document_version_id))
    ].sort(),
    missingRequired = required.filter((versionId) => !aggregate.includes(versionId));
  if (missingRequired.length)
    throw new HttpError(409, {
      error: 'runner_required_context_unconsumed',
      required_document_version_ids: required,
      missing_document_version_ids: missingRequired
    });
}

function assertDeclaredContextAggregate(aggregate, declaredAggregate) {
  if (declaredAggregate === null) return;
  const actual = [...new Set(Array.isArray(declaredAggregate) ? declaredAggregate : [])].sort();
  if (actual.length !== aggregate.length || actual.some((item, index) => item !== aggregate[index]))
    throw new HttpError(409, {
      error: 'runner_consumed_context_mismatch',
      source: 'aggregate',
      expected_document_version_ids: aggregate,
      actual_document_version_ids: actual
    });
}

function runtimeReadSelections(state, execution, nodeRunId, initialSelectionId) {
  if (!nodeRunId) return [];
  const run = state.node_runs.find(
    (item) =>
      item.id === nodeRunId && item.task_execution_id === execution.id && item.project_id === execution.project_id
  );
  if (!run) throw new HttpError(409, { error: 'runner_context_run_invalid', node_run_id: nodeRunId });
  return state.context_selections.filter((selection) => {
    const runtime = selection.runtime_context;
    if (
      runtime?.schema_version !== 'aiws.context_runtime_selection.v1' ||
      runtime.purpose !== 'mcp_read' ||
      runtime.run_id !== nodeRunId ||
      runtime.task_execution_id !== execution.id ||
      runtime.initial_context_selection_id !== initialSelectionId ||
      selection.project_id !== execution.project_id ||
      !runtime.read_document_version_id
    )
      return false;
    const client = state.mcp_clients.find((item) => item.id === runtime.mcp_client_id),
      binding = client?.context_binding;
    return (
      client?.kind === 'internal_codex' &&
      binding?.schema_version === 'aiws.mcp_context_binding.v1' &&
      binding.project_id === execution.project_id &&
      binding.session_id === runtime.session_id &&
      binding.run_id === nodeRunId &&
      binding.task_execution_id === execution.id &&
      binding.context_selection_id === initialSelectionId
    );
  });
}

function orderedContextSelectionIds(state, values, initialSelectionId) {
  return [...values].sort((left, right) => {
    if (left === initialSelectionId) return -1;
    if (right === initialSelectionId) return 1;
    const leftSelection = state.context_selections.find((item) => item.id === left),
      rightSelection = state.context_selections.find((item) => item.id === right);
    return (
      String(leftSelection?.created_at || '').localeCompare(String(rightSelection?.created_at || '')) ||
      String(left).localeCompare(String(right))
    );
  });
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
