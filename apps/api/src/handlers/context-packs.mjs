import { HttpError } from '../http.mjs';
import { addTrace, saveArtifact } from '../state.mjs';
import { buildContextPack, contextPackToMarkdown, now } from '../../../../packages/shared/index.mjs';

export function previewContextPack(state, { actor, node, project, workspace, contract, body }) {
  const ctx = buildContextPack({ state, project, workspace, node, contract, purpose: body.purpose || 'node_run', receiver_name: body.receiver_name || 'CodexRunner', pinnedRefs: body.pinned_refs || [] });
  state.context_packs.push(ctx);
  state.context_sufficiency_checks.push(ctx._sufficiency_check);
  addContextTraces(state, { actorId: actor.id, project, workspace, node, ctx, prefix: 'Context Pack' });
  return ctx;
}

export async function confirmContextPack(state, { actor, contextPackId }) {
  const ctx = state.context_packs.find((item) => item.id === contextPackId);
  if (!ctx) throw new HttpError(404, 'context_pack_not_found');
  const jsonRef = await saveArtifact('context-packs', `${ctx.id}.json`, ctx.content_json, { context_pack_id: ctx.id });
  const mdRef = await saveArtifact('context-packs', `${ctx.id}.md`, contextPackToMarkdown(ctx), { context_pack_id: ctx.id });
  state.file_refs.push(jsonRef, mdRef);
  Object.assign(ctx, { status: 'confirmed', content_file_ref_id: jsonRef.id, markdown_file_ref_id: mdRef.id, confirmed_by_user_id: actor.id, updated_at: now() });
  addTrace(state, 'context_pack.confirmed', { project_id: ctx.content_json.project.id, workspace_id: ctx.source_workspace_id, node_id: ctx.content_json.workflow_node?.id, target_type: 'context_pack', target_id: ctx.id, summary: '用户确认 Context Pack 并落盘。', data: { json_ref: jsonRef.id, md_ref: mdRef.id } }, actor.id);
  return { context_pack: ctx, file_refs: [jsonRef, mdRef] };
}

export function ensureRunContextPack(state, { actor, node, project, workspace, contract, body }) {
  const existing = body.context_pack_id ? state.context_packs.find((ctx) => ctx.id === body.context_pack_id) : null;
  if (existing) return existing;
  const ctx = buildContextPack({ state, project, workspace, node, contract, purpose: 'node_run', receiver_name: body.runner === 'codex' ? 'CodexRunner' : 'DockerCodexRunner' });
  state.context_packs.push(ctx);
  state.context_sufficiency_checks.push(ctx._sufficiency_check);
  addContextTraces(state, { actorId: actor.id, project, workspace, node, ctx, prefix: 'NodeRun 前' });
  return ctx;
}

function addContextTraces(state, { actorId, project, workspace, node, ctx, prefix }) {
  addTrace(state, 'memory.sufficiency.checked', { project_id: project.id, workspace_id: workspace?.id, node_id: node.id, target_type: 'context_pack', target_id: ctx.id, summary: `${prefix}充分性检查：${ctx._sufficiency_check.status}`, data: ctx._sufficiency_check }, actorId);
  addTrace(state, 'memory.manifest.generated', { project_id: project.id, workspace_id: workspace?.id, node_id: node.id, target_type: 'context_pack', target_id: ctx.id, summary: `${prefix}生成 Memory Manifest：included ${ctx.memory_manifest.included.length} / excluded ${ctx.memory_manifest.excluded.length}`, data: ctx.memory_manifest }, actorId);
  addTrace(state, 'context_pack.generated', { project_id: project.id, workspace_id: workspace?.id, node_id: node.id, target_type: 'context_pack', target_id: ctx.id, summary: `${prefix}Context Pack：${ctx.quality_check.passed ? 'quality passed' : 'needs review'}` }, actorId);
  if (ctx._sufficiency_check.conflicts?.length) addTrace(state, 'memory.conflict.detected', { project_id: project.id, workspace_id: workspace?.id, node_id: node.id, target_type: 'context_pack', target_id: ctx.id, summary: 'Context Pack 发现记忆冲突', data: ctx._sufficiency_check.conflicts }, actorId);
}
