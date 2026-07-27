import { compactContextMap, contextHash, createContextSelection } from '../../../packages/system-context/src/index.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { readCasBlob } from './asset-cas.mjs';
import { HttpError } from './http.mjs';
import { assertProjectRead } from './project-governance-v19.mjs';
import { mutate } from './state.mjs';

export async function createRuntimeSearchSelection({
  request,
  binding,
  projectId,
  candidateNodeIds,
  explicitRefs,
  candidateRanks,
  requestedTokenBudget
}) {
  return mutate((state) => {
    const { client, binding: currentBinding } = assertRuntimeContextClient(state, request, binding);
    if (currentBinding.project_id !== projectId)
      throw new HttpError(403, { error: 'context_runtime_project_mismatch', project_id: projectId });
    assertProjectRead(state, projectId, client.subject_user_id);
    const usage = runtimeContextBudgetUsage(state, currentBinding),
      tokenBudget = requestedRuntimeTokenBudget(requestedTokenBudget, usage.remaining),
      selection = createContextSelection(state, {
        id: id('csel'),
        actorId: client.subject_user_id,
        sessionId: runtimePolicySessionId(state, currentBinding),
        projectId,
        anchorNodeId: currentBinding.anchor_node_id,
        candidateNodeIds,
        tokenBudget,
        scopes: client.scopes,
        allowedProjectIds: [projectId],
        explicitRefs,
        candidateRanks,
        alreadyBudgetedDocumentVersionIds: [...usage.budgetedVersionIds],
        timestamp: now()
      });
    selection.runtime_context = runtimeSelectionMetadata({
      purpose: 'mcp_search',
      client,
      binding: currentBinding,
      parentSelectionId: currentBinding.context_selection_id,
      usage,
      selection
    });
    state.context_selections.push(selection);
    return selection;
  });
}

export async function createRuntimeReadSelection({
  request,
  binding,
  nodeId,
  requestedVersionId,
  approvedSelectionId
}) {
  const outcome = await mutate((state) => {
    const { client, binding: currentBinding } = assertRuntimeContextClient(state, request, binding),
      node = state.context_nodes.find((item) => item.id === nodeId);
    assertProjectRead(state, currentBinding.project_id, client.subject_user_id);
    assertRuntimeNodeAccess(node, currentBinding, client.scopes);
    const version = state.context_document_versions.find(
      (item) => item.id === node.current_version_id && item.node_id === node.id
    );
    if (!version || version.source_hash !== node.source_hash)
      throw new HttpError(503, { error: 'context_projection_unavailable', node_id: node.id });
    assertRequestedVersion(node, version, requestedVersionId);
    if (approvedSelectionId)
      assertRuntimeReadApproval(state, {
        selectionId: approvedSelectionId,
        node,
        version,
        binding: currentBinding,
        clientId: client.id
      });

    const usage = runtimeContextBudgetUsage(state, currentBinding),
      selection = exactRuntimeSelection(state, {
        client,
        binding: currentBinding,
        node,
        usage
      }),
      included = selection.included.find((item) => item.node_id === node.id && item.document_version_id === version.id);
    selection.runtime_context = runtimeSelectionMetadata({
      purpose: included ? 'mcp_read_approved' : 'mcp_read_denied',
      client,
      binding: currentBinding,
      parentSelectionId: approvedSelectionId || currentBinding.context_selection_id,
      usage,
      selection,
      readNodeId: node.id,
      readDocumentVersionId: included?.document_version_id || null
    });
    state.context_selections.push(selection);
    return {
      selection,
      document_version_id: included?.document_version_id || null,
      exclusion: selection.excluded.find((item) => item.node_id === node.id) || null
    };
  });
  if (!outcome.document_version_id)
    throw new HttpError(409, {
      error: 'context_runtime_read_not_approved',
      context_selection_id: outcome.selection.id,
      node_id: nodeId,
      reason: outcome.exclusion?.reason || 'selection_excluded'
    });
  return outcome;
}

