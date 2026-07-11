import { Background, BackgroundVariant, MiniMap, ReactFlow, useEdgesState, useNodesState, useReactFlow, type NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, json } from '../../../api/client';
import { keys } from '../../../api/queries';
import type { ChangeProposal, NodeKind, ProjectBundle, Workflow } from '../../../api/types';
import { useUi } from '../../../state/ui';
import { CanvasToolbar } from './CanvasToolbar';
import { autoLayout, reconcileCanvasNodes, toCanvasEdges, toCanvasNodes } from './graph';
import { NodeInspector } from './NodeInspector';
import type { CanvasNode } from './node-types';
import { WorkspaceNode } from './WorkspaceNode';

const nodeTypes = { workspace: WorkspaceNode };
type Snapshot = Array<{ id: string; position: { x: number; y: number } }>;

export function WorkflowCanvas({ bundle, workflow }: { bundle: ProjectBundle; workflow: Workflow }) {
  const initial = useMemo(() => toCanvasNodes(bundle), [bundle]);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(initial);
  const [edges, setEdges] = useEdgesState(toCanvasEdges(bundle.nodes));
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const beforeDrag = useRef<Snapshot>([]);
  const dragging = useRef(false);
  const flow = useReactFlow<CanvasNode>();
  const navigate = useNavigate();
  const client = useQueryClient();
  const ui = useUi();
  const selected = bundle.nodes.find((node) => node.id === ui.inspectorNodeId);
  const contract = bundle.contracts.find((item) => item.node_id === selected?.id);
  const saveLayout = useMutation({ mutationFn: (snapshot: Snapshot) => api(`/workflows/${workflow.id}/layout`, json('PUT', { nodes: snapshot })), onError: (error) => ui.toast(`画布位置保存失败：${error.message}`, 'error') });
  const proposal = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<ChangeProposal>(`/workflows/${workflow.id}/proposals`, json('POST', body)),
    onSuccess: (result) => { client.invalidateQueries({ queryKey: keys.proposals(bundle.project.id) }); ui.showProposal(result.id); },
    onError: (error) => ui.toast(error.message, 'error')
  });

  useEffect(() => {
    setNodes((current) => reconcileCanvasNodes(current, initial, dragging.current));
    setEdges(toCanvasEdges(bundle.nodes));
    if (ui.inspectorNodeId && !bundle.nodes.some((node) => node.id === ui.inspectorNodeId)) ui.inspect(null);
  }, [initial, bundle.nodes, setEdges, setNodes, ui.inspectorNodeId]);

  function snapshot(value = nodes): Snapshot { return value.map(({ id, position }) => ({ id, position })); }
  function applyPositions(value: Snapshot) { setNodes((items) => items.map((node) => ({ ...node, position: value.find((item) => item.id === node.id)?.position || node.position }))); saveLayout.mutate(value); }
  function commit(previous: Snapshot, next: Snapshot) { setHistory((items) => [...items, previous].slice(-30)); setFuture([]); saveLayout.mutate(next); }
  function undo() { const previous = history.at(-1); if (!previous) return; setFuture((items) => [snapshot(), ...items]); setHistory((items) => items.slice(0, -1)); applyPositions(previous); }
  function redo() { const next = future[0]; if (!next) return; setHistory((items) => [...items, snapshot()]); setFuture((items) => items.slice(1)); applyPositions(next); }
  function layout() { const previous = snapshot(); const nextNodes = autoLayout(nodes); setNodes(nextNodes); commit(previous, snapshot(nextNodes)); window.setTimeout(() => flow.fitView({ padding: .18, duration: 300 }), 30); }
  function add(type: NodeKind) { proposal.mutate({ action: 'add_node', node: { type, title: defaultTitle(type), position: flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) } }); }
  function changes(value: NodeChange<CanvasNode>[]) { onNodesChange(value); }

  return (
    <section className="workflow-page">
      <div className="canvas-caption"><span>{workflow.title}</span><i>{bundle.nodes.length} 节点</i></div>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={changes} onConnect={(connection) => { if (connection.source && connection.target) proposal.mutate({ action: 'connect_nodes', source_id: connection.source, target_id: connection.target }); }} onNodeClick={(_, node) => ui.inspect(node.id)} onNodeDoubleClick={(_, node) => navigate(`/projects/${bundle.project.id}/nodes/${node.id}`)} onNodeDragStart={() => { dragging.current = true; beforeDrag.current = snapshot(); }} onNodeDragStop={() => { dragging.current = false; commit(beforeDrag.current, snapshot()); }} fitView fitViewOptions={{ padding: .22 }} minZoom={.25} maxZoom={1.8} deleteKeyCode={null} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#c7cccf" />
        <MiniMap pannable zoomable nodeColor={(node) => typeColor((node.data as CanvasNode['data']).record.type)} />
        <CanvasToolbar canUndo={history.length > 0} canRedo={future.length > 0} onAdd={add} onTemplate={() => proposal.mutate({ action: 'apply_template', template: 'five_stage' })} onAi={() => proposal.mutate({ action: 'ai_generate', goal: bundle.project.goal })} onLayout={layout} onUndo={undo} onRedo={redo} onZoomIn={() => flow.zoomIn()} onZoomOut={() => flow.zoomOut()} onFit={() => flow.fitView({ padding: .2, duration: 250 })} />
        {!nodes.length && <div className="canvas-empty"><strong>空工作流</strong><span>尚无节点</span></div>}
      </ReactFlow>
      {selected && <NodeInspector node={selected} contract={contract} projectId={bundle.project.id} />}
    </section>
  );
}

function defaultTitle(type: NodeKind) { return { goal_definition: '定义目标', research: '开展调研', analysis: '分析方案', execution: '执行任务', retrospective: '复盘沉淀' }[type]; }
function typeColor(type: string) { return { goal_definition: '#285e8e', research: '#176b52', analysis: '#8a5512', execution: '#8d3d50', retrospective: '#4f5860' }[type] || '#687176'; }
