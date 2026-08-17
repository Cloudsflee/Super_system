import { hashJson } from '../../crypto.mjs';

export const PACK_SCHEMA = 'aiws.context_pack.v5';

export function buildContextPack({ id, projectId, selection, documents = [], brief = null, repository = null, workflow = null, contracts = [], timestamp = new Date().toISOString(), legacySources = [] } = {}) {
  const outcomeContract = normalizeOutcomeContract(workflow, contracts);
  const qualityRubric = normalizeQualityRubric(workflow, contracts);
  const documentVersions = documents.map((document) => ({
    node_id: document.node_id,
    document_version_id: document.document_version_id,
    content_hash: document.content_hash,
    token_estimate: Number(document.token_estimate || 0),
    content: document.content
  }));
  const pack = {
    id: id || null,
    schema_version: PACK_SCHEMA,
    project_id: String(projectId),
    selection_id: selection?.id || null,
    selection_hash: selection?.selection_hash || hashJson(selection || {}),
    policy_revision: Number(selection?.policy_revision || 0),
    selection: {
      schema_version: 'aiws.context_selection.v2',
      id: selection?.id || null,
      hash: selection?.selection_hash || null,
      included: selection?.included || [],
      excluded: selection?.excluded || []
    },
    retrieval_plan: selection?.retrieval_plan || { strategy: 'explicit', token_budget: 12000 },
    document_versions: documentVersions,
    documents: documentVersions,
    brief_snapshot: brief ? { revision: Number(brief.revision || 0), content_hash: brief.content_hash || '', content: brief.content || {} } : null,
    repository_snapshot: repository ? { revision: Number(repository.revision || 0), head_sha: repository.head_sha || '', status: repository.status || '' } : null,
    workflow_snapshot: workflow ? { revision: Number(workflow.revision || 0), graph_hash: workflow.graph_hash || '', name: workflow.name || '', tasks: workflow.tasks || [] } : null,
    outcome_contract_hash: hashJson(outcomeContract),
    quality_rubric_hash: hashJson(qualityRubric),
    memory_manifest: {
      schema_version: 'aiws.memory_manifest.v1',
      brief_revision: Number(brief?.revision || 0),
      repository_revision: Number(repository?.revision || 0),
      workflow_revision: Number(workflow?.revision || 0),
      document_version_ids: documentVersions.map((item) => item.document_version_id).filter(Boolean),
      source_hashes: Object.fromEntries(documentVersions.map((item) => [item.node_id, item.content_hash])),
      outcome_contract_hash: hashJson(outcomeContract),
      quality_rubric_hash: hashJson(qualityRubric)
    },
    // The old source_ids view remains available for R4 execution references.
    sources: legacySources.map((source) => ({ id: source.id, title: source.title, path: source.path, content: source.content })),
    created_at: timestamp,
    immutable: true
  };
  return { ...pack, pack_hash: hashJson(pack) };
}

function normalizeOutcomeContract(workflow, contracts) {
  const contractByNode = new Map((contracts || []).map((item) => [String(item.node_id), item.contract || {}]));
  const nodeIds = new Set([...(workflow?.tasks || []).map((task) => String(task.id)), ...contractByNode.keys()]);
  return {
    schema_version: 'aiws.outcome_contract.v1',
    workflow_revision: Number(workflow?.revision || 0),
    requirements: [...nodeIds].sort().map((nodeId) => {
      const task = (workflow?.tasks || []).find((item) => String(item.id) === nodeId) || {};
      const contract = contractByNode.get(nodeId) || {};
      return { node_id: nodeId, acceptance: uniqueStrings([...(task.acceptance || []), ...(contract.acceptance || [])]) };
    })
  };
}
function normalizeQualityRubric(workflow, contracts) {
  const contractByNode = new Map((contracts || []).map((item) => [String(item.node_id), item.contract || {}]));
  const nodeIds = new Set([...(workflow?.tasks || []).map((task) => String(task.id)), ...contractByNode.keys()]);
  return {
    schema_version: 'aiws.quality_rubric.v1',
    workflow_revision: Number(workflow?.revision || 0),
    criteria: [...nodeIds].sort().map((nodeId) => {
      const task = (workflow?.tasks || []).find((item) => String(item.id) === nodeId) || {};
      const contract = contractByNode.get(nodeId) || {};
      const outputs = [...(task.outputs || []), ...(contract.outputs || []), ...(contract.output_slots || [])]
        .map((output) => typeof output === 'string' ? output : output?.selector || output?.name)
        .filter(Boolean);
      return { node_id: nodeId, evidence: uniqueStrings(outputs) };
    })
  };
}
function uniqueStrings(values) { return [...new Set(values.map(String).filter(Boolean))].sort(); }
