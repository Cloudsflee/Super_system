import path from 'node:path';
import { estimateTokens, id, now } from '../../../packages/shared/index.mjs';
import { cleanText } from './assist-v3-domain.mjs';
import { currentProjectWorkflow, workflowGraphSnapshot } from './workflow-graph-service.mjs';

export function createTurnContext(state, { actor, project, session, turn, attachmentIds }) {
  const created = now();
  const brief = state.project_briefs.filter((item) => item.project_id === project.id && item.status !== 'superseded').sort((a, b) => b.version - a.version)[0] || null;
  const workflow = project.status !== 'draft' && project.onboarding_state === 'confirmed' ? currentProjectWorkflow(state, project.id) : null;
  const workflowDraft = workflow ? null : state.workflow_drafts.find((item) => item.project_id === project.id && item.status !== 'activated') || null;
  const scopeContext = minimalScopeContext(state, { project, session, brief, workflow, workflowDraft });
  const assets = scopedMemoryAssets(state, session).slice(-50);
  const missing = turn.prompt ? [] : ['prompt'];
  const check = {
    id: id('csc'), project_id: project.id, workspace_id: session.workspace_id, node_id: session.node_id,
    target_type: 'assist_turn', target_id: turn.id, status: missing.length ? 'insufficient' : 'sufficient',
    missing_slots: missing, conflicts: [], stale_refs: [],
    included_memory_refs: assets.map((item) => item.current_version_id).filter(Boolean), excluded_memory_refs: [],
    token_estimate: estimateTokens(turn.prompt), token_budget: Number(project.settings?.token_budget || 12_000), created_at: created
  };
  const pack = {
    id: id('ctx'), source_workspace_id: session.workspace_id, receiver_type: 'assist_turn', receiver_name: `${turn.mode}:${turn.id}`,
    purpose: 'assist_v3_turn', version: 1, status: 'confirmed',
    content_json: {
      project: { id: project.id, title: project.title, goal: project.goal },
      scope: { type: session.scope_type, id: session.scope_id, snapshot: session.scope_snapshot || null },
      ...scopeContext, attachment_ids: attachmentIds,
      operation_reference: publicOperationReference(state.assist_operations.find((item) => item.id === turn.operation_reference_id), state)
    },
    memory_manifest: { included_asset_version_ids: assets.map((item) => item.current_version_id).filter(Boolean), digest_id: null, authority: 'confirmed_only', scope_type: session.scope_type, scope_id: session.scope_id },
    sufficiency_check_id: check.id, content_file_ref_id: null, markdown_file_ref_id: null,
    included_asset_versions: assets.map((item) => item.current_version_id).filter(Boolean), token_estimate: check.token_estimate,
    quality_check: { sufficient: !missing.length, missing_slots: missing }, confirmed_by_user_id: actor.id,
    created_at: created, updated_at: created
  };
  return { check, pack };
}

function minimalScopeContext(state, { project, session, brief, workflow, workflowDraft }) {
  if (session.scope_type === 'project') {
    const decisions = state.decisions.filter((item) => item.project_id === project.id && ['accepted', 'confirmed'].includes(item.status)).slice(-50).map((item) => ({ id: item.id, title: item.title, summary: item.summary, status: item.status }));
    return {
      brief: brief?.content || null,
      brief_ref: brief ? { id: brief.id, revision: brief.revision, version: brief.version } : null,
      global_decisions: decisions,
      ...(workflowDraft ? { workflow_draft: { id: workflowDraft.id, revision: workflowDraft.revision, nodes: workflowDraft.nodes, generation_status: workflowDraft.generation_status, route: `/projects/${project.id}/onboarding`, mutation_policy: 'direct_draft_edit', hierarchy: 'workstream_task' } } : {})
    };
  }
  if (session.scope_type === 'workflow') {
    const selected = state.workflows.find((item) => item.id === session.scope_id && item.project_id === project.id) || workflow;
    const graph = selected ? workflowGraphSnapshot(state, selected, null) : null;
    return selected && graph ? { workflow: { id: selected.id, title: selected.title, revision: graph.revision, graph, route: `/projects/${project.id}/workflow`, mutation_policy: 'change_proposal' } } : {};
  }
  const node = state.workflow_nodes.find((item) => item.id === session.scope_id), selectedWorkflow = state.workflows.find((item) => item.id === node?.workflow_id);
  if (session.scope_type === 'workstream' && node) {
    const contract = state.node_contracts.find((item) => item.id === node.current_contract_id), graph = selectedWorkflow ? workflowGraphSnapshot(state, selectedWorkflow, node.id) : null;
    return { workstream: { id: node.id, title: node.title, outcome: node.outcome, category: node.category, boundary: node.boundary, contract, task_graph: graph, repository_targets: state.repository_targets.filter((item) => item.workstream_id === node.id) } };
  }
  if (session.scope_type === 'task' && node) {
    const dependencyIds = (node.dependencies || []).map((item) => typeof item === 'string' ? item : item.node_id).filter(Boolean);
    const dependencies = dependencyIds.map((dependencyId) => {
      const dependency = state.workflow_nodes.find((item) => item.id === dependencyId);
      return { id: dependencyId, title: dependency?.title || null, status: dependency?.status || null, outputs: state.assets.filter((item) => item.node_id === dependencyId && item.status === 'confirmed').map((item) => ({ id: item.id, title: item.title, summary: item.summary, current_version_id: item.current_version_id })) };
    });
    return { task: { id: node.id, title: node.title, goal: node.goal, task_kind: node.task_kind, execution_mode: node.execution_mode, required: node.required !== false, dependencies, repository_targets: state.repository_targets.filter((item) => item.task_id === node.id) } };
  }
  return {};
}

