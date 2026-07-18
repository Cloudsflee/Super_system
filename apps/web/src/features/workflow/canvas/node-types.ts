import type { Node } from '@xyflow/react';
import type { WorkflowNode } from '../../../api/types';
import type { WorkflowNodeActionHandlers } from './workflow-node-actions';

export type CanvasNodeData = { record: WorkflowNode; projectId: string; actions?: WorkflowNodeActionHandlers } & Record<string, unknown>;
export type CanvasNode = Node<CanvasNodeData, 'workspace'>;

export const nodeLabels = {
  goal_definition: '目标', research: '调研', analysis: '分析', execution: '执行', retrospective: '复盘',
  workstream: '成果节点', task: '任务'
} as const;

export type DisplayNodeStatus = 'ready' | 'running' | 'completed' | 'blocked' | 'failed';

export function normalizeNodeStatus(value?: string): DisplayNodeStatus {
  if (['running', 'starting'].includes(value || '')) return 'running';
  if (['completed', 'succeeded', 'needs_review', 'skipped'].includes(value || '')) return 'completed';
  if (['blocked', 'partial', 'cancelled', 'stopped', 'stopping'].includes(value || '')) return 'blocked';
  if (['failed', 'rejected'].includes(value || '')) return 'failed';
  return 'ready';
}

export function nodeStatusLabel(value?: string) {
  return { ready: '就绪', running: '执行中', completed: '已完成', blocked: '已阻塞', failed: '失败' }[normalizeNodeStatus(value)];
}
