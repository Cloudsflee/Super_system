export type WorkflowExecutionConfig = {
  mode: string; argv: string[]; cwd_role?: string; input_paths: string[]; output_paths: string[];
  deadline_seconds: number; resource_profile: string; capabilities: string[]; check_ids: string[];
  [key: string]: unknown;
};
export type WorkflowEditorNode = {
  id: string; kind: string; title: string; parent_id?: string | null; depends_on?: string[];
  config?: { goal?: string; execution?: WorkflowExecutionConfig; [key: string]: unknown };
  contract?: { acceptance?: string[]; [key: string]: unknown }; [key: string]: unknown;
};
export type WorkflowValidationIssue = { path: string; message: string };
export type WorkflowGraph = { nodes: WorkflowEditorNode[]; [key: string]: unknown };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const checks = ['node_test', 'git_diff_check'];
const capabilities = ['workspace:read', 'workspace:write', 'network:none', 'network:model', 'check:node_test', 'check:git_diff_check'];
export function parseWorkflowGraph(source: string): WorkflowGraph | null {
  try { const graph: unknown = JSON.parse(source); return record(graph) && Array.isArray(graph.nodes) ? graph as WorkflowGraph : null; } catch { return null; }
}
export function relativeWorkflowPath(value: string): boolean {
  return Boolean(value) && value.length <= 512 && !/[\\\0\r\n:]/.test(value) && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part));
}
/** Read raw entries: duplicate or malformed nodes must never disappear during validation. */
export function validateWorkflowGraph(graph: unknown): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });
  if (!record(graph) || !Array.isArray(graph.nodes)) return [{ path: 'nodes', message: '图谱需要 nodes 数组' }];
  if (graph.nodes.length > 500) issue('nodes', '节点数量最多为 500');
  const nodes = graph.nodes as unknown[];
  const ids = new Set<string>();
  const byId = new Map<string, Record<string, unknown>>();
  nodes.forEach((node, index) => {
    const path = `nodes[${index}]`;
    if (!record(node)) { issue(path, '节点必须是对象'); return; }
    if (typeof node.id !== 'string' || !node.id.trim()) issue(`${path}.id`, '节点 ID 必须非空');
    else { if (ids.has(node.id)) issue(`${path}.id`, '节点 ID 必须唯一'); ids.add(node.id); byId.set(node.id, node); }
    if (!['task', 'workstream'].includes(String(node.kind))) issue(`${path}.kind`, '节点类型须为 task 或 workstream');
    if (typeof node.title !== 'string' || !node.title.trim() || node.title.length > 200) issue(`${path}.title`, '标题须为 1–200 个字符');
  });
  nodes.forEach((node, index) => {
    if (!record(node)) return;
    const path = `nodes[${index}]`;
    const deps = node.depends_on ?? [];
    if (!strings(deps) || new Set(deps).size !== deps.length) issue(`${path}.depends_on`, '依赖必须是唯一 ID 列表');
    else for (const dep of deps) { if (!ids.has(dep)) issue(`${path}.depends_on`, `依赖 ${dep} 不存在`); if (dep === node.id) issue(`${path}.depends_on`, '节点不得依赖自身'); }
    if (node.parent_id && (node.parent_id === node.id || byId.get(String(node.parent_id))?.kind !== 'workstream')) issue(`${path}.parent_id`, '父节点必须是其他工作流组');
    if (node.kind === 'workstream') return;
    const execution = record(node.config) ? node.config.execution : null;
    if (!record(execution)) { issue(`${path}.config.execution`, 'Task 需要有效 execution'); return; }
    const ep = `${path}.config.execution`;
    if (!['read', 'write'].includes(String(execution.mode))) issue(`${ep}.mode`, '执行模式须为 read 或 write');
    if (!strings(execution.argv) || !execution.argv.length || execution.argv.some(arg => /[\0\r\n]/.test(arg)) || !['node', 'pnpm', 'npm', 'git', 'codex'].includes(execution.argv[0])) issue(`${ep}.argv`, '命令首项须为 node/pnpm/npm/git/codex，参数须为单行字符串');
    if (execution.cwd_role != null && !['task', 'candidate'].includes(String(execution.cwd_role))) issue(`${ep}.cwd_role`, '工作目录角色无效');
    if (!Number.isInteger(execution.deadline_seconds) || Number(execution.deadline_seconds) < 1 || Number(execution.deadline_seconds) > 900) issue(`${ep}.deadline_seconds`, '截止时间须为 1–900 秒');
    if (!['light', 'standard'].includes(String(execution.resource_profile))) issue(`${ep}.resource_profile`, '资源配置须为 light 或 standard');
    for (const key of ['input_paths', 'output_paths'] as const) { const paths = execution[key]; if (!strings(paths) || paths.length > 64 || new Set(paths).size !== paths.length || paths.some(p => !relativeWorkflowPath(p))) issue(`${ep}.${key}`, '路径须为唯一相对路径，禁止绝对路径、URL 和 ..'); }
    const selectedChecks = execution.check_ids;
    if (!strings(selectedChecks) || !selectedChecks.length || selectedChecks.length > 16 || new Set(selectedChecks).size !== selectedChecks.length || selectedChecks.some(check => !checks.includes(check))) issue(`${ep}.check_ids`, '至少选择 node_test 或 git_diff_check，且不得重复');
    const acceptance = record(node.contract) ? node.contract.acceptance : null;
    if (!strings(acceptance) || !strings(selectedChecks) || JSON.stringify(acceptance) !== JSON.stringify(selectedChecks)) issue(`${path}.contract.acceptance`, '验收契约必须与 check_ids 完全一致');
    const caps = execution.capabilities;
    if (!strings(caps) || caps.length > 16 || new Set(caps).size !== caps.length || caps.some(cap => !capabilities.includes(cap)) || !caps.includes('network:none') || (execution.mode === 'write' && !caps.includes('workspace:write'))) issue(`${ep}.capabilities`, '能力须包含 network:none，写任务还须有 workspace:write，且不得含未知或重复能力');
  });
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) { issue('nodes', '依赖图存在循环'); return; }
    if (visited.has(id)) return;
    visiting.add(id); const deps = byId.get(id)?.depends_on;
    if (strings(deps)) for (const dep of deps) if (byId.has(dep)) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  return issues;
}
export function newWorkflowNode(kind: 'task' | 'workstream', nodes: WorkflowEditorNode[]): WorkflowEditorNode {
  let ordinal = 1; while (nodes.some(node => node.id === `${kind}_${ordinal}`)) ordinal++;
  const node: WorkflowEditorNode = { id: `${kind}_${ordinal}`, kind, title: kind === 'task' ? '新任务' : '新工作流组', parent_id: null, depends_on: [], config: {}, contract: {} };
  if (kind === 'task') { node.config = { execution: { mode: 'read', argv: ['node', '--version'], cwd_role: 'task', input_paths: [], output_paths: [], deadline_seconds: 60, resource_profile: 'light', capabilities: ['network:none', 'workspace:read'], check_ids: ['node_test'] } }; node.contract = { acceptance: ['node_test'] }; }
  return node;
}