export async function createRuntimeReadReceipt({ request, binding, approvalSelectionId, nodeId, documentVersionId }) {
  return mutate((state) => {
    const { client, binding: currentBinding } = assertRuntimeContextClient(state, request, binding),
      node = state.context_nodes.find((item) => item.id === nodeId),
      version = state.context_document_versions.find(
        (item) => item.id === documentVersionId && item.node_id === nodeId
      ),
      approval = state.context_selections.find((item) => item.id === approvalSelectionId);
    assertCurrentRuntimeDocument(node, version, currentBinding, documentVersionId);
    assertReadApprovalReceipt(approval, {
      client,
      binding: currentBinding,
      nodeId,
      documentVersionId,
      approvalSelectionId
    });
    const usage = runtimeContextBudgetUsage(state, currentBinding),
      receipt = exactRuntimeSelection(state, {
        client,
        binding: currentBinding,
        node,
        usage
      }),
      included = receipt.included.find((item) => item.node_id === node.id && item.document_version_id === version.id);
    if (!included)
      throw new HttpError(409, {
        error: 'context_runtime_read_receipt_invalid',
        node_id: node.id,
        document_version_id: version.id
      });
    receipt.runtime_context = runtimeSelectionMetadata({
      purpose: 'mcp_read',
      client,
      binding: currentBinding,
      parentSelectionId: approvalSelectionId,
      usage,
      selection: receipt,
      readNodeId: node.id,
      readDocumentVersionId: version.id
    });
    state.context_selections.push(receipt);
    return receipt;
  });
}

export function runtimeContextBinding(state, request) {
  const clientId = contextRequestClientId(request);
  if (!clientId) return null;
  const client = state.mcp_clients?.find((item) => item.id === clientId);
  return client?.kind === 'internal_codex' && client.context_binding?.schema_version === 'aiws.mcp_context_binding.v1'
    ? client.context_binding
    : null;
}

export function contextRequestProjectAllowlist(request) {
  const value = (request.req || request)?.auth?.extra?.project_allowlist;
  return normalizeArray(value);
}

export function compactRuntimeMap(state, projectId, rootSourceId = null) {
  const nodes = (state.context_nodes || []).filter((node) => node.project_id === projectId),
    projectNode = nodes.find((node) => node.source_collection === 'projects' && node.source_id === projectId),
    anchor = rootSourceId ? nodes.find((node) => node.source_id === rootSourceId) : null;
  return {
    uri: `aiws://context/map/projects/${encodeURIComponent(projectId)}`,
    snapshot_hash: contextHash(
      nodes.map((node) => [node.id, node.source_hash, node.current_version_id, node.parent_id, node.status])
    ),
    anchor_node_id: anchor?.id || projectNode?.id || null,
    markdown: compactContextMap(nodes, { rootId: projectNode?.id || 'ctx_root_system', maxDepth: 3, maxNodes: 120 })
  };
}

export async function loadContextSelectionDocumentsInState(state, selection) {
  const documents = [];
  for (const included of selection?.included || []) {
    const node = state.context_nodes.find((item) => item.id === included.node_id),
      version = state.context_document_versions.find(
        (item) => item.id === included.document_version_id && item.node_id === included.node_id
      );
    if (!node || !version || version.content_sha256 !== included.content_sha256)
      throw new HttpError(503, { error: 'context_projection_unavailable', node_id: included.node_id });
    const markdown = await readSelectionMarkdown(version, included);
    documents.push({
      node_id: node.id,
      uri: node.uri,
      title: node.title,
      summary: node.deterministic_summary,
      document_version_id: version.id,
      content_sha256: version.content_sha256,
      token_estimate: version.token_estimate,
      markdown
    });
  }
  return documents;
}

async function readSelectionMarkdown(version, included) {
  let markdown;
  try {
    markdown = (await readCasBlob(version.cas_ref)).toString('utf8');
  } catch (error) {
    throw new HttpError(503, {
      error: 'context_projection_unavailable',
      node_id: included.node_id,
      reason: error.code || error.message
    });
  }
  if (contextHash(Buffer.from(markdown, 'utf8')) !== included.content_sha256)
    throw new HttpError(503, {
      error: 'context_projection_unavailable',
      node_id: included.node_id,
      reason: 'hash_mismatch'
    });
  return markdown;
}

