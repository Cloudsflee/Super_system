import { AssetStatus, Freshness, MemoryAuthority } from './enums.mjs';
import { estimateTokens, id, now } from './utils.mjs';

const authorityRank = { [MemoryAuthority.UserConfirmed]: 100, [MemoryAuthority.SystemConfirmed]: 80, [MemoryAuthority.Imported]: 60, [MemoryAuthority.CodexMemoryHint]: 30, [MemoryAuthority.AiDraft]: 10 };
const freshnessRank = { [Freshness.Current]: 100, [Freshness.Unknown]: 50, [Freshness.Stale]: 20, [Freshness.Disputed]: 5, [Freshness.Superseded]: 0 };

export function memoryScore(item) {
  return (authorityRank[item.authority] || 0) + (freshnessRank[item.freshness] || 0) + (item.scope === 'node' ? 8 : item.scope === 'workspace' ? 5 : item.scope === 'project' ? 3 : 0);
}

export function buildMemoryItems(state, projectId, workspaceId = null) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return [];
  const items = [projectMemory(project, projectId)];
  pushAssetMemory(items, state, projectId, workspaceId);
  pushDecisionMemory(items, state, projectId, workspaceId);
  pushDigestMemory(items, state, projectId);
  pushRunnerMemory(items, state, projectId, workspaceId);
  return uniqueMemory(items);
}

function projectMemory(project, projectId) {
  return { id: id('mem'), project_id: projectId, workspace_id: project.current_workspace_id, source_type: 'project_rule', source_id: project.id, title: '项目目标与边界', summary: project.goal || project.title, scope: 'project', authority: MemoryAuthority.UserConfirmed, freshness: Freshness.Current, tags: ['project', 'goal'], last_verified_at: project.updated_at || now(), created_at: now(), updated_at: now() };
}

function pushAssetMemory(items, state, projectId, workspaceId) {
  for (const asset of state.assets.filter((a) => a.project_id === projectId)) items.push({ id: id('mem'), project_id: projectId, workspace_id: asset.workspace_id || workspaceId, source_type: 'asset', source_id: asset.id, title: asset.title, summary: asset.summary, scope: asset.scope || 'project', authority: asset.status === AssetStatus.Confirmed ? MemoryAuthority.UserConfirmed : MemoryAuthority.AiDraft, freshness: asset.status === AssetStatus.Stale ? Freshness.Stale : asset.status === AssetStatus.Disputed ? Freshness.Disputed : asset.status === AssetStatus.Superseded ? Freshness.Superseded : Freshness.Current, tags: asset.tags || ['asset'], last_verified_at: asset.updated_at || asset.created_at, created_at: now(), updated_at: now() });
}

function pushDecisionMemory(items, state, projectId, workspaceId) {
  for (const decision of state.decisions.filter((d) => d.project_id === projectId)) items.push({ id: id('mem'), project_id: projectId, workspace_id: decision.workspace_id || workspaceId, source_type: 'decision', source_id: decision.id, title: decision.title, summary: decision.summary, scope: 'project', authority: MemoryAuthority.UserConfirmed, freshness: decision.status === 'superseded' ? Freshness.Superseded : Freshness.Current, tags: decision.tags || ['decision'], last_verified_at: decision.updated_at || decision.created_at, created_at: now(), updated_at: now() });
}

function pushDigestMemory(items, state, projectId) {
  for (const digest of state.digests.filter((d) => d.project_id === projectId && d.status === 'confirmed')) items.push({ id: id('mem'), project_id: projectId, workspace_id: digest.workspace_id, source_type: 'digest', source_id: digest.id, title: `Workspace Digest v${digest.version}`, summary: digest.summary, scope: 'workspace', authority: MemoryAuthority.SystemConfirmed, freshness: Freshness.Current, tags: ['digest'], last_verified_at: digest.updated_at || digest.created_at, created_at: now(), updated_at: now() });
}

function pushRunnerMemory(items, state, projectId, workspaceId) {
  for (const hint of (state.runner_memory_candidates || []).filter((h) => h.project_id === projectId)) items.push({ id: id('mem'), project_id: projectId, workspace_id: hint.workspace_id || workspaceId, source_type: 'runner_memory_candidate', source_id: hint.id, title: hint.title, summary: hint.summary, scope: hint.scope || 'runner', authority: hint.status === 'confirmed' ? MemoryAuthority.UserConfirmed : MemoryAuthority.CodexMemoryHint, freshness: hint.freshness || Freshness.Unknown, tags: hint.tags || ['runner-memory'], last_verified_at: hint.updated_at || hint.created_at, created_at: now(), updated_at: now() });
}

