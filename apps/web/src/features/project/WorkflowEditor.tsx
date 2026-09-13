import { useMemo, useState } from 'react';
import { WorkflowWorkbench } from './WorkflowCanvas';
import { newWorkflowNode, parseWorkflowGraph, validateWorkflowGraph, type WorkflowEditorNode, type WorkflowExecutionConfig } from './workflowEditorModel';
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