function exactRuntimeSelection(state, { client, binding, node, usage }) {
  return createContextSelection(state, {
    id: id('csel'),
    actorId: client.subject_user_id,
    sessionId: runtimePolicySessionId(state, binding),
    projectId: binding.project_id,
    anchorNodeId: binding.anchor_node_id,
    candidateNodeIds: [node.id],
    tokenBudget: usage.remaining,
    scopes: client.scopes,
    allowedProjectIds: [binding.project_id],
    explicitRefs: [node.id],
    candidateRanks: new Map([[node.id, 0]]),
    alreadyBudgetedDocumentVersionIds: [...usage.budgetedVersionIds],
    timestamp: now()
  });
}

function assertRuntimeNodeAccess(node, binding, scopes) {
  if (!node) throw new HttpError(404, { error: 'context_node_not_found' });
  if (node.project_id !== binding.project_id)
    throw new HttpError(403, {
      error: 'context_runtime_project_mismatch',
      node_id: node.id,
      project_id: node.project_id || null
    });
  if (node.sensitivity === 'secret') throw new HttpError(403, { error: 'context_node_sensitive' });
  const missing = (node.required_scopes || []).filter((scope) => !scopes.includes(scope));
  if (missing.length) throw new HttpError(403, { error: 'mcp_scope_required', required_scopes: missing });
}

function assertRequestedVersion(node, version, requestedVersionId) {
  if (!requestedVersionId || requestedVersionId === version.id) return;
  throw new HttpError(409, {
    error: 'context_runtime_historical_version_forbidden',
    node_id: node.id,
    requested_document_version_id: requestedVersionId,
    current_document_version_id: version.id
  });
}

function assertCurrentRuntimeDocument(node, version, binding, documentVersionId) {
  if (
    node &&
    version &&
    node.project_id === binding.project_id &&
    node.current_version_id === version.id &&
    node.source_hash === version.source_hash
  )
    return;
  throw new HttpError(409, {
    error: 'context_runtime_read_superseded',
    node_id: node?.id || null,
    document_version_id: documentVersionId,
    current_document_version_id: node?.current_version_id || null
  });
}

function assertRuntimeReadApproval(state, { selectionId, node, version, binding, clientId }) {
  const selection = state.context_selections.find((item) => item.id === selectionId);
  if (!selection || selection.project_id !== binding.project_id)
    throw new HttpError(409, { error: 'context_runtime_selection_invalid', context_selection_id: selectionId });
  const initial = selection.id === binding.context_selection_id,
    runtime = selection.runtime_context;
  if (
    !initial &&
    (!runtime ||
      runtime.schema_version !== 'aiws.context_runtime_selection.v1' ||
      runtime.mcp_client_id !== clientId ||
      runtime.run_id !== binding.run_id ||
      runtime.task_execution_id !== binding.task_execution_id ||
      !['mcp_search', 'mcp_read'].includes(runtime.purpose))
  )
    throw new HttpError(409, { error: 'context_runtime_selection_invalid', context_selection_id: selectionId });
  const included = selection.included?.find(
    (item) => item.node_id === node.id && item.document_version_id === version.id
  );
  if (!included)
    throw new HttpError(409, {
      error: 'context_runtime_selection_document_not_included',
      context_selection_id: selectionId,
      node_id: node.id,
      document_version_id: version.id
    });
}

function assertReadApprovalReceipt(approval, { client, binding, nodeId, documentVersionId, approvalSelectionId }) {
  const runtime = approval?.runtime_context,
    included = approval?.included?.some(
      (item) => item.node_id === nodeId && item.document_version_id === documentVersionId
    );
  if (
    runtime?.schema_version === 'aiws.context_runtime_selection.v1' &&
    runtime.purpose === 'mcp_read_approved' &&
    runtime.mcp_client_id === client.id &&
    runtime.run_id === binding.run_id &&
    runtime.task_execution_id === binding.task_execution_id &&
    runtime.read_node_id === nodeId &&
    runtime.read_document_version_id === documentVersionId &&
    included
  )
    return;
  throw new HttpError(409, {
    error: 'context_runtime_read_approval_invalid',
    context_selection_id: approvalSelectionId
  });
}

