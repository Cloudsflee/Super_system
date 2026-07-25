import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type NodeChange,
  type Viewport
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PanelRightOpen } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, json } from '../../../api/client';
import { keys } from '../../../api/queries';
import type { ChangeProposal, ProjectBundle, Workflow } from '../../../api/types';
import { useUi } from '../../../state/ui';
import { CanvasToolbar } from './CanvasToolbar';
import { autoLayout, reconcileCanvasNodes, toCanvasEdges, toCanvasNodes } from './graph';
import { NodeInspector } from './NodeInspector';
import type { CanvasNode } from './node-types';
import { WorkspaceNode } from './WorkspaceNode';

const nodeTypes = { workspace: WorkspaceNode };
type Snapshot = Array<{ id: string; position: { x: number; y: number } }>;
type StoredView = { viewport: Viewport; selectedId: string | null; inspectorOpen: boolean };

export function WorkflowCanvas({ bundle, workflow }: { bundle: ProjectBundle; workflow: Workflow }) {
  const initial = useMemo(() => toCanvasNodes(bundle), [bundle]);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(initial);
  const [edges, setEdges] = useEdgesState(toCanvasEdges(bundle.nodes));
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [editNodeId, setEditNodeId] = useState<string | null>(null);
  const [compactViewport, setCompactViewport] = useState(
    () => window.matchMedia?.('(max-width: 700px)').matches || false
  );
  const beforeDrag = useRef<Snapshot>([]);
  const dragging = useRef(false);
  const storedView = useRef<StoredView | null>(readStoredView(workflow.id));
  const flow = useReactFlow<CanvasNode>();
  const navigate = useNavigate();
  const client = useQueryClient();
  const ui = useUi();
  const selected = bundle.nodes.find((node) => node.id === ui.inspectorNodeId);
  const contract = bundle.contracts.find((item) => item.node_id === selected?.id);
  const saveLayout = useMutation({
    mutationFn: (snapshot: Snapshot) =>
      api(
        `/workflows/${workflow.id}/layout`,
        json('PUT', { nodes: snapshot }, { name: '保存工作流画布位置', feedback: 'background', timeoutMs: 120_000 })
      ),
    onError: (error) => ui.toast(`画布位置保存失败：${error.message}`, 'error')
  });
  const proposal = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<ChangeProposal>(
        `/workflows/${workflow.id}/graph-proposals`,
        json(
          'POST',
          {
            ...body,
            parent_node_id: null,
            expected_revision: Number(workflow.workflow_revision || workflow.version || 1)
          },
          '创建工作流变更提案'
        )
      ),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: keys.proposals(bundle.project.id) });
      ui.showProposal(result.id);
    },
    onError: (error) => ui.toast(error.message, 'error')
  });

  useEffect(() => {
    setNodes((current) => reconcileCanvasNodes(current, initial, dragging.current));
    setEdges(toCanvasEdges(bundle.nodes));
    if (ui.inspectorNodeId && !bundle.nodes.some((node) => node.id === ui.inspectorNodeId)) ui.inspect(null);
  }, [initial, bundle.nodes, setEdges, setNodes, ui.inspectorNodeId]);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 700px)'),
      change = () => setCompactViewport(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const saved = storedView.current;
    window.setTimeout(() => {
      if (saved) {
        void flow.setViewport(saved.viewport, { duration: 0 });
        if (saved.inspectorOpen && saved.selectedId && bundle.nodes.some((item) => item.id === saved.selectedId))
          ui.inspect(saved.selectedId);
      } else flow.fitView({ padding: 0.2, minZoom: compactViewport ? 0.78 : 0.25, duration: 180 });
    }, 0);
  }, [flow]);

  function snapshot(value = nodes): Snapshot {
    return value.map(({ id, position }) => ({ id, position }));
  }
  function applyPositions(value: Snapshot) {
    setNodes((items) =>
      items.map((node) => ({ ...node, position: value.find((item) => item.id === node.id)?.position || node.position }))
    );
    saveLayout.mutate(value);
  }
  function commit(previous: Snapshot, next: Snapshot) {
    setHistory((items) => [...items, previous].slice(-30));
    setFuture([]);
    saveLayout.mutate(next);
  }
  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setFuture((items) => [snapshot(), ...items]);
    setHistory((items) => items.slice(0, -1));
    applyPositions(previous);
  }
  function redo() {
    const next = future[0];
    if (!next) return;
    setHistory((items) => [...items, snapshot()]);
    setFuture((items) => items.slice(1));
    applyPositions(next);
  }
  function layout() {
    const previous = snapshot();
    const nextNodes = autoLayout(nodes);
    setNodes(nextNodes);
    commit(previous, snapshot(nextNodes));
    window.setTimeout(() => flow.fitView({ padding: 0.18, minZoom: compactViewport ? 0.78 : 0.25, duration: 300 }), 30);
  }
  function add() {
    const position = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    proposal.mutate(createNodeProposal(position));
  }
  function changes(value: NodeChange<CanvasNode>[]) {
    onNodesChange(value);
  }
  function assistNode(node: ProjectBundle['nodes'][number]) {
    ui.inspect(node.id);
    ui.setAssist(true);
    window.dispatchEvent(
      new CustomEvent('aiws:assist-prefill', { detail: { prompt: `优化工作流节点“${node.title}”：` } })
    );
  }
  function remember(viewport = flow.getViewport(), selectedId = ui.inspectorNodeId) {
    writeStoredView(workflow.id, { viewport, selectedId, inspectorOpen: Boolean(selectedId) });
  }
  function enter(nodeId: string) {
    remember(flow.getViewport(), nodeId);
    navigate(`/projects/${bundle.project.id}/workflow/${nodeId}`);
  }
  const interactiveNodes = nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      actions: {
        view: () => {
          setEditNodeId(null);
          ui.inspect(node.id);
        },
        enter: () => enter(node.id),
        assist: () => assistNode(node.data.record),
        edit: () => {
          setEditNodeId(node.id);
          ui.inspect(node.id);
        },
        remove: () => proposal.mutate({ operations: [{ type: 'delete_node', node_id: node.id }] })
      }
    }
  }));

  return (
    <WorkflowCanvasSurface
      nodes={interactiveNodes}
      edges={edges}
      compactViewport={compactViewport}
      restoreView={!storedView.current}
      focusMode={ui.focusMode}
      selected={selected}
      contract={contract}
      contextLane={ui.contextLane}
      editNodeId={editNodeId}
      projectId={bundle.project.id}
      workflowVersion={Number(workflow.workflow_revision || workflow.version || 1)}
      canUndo={history.length > 0}
      canRedo={future.length > 0}
      onNodesChange={changes}
      onConnect={(source, target) =>
        proposal.mutate({ operations: [{ type: 'connect', node_id: target, dependency_id: source }] })
      }
      onSelect={(nodeId) => {
        setEditNodeId(null);
        ui.inspect(nodeId);
        remember(flow.getViewport(), nodeId);
      }}
      onEnter={enter}
      onDragStart={() => {
        dragging.current = true;
        beforeDrag.current = snapshot();
      }}
      onDragStop={() => {
        dragging.current = false;
        commit(beforeDrag.current, snapshot());
      }}
      onMoveEnd={remember}
      onAdd={add}
      onLayout={layout}
      onUndo={undo}
      onRedo={redo}
      onZoomIn={() => flow.zoomIn()}
      onZoomOut={() => flow.zoomOut()}
      onFit={() => flow.fitView({ padding: 0.2, minZoom: compactViewport ? 0.78 : 0.25, duration: 250 })}
      onInspect={ui.inspect}
      onEditingChange={(editing) => setEditNodeId(editing && selected ? selected.id : null)}
      onAssist={() => selected && assistNode(selected)}
    />
  );
}

