import path from 'node:path';
import { estimateTokens, id, now } from '../../../packages/shared/index.mjs';
import { cleanText } from './assist-v3-domain.mjs';

export function createTurnContext(state, { actor, project, session, turn, attachmentIds }) {
  const created = now();
  const brief = state.project_briefs.filter((item) => item.project_id === project.id && item.status !== 'superseded').sort((a, b) => b.version - a.version)[0] || null;
  const workflowDraft = state.workflow_drafts.find((item) => item.project_id === project.id) || null;
  const assets = state.assets.filter((item) => item.project_id === project.id && item.status === 'confirmed').slice(-50);
  const digest = state.digests.filter((item) => item.project_id === project.id && item.status === 'confirmed').at(-1) || null;
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
      brief: brief?.content || null,
      brief_ref: brief ? { id: brief.id, revision: brief.revision, version: brief.version } : null,
      workflow_draft: workflowDraft ? { id: workflowDraft.id, revision: workflowDraft.revision, nodes: workflowDraft.nodes } : null,
      digest: digest ? { id: digest.id, summary: digest.summary } : null, attachment_ids: attachmentIds,
      operation_reference: publicOperationReference(state.assist_operations.find((item) => item.id === turn.operation_reference_id))
    },
    memory_manifest: { included_asset_version_ids: assets.map((item) => item.current_version_id).filter(Boolean), digest_id: digest?.id || null, authority: 'confirmed_only' },
    sufficiency_check_id: check.id, content_file_ref_id: null, markdown_file_ref_id: null,
    included_asset_versions: assets.map((item) => item.current_version_id).filter(Boolean), token_estimate: check.token_estimate,
    quality_check: { sufficient: !missing.length, missing_slots: missing }, confirmed_by_user_id: actor.id,
    created_at: created, updated_at: created
  };
  return { check, pack };
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
function publicOperationReference(item) { return item ? { operation_reference_id: item.id, capability_id: item.capability_id || null, action: item.action || null, target_id: item.target_id, target_label: item.target_label || item.target_id, locator: item.locator || { route: item.route, surface_id: item.surface_id, surface_revision: item.surface_revision }, before_value: item.before_value, after_value: item.after_value, current_value: item.current_value } : null; }

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
