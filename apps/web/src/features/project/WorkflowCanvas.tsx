import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { List, Maximize2, Network, Rows3 } from 'lucide-react';
import { nodeKindLabel } from '../../i18n';

type WorkflowGraph = Record<string, unknown>;
type WorkflowNode = { id: string; title: string; kind: string; parent_id?: string; deps?: string[]; goal?: string; acceptance?: string[]; position?: { x?: number; y?: number }; [key: string]: unknown };

export function normalizeWorkflowNodes(graph: WorkflowGraph | null | undefined): WorkflowNode[] {
  if (!graph || typeof graph !== 'object') return [];
  const rows: WorkflowNode[] = [];
  const push = (value: unknown, fallbackKind = 'task', parentId?: string) => {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    const id = String(item.id || item.node_id || '');
    if (!id || rows.some((row) => row.id === id)) return;
    const node: WorkflowNode = {
      ...item,
      id,
      title: String(item.title || item.name || item.label || id),
      kind: String(item.kind || item.type || fallbackKind),
      ...(parentId ? { parent_id: parentId } : item.parent_id ? { parent_id: String(item.parent_id) } : {}),
      deps: Array.isArray(item.depends_on) ? item.depends_on.map(String) : Array.isArray(item.deps) ? item.deps.map(String) : Array.isArray(item.dependencies) ? item.dependencies.map(String) : []
    };
    rows.push(node);
    if (Array.isArray(item.tasks)) for (const task of item.tasks) push(task, 'task', id);
    if (Array.isArray(item.nodes)) for (const child of item.nodes) push(child, 'task', id);
  };
  if (Array.isArray(graph.nodes)) for (const node of graph.nodes) push(node);
  if (Array.isArray(graph.workstreams)) for (const workstream of graph.workstreams) push(workstream, 'workstream');
  if (Array.isArray(graph.tasks)) for (const task of graph.tasks) push(task, 'task');
  return rows;
}

function graphEdges(nodes: WorkflowNode[]): Edge[] {
  const known = new Set(nodes.map((node) => node.id));
  return nodes.flatMap((node) => (node.deps || []).filter((dep) => known.has(dep)).map((dep) => ({ id: `${dep}->${node.id}`, source: dep, target: node.id, animated: false })));
}

export function WorkflowCanvas({ graph, density = 'comfortable', selectedId, onSelect }: { graph: WorkflowGraph | null | undefined; density?: 'compact' | 'comfortable'; selectedId?: string; onSelect?: (id: string) => void }) {
  const rows = useMemo(() => normalizeWorkflowNodes(graph), [graph]);
  const nodes = useMemo<Node[]>(() => rows.map((row, index) => ({
    id: row.id,
    position: { x: Number(row.position?.x || (index % 3) * 250), y: Number(row.position?.y || Math.floor(index / 3) * (density === 'compact' ? 86 : 120)) },
    data: { label: <span><strong>{row.title}</strong><small>{nodeKindLabel(row.kind)}{row.parent_id ? ` · ${row.parent_id}` : ''}</small></span> },
    className: row.kind === 'workstream' ? 'workflow-flow-node workstream' : 'workflow-flow-node',
    selected: row.id === selectedId
  })), [density, rows, selectedId]);
  const edges = useMemo(() => graphEdges(rows), [rows]);
  if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') {
    return <div className={`workflow-canvas-fallback ${density}`} data-testid="workflow-canvas" role="group" aria-label="Workflow 画布"><div className="workflow-canvas-grid">{rows.map((row) => <button type="button" aria-pressed={row.id === selectedId} onClick={() => onSelect?.(row.id)} className="workflow-flow-node" key={row.id}><strong>{row.title}</strong><small>{nodeKindLabel(row.kind)}</small></button>)}{!rows.length && <span className="list-empty">暂无工作流节点</span>}</div></div>;
  }
  return <div className={`workflow-canvas ${density}`} data-testid="workflow-canvas"><ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.35} maxZoom={1.8} nodesConnectable={false} nodesDraggable={false} elementsSelectable onNodeClick={(_, node) => onSelect?.(node.id)} onSelectionChange={({ nodes: selected }) => { if (selected[0] && selected[0].id !== selectedId) onSelect?.(selected[0].id); }}><MiniMap pannable zoomable /><Controls showInteractive={false} /><Background gap={density === 'compact' ? 14 : 20} size={1} /></ReactFlow></div>;
}

