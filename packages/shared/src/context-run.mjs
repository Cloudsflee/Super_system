import { AssetStatus, RunnerStatus } from './enums.mjs';
import { buildMemoryManifest, buildSufficiencyCheck } from './memory.mjs';
import { estimateTokens, id, now, pick, slugify } from './utils.mjs';

export function buildContextPack({ state, project, workspace, node, contract, purpose = 'node_run', receiver_name = 'CodexRunner', pinnedRefs = [] }) {
  const tokenBudget = project.settings?.token_budget || 12000;
  const sufficiency = buildSufficiencyCheck({ state, project, workspace, node, contract, target_type: purpose, tokenBudget });
  const manifest = buildMemoryManifest({ state, project, workspace, node, contract, tokenBudget, pinnedRefs });
  sufficiency.included_memory_refs = manifest.included.map((m) => m.ref);
  sufficiency.excluded_memory_refs = manifest.excluded.map((m) => ({ ref: m.ref, reason: m.reason }));
  const latestDigest = [...state.digests].reverse().find((d) => d.workspace_id === workspace?.id && d.status === 'confirmed') || null;
  const confirmedAssets = state.assets.filter((a) => a.project_id === project.id && a.status === AssetStatus.Confirmed);
  const decisions = state.decisions.filter((d) => d.project_id === project.id && d.status !== 'superseded');
  const submissions = (state.submissions || []).filter((item) => item.project_id === project.id && (!node || item.node_id !== node.id)).slice(-8);
  const availableTools = (state.tools || []).filter((t) => t.enabled !== false && (contract.allowed_tools || []).some((tool) => tool === t.id || tool === t.name || (t.capabilities || []).includes(tool)));
  const content = {
    schema_version: 'aiws.context_pack.v1', project: pick(project, ['id', 'title', 'goal', 'role', 'background', 'workspace_root', 'repo_path']),
    workspace: workspace ? pick(workspace, ['id', 'title', 'goal', 'type', 'status', 'current_digest_id']) : null,
    workflow_node: node ? pick(node, ['id', 'type', 'title', 'goal', 'status', 'order_index']) : null,
    node_contract: contract, purpose, runner_instruction: buildRunnerInstruction({ project, node, contract }),
    latest_digest: latestDigest ? pick(latestDigest, ['id', 'version', 'summary', 'body', 'evidence_refs']) : null,
    confirmed_assets: confirmedAssets.map((a) => pick(a, ['id', 'asset_type', 'title', 'summary', 'evidence_refs', 'tags', 'created_at'])),
    decisions: decisions.map((d) => pick(d, ['id', 'title', 'summary', 'rationale', 'evidence_refs'])),
    submissions: submissions.map((s) => pick(s, ['id', 'title', 'summary', 'changes', 'evidence_refs', 'risks', 'from_session_id', 'to_session_id', 'created_at'])),
    available_tools: availableTools.map((t) => ({ id: t.id, name: t.name, type: t.type, health_status: t.health_status, permissions: t.permissions || {}, usage_boundary: t.usage_boundary || '仅在 Node Contract 允许范围内使用' })),
    git: { repo_path: project.repo_path || project.workspace_root || '', branch_strategy: 'aiws/{node_slug}-{short_run_id}', dirty_policy: 'commit 型节点在 dirty repo 中先捕获 baseline，并要求人工确认。' },
    return_schema_ref: 'aiws.node_run_result.v1', result_schema: nodeRunResultSchema(), sufficiency_check: sufficiency, memory_manifest: manifest
  };
  return { id: id('ctx'), source_workspace_id: workspace?.id || project.current_workspace_id, receiver_type: 'ai_runner', receiver_name, purpose, version: 1, status: 'draft', content_json: content, content_file_ref_id: null, markdown_file_ref_id: null, included_asset_versions: confirmedAssets.map((a) => ({ asset_id: a.id, version_id: a.current_version_id || null })), token_estimate: estimateTokens(JSON.stringify(content)), quality_check: qualityCheckContextPack(content), memory_manifest: manifest, sufficiency_check_id: sufficiency.id, created_by: 'system', consumed_at: null, created_at: now(), updated_at: now(), _sufficiency_check: sufficiency };
}

