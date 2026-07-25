import type { Edge } from '@xyflow/react';
import type { ProjectBundle, WorkflowNode } from '../../../api/types';
import type { CanvasNode } from './node-types';

export function toCanvasNodes(bundle: ProjectBundle): CanvasNode[] {
  return bundle.nodes.map((record, index) => ({
    id: record.id,
    type: 'workspace',
    position: record.position || { x: 90 + (index % 4) * 270, y: 100 + Math.floor(index / 4) * 210 },
    data: { record, projectId: bundle.project.id }
  }));
}

export function toCanvasEdges(nodes: WorkflowNode[]): Edge[] {
  const ordered = [...nodes].sort((a, b) => a.order_index - b.order_index);
  return nodes.reduce<Edge[]>((result, node) => {
    node.dependencies.forEach((dependency, index) => {
      const source = dependency.node_id || ordered[dependency.node_order ?? -1]?.id;
      if (source) result.push({ id: `${source}-${node.id}-${index}`, source, target: node.id, type: 'smoothstep' });
    });
    return result;
  }, []);
}

export function autoLayout(nodes: CanvasNode[]) {
  return nodes.map((node, index) => ({
    ...node,
    position: { x: 90 + (index % 4) * 280, y: 100 + Math.floor(index / 4) * 220 }
  }));
}

export function reconcileCanvasNodes(current: CanvasNode[], incoming: CanvasNode[], preservePositions = false) {
  const existing = new Map(current.map((node) => [node.id, node]));
  return incoming.map((node) => {
    const previous = existing.get(node.id);
    return previous
      ? {
          ...previous,
          ...node,
          position: preservePositions ? previous.position : node.position,
          selected: previous.selected
        }
      : node;
  });
}
