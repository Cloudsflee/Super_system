import { HttpError } from '../http.mjs';
import { addTrace, saveArtifact } from '../state.mjs';
import { buildContextPack, contextPackToMarkdown, estimateTokens, now } from '../../../../packages/shared/index.mjs';
import { assertExchangeGrantActive } from '../exchange-v19.mjs';

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
  if (body.context_pack_id) {
    const existing = state.context_packs.find((ctx) => ctx.id === body.context_pack_id);
    if (!existing) throw new HttpError(404, { error: 'context_pack_not_found' });
    assertContextPackProject(state, existing, project.id);
    if (isExchangePack(existing)) return mergeExchangePack(state, { actor, node, project, workspace, contract, body, exchangePack: existing });
    if (existing.status !== 'confirmed') throw new HttpError(409, { error: 'context_pack_not_confirmed' });
    const scopedNodeId = existing.content_json?.workflow_node?.id;
    if (scopedNodeId && scopedNodeId !== node.id) throw new HttpError(409, { error: 'context_pack_scope_mismatch', context_pack_id: existing.id, node_id: node.id });
    return existing;
  }
  const ctx = buildContextPack({ state, project, workspace, node, contract, purpose: 'node_run', receiver_name: body.runner === 'codex' ? 'CodexRunner' : 'DockerCodexRunner' });
  state.context_packs.push(ctx);
  state.context_sufficiency_checks.push(ctx._sufficiency_check);
  addContextTraces(state, { actorId: actor.id, project, workspace, node, ctx, prefix: 'NodeRun 前' });
  return ctx;
}

function mergeExchangePack(state, { actor, node, project, workspace, contract, body, exchangePack }) {
  if (exchangePack.status !== 'confirmed') throw new HttpError(409, { error: 'context_pack_not_confirmed' });
  const grantId = exchangePack.exchange_grant_id || exchangePack.memory_manifest?.grant_id || exchangePack.content_json?.external_context?.exchange_grant_id;
  const { grant } = assertExchangeGrantActive(state, grantId, actor.id);
  const external = exchangePack.content_json?.external_context;
  const packSnapshotHash = exchangePack.memory_manifest?.snapshot_hash || exchangePack.memory_manifest?.external_context?.snapshot_hash;
  if (grant.target_project_id !== project.id || grant.snapshot_hash !== packSnapshotHash || grant.snapshot_hash !== external?.snapshot_hash) {
    throw new HttpError(409, { error: 'exchange_context_pack_inactive' });
  }
  assertTargetScope(state, exchangePack.content_json?.target_scope, project.id, node);
  const ctx = buildContextPack({ state, project, workspace, node, contract, purpose: 'node_run', receiver_name: body.runner === 'codex' ? 'CodexRunner' : 'DockerCodexRunner' });
  Object.assign(ctx.content_json, {
    precedence: 'target_local_first', external_context_pack_id: exchangePack.id,
    external_context: structuredClone(external),
    exchange_policy: { local_context_precedence: true, sibling_context_included: false, grant_revalidated_at: now() }
  });
  Object.assign(ctx, { external_context_pack_id: exchangePack.id, exchange_grant_id: grant.id });
  ctx.memory_manifest = { ...ctx.memory_manifest, external_context: { authority: 'exchange_grant', grant_id: grant.id, snapshot_hash: grant.snapshot_hash, source_context_pack_id: exchangePack.id } };
  ctx.content_json.memory_manifest = ctx.memory_manifest;
  ctx.token_estimate = estimateTokens(JSON.stringify(ctx.content_json));
  state.context_packs.push(ctx);
  state.context_sufficiency_checks.push(ctx._sufficiency_check);
  addContextTraces(state, { actorId: actor.id, project, workspace, node, ctx, prefix: 'NodeRun 前' });
  return ctx;
}

function assertContextPackProject(state, contextPack, projectId) {
  const declared = contextPack.content_json?.project?.id || null;
  const workspaceProject = state.workspaces.find((item) => item.id === contextPack.source_workspace_id)?.project_id || null;
  if (!declared && !workspaceProject) throw new HttpError(409, { error: 'context_pack_project_unresolved', context_pack_id: contextPack.id });
  if (declared && declared !== projectId || workspaceProject && workspaceProject !== projectId || declared && workspaceProject && declared !== workspaceProject) {
    throw new HttpError(403, { error: 'context_pack_project_mismatch', context_pack_id: contextPack.id, project_id: projectId });
  }
}

function assertTargetScope(state, scope, projectId, node) {
  if (!scope || scope.type === 'project' && scope.id === projectId) return;
  if (scope.type === 'workflow' && node.workflow_id === scope.id) return;
  if (scope.type === 'workstream' && (node.id === scope.id || node.parent_node_id === scope.id)) return;
  if (scope.type === 'task' && node.id === scope.id) return;
  const workflow = state.workflows.find((item) => item.id === node.workflow_id);
  if (!workflow || workflow.project_id !== projectId) throw new HttpError(403, { error: 'exchange_target_scope_mismatch' });
  throw new HttpError(403, { error: 'exchange_target_scope_mismatch', target_scope: scope, node_id: node.id });
}

function isExchangePack(contextPack) { return contextPack.purpose === 'cross_project_exchange' || Boolean(contextPack.exchange_grant_id) || contextPack.memory_manifest?.authority === 'exchange_grant' || contextPack.memory_manifest?.external_context?.authority === 'exchange_grant'; }

function addContextTraces(state, { actorId, project, workspace, node, ctx, prefix }) {
  addTrace(state, 'memory.sufficiency.checked', { project_id: project.id, workspace_id: workspace?.id, node_id: node.id, target_type: 'context_pack', target_id: ctx.id, summary: `${prefix}充分性检查：${ctx._sufficiency_check.status}`, data: ctx._sufficiency_check }, actorId);
  addTrace(state, 'memory.manifest.generated', { project_id: project.id, workspace_id: workspace?.id, node_id: node.id, target_type: 'context_pack', target_id: ctx.id, summary: `${prefix}生成 Memory Manifest：included ${ctx.memory_manifest.included.length} / excluded ${ctx.memory_manifest.excluded.length}`, data: ctx.memory_manifest }, actorId);
  addTrace(state, 'context_pack.generated', { project_id: project.id, workspace_id: workspace?.id, node_id: node.id, target_type: 'context_pack', target_id: ctx.id, summary: `${prefix}Context Pack：${ctx.quality_check.passed ? 'quality passed' : 'needs review'}` }, actorId);
  if (ctx._sufficiency_check.conflicts?.length) addTrace(state, 'memory.conflict.detected', { project_id: project.id, workspace_id: workspace?.id, node_id: node.id, target_type: 'context_pack', target_id: ctx.id, summary: 'Context Pack 发现记忆冲突', data: ctx._sufficiency_check.conflicts }, actorId);
}
