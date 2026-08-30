import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { List, Maximize2, Network, Rows3 } from 'lucide-react';

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
      deps: Array.isArray(item.deps) ? item.deps.map(String) : Array.isArray(item.dependencies) ? item.dependencies.map(String) : []
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

export function WorkflowCanvas({ graph, density = 'comfortable' }: { graph: WorkflowGraph | null | undefined; density?: 'compact' | 'comfortable' }) {
  const rows = useMemo(() => normalizeWorkflowNodes(graph), [graph]);
  const nodes = useMemo<Node[]>(() => rows.map((row, index) => ({
    id: row.id,
    position: { x: Number(row.position?.x || (index % 3) * 250), y: Number(row.position?.y || Math.floor(index / 3) * (density === 'compact' ? 86 : 120)) },
    data: { label: <span><strong>{row.title}</strong><small>{row.kind}{row.parent_id ? ` · ${row.parent_id}` : ''}</small></span> },
    className: row.kind === 'workstream' ? 'workflow-flow-node workstream' : 'workflow-flow-node'
  })), [density, rows]);
  const edges = useMemo(() => graphEdges(rows), [rows]);
  if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') {
    return <div className={`workflow-canvas-fallback ${density}`} data-testid="workflow-canvas" role="img" aria-label="Workflow canvas"><div className="workflow-canvas-grid">{rows.map((row) => <div className="workflow-flow-node" key={row.id}><strong>{row.title}</strong><small>{row.kind}</small></div>)}{!rows.length && <span className="list-empty">No workflow nodes</span>}</div></div>;
  }
  return <div className={`workflow-canvas ${density}`} data-testid="workflow-canvas"><ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.35} maxZoom={1.8} nodesConnectable={false} nodesDraggable={false} elementsSelectable><MiniMap pannable zoomable /><Controls showInteractive={false} /><Background gap={density === 'compact' ? 14 : 20} size={1} /></ReactFlow></div>;
}

export function WorkflowWorkbench({ graph, initialView = 'canvas', onViewContext, onReplan }: { graph: WorkflowGraph | null | undefined; initialView?: 'canvas' | 'workstreams' | 'nodes'; onViewContext?: () => void; onReplan?: () => void }) {
  const [view, setView] = useState<'canvas' | 'workstreams' | 'nodes'>(initialView);
  useEffect(() => setView(initialView), [initialView]);
  const [density, setDensity] = useState<'compact' | 'comfortable'>('comfortable');
  const rows = useMemo(() => normalizeWorkflowNodes(graph), [graph]);
  const workstreams = rows.filter((row) => row.kind === 'workstream');
  const tasks = rows.filter((row) => row.kind !== 'workstream');
  return <div className="workflow-workbench" data-testid="workflow-workbench"><div className="workflow-workbench-toolbar"><div className="segmented" role="tablist" aria-label="Workflow views"><button role="tab" aria-selected={view === 'canvas'} className={view === 'canvas' ? 'active' : ''} onClick={() => setView('canvas')}><Network size={14} />Canvas</button><button role="tab" aria-selected={view === 'workstreams'} className={view === 'workstreams' ? 'active' : ''} onClick={() => setView('workstreams')}><Rows3 size={14} />Workstreams</button><button role="tab" aria-selected={view === 'nodes'} className={view === 'nodes' ? 'active' : ''} onClick={() => setView('nodes')}><List size={14} />Nodes</button></div><div className="workflow-workbench-actions"><button className="icon-button" title="Compact density" aria-label="Compact density" aria-pressed={density === 'compact'} onClick={() => setDensity('compact')}><Maximize2 size={14} /></button><button className="icon-button" title="Comfortable density" aria-label="Comfortable density" aria-pressed={density === 'comfortable'} onClick={() => setDensity('comfortable')}><Rows3 size={14} /></button><button className="icon-button" title="View context" aria-label="View context" onClick={onViewContext}><Network size={14} /></button><button className="button" onClick={onReplan}>Replan</button></div></div>{view === 'canvas' && <WorkflowCanvas graph={graph} density={density} />}{view === 'workstreams' && <div className="workflow-row-list">{workstreams.map((row) => <div className="workflow-row" key={row.id}><span><strong>{row.title}</strong><small>{row.goal || 'Workstream'} · {(row.tasks as unknown[] | undefined)?.length || tasks.filter((task) => task.parent_id === row.id).length} tasks</small></span><code>{row.id}</code></div>)}{!workstreams.length && <div className="list-empty">No workstreams</div>}</div>}{view === 'nodes' && <div className="workflow-row-list">{rows.map((row) => <div className="workflow-row" key={row.id}><span><strong>{row.title}</strong><small>{row.kind}{row.parent_id ? ` · parent ${row.parent_id}` : ''} · {(row.deps || []).length} dependencies</small></span><code>{row.id}</code></div>)}{!rows.length && <div className="list-empty">No nodes</div>}</div>}</div>;
}
