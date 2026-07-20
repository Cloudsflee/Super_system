import { hashString, id, now, slugify, unique } from './utils.mjs';
import { NodeType, ProjectStatus, WorkflowStatus, WorkspaceStatus } from './enums.mjs';

export const workflowTemplates = Object.freeze([
  { type: NodeType.GoalDefinition, title: '目标定义与成功标准', goal: '澄清项目目标、边界、角色、验收标准与阻塞风险。', outputs: ['项目目标卡', '成功标准', '待确认问题'] },
  { type: NodeType.Research, title: '信息收集与材料整理', goal: '收集 repo、文档、外部资料、已有工具和约束，形成可追溯引用。', outputs: ['资料索引', '事实清单', '风险提示'] },
  { type: NodeType.Analysis, title: '方案分析与节点契约', goal: '比较方案、确定实施路径、定义 Node Contract 和工具权限。', outputs: ['方案决策', 'Node Contract', '工具策略'] },
  { type: NodeType.Execution, title: '执行 / 编码 / 工具任务', goal: '在确认的 Context Pack 和工具权限下执行任务，生成可验证产物。', outputs: ['NodeRunResult', '文件变化', '资产候选', '测试结果'] },
  { type: NodeType.Retrospective, title: '复盘沉淀与下一步', goal: '确认资产、更新 Digest、形成 Git/PR 和下一轮上下文。', outputs: ['Confirmed Assets', 'Workspace Digest', 'Git/PR 记录', '下一步计划'] }
]);

export function createLocalOwner(displayName = 'Local Owner') {
  const userId = id('usr');
  return {
    user: { id: userId, display_name: displayName, email: '', avatar_url: '', role: 'owner', auth_mode: 'local_auto', created_at: now(), updated_at: now() },
    session: { id: id('ses'), user_id: userId, session_token_hash: hashString(`${userId}:local_auto`), mode: 'local_auto', expires_at: null, created_at: now() }
  };
}

export function createProject({ title, goal, role = '', background = '', workspace_root = '', repo_path = '', created_by_user_id, status = ProjectStatus.Active, settings = {} }) {
  const projectId = id('prj');
  const workspaceId = id('wsp');
  const created = now();
  return {
    project: {
      id: projectId, title: title || goal?.slice(0, 40) || '未命名项目', goal: goal || '', role, background,
      status, workspace_root: workspace_root || repo_path || '', repo_path: repo_path || workspace_root || '',
      current_workspace_id: workspaceId, owner_user_id: created_by_user_id, settings: { token_budget: 12000, preferred_runner: 'codex_docker', workspace_root_whitelist: workspace_root || repo_path ? [workspace_root || repo_path] : [], ...settings },
      created_by_user_id, created_at: created, updated_at: created
    },
    workspace: { id: workspaceId, project_id: projectId, parent_workspace_id: null, workflow_node_id: null, type: 'project', title: 'Project Workspace', goal: goal || '', status: WorkspaceStatus.Active, current_digest_id: null, active_agent_session_id: null, open_questions: [], created_at: created, updated_at: created }
  };
}

export function createEmptyWorkflow(project, actorId) {
  const created = now();
  return {
    id: id('wfl'), project_id: project.id, workspace_id: project.current_workspace_id,
    title: `${project.title} · 工作流`, version: 1, status: WorkflowStatus.Active,
    generated_by: 'human', confirmed_by: 'human', confirmed_by_user_id: actorId,
    created_by_user_id: actorId, graph_json: { nodes: [], edges: [] },
    created_at: created, updated_at: created
  };
}

export function createNodeWorkspace(project, node, actorId) {
  const created = now();
  return { id: id('wsp'), project_id: project.id, parent_workspace_id: project.current_workspace_id, workflow_node_id: node.id, type: 'node', title: node.title, goal: node.goal, status: WorkspaceStatus.Active, current_digest_id: null, active_agent_session_id: null, open_questions: [], created_by_user_id: actorId, created_at: created, updated_at: created };
}

