import { HttpError } from './http.mjs';
import { normalizeIdList } from './task-handoff.mjs';

export function resolveAttestationEffectClaims(execution, outputKey, input) {
  if (execution?.effects_schema_version !== 'aiws.task_effects.v2' || input?.decision !== 'accepted') return [];
  const effects = effectClaimsForOutput(execution, outputKey),
    available = new Set(effects.map((item) => item.claim_id)),
    requested = normalizeIdList(input.acceptedEffectClaimIds),
    invalid = requested.filter((claimId) => !available.has(claimId));
  if (invalid.length)
    throw new HttpError(409, {
      error: 'task_effect_claim_scope_invalid',
      output_key: outputKey,
      invalid_claim_ids: invalid,
      available_claim_ids: [...available].sort()
    });
  if (input.attestorType === 'trusted_verifier' && effects.length)
    assertTrustedClaimEvidence(effects, outputKey, input);
  const accepted = input.attestorType === 'trusted_verifier' ? [...available].sort() : requested,
    acceptedSet = new Set(accepted),
    required = requiredEffectClaimIds(execution, outputKey),
    missing = required.filter((claimId) => !acceptedSet.has(claimId));
  if (missing.length)
    throw new HttpError(409, {
      error: 'task_effect_claim_acceptance_required',
      output_key: outputKey,
      missing_claim_ids: missing
    });
  return accepted;
}

export function effectClaimAcceptanceResults(execution, outputKey, input) {
  const accepted = new Set(normalizeIdList(input?.acceptedEffectClaimIds)),
    outputVersion = input?.outputVersion,
    outputEvidenceRefs = verifiedOutputEvidenceRefs(outputVersion, input?.evidence);
  return effectClaimsForOutput(execution, outputKey)
    .filter((effect) => accepted.has(effect.claim_id))
    .map((effect) => ({
      claim_id: effect.claim_id,
      status: 'accepted',
      source_type: effect.input_key ? 'input' : 'context',
      input_key: effect.input_key || null,
      document_version_id: effect.document_version_id || null,
      contribution_id: effect.contribution_id || null,
      source_receipts: normalizeIdList(effect.source_receipts),
      output_key: outputKey,
      output_version_id: outputVersion?.id || null,
      output_content_sha256: outputVersion?.content_sha256 || null,
      criterion_ids: normalizeIdList(effect.criterion_ids),
      output_evidence_refs: outputEvidenceRefs,
      attestor_type: input.attestorType,
      attestor_id: input.attestorId
    }));
}

export function effectClaimsForOutput(execution, outputKey) {
  return [...(execution?.input_effects || []), ...(execution?.context_effects || [])]
    .filter((effect) => effect?.claim_id && (effect.output_keys || []).includes(outputKey))
    .sort((left, right) => left.claim_id.localeCompare(right.claim_id));
}

export function validateRequestedEffectClaims(execution, values) {
  const requested = normalizeIdList(values),
    available = new Set(
      [...(execution?.input_effects || []), ...(execution?.context_effects || [])]
        .map((effect) => effect?.claim_id)
        .filter(Boolean)
    ),
    invalid = requested.filter((claimId) => !available.has(claimId));
  if (invalid.length)
    throw new HttpError(409, {
      error: 'task_effect_claim_scope_invalid',
      invalid_claim_ids: invalid,
      available_claim_ids: [...available].sort()
    });
  return requested;
}

function assertTrustedClaimEvidence(effects, outputKey, input) {
  const missingSourceReceipts = effects
      .filter((effect) => !normalizeIdList(effect.source_receipts).length)
      .map((effect) => effect.claim_id),
    outputEvidenceRefs = verifiedOutputEvidenceRefs(input?.outputVersion, input?.evidence);
  if (!missingSourceReceipts.length && outputEvidenceRefs.length) return;
  throw new HttpError(409, {
    error: 'task_effect_claim_evidence_required',
    output_key: outputKey,
    missing_source_receipt_claim_ids: missingSourceReceipts,
    output_evidence_required: outputEvidenceRefs.length === 0
  });
}

function verifiedOutputEvidenceRefs(version, evidence) {
  const commands = Array.isArray(evidence?.commands)
    ? evidence.commands
    : Array.isArray(evidence?.test_results)
      ? evidence.test_results
      : [];
  return normalizeIdList([
    ...(version?.evidence_refs || []),
    ...(evidence?.repository_sha ? [`commit:${evidence.repository_sha}`] : []),
    ...(evidence?.commit_sha ? [`commit:${evidence.commit_sha}`] : []),
    ...(evidence?.external_snapshot_sha256 ? [`snapshot:${evidence.external_snapshot_sha256}`] : []),
    ...commands.map((item) => (item?.log_sha256 ? `cas:${item.log_sha256}` : null))
  ]);
}

function requiredEffectClaimIds(execution, outputKey) {
  const requiredContributions = new Set(
      (execution?.context_snapshot?.input_effect_obligations || [])
        .filter(
          (item) =>
            item.application_policy === 'required' &&
            item.contribution?.id &&
            (item.contribution.target_output_keys || []).includes(outputKey)
        )
        .map((item) => item.contribution.id)
    ),
    requiredContextDocuments = new Set(
      (execution?.context_snapshot?.system_context?.document_versions || [])
        .filter((item) => item.required === true || item.consumption_policy === 'must_use')
        .map((item) => item.document_version_id)
    );
  return normalizeIdList(
    [
      ...(execution?.input_effects || []).filter(
        (effect) => requiredContributions.has(effect.contribution_id) && (effect.output_keys || []).includes(outputKey)
      ),
      ...(execution?.context_effects || []).filter(
        (effect) =>
          requiredContextDocuments.has(effect.document_version_id) && (effect.output_keys || []).includes(outputKey)
      )
    ].map((effect) => effect.claim_id)
  );
}
