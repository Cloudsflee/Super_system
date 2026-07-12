import fsp from 'node:fs/promises';
import { estimateTokens, id, now } from '../../../packages/shared/index.mjs';
import { cleanText } from './assist-v3-domain.mjs';
import { assistPageActionInstruction } from './assist-v3-actions.mjs';

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
  const boundary = turn.mode === 'agent'
    ? 'You may edit files only inside the current isolated worktree. Do not push, publish, or modify repositories outside the current working directory. Leave all changes reviewable.'
    : 'This is a strictly read-only turn. Do not edit, create, delete, rename, or apply patches to files. Do not run mutating commands.';
  const plan = turn.mode === 'plan' ? 'Return a concrete implementation plan, risks, and verification steps without making changes.' : '';
  const pageActions = assistPageActionInstruction(turn.view_context);
  const attachmentContext = attachments.map((item) => ({
    kind: item.kind, path: item.relative_path, url: item.url, content_type: item.content_type,
    model_policy: item.model_policy, selection: item.selection,
    text: item.model_policy === 'injectable' ? cleanText(item.text, 20_000) : null
  }));
  return [
    `You are Codex in AI Workspace Assist V3 ${turn.mode.toUpperCase()} mode.`, boundary, plan,
    `Project: ${project.title}. Goal: ${project.goal || ''}`, `Scope: ${session.scope_type}:${session.scope_id}.`,
    `Context Pack: ${JSON.stringify(contextPack?.content_json || {})}`,
    `Attachments: ${JSON.stringify(attachmentContext)}`, pageActions, `User request: ${turn.prompt}`
  ].filter(Boolean).join('\n\n');
}

export async function appServerUserInput(prompt, attachments, state) {
  const input = [{ type: 'text', text: prompt, text_elements: [] }];
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