function runtimeSelectionMetadata({
  purpose,
  client,
  binding,
  parentSelectionId,
  usage,
  selection,
  readNodeId = null,
  readDocumentVersionId = null
}) {
  return {
    schema_version: 'aiws.context_runtime_selection.v1',
    purpose,
    mcp_client_id: client.id,
    session_id: binding.session_id,
    run_id: binding.run_id,
    task_execution_id: binding.task_execution_id,
    context_pack_id: binding.context_pack_id,
    initial_context_selection_id: binding.context_selection_id,
    parent_context_selection_id: parentSelectionId,
    read_node_id: readNodeId,
    read_document_version_id: readDocumentVersionId,
    incremental_token_budget: selection.token_budget,
    incremental_token_used: selection.token_used,
    cumulative_token_used: usage.used + selection.token_used,
    total_token_budget: usage.total
  };
}

function runtimeContextBudgetUsage(state, binding) {
  const initial = state.context_selections.find((item) => item.id === binding.context_selection_id);
  if (!initial || initial.project_id !== binding.project_id)
    throw new HttpError(409, {
      error: 'context_runtime_initial_selection_invalid',
      context_selection_id: binding.context_selection_id
    });
  const runtimeSelections = state.context_selections.filter(
      (item) =>
        item.runtime_context?.schema_version === 'aiws.context_runtime_selection.v1' &&
        item.runtime_context.session_id === binding.session_id &&
        item.runtime_context.run_id === binding.run_id &&
        item.runtime_context.task_execution_id === binding.task_execution_id
    ),
    selections = [initial, ...runtimeSelections],
    used = selections.reduce((sum, item) => sum + Math.max(0, Number(item.token_used || 0)), 0),
    total = Math.max(Number(initial.token_budget || binding.token_budget || 0), Number(initial.token_used || 0)),
    budgetedVersionIds = new Set(
      selections.flatMap((item) => (item.included || []).map((entry) => entry.document_version_id)).filter(Boolean)
    );
  return { total, used, remaining: Math.max(0, total - used), budgetedVersionIds };
}

function runtimePolicySessionId(state, binding) {
  return state.context_selections.find((item) => item.id === binding.context_selection_id)?.session_id || null;
}

function requestedRuntimeTokenBudget(value, remaining) {
  if (value == null || value === '') return remaining;
  const requested = Number(value);
  if (!Number.isInteger(requested) || requested < 1 || requested > 200_000)
    throw new HttpError(400, { error: 'context_token_budget_invalid' });
  return Math.min(requested, remaining);
}

function assertRuntimeContextClient(state, request, expectedBinding) {
  const clientId = contextRequestClientId(request),
    client = state.mcp_clients?.find((item) => item.id === clientId),
    binding = client?.context_binding;
  if (!runtimeBindingMatches(client, binding, expectedBinding))
    throw new HttpError(409, { error: 'context_runtime_binding_invalid' });
  return { client, binding };
}

function runtimeBindingMatches(client, binding, expected) {
  return Boolean(
    client &&
    client.kind === 'internal_codex' &&
    client.status === 'active' &&
    binding?.schema_version === 'aiws.mcp_context_binding.v1' &&
    binding.project_id === expected.project_id &&
    binding.session_id === expected.session_id &&
    binding.run_id === expected.run_id &&
    binding.task_execution_id === expected.task_execution_id &&
    binding.context_selection_id === expected.context_selection_id &&
    binding.context_pack_id === expected.context_pack_id
  );
}

function contextRequestClientId(request) {
  return optionalString((request.req || request)?.auth?.clientId);
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function optionalString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
