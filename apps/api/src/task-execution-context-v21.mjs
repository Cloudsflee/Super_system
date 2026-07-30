import { CONTEXT_PACK_SCHEMA, ensureContextCollections } from '../../../packages/system-context/src/index.mjs';
import { HttpError } from './http.mjs';

export function prepareV21ContextSelection(state, snapshot, task, explicitSourceRefs, requiredContextRefs) {
  ensureContextCollections(state);
  const enabled = Boolean(snapshot.outcome_contract_hash && snapshot.quality_rubric_hash);
  const mandatoryEvidenceNodeIds = state.context_nodes
    .filter((node) => requiredContextRefs.has(`${node.source_collection || ''}:${node.source_id || ''}`))
    .map((node) => node.id);
  const retrievalPlan = {
    schema_version: 'aiws.context_retrieval_plan.v1',
    strategy: 'minisearch_graph_deterministic',
    anchor: { source_collection: 'workflow_nodes', source_id: task.id },
    explicit_source_refs: explicitSourceRefs,
    rubric_criterion_ids: (snapshot.quality_rubric?.criteria || [])
      .filter((item) => item.applicable)
      .map((item) => item.id)
      .sort(),
    mandatory_evidence_node_ids: [...mandatoryEvidenceNodeIds].sort()
  };
  return {
    enabled,
    retrievalPlan,
    selectionOptions: {
      retrievalPlan,
      rubricHash: snapshot.quality_rubric_hash,
      outcomeContractHash: snapshot.outcome_contract_hash,
      mandatoryEvidenceNodeIds,
      selectionSchema: enabled ? 'aiws.context_selection.v2' : 'aiws.context_selection.v1'
    }
  };
}

export function assertMandatoryContextEvidence(selection, enabled) {
  if (!enabled || !selection.mandatory_evidence?.missing_node_ids?.length) return;
  throw new HttpError(409, {
    error: 'context_mandatory_evidence_insufficient',
    missing_node_ids: selection.mandatory_evidence.missing_node_ids,
    token_budget: selection.token_budget,
    token_used: selection.token_used
  });
}

export function applyV21ContextPackFields(contextPack, snapshot, selection, prepared) {
  const schemaVersion = prepared.enabled ? CONTEXT_PACK_SCHEMA : 'aiws.context_pack.v4';
  Object.assign(contextPack, {
    schema_version: schemaVersion,
    version: prepared.enabled ? 5 : 4,
    context_selection_id: selection.id,
    context_document_versions: selection.included.map((item) => item.document_version_id),
    retrieval_plan: prepared.retrievalPlan,
    rubric_hash: snapshot.quality_rubric_hash,
    outcome_contract_hash: snapshot.outcome_contract_hash,
    mandatory_evidence: selection.mandatory_evidence,
    document_version_bindings: selection.included.map((item) => ({
      node_id: item.node_id,
      document_version_id: item.document_version_id,
      content_sha256: item.content_sha256
    }))
  });
  Object.assign(contextPack.content_json, {
    schema_version: schemaVersion,
    retrieval_plan: prepared.retrievalPlan,
    rubric_hash: snapshot.quality_rubric_hash,
    outcome_contract_hash: snapshot.outcome_contract_hash,
    mandatory_evidence: selection.mandatory_evidence
  });
}
