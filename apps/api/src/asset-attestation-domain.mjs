import { id, now } from '../../../packages/shared/index.mjs';
import { acceptanceCriterionId } from '../../../packages/shared/src/task-contributions.mjs';
import { verifyAssetVersionPayload } from './asset-cas.mjs';
import { assertDeploymentSystemEvidence, DEPLOYMENT_RUNTIME_VERIFIER } from './deployment-evidence-attestation.mjs';
import { HttpError } from './http.mjs';
import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { updateAcceptedContributions } from './task-contribution-authority.mjs';
import { effectClaimAcceptanceResults, resolveAttestationEffectClaims } from './task-effect-claims.mjs';
import { recordAssetLineage } from './task-output-service.mjs';

export const TRUSTED_VERIFIERS = Object.freeze(
  new Set([
    'repository_change_verifier',
    'repository_verify_verifier',
    'repository_integrate_verifier',
    DEPLOYMENT_RUNTIME_VERIFIER,
    'aiws_cas_verifier'
  ])
);

export async function attestAssetVersionInState(state, input) {
  const normalized = normalizeAttestationInput(input);
  const context = resolveAttestationContext(state, normalized);
  const { asset, version, execution, key, slot } = context;
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
  const { asset, version } = requireCurrentAssetVersion(state, input);
  assertAttestationDecision(input.decision);
  const execution = resolveAttestationExecution(state, asset, input.taskExecutionId);
  const key = input.outputKey || asset.output_key || version.output_key;
  const slot = executionOutputSlot(state, execution, key);
  const confirmationPolicy = slot?.confirmation_policy || asset.confirmation_policy || 'human';
  assertAttestorAuthorized(input, confirmationPolicy);
  if (confirmationPolicy === 'system_evidence')
    assertSystemEvidence(state, slot, asset, version, input.evidence, execution);
  input.acceptedEffectClaimIds = resolveAttestationEffectClaims(execution, key, { ...input, outputVersion: version });
  return { asset, version, execution, key, slot, confirmationPolicy };
}

function requireCurrentAssetVersion(state, input) {
  const asset = state.assets.find((item) => item.id === input.assetId);
  const version = state.asset_versions.find((item) => item.id === input.versionId && item.asset_id === input.assetId);
  if (!asset || !version) throw new HttpError(404, { error: 'asset_version_not_found' });
  if (asset.current_version_id !== version.id)
    throw new HttpError(409, { error: 'asset_version_superseded', current_version_id: asset.current_version_id });
  if (!input.expectedSha256 || input.expectedSha256 !== version.content_sha256)
    throw new HttpError(409, {
      error: 'asset_version_hash_mismatch',
      expected_sha256: input.expectedSha256 || null,
      actual_sha256: version.content_sha256
    });
  return { asset, version };
}

function assertAttestationDecision(decision) {
  if (!['accepted', 'rejected'].includes(decision))
    throw new HttpError(400, { error: 'asset_attestation_decision_invalid' });
}

function resolveAttestationExecution(state, asset, taskExecutionId) {
  const execution = taskExecutionId ? state.task_executions.find((item) => item.id === taskExecutionId) : null;
  if (taskExecutionId && (!execution || asset.task_execution_id !== execution.id))
    throw new HttpError(409, { error: 'asset_task_execution_mismatch' });
  return execution;
}

function executionOutputSlot(state, execution, key) {
  if (!execution) return null;
  const contract = state.node_contracts.find((item) => item.id === execution.contract_id);
  return contract?.expected_outputs?.find((item) => item.key === key) || null;
}

function assertAttestorAuthorized(input, confirmationPolicy) {
  if (confirmationPolicy === 'system_evidence') {
    if (input.attestorType !== 'trusted_verifier' || !TRUSTED_VERIFIERS.has(input.attestorId))
      throw new HttpError(403, { error: 'trusted_verifier_required' });
    return;
  }
  if (input.attestorType !== 'human') throw new HttpError(403, { error: 'human_attestor_required' });
  if (input.attestorType === 'trusted_verifier' && !TRUSTED_VERIFIERS.has(input.attestorId))
    throw new HttpError(403, { error: 'trusted_verifier_unknown' });
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
    effect_acceptance_results: effectClaimAcceptanceResults(execution, key, { ...input, outputVersion: version }),
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
    outputBindings.push(
      acceptedOutputBindingSnapshot(asset, version, key, slot, confirmationPolicy, attestation, criteria)
    );
  execution.output_bindings = outputBindings;
  execution.acceptance_results = mergeAcceptanceResults(execution.acceptance_results, acceptanceResults, key);
  updateAcceptedContributions(execution);
  execution.updated_at = now();
  recordAssetLineage(state, execution.context_snapshot, execution.output_bindings, execution.id);
}

