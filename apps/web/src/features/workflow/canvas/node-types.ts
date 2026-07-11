import type { Node } from '@xyflow/react';
import type { WorkflowNode } from '../../../api/types';

export type CanvasNodeData = { record: WorkflowNode; projectId: string } & Record<string, unknown>;
export type CanvasNode = Node<CanvasNodeData, 'workspace'>;

export const nodeLabels = {
  goal_definition: '目标', research: '调研', analysis: '分析', execution: '执行', retrospective: '复盘'
} as const;