function WorkflowCanvasSurface({
  nodes,
  edges,
  compactViewport,
  restoreView,
  focusMode,
  selected,
  contract,
  contextLane,
  editNodeId,
  projectId,
  workflowVersion,
  canUndo,
  canRedo,
  onNodesChange,
  onConnect,
  onSelect,
  onEnter,
  onDragStart,
  onDragStop,
  onMoveEnd,
  onAdd,
  onLayout,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onFit,
  onInspect,
  onEditingChange,
  onAssist
}: {
  nodes: CanvasNode[];
  edges: Edge[];
  compactViewport: boolean;
  restoreView: boolean;
  focusMode: boolean;
  selected?: ProjectBundle['nodes'][number];
  contract?: ProjectBundle['contracts'][number];
  contextLane: string | null;
  editNodeId: string | null;
  projectId: string;
  workflowVersion: number;
  canUndo: boolean;
  canRedo: boolean;
  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onConnect: (source: string, target: string) => void;
  onSelect: (nodeId: string) => void;
  onEnter: (nodeId: string) => void;
  onDragStart: () => void;
  onDragStop: () => void;
  onMoveEnd: (viewport: Viewport) => void;
  onAdd: () => void;
  onLayout: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onInspect: (nodeId: string | null) => void;
  onEditingChange: (editing: boolean) => void;
  onAssist: () => void;
}) {
  return (
    <section className="workflow-page">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={(connection) => {
          if (connection.source && connection.target) onConnect(connection.source, connection.target);
        }}
        onNodeClick={(_, node) => onSelect(node.id)}
        onNodeDoubleClick={(_, node) => onEnter(node.id)}
        onNodeDragStart={onDragStart}
        onNodeDragStop={onDragStop}
        onMoveEnd={(_, viewport) => onMoveEnd(viewport)}
        fitView={restoreView}
        fitViewOptions={{ padding: 0.22, minZoom: compactViewport ? 0.78 : 0.25 }}
        minZoom={0.25}
        maxZoom={1.8}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(255,255,255,.08)" />
        {!focusMode && (
          <MiniMap
            style={{ width: 145, height: 94 }}
            pannable
            zoomable
            nodeColor={(node) => typeColor((node.data as CanvasNode['data']).record.type)}
          />
        )}
        <CanvasToolbar
          canUndo={canUndo}
          canRedo={canRedo}
          onAdd={onAdd}
          onLayout={onLayout}
          onUndo={onUndo}
          onRedo={onRedo}
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
          onFit={onFit}
        />
        {!nodes.length && (
          <div className="canvas-empty">
            <strong>空工作流</strong>
            <span>尚无节点</span>
          </div>
        )}
      </ReactFlow>
      {selected && contextLane !== 'assist' && (
        <NodeInspector
          node={selected}
          contract={contract}
          projectId={projectId}
          workflowVersion={workflowVersion}
          startEditing={editNodeId === selected.id}
          onEditingChange={onEditingChange}
          onAssist={onAssist}
        />
      )}
      {selected && contextLane === 'assist' && (
        <button className="context-peek inspector-peek" onClick={() => onInspect(selected.id)}>
          <PanelRightOpen size={15} />
          <span>{selected.title}</span>
        </button>
      )}
    </section>
  );
}