function acceptedOutputBindingSnapshot(asset, version, key, slot, confirmationPolicy, attestation, criteria) {
  return {
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
  };
}

function assertSystemEvidence(state, slot, asset, version, evidence, execution) {
  if (/WorkstreamOutcome/i.test(asset.asset_type)) return assertWorkstreamOutcomeEvidence(state, version, evidence);
  if (!execution || execution.input_superseded)
    throw new HttpError(409, { error: 'system_evidence_execution_invalid' });
  if (/DeliveryEvidence/i.test(asset.asset_type))
    return assertDeploymentSystemEvidence(state, asset, version, evidence, execution);
  const repositorySha = evidence.repository_sha || evidence.commit_sha || version.repository_sha;
  const commands = evidenceCommands(evidence);
  if (/TestReport|TestEvidence/i.test(asset.asset_type)) assertTestEvidence(state, repositorySha, commands);
  else if (/RepositoryVersion|CodeChange/i.test(asset.asset_type)) assertRepositoryEvidence(repositorySha, evidence);
  else if (!commands.length && !repositorySha && !evidence.external_snapshot_sha256)
    throw new HttpError(409, { error: 'system_evidence_incomplete' });
  if (slot && slot.confirmation_policy !== 'system_evidence')
    throw new HttpError(409, { error: 'system_evidence_policy_mismatch' });
}

function assertWorkstreamOutcomeEvidence(state, version, evidence) {
  const terminalBindings = Array.isArray(evidence.terminal_output_bindings) ? evidence.terminal_output_bindings : [];
  const handoffBindings = Array.isArray(evidence.handoff_output_bindings)
    ? evidence.handoff_output_bindings
    : terminalBindings;
  if (
    !evidence.workflow_execution_id ||
    !terminalBindings.length ||
    !handoffBindings.length ||
    evidence.external_snapshot_sha256 !== version.content_sha256
  )
    throw new HttpError(409, { error: 'workstream_outcome_evidence_incomplete' });
  const invalidTerminal = terminalBindings.some(
    (binding) => !acceptedOutputBinding(state, binding, evidence.workflow_execution_id)
  );
  const invalidHandoff = handoffBindings.some(
    (binding) =>
      !terminalBindings.some(
        (candidate) => candidate.asset_id === binding.asset_id && candidate.version_id === binding.version_id
      )
  );
  if (invalidTerminal || invalidHandoff) throw new HttpError(409, { error: 'workstream_outcome_source_invalid' });
}

function evidenceCommands(evidence) {
  if (Array.isArray(evidence.commands)) return evidence.commands;
  return Array.isArray(evidence.test_results) ? evidence.test_results : [];
}

function assertTestEvidence(state, repositorySha, commands) {
  if (!repositorySha || !commands.length) throw new HttpError(409, { error: 'test_evidence_incomplete' });
  const invalidCommand = commands.some(
    (item) => Number(item.exit_code) !== 0 || !item.command || !(item.log_sha256 || item.raw_log_sha256)
  );
  if (invalidCommand) throw new HttpError(409, { error: 'test_evidence_command_invalid' });
  const missingBlob = commands.some(
    (item) => !state.asset_blobs.some((blob) => blob.sha256 === (item.log_sha256 || item.raw_log_sha256))
  );
  if (missingBlob) throw new HttpError(409, { error: 'test_evidence_log_blob_missing' });
}

function assertRepositoryEvidence(repositorySha, evidence) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(String(repositorySha || '')))
    throw new HttpError(409, { error: 'repository_evidence_sha_invalid' });
  if (
    (evidence.checkout_head && evidence.checkout_head !== repositorySha) ||
    (evidence.commit_sha && evidence.commit_sha !== repositorySha)
  )
    throw new HttpError(409, { error: 'repository_evidence_sha_mismatch' });
}

function acceptedOutputBinding(state, binding, workflowExecutionId) {
  const asset = state.assets.find(
    (item) =>
      item.id === binding?.asset_id && item.current_version_id === binding?.version_id && item.status === 'confirmed'
  );
  const version = state.asset_versions.find(
    (item) =>
      item.id === binding?.version_id &&
      item.asset_id === asset?.id &&
      item.verification_status === 'verified' &&
      item.immutable === true
  );
  const attestation = state.asset_attestations.find(
    (item) =>
      item.asset_version_id === version?.id &&
      item.decision === 'accepted' &&
      (item.confirmation_policy !== 'system_evidence' || item.attestor_type === 'trusted_verifier')
  );
  const execution = asset?.task_execution_id
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

function normalizeIdList(values) {
  return [
    ...new Set((values || []).filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))
  ].sort();
}

function mergeAcceptanceResults(current, values, outputKey) {
  return [
    ...(current || []).filter((item) => item.output_key !== outputKey),
    ...values.map((item) => ({ ...item, output_key: outputKey }))
  ];
}

function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
