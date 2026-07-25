import { ArrowUpRight, Eye, Pencil, Sparkles, Trash2 } from 'lucide-react';
import type { WorkflowNode } from '../../../api/types';
import type { ContextMenuAction } from '../../../components/common/ContextMenu';

export type WorkflowNodeActionHandlers = {
  view: () => void;
  enter: () => void;
  assist: () => void;
  edit: () => void;
  remove: () => void;
};

export function workflowNodeActions(node: WorkflowNode, handlers: WorkflowNodeActionHandlers): ContextMenuAction[] {
  return [
    { id: `workflow-node.${node.id}.view`, label: '查看详情', icon: Eye, onSelect: handlers.view },
    { id: `workflow-node.${node.id}.enter`, label: '进入工作区', icon: ArrowUpRight, onSelect: handlers.enter },
    { id: `workflow-node.${node.id}.assist`, label: '让智能助手优化', icon: Sparkles, onSelect: handlers.assist },
    { id: `workflow-node.${node.id}.separator`, label: '', separator: true, onSelect: () => undefined },
    { id: `workflow-node.${node.id}.edit`, label: '编辑节点', icon: Pencil, onSelect: handlers.edit },
    { id: `workflow-node.${node.id}.remove`, label: '移除节点', icon: Trash2, danger: true, onSelect: handlers.remove }
  ];
}
