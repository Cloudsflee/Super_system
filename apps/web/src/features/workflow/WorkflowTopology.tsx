import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WorkflowNode } from '../../api/types';

export type TopologyRelation = 'neutral' | 'active' | 'upstream' | 'downstream' | 'unrelated';
type TopologyEdge = { sourceId: string; targetId: string };
type AnchorPoint = { x: number; y: number };
type EdgePath = TopologyEdge & { d: string; source: AnchorPoint; target: AnchorPoint };

export function buildTaskTopologyFocus(tasks: WorkflowNode[], activeTaskId: string | null) {
  const ids = new Set(tasks.map((task) => task.id));
  const localActiveTaskId = activeTaskId && ids.has(activeTaskId) ? activeTaskId : null;
  const dependencies = new Map(tasks.map((task) => [task.id, taskDependencyIds(task).filter((id) => ids.has(id))]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  for (const [targetId, sourceIds] of dependencies) for (const sourceId of sourceIds) dependents.get(sourceId)?.push(targetId);
  const upstream = localActiveTaskId ? collectRelated(localActiveTaskId, dependencies) : new Set<string>();
  const downstream = localActiveTaskId ? collectRelated(localActiveTaskId, dependents) : new Set<string>();
  const relations = new Map(tasks.map((task) => [task.id, !localActiveTaskId ? 'neutral' : task.id === localActiveTaskId ? 'active' : upstream.has(task.id) ? 'upstream' : downstream.has(task.id) ? 'downstream' : 'unrelated'] as const));
  return { activeTaskId: localActiveTaskId, upstream, downstream, relations };
}

export function WorkflowTopologyLayer({ tasks, activeTaskId, layoutRevision = '' }: { tasks: WorkflowNode[]; activeTaskId: string | null; layoutRevision?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const edges = useMemo(() => topologyEdges(tasks), [tasks]);
  const focus = useMemo(() => buildTaskTopologyFocus(tasks, activeTaskId), [tasks, activeTaskId]);
  const [layout, setLayout] = useState<{ width: number; height: number; paths: EdgePath[] }>({ width: 1, height: 1, paths: [] });

  useLayoutEffect(() => {
    const svg = svgRef.current, container = svg?.parentElement;
    if (!svg || !container) return;
    let frame = 0;
    const update = () => {
      const containerRect = container.getBoundingClientRect();
      const rows = new Map([...container.querySelectorAll<HTMLElement>('[data-task-id]')].map((row) => [row.dataset.taskId || '', row]));
      const width = Math.max(1, container.clientWidth || containerRect.width), height = Math.max(1, container.scrollHeight || containerRect.height);
      const anchorPoint = (taskId: string): AnchorPoint => {
        const anchor = rows.get(taskId)?.querySelector<HTMLElement>('[data-topology-anchor]');
        const rect = anchor?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return { x: rect.left - containerRect.left + rect.width / 2, y: rect.top - containerRect.top + rect.height / 2 };
      };
      const paths = edges.map((edge, index) => {
        const source = anchorPoint(edge.sourceId), target = anchorPoint(edge.targetId), direction = target.y >= source.y ? 1 : -1;
        const bend = Math.min(38, Math.max(12, Math.abs(target.y - source.y) * .22)), laneX = Math.max(5, Math.min(source.x, target.x) - 16 - index % 3 * 5);
        return { ...edge, source, target, d: `M ${source.x} ${source.y} C ${laneX} ${source.y + direction * bend}, ${laneX} ${target.y - direction * bend}, ${target.x} ${target.y}` };
      });
      setLayout({ width, height, paths });
    };
    const schedule = () => {
      if (frame) return;
      if (window.requestAnimationFrame) frame = window.requestAnimationFrame(() => { frame = 0; update(); });
      else frame = window.setTimeout(() => { frame = 0; update(); }, 0);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(container); container.querySelectorAll<HTMLElement>('[data-task-id], [data-topology-anchor]').forEach((element) => observer?.observe(element));
    window.addEventListener('resize', schedule); update();
    return () => { observer?.disconnect(); if (frame) { if (window.cancelAnimationFrame) window.cancelAnimationFrame(frame); else window.clearTimeout(frame); } window.removeEventListener('resize', schedule); };
  }, [edges, layoutRevision, tasks]);

  return <svg ref={svgRef} className={`workflow-topology-layer${activeTaskId ? ' focused' : ''}`} width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
    {layout.paths.map((edge) => <path key={`${edge.sourceId}-${edge.targetId}`} className={`workflow-topology-edge ${edgeRelation(focus, edge)}`} data-source-id={edge.sourceId} data-target-id={edge.targetId} data-source-x={edge.source.x} data-source-y={edge.source.y} data-target-x={edge.target.x} data-target-y={edge.target.y} d={edge.d} vectorEffect="non-scaling-stroke" />)}
  </svg>;
}

function topologyEdges(tasks: WorkflowNode[]) { const ids = new Set(tasks.map((task) => task.id)); return tasks.flatMap((task) => taskDependencyIds(task).filter((id) => ids.has(id)).map((sourceId) => ({ sourceId, targetId: task.id }))); }
function taskDependencyIds(task: WorkflowNode) { return (task.dependencies || []).map((entry) => entry.node_id).filter(Boolean) as string[]; }
function collectRelated(startId: string, graph: Map<string, string[]>) { const found = new Set<string>(), pending = [...(graph.get(startId) || [])]; while (pending.length) { const id = pending.pop() as string; if (found.has(id)) continue; found.add(id); pending.push(...(graph.get(id) || [])); } return found; }
function edgeRelation(focus: ReturnType<typeof buildTaskTopologyFocus>, edge: TopologyEdge): TopologyRelation { if (!focus.activeTaskId) return 'neutral'; if (focus.upstream.has(edge.sourceId) && (edge.targetId === focus.activeTaskId || focus.upstream.has(edge.targetId))) return 'upstream'; if ((edge.sourceId === focus.activeTaskId || focus.downstream.has(edge.sourceId)) && focus.downstream.has(edge.targetId)) return 'downstream'; return 'unrelated'; }