export function WorkflowWorkbench({ graph, initialView = 'canvas', onViewContext, onReplan, selectedId, onSelect, replanDisabled = false }: { graph: WorkflowGraph | null | undefined; initialView?: 'canvas' | 'workstreams' | 'nodes'; onViewContext?: () => void; onReplan?: () => void; selectedId?: string; onSelect?: (id: string) => void; replanDisabled?: boolean }) {
  const [view, setView] = useState<'canvas' | 'workstreams' | 'nodes'>(initialView);
  useEffect(() => setView(initialView), [initialView]);
  const [density, setDensity] = useState<'compact' | 'comfortable'>('comfortable');
  const rows = useMemo(() => normalizeWorkflowNodes(graph), [graph]);
  const workstreams = rows.filter((row) => row.kind === 'workstream');
  const tasks = rows.filter((row) => row.kind !== 'workstream');
  return <div className="workflow-workbench" data-testid="workflow-workbench">
    <div className="workflow-workbench-toolbar">
      <div className="segmented" role="tablist" aria-label="Workflow 视图">
        <button role="tab" aria-selected={view === 'canvas'} className={view === 'canvas' ? 'active' : ''} onClick={() => setView('canvas')}><Network size={14} />画布</button>
        <button role="tab" aria-selected={view === 'workstreams'} className={view === 'workstreams' ? 'active' : ''} onClick={() => setView('workstreams')}><Rows3 size={14} />工作流组</button>
        <button role="tab" aria-selected={view === 'nodes'} className={view === 'nodes' ? 'active' : ''} onClick={() => setView('nodes')}><List size={14} />节点</button>
      </div>
      <div className="workflow-workbench-actions">
        <button className="icon-button" title="紧凑密度" aria-label="紧凑密度" aria-pressed={density === 'compact'} onClick={() => setDensity('compact')}><Maximize2 size={14} /></button>
        <button className="icon-button" title="舒适密度" aria-label="舒适密度" aria-pressed={density === 'comfortable'} onClick={() => setDensity('comfortable')}><Rows3 size={14} /></button>
        <button className="icon-button" title="查看上下文" aria-label="查看上下文" onClick={onViewContext}><Network size={14} /></button>
        <button className="button" disabled={replanDisabled} onClick={onReplan}>重新规划</button>
      </div>
    </div>
    {view === 'canvas' && <WorkflowCanvas graph={graph} density={density} selectedId={selectedId} onSelect={onSelect} />}
    {view === 'workstreams' && <div className="workflow-row-list">{workstreams.map((row) => <button type="button" aria-pressed={row.id === selectedId} className="workflow-row" key={row.id} onClick={() => onSelect?.(row.id)}><span><strong>{row.title}</strong><small>{row.goal || '工作流组'} · {(row.tasks as unknown[] | undefined)?.length || tasks.filter((task) => task.parent_id === row.id).length} 个任务</small></span><code>{row.id}</code></button>)}{!workstreams.length && <div className="list-empty">暂无工作流组</div>}</div>}
    {view === 'nodes' && <div className="workflow-row-list">{rows.map((row) => <button type="button" aria-pressed={row.id === selectedId} className="workflow-row" key={row.id} onClick={() => onSelect?.(row.id)}><span><strong>{row.title}</strong><small>{nodeKindLabel(row.kind)}{row.parent_id ? ` · 父节点 ${row.parent_id}` : ''} · {(row.deps || []).length} 个依赖</small></span><code>{row.id}</code></button>)}{!rows.length && <div className="list-empty">暂无节点</div>}</div>}
  </div>;
}

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
export type EditableWorkflowGraph = { nodes: WorkflowEditorNode[]; [key: string]: unknown };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const checks = ['node_test', 'git_diff_check'];
const capabilities = ['workspace:read', 'workspace:write', 'network:none', 'network:model', 'check:node_test', 'check:git_diff_check'];
export function parseWorkflowGraph(source: string): EditableWorkflowGraph | null {
  try { const graph: unknown = JSON.parse(source); return record(graph) && Array.isArray(graph.nodes) ? graph as EditableWorkflowGraph : null; } catch { return null; }
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

const list = (source: string) => source === '' ? [] : source.split('\n');

export function WorkflowEditor({ source, onChange, busy, onContext, onReplan, replanDisabled, initialView }: {
  source: string; onChange: (source: string) => void; busy: boolean; onContext: () => void; onReplan: () => void;
  replanDisabled: boolean; initialView: 'canvas' | 'workstreams' | 'nodes';
}) {
  const graph = useMemo(() => parseWorkflowGraph(source), [source]);
  const issues = useMemo(() => validateWorkflowGraph(graph), [graph]);
  const [selectedId, setSelectedId] = useState('');
  const editable = Boolean(graph && graph.nodes.every(node => node && typeof node === 'object' && !Array.isArray(node) && typeof node.id === 'string' && typeof node.title === 'string'));
  const nodes = editable ? graph!.nodes : [];
  const selected = nodes.find(node => node.id === selectedId);
  const write = (next: WorkflowEditorNode[]) => onChange(JSON.stringify({ ...graph, nodes: next }, null, 2));
  const update = (patch: Partial<WorkflowEditorNode>) => write(nodes.map(node => node.id === selectedId ? { ...node, ...patch } : node));
  const add = (kind: 'workstream' | 'task') => { const node = newWorkflowNode(kind, nodes); write([...nodes, node]); setSelectedId(node.id); };
  const children = nodes.filter(node => node.parent_id === selectedId);
  const dependents = nodes.filter(node => node.depends_on?.includes(selectedId));
  const remove = () => { if (!selected || children.length) return; write(nodes.filter(node => node.id !== selectedId).map(node => ({ ...node, depends_on: node.depends_on?.filter(dep => dep !== selectedId) || [] }))); setSelectedId(''); };
  return <div className="workflow-structured-editor">
    <WorkflowWorkbench graph={graph} initialView={initialView} selectedId={selectedId} onSelect={setSelectedId} onViewContext={onContext} onReplan={onReplan} replanDisabled={busy || replanDisabled} />
    <div className="form-actions"><button className="button" disabled={busy || !editable} onClick={() => add('workstream')}>新增工作流组</button><button className="button" disabled={busy || !editable} onClick={() => add('task')}>新增 Task</button></div>
    {selected && <fieldset className="workflow-node-editor" disabled={busy}><legend>节点详情 · {selected.id}</legend>
      <label><span>节点标题</span><input aria-label="节点标题" value={selected.title} onChange={event => update({ title: event.target.value })} /></label>
      <p>类型：{selected.kind === 'workstream' ? '工作流组' : 'Task'}</p>
      <label><span>节点目标</span><textarea aria-label="节点目标" rows={2} value={selected.config?.goal || String(selected.goal || '')} onChange={event => update({ config: { ...selected.config, goal: event.target.value } })} /></label>
      <label><span>父工作流组</span><select aria-label="父工作流组" value={selected.parent_id || ''} onChange={event => update({ parent_id: event.target.value || null })}><option value="">无</option>{nodes.filter(node => node.kind === 'workstream' && node.id !== selected.id).map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label>
      <label><span>依赖 ID（每行一个）</span><textarea aria-label="依赖 ID（每行一个）" rows={2} value={Array.isArray(selected.depends_on) ? selected.depends_on.join('\n') : ''} onChange={event => update({ depends_on: list(event.target.value) })} /></label>
      {selected.kind === 'task' && <ExecutionFields key={selected.id} node={selected} onChange={update} />}
      {children.length > 0 && <p className="prerequisite-note">删除前请为 {children.map(node => node.title).join('、')} 选择其他父工作流组或删除子节点。</p>}
      {dependents.length > 0 && <p>删除时同步清理 {dependents.map(node => node.title).join('、')} 对本节点的依赖。</p>}
      <button className="button danger" disabled={children.length > 0} onClick={remove}>删除节点</button>
    </fieldset>}
    <details className="workflow-json-editor"><summary>高级 JSON 编辑</summary><label><span>图谱 JSON</span><textarea aria-label="图谱 JSON" rows={9} spellCheck={false} value={source} disabled={busy} onChange={event => onChange(event.target.value)} /></label></details>
    {issues.length > 0 && <div className="workflow-validation" role="alert"><strong>保存前请处理：</strong><ul>{issues.map((issue, index) => <li key={index}>{issue.path}：{issue.message}</li>)}</ul></div>}
  </div>;
}

function ExecutionFields({ node, onChange }: { node: WorkflowEditorNode; onChange: (patch: Partial<WorkflowEditorNode>) => void }) {
  const execution = node.config?.execution;
  const set = (patch: Partial<WorkflowExecutionConfig>) => onChange({ config: { ...node.config, execution: { ...execution, ...patch } as WorkflowExecutionConfig } });
  return <>
    <label><span>执行模式</span><select aria-label="执行模式" value={execution?.mode || ''} onChange={event => set({ mode: event.target.value })}><option value="">选择模式</option><option value="read">read</option><option value="write">write</option></select></label>
    <label><span>命令参数（每行一个参数）</span><textarea aria-label="命令参数（每行一个参数）" rows={4} value={Array.isArray(execution?.argv) ? execution.argv.join('\n') : ''} onChange={event => set({ argv: list(event.target.value) })} /></label>
    <p className="prerequisite-note">第一行为命令；后续每行保留为一个完整参数，包括其中的空格与引号。</p>
    {(['input_paths', 'output_paths', 'capabilities', 'check_ids'] as const).map(key => <label key={key}><span>{{ input_paths: '输入路径', output_paths: '输出路径', capabilities: '能力', check_ids: '检查 ID' }[key]}（每行一个）</span><textarea aria-label={`${{ input_paths: '输入路径', output_paths: '输出路径', capabilities: '能力', check_ids: '检查 ID' }[key]}（每行一个）`} rows={2} value={Array.isArray(execution?.[key]) ? execution[key].join('\n') : ''} onChange={event => set({ [key]: list(event.target.value) })} /></label>)}
    <label><span>截止时间（秒）</span><input aria-label="截止时间（秒）" type="number" min={1} max={900} value={execution?.deadline_seconds ?? ''} onChange={event => set({ deadline_seconds: Number(event.target.value) })} /></label>
    <label><span>资源配置</span><select aria-label="资源配置" value={execution?.resource_profile || ''} onChange={event => set({ resource_profile: event.target.value })}><option value="">选择资源配置</option><option value="light">light</option><option value="standard">standard</option></select></label>
    <label><span>验收检查（与检查 ID 一致）</span><textarea aria-label="验收检查（与检查 ID 一致）" rows={2} value={Array.isArray(node.contract?.acceptance) ? node.contract.acceptance.join('\n') : ''} onChange={event => onChange({ contract: { ...node.contract, acceptance: list(event.target.value) } })} /></label>
  </>;
}