export function defaultContractForNode(node, project, actorId, status = 'draft') {
  const created = now();
  const outputs = { [NodeType.GoalDefinition]: ['目标卡', '成功标准', '开放问题'], [NodeType.Research]: ['资料索引', '事实清单', '引用清单'], [NodeType.Analysis]: ['方案对比', '决策记录', '风险缓解策略'], [NodeType.Execution]: ['可运行变更', '测试结果', '资产候选', 'Git diff'], [NodeType.Retrospective]: ['Confirmed Assets', 'Workspace Digest', 'PR 草稿', '下一步计划'] };
  return {
    id: id('ctr'), node_id: node.id, version: 1, node_goal: node.goal || node.title,
    expected_inputs: [{ key: 'project_goal', label: '项目目标', required: true, value: project.goal || '' }, { key: 'workspace_materials', label: '已有材料 / repo', required: false, value: project.repo_path || project.workspace_root || '' }],
    expected_outputs: (outputs[node.type] || ['节点结果']).map((label) => ({ label, required: true })),
    acceptance_criteria: ['输出必须与项目目标直接相关，并说明证据来源。', '所有长期事实必须先作为资产候选，再由用户确认。', 'Context Pack 必须包含 Memory Manifest 和充分性检查结果。'],
    required_context: [{ type: 'project_goal', required: true }, { type: 'latest_digest', required: false }, { type: 'confirmed_assets', required: false }, { type: 'allowed_tools', required: true }],
    allowed_tools: ['filesystem', 'git', node.type === NodeType.Execution ? 'codex_runner' : 'assist'],
    asset_output_types: node.type === NodeType.Execution ? ['CodeChangeAsset', 'DecisionAsset', 'ContextPackAsset'] : ['DecisionAsset', 'DigestAsset'],
    failure_policy: { on_missing_context: 'ask_user_or_generate_options', on_runner_error: 'record_trace_and_offer_retry', on_test_failure: 'mark_partial_and_keep_diff_reviewable' },
    review_policy: { human_required: true, asset_confirmation_required: true, commit_requires_review: true },
    status, confirmed_by: status === 'confirmed' ? 'human' : null, confirmed_by_user_id: status === 'confirmed' ? actorId : null,
    created_by_user_id: actorId, created_at: created, updated_at: created
  };
}

export function validateNodeContract(contract) {
  const errors = [];
  if (!contract?.node_goal?.trim()) errors.push('node_goal 不能为空');
  if (!Array.isArray(contract?.expected_inputs)) errors.push('expected_inputs 必须是数组');
  if (!Array.isArray(contract?.expected_outputs) || contract.expected_outputs.length === 0) errors.push('expected_outputs 至少需要一项');
  if (!Array.isArray(contract?.acceptance_criteria) || contract.acceptance_criteria.length === 0) errors.push('acceptance_criteria 至少需要一项');
  if (!Array.isArray(contract?.allowed_tools) || contract.allowed_tools.length === 0) errors.push('allowed_tools 至少需要一项');
  if (!Array.isArray(contract?.asset_output_types)) errors.push('asset_output_types 必须是数组');
  return { ok: errors.length === 0, errors };
}

export function applyContractPatch(contract, patch, actorId) {
  const allowed = new Set(['node_goal', 'expected_inputs', 'expected_outputs', 'acceptance_criteria', 'required_context', 'allowed_tools', 'asset_output_types', 'failure_policy', 'review_policy']);
  const next = JSON.parse(JSON.stringify(contract));
  for (const [key, value] of Object.entries(patch || {})) if (allowed.has(key)) next[key] = value;
  Object.assign(next, { id: id('ctr'), version: Number(contract.version || 0) + 1, status: 'draft', confirmed_by: null, confirmed_by_user_id: null, created_by_user_id: actorId, created_at: now(), updated_at: now() });
  return next;
}