function uniqueMemory(items) {
  const seen = new Set();
  return items.filter((item) => { const key = `${item.source_type}:${item.source_id}:${item.title}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

export function findMemoryConflicts(memoryItems) {
  const conflicts = [];
  const confirmed = memoryItems.filter((m) => [MemoryAuthority.UserConfirmed, MemoryAuthority.SystemConfirmed].includes(m.authority));
  const hints = memoryItems.filter((m) => m.authority === MemoryAuthority.CodexMemoryHint || m.freshness === Freshness.Disputed);
  for (const hint of hints) {
    const matched = confirmed.find((item) => hasConflictSignal(hint, item));
    if (matched) conflicts.push({ id: id('cfl'), higher_authority_ref: `${matched.source_type}:${matched.source_id}`, lower_authority_ref: `${hint.source_type}:${hint.source_id}`, summary: `检测到低权威记忆「${hint.title}」可能与确认事实「${matched.title}」冲突。`, resolution: '以 user/system confirmed 事实为准，并提示用户确认。' });
  }
  return conflicts;
}

function hasConflictSignal(hint, item) {
  const text = `${hint.title} ${hint.summary}`;
  const tagOverlap = (item.tags || []).some((tag) => (hint.tags || []).includes(tag));
  const titleOverlap = item.title && text.toLowerCase().includes(String(item.title).toLowerCase());
  return (tagOverlap || titleOverlap) && /冲突|conflict|旧|deprecated|相反|不要/.test(text);
}

export function buildSufficiencyCheck({ state, project, workspace, node, contract, target_type = 'node_run', target_id = null, tokenBudget = 12000 }) {
  const missing_slots = missingSlots(project, contract);
  const memoryItems = buildMemoryItems(state, project.id, workspace?.id);
  const conflicts = findMemoryConflicts(memoryItems);
  const stale_refs = memoryItems.filter((m) => [Freshness.Stale, Freshness.Disputed, Freshness.Superseded].includes(m.freshness)).map((m) => ({ ref: `${m.source_type}:${m.source_id}`, title: m.title, freshness: m.freshness }));
  return { id: id('sfc'), project_id: project.id, workspace_id: workspace?.id || project.current_workspace_id, node_id: node?.id || null, target_type, target_id, status: sufficiencyStatus(missing_slots, conflicts), missing_slots, conflicts, stale_refs, recommended_questions: questionsForIssues(missing_slots, conflicts), recommended_options: optionsForSufficiency(missing_slots, conflicts), included_memory_refs: [], excluded_memory_refs: [], token_estimate: estimateTokens(JSON.stringify({ project, node, contract, memoryItems })), token_budget: tokenBudget, created_at: now() };
}

function missingSlots(project, contract) {
  const slots = [];
  if (!project?.goal?.trim()) slots.push({ key: 'project.goal', label: '项目目标', why: 'Codex 需要明确目标才能执行或生成选项。', required: true });
  if (!contract?.node_goal?.trim()) slots.push({ key: 'contract.node_goal', label: '节点目标', why: '节点必须有预期目标。', required: true });
  if (!Array.isArray(contract?.acceptance_criteria) || contract.acceptance_criteria.length === 0) slots.push({ key: 'contract.acceptance_criteria', label: '验收标准', why: '没有验收标准无法判断输出是否完成。', required: true });
  if (!Array.isArray(contract?.allowed_tools) || contract.allowed_tools.length === 0) slots.push({ key: 'contract.allowed_tools', label: '允许工具', why: '必须明确 Codex/系统侧可用工具边界。', required: true });
  return slots;
}

function questionsForIssues(slots, conflicts) {
  return [
    ...slots.map((slot) => ({ id: id('q'), question: `请补充「${slot.label}」：${slot.why}`, why: slot.why, required: slot.required })),
    ...conflicts.map((conflict) => ({ id: id('q'), question: `如何处理记忆冲突：${conflict.summary}`, why: conflict.resolution, required: true }))
  ];
}
function sufficiencyStatus(slots, conflicts) { return conflicts.length ? 'conflict' : slots.some((s) => s.required) ? 'needs_user_input' : slots.length ? 'insufficient' : 'sufficient'; }
function optionsForSufficiency(slots, conflicts) {
  if (slots.length) return [{ id: id('opt'), label: '按系统推荐方案继续', description: '使用系统推荐的最小可用契约补齐缺失项。', impact: '速度最快，但需要后续 Review。', recommended: true }, { id: id('opt'), label: '先完善信息', description: '停留在当前页面，逐项补齐缺失字段。', impact: '质量最高，适合正式节点运行。', recommended: false }];
  if (conflicts.length) return [{ id: id('opt'), label: '采用确认事实', description: '以 confirmed Asset/Decision/Contract 为准。', impact: '保持系统事实源一致。', recommended: true }, { id: id('opt'), label: '重新确认冲突', description: '让用户选择是否更新资产或决策。', impact: '适合旧事实可能过期的场景。', recommended: false }];
  return [];
}

export function buildMemoryManifest({ state, project, workspace, node, contract, tokenBudget = 12000, pinnedRefs = [] }) {
  const memoryItems = buildMemoryItems(state, project.id, workspace?.id);
  pushToolMemory(memoryItems, state, project, workspace);
  const allowed = new Set(contract?.allowed_tools || []), pinned = new Set(pinnedRefs || []), included = [], excluded = [], warnings = [];
  let used = 0;
  for (const item of sortMemory(memoryItems, pinned)) used = routeMemoryItem({ item, allowed, pinned, tokenBudget, used, included, excluded, warnings });
  return { id: id('mmf'), project_id: project.id, workspace_id: workspace?.id || project.current_workspace_id, node_id: node?.id || null, generated_at: now(), token_budget: tokenBudget, token_estimate: used, included, excluded, warnings, policy: { authority_order: ['current user input', 'NodeContract', 'Confirmed Asset/Decision', 'Digest', 'AGENTS.md', 'Trace Summary', 'Codex memory hint', 'AI draft'], rule: 'Codex Memory / Session 不得覆盖 Context Pack、Confirmed Asset、Decision 或 NodeContract。' } };
}

function pushToolMemory(memoryItems, state, project, workspace) {
  for (const tool of (state.tools || []).filter((t) => t.enabled !== false)) memoryItems.push({ id: id('mem'), project_id: project.id, workspace_id: workspace?.id, source_type: 'tool', source_id: tool.id, title: tool.name, summary: `${tool.type} · ${tool.health_status || 'unknown'} · ${tool.description || ''}`, scope: 'project', authority: MemoryAuthority.SystemConfirmed, freshness: tool.health_status === 'unhealthy' ? Freshness.Stale : Freshness.Current, tags: ['tool', tool.type, ...(tool.capabilities || [])], last_verified_at: tool.last_checked_at || tool.created_at || now(), created_at: now(), updated_at: now() });
}

function sortMemory(memoryItems, pinned) { return memoryItems.sort((a, b) => ((pinned.has(`${b.source_type}:${b.source_id}`) ? 10000 : 0) + memoryScore(b)) - ((pinned.has(`${a.source_type}:${a.source_id}`) ? 10000 : 0) + memoryScore(a))); }

function routeMemoryItem({ item, allowed, pinned, tokenBudget, used, included, excluded, warnings }) {
  const ref = `${item.source_type}:${item.source_id}`;
  const token_estimate = estimateTokens(`${item.title}\n${item.summary}`);
  const isAllowedTool = item.source_type !== 'tool' || allowed.has(item.source_id) || allowed.has(item.title) || (item.tags || []).some((tag) => allowed.has(tag));
  if ([Freshness.Stale, Freshness.Disputed, Freshness.Superseded].includes(item.freshness)) warnings.push({ ref, title: item.title, freshness: item.freshness, reason: '记忆不是 current，不能作为默认事实。' });
  if (!isAllowedTool) { excluded.push({ ref, title: item.title, reason: '工具未被当前 Node Contract 允许。', authority: item.authority, freshness: item.freshness }); return used; }
  if (item.freshness === Freshness.Superseded) { excluded.push({ ref, title: item.title, reason: '已被 superseded，不进入正文。', authority: item.authority, freshness: item.freshness }); return used; }
  if (!pinned.has(ref) && used + token_estimate > tokenBudget) { excluded.push({ ref, title: item.title, reason: '超过 token budget，且未被 pin。', authority: item.authority, freshness: item.freshness }); return used; }
  included.push({ ref, source_type: item.source_type, source_id: item.source_id, title: item.title, summary: item.summary, reason: includeReason(item), authority: item.authority, freshness: item.freshness, token_estimate });
  return used + token_estimate;
}

function includeReason(item) { return item.source_type === 'tool' ? '节点允许工具' : item.source_type === 'asset' ? '用户确认资产/候选资产' : item.source_type === 'digest' ? '最新工作区摘要' : '与当前项目 / 工作区相关'; }

export function buildAssistContextPack({ state, project, workspace, node, contract, target_type, target_id, field_key = null, user_prompt = '', tokenBudget = 4000 }) {
  const sufficiency = buildSufficiencyCheck({ state, project, workspace, node, contract, target_type: `assist:${target_type}`, target_id, tokenBudget });
  const manifest = buildMemoryManifest({ state, project, workspace, node, contract, tokenBudget });
  sufficiency.included_memory_refs = manifest.included.map((m) => m.ref);
  sufficiency.excluded_memory_refs = manifest.excluded.map((m) => ({ ref: m.ref, reason: m.reason }));
  return { schema_version: 'aiws.assist_context_pack.v1', target_type, target_id, field_key, user_prompt, project: project ? { id: project.id, title: project.title, goal: project.goal } : null, workspace: workspace ? { id: workspace.id, title: workspace.title, goal: workspace.goal } : null, workflow_node: node ? { id: node.id, title: node.title, type: node.type, goal: node.goal } : null, node_contract: contract || null, sufficiency_check: sufficiency, memory_manifest: manifest, generated_at: now() };
}

export function mergeSufficiencyIntoAssistResult(result, assistContext) {
  const check = assistContext?.sufficiency_check;
  const questions = [...(check?.recommended_questions || []), ...(result.questions || [])];
  const options = [...(check?.recommended_options || []), ...(result.options || [])];
  const status = check?.status === 'conflict' ? 'conflict' : check?.status === 'needs_user_input' && result.status === 'draft_ready' ? 'needs_user_choice' : result.status;
  return { ...result, status, questions, options, memory_manifest: assistContext?.memory_manifest, sufficiency_check: check, assist_context_pack: assistContext };
}