export function buildRunnerInstruction({ project, node, contract }) {
  return ['你正在 AI Workspace System 的受控 Node Workspace 中工作。', `项目目标：${project.goal || project.title}`, `当前节点：${node?.title || '未指定节点'}。节点目标：${contract?.node_goal || node?.goal || ''}`, '必须遵守 Node Contract 的验收标准、allowed_tools、失败处理和 Review 策略。', '如果 Codex Memory / 旧 Session 与 Context Pack、Confirmed Asset、Decision 或 NodeContract 冲突，必须以后者为准，并在结果中报告冲突。', '输出必须匹配 aiws.node_run_result.v1：包含 status、summary、changed_files、asset_candidates、test_results、next_actions。'].join('\n');
}
export function nodeRunResultSchema() { return { type: 'object', required: ['status', 'summary', 'changed_files', 'asset_candidates', 'test_results', 'next_actions'], properties: { status: { enum: ['succeeded', 'partial', 'blocked', 'failed'] }, summary: { type: 'string' }, changed_files: { type: 'array' }, asset_candidates: { type: 'array' }, test_results: { type: 'array' }, next_actions: { type: 'array' }, warnings: { type: 'array' } } }; }
export function qualityCheckContextPack(content) {
  const checks = { has_project_goal: Boolean(content.project?.goal), has_node_goal: Boolean(content.node_contract?.node_goal), has_acceptance_criteria: Array.isArray(content.node_contract?.acceptance_criteria) && content.node_contract.acceptance_criteria.length > 0, has_allowed_tools: Array.isArray(content.node_contract?.allowed_tools) && content.node_contract.allowed_tools.length > 0, has_memory_manifest: Boolean(content.memory_manifest), has_sufficiency_check: Boolean(content.sufficiency_check), has_return_schema: Boolean(content.return_schema_ref) };
  return { ...checks, passed: Object.values(checks).every(Boolean), warnings: [...(!checks.has_acceptance_criteria ? ['缺少验收标准'] : []), ...(content.sufficiency_check?.status === 'conflict' ? ['存在记忆冲突，需要用户确认'] : []), ...(content.memory_manifest?.warnings || []).map((w) => `记忆警告：${w.title} · ${w.freshness}`)] };
}
export function contextPackToMarkdown(contextPack) {
  const c = contextPack.content_json, lines = [`# Context Pack ${contextPack.id}`, '', `- Purpose: ${contextPack.purpose}`, `- Receiver: ${contextPack.receiver_name}`, `- Token estimate: ${contextPack.token_estimate}`, '', '## Project', `- ${c.project.title}: ${c.project.goal}`, '', '## Node Contract', `Goal: ${c.node_contract.node_goal}`, 'Acceptance Criteria:'];
  for (const item of c.node_contract.acceptance_criteria || []) lines.push(`- ${item}`);
  lines.push('', '## Memory Manifest', 'Included:');
  for (const item of c.memory_manifest.included) lines.push(`- ${item.ref} · ${item.title} · ${item.reason}`);
  lines.push('Excluded:'); for (const item of c.memory_manifest.excluded) lines.push(`- ${item.ref} · ${item.title} · ${item.reason}`);
  lines.push('Warnings:'); for (const item of c.memory_manifest.warnings) lines.push(`- ${item.ref} · ${item.title} · ${item.reason}`);
  lines.push('', '## Runner Instruction', c.runner_instruction);
  return `${lines.join('\n')}\n`;
}
export function agensAiwsBlock(contextPackPath = '.ai-workspace/context/current.md') { return ['<!-- AIWS:BEGIN -->', '# AI Workspace System Runner Contract', '', `- 当前任务以 ${contextPackPath} 中的 Context Pack 为准。`, '- Context Pack、Confirmed Asset、Decision、NodeContract 的权威性高于 Codex Memory / 旧 Session / AGENTS.md 其他建议。', '- 如果发现冲突，必须报告冲突并请求用户确认，不得静默覆盖系统确认事实。', '- 运行完成后输出 aiws.node_run_result.v1 结构。', '<!-- AIWS:END -->', ''].join('\n'); }
export const agentsAiwsBlock = agensAiwsBlock;
export function generateBranchName(nodeTitle, runId) {
  const title = slugify(nodeTitle).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'node';
  const suffix = String(runId || id('run')).slice(-8).replace(/[^a-zA-Z0-9_-]+/g, '').toLowerCase() || 'run';
  return `aiws/${title}-${suffix}`;
}
export function generatePrBody({ project, node, run, diff, assets = [], tests = [] }) { return ['## AIWS NodeRun', `- Project: ${project?.title || ''}`, `- Goal: ${project?.goal || ''}`, `- Node: ${node?.title || ''}`, `- NodeRun: ${run?.id || ''}`, '', '## Summary', diff?.summary || run?.summary || '本 PR 由 AI Workspace System 生成草稿，需要人工 Review。', '', '## Changed Files', ...((diff?.changed_files || run?.changed_files || []).map((f) => `- ${typeof f === 'string' ? f : f.path || f.file}`)), '', '## Tests', ...((tests.length ? tests : run?.test_results || []).map((t) => `- ${t.name || 'test'}: ${t.status || 'unknown'}`)), '', '## Assets / Trace', ...assets.map((a) => `- ${a.title}: ${a.summary}`), '', '> GitHub 未绑定时，此内容作为 PR 草稿保存。'].join('\n'); }
export function buildNodeRunResult({ run, contextPack, changedFiles = [], raw = '', status = RunnerStatus.Succeeded }) { const nodeTitle = contextPack?.content_json?.workflow_node?.title || '节点任务'; return { schema_version: 'aiws.node_run_result.v1', status, summary: `${nodeTitle} 已完成 ${status}。${raw ? `Runner 输出：${raw.slice(0, 220)}` : ''}`, changed_files: changedFiles, asset_candidates: [{ id: id('ac'), asset_type: changedFiles.length ? 'CodeChangeAsset' : 'DecisionAsset', title: changedFiles.length ? `${nodeTitle} 文件变更资产` : `${nodeTitle} 结果资产`, summary: changedFiles.length ? `本次运行产生 ${changedFiles.length} 个文件变化，可在 Git Review 中确认。` : '本次运行产出可复用结论，需要用户确认后进入资产库。', evidence_refs: [`node_run:${run.id}`, `context_pack:${contextPack?.id}`], tags: changedFiles.length ? ['code-change', 'node-run'] : ['decision', 'node-run'] }], test_results: [], warnings: [], next_actions: ['Review asset candidates', 'Generate digest', 'Open Git Review'] }; }

export function normalizeRunnerOutput(raw, fallback = {}) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const required = ['status', 'summary', 'changed_files', 'asset_candidates', 'test_results', 'next_actions'];
    const missing = required.filter((key) => !(key in parsed));
    if (missing.length) {
      return {
        status: RunnerStatus.Partial,
        result: { ...fallback, ...parsed, warnings: [`missing fields: ${missing.join(', ')}`] },
        parse_error: null
      };
    }
    return { status: parsed.status || RunnerStatus.Succeeded, result: parsed, parse_error: null };
  } catch (error) {
    return {
      status: RunnerStatus.Partial,
      result: {
        ...fallback,
        status: RunnerStatus.Partial,
        summary: 'Runner 输出不是合法 JSON，已保留 raw output。',
        changed_files: [],
        asset_candidates: [],
        test_results: [],
        next_actions: ['查看 raw output'],
        warnings: [String(error.message)]
      },
      parse_error: error.message
    };
  }
}
