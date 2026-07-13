import fsp from 'node:fs/promises';
import { estimateTokens, id, now } from '../../../packages/shared/index.mjs';
import { cleanText } from './assist-v3-domain.mjs';

export function createTurnContext(state, { actor, project, session, turn, attachmentIds }) {
  const created = now();
  const brief = state.project_briefs.filter((item) => item.project_id === project.id && item.status !== 'superseded').sort((a, b) => b.version - a.version)[0] || null;
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
    content_json: { project: { id: project.id, title: project.title, goal: project.goal }, brief: brief?.content || null, digest: digest ? { id: digest.id, summary: digest.summary } : null, attachment_ids: attachmentIds },
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
    migrated_thread_history: session.native_thread_generation === 1 ? limitedLegacyHistory(session) : null
  };
  return [{ kind: 'application', value: JSON.stringify(value) }];
}

export async function appServerUserInput(userText, attachments, state) {
  const input = [{ type: 'text', text: cleanText(userText, 100_000), text_elements: [] }];
  for (const attachment of attachments.filter((item) => item.model_policy === 'injectable').slice(0, 12)) {
    const text = cleanText(attachment.text, 100_000);
    if (text) input.push({ type: 'text', text: `[Attachment: ${cleanText(attachment.title || attachment.relative_path || attachment.kind, 500)}]\n${text}`, text_elements: [] });
  }
  for (const attachment of attachments.filter((item) => item.model_policy === 'image').slice(0, 8)) {
    const ref = state.file_refs.find((item) => item.id === attachment.file_ref_id);
    const sourcePath = ref?.absolute_path || attachment.managed_path;
    if (!sourcePath || Number(ref?.size_bytes || attachment.size_bytes) > 10 * 1024 * 1024) continue;
    const bytes = await fsp.readFile(sourcePath).catch(() => null); if (!bytes) continue;
    const type = /^image\/(?:png|jpeg|webp|gif)$/i.test(attachment.content_type) ? attachment.content_type : 'image/png';
    input.push({ type: 'image', detail: 'auto', url: `data:${type};base64,${bytes.toString('base64')}` });
  }
  return input;
}

function safePageContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { route: cleanText(value.route, 2_000), surface: value.surface && typeof value.surface === 'object' ? value.surface : null };
}

function limitedLegacyHistory(session) {
  return { legacy_thread_id_present: Boolean(session.legacy_codex_thread_id || session.codex_thread_id), note: 'A V1.4 native thread was retained for audit. Continue in this V1.5 dynamic-tools generation without exposing the legacy identifier.' };
}