function scopedMemoryAssets(state, session) {
  const confirmed = state.assets.filter((item) => item.project_id === session.project_id && item.status === 'confirmed');
  if (session.scope_type === 'project') return confirmed.filter((item) => !item.node_id);
  if (session.scope_type === 'task') {
    const node = state.workflow_nodes.find((item) => item.id === session.scope_id), dependencies = new Set((node?.dependencies || []).map((item) => typeof item === 'string' ? item : item.node_id));
    return confirmed.filter((item) => dependencies.has(item.node_id));
  }
  return [];
}

export function turnPrompt({ turn, session, project, contextPack, attachments }) {
  return cleanText(turn?.prompt, 100_000);
}

export function applicationAdditionalContext({ turn, session, project, contextPack, attachments }) {
  const writable = turn.code_access === 'workspace_write';
  const boundary = writable
    ? 'Code access: workspaceWrite inside the current isolated thread change batch. Do not push, publish, or modify repositories outside the current working directory. Leave all changes reviewable.'
    : `Code access: read-only (${turn.code_read_only_reason || 'read_only'}). Do not edit, create, delete, rename, apply patches, or run mutating commands.`;
  const attachmentContext = attachments.map((item) => ({
    kind: item.kind, path: item.relative_path, url: item.url, content_type: item.content_type,
    model_policy: item.model_policy, selection: item.selection
  }));
  const value = {
    schema: 'aiws.application-context.v1',
    boundary,
    project: { id: project.id, title: project.title, goal: project.goal || '', status: project.status, managed_workspace_state: project.managed_workspace_state || null },
    scope: { type: session.scope_type, id: session.scope_id },
    context_pack: contextPack?.content_json || {},
    attachments: attachmentContext,
    page: safePageContext(turn.view_context),
    clarification: clarificationContext(session.clarification_policy, turn.collaboration_mode),
    operation_reference: operationReferenceContext(contextPack, turn.operation_reference_id),
    migrated_thread_history: session.native_thread_generation === 1 ? limitedLegacyHistory(session) : null
  };
  return [{ kind: 'application', value: JSON.stringify(value) }];
}

function clarificationContext(policy, mode) {
  return {
    policy: policy === 'auto_recommend' ? 'auto_recommend' : 'ask', collaboration_mode: mode === 'plan' ? 'plan' : 'default',
    instruction: policy === 'auto_recommend'
      ? 'When a material ambiguity has exactly one clearly marked safe recommendation, prefer it. Credentials, approvals, deletion, irreversible actions, conflicts, and questions without a recommendation must still use requestUserInput.'
      : 'When a material ambiguity would change scope or outcome, use requestUserInput before proceeding. This preference does not change collaboration mode.'
  };
}

function operationReferenceContext(contextPack, referenceId) {
  if (!referenceId) return null;
  return { ...(contextPack?.content_json?.operation_reference || {}), operation_reference_id: referenceId, instruction: 'Apply the requested follow-up to this exact prior operation target. Do not infer a different target.' };
}
function publicOperationReference(item, state) { const proposal = item?.proposal_id ? state?.change_proposals?.find((entry) => entry.id === item.proposal_id) : null; return item ? { operation_reference_id: item.id, capability_id: item.capability_id || null, action: item.action || null, result_kind: item.result_kind || null, proposal_id: item.proposal_id || null, proposal_status: proposal?.status || item.proposal_status || null, target_id: item.target_id, target_label: item.target_label || item.target_id, locator: item.locator || { route: item.route, surface_id: item.surface_id, surface_revision: item.surface_revision }, before_value: item.before_value, after_value: item.after_value, current_value: item.current_value } : null; }

export async function appServerUserInput(userText, attachments, _state, options = {}) {
  const input = [{ type: 'text', text: cleanText(userText, 100_000), text_elements: [] }];
  for (const attachment of attachments.filter((item) => ['selection', 'text', 'url'].includes(item.kind) && item.model_policy === 'injectable').slice(0, 12)) {
    const text = cleanText(attachment.text, 100_000);
    if (text) input.push({ type: 'text', text: `[Attachment: ${cleanText(attachment.title || attachment.relative_path || attachment.kind, 500)}]\n${text}`, text_elements: [] });
  }
  for (const attachment of attachments.filter((item) => !['selection', 'text'].includes(item.kind)).slice(0, 20)) {
    const nativePath = options.nativePaths?.get(attachment.id) || projectMentionPath(attachment, options);
    if (!nativePath) continue;
    const name = cleanText(attachment.original_filename || attachment.title || path.basename(nativePath), 500);
    if (attachment.model_policy === 'image' && options.imageCapable !== false) input.push({ type: 'localImage', path: nativePath });
    else input.push({ type: 'mention', name, path: nativePath });
  }
  return input;
}

function projectMentionPath(attachment, options) {
  const relative = String(attachment.relative_path || '').replaceAll('\\', '/');
  if (!relative || relative.startsWith('/') || relative.split('/').includes('..')) return null;
  if (options.containerized) return `/workspace/${relative}`;
  return options.cwd ? path.join(options.cwd, ...relative.split('/')) : relative;
}

function safePageContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { route: cleanText(value.route, 2_000), browser_instance_id: cleanText(value.browser_instance_id || value.surface?.browser_instance_id, 200) || null, surface: value.surface && typeof value.surface === 'object' ? value.surface : null };
}

function limitedLegacyHistory(session) {
  return { legacy_thread_id_present: Boolean(session.legacy_codex_thread_id || session.historical_shared_codex_thread_id), note: 'A legacy native thread is retained for audit only. Continue in an isolated V1.6 thread without exposing or resuming the shared identifier.' };
}