function createNodeProposal(position: { x: number; y: number }) {
  return {
    operations: [
      {
        type: 'add_node',
        node: {
          role: 'workstream',
          title: '新成果节点',
          goal: '形成可独立验收的项目成果',
          outcome: '一项经过审阅且可验证的项目成果',
          category: 'deliverable',
          boundary: { deliverable: 'new_outcome' },
          acceptance_criteria: ['成果可独立审阅，并附有验收证据。'],
          dependency_ids: [],
          position,
          tasks: [
            {
              title: '完成并验证成果',
              goal: '产出成果并整理验收证据',
              task_kind: 'manual',
              execution_mode: 'manual',
              dependency_ids: []
            }
          ]
        }
      }
    ]
  };
}

function typeColor(type: string) {
  return (
    {
      goal_definition: '#285e8e',
      research: '#176b52',
      analysis: '#8a5512',
      execution: '#8d3d50',
      retrospective: '#4f5860'
    }[type] || '#687176'
  );
}
function viewKey(workflowId: string) {
  return `aiws:v19:workflow-view:${workflowId}`;
}
function readStoredView(workflowId: string): StoredView | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(viewKey(workflowId)) || 'null');
    return parsed?.viewport &&
      Number.isFinite(parsed.viewport.x) &&
      Number.isFinite(parsed.viewport.y) &&
      Number.isFinite(parsed.viewport.zoom)
      ? parsed
      : null;
  } catch {
    return null;
  }
}
function writeStoredView(workflowId: string, value: StoredView) {
  try {
    sessionStorage.setItem(viewKey(workflowId), JSON.stringify(value));
  } catch {
    /* View restoration is best effort. */
  }
}
