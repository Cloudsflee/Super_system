import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  ArrowUpRight,
  CircleAlert,
  FileOutput,
  GitBranch,
  ListChecks,
  MoreHorizontal,
  ShieldCheck,
  Sparkles
} from 'lucide-react';
import { useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconButton } from '../../../components/common/IconButton';
import { useContextMenu, useContextMenuResolver } from '../../../components/common/ContextMenu';
import { useUi } from '../../../state/ui';
import type { CanvasNode } from './node-types';
import { nodeLabels, nodeStatusLabel, normalizeNodeStatus } from './node-types';
import { workflowNodeActions, type WorkflowNodeActionHandlers } from './workflow-node-actions';

export function WorkspaceNode({ data, selected }: NodeProps<CanvasNode>) {
  const node = data.record;
  const ui = useUi(),
    navigate = useNavigate(),
    menu = useContextMenu(),
    more = useRef<HTMLButtonElement>(null);
  const running =
    normalizeNodeStatus(node.status) === 'running' || normalizeNodeStatus(node.latest_run?.status) === 'running';
  const fallback = useMemo<WorkflowNodeActionHandlers>(
    () => ({
      view: () => ui.inspect(node.id),
      enter: () => navigate(`/projects/${data.projectId}/workflow/${node.id}`),
      assist: () => {
        ui.setContextNode(node.id);
        ui.setAssist(true);
        window.dispatchEvent(
          new CustomEvent('aiws:assist-prefill', { detail: { prompt: `优化工作流节点“${node.title}”：` } })
        );
      },
      edit: () => ui.inspect(node.id),
      remove: () => undefined
    }),
    [data.projectId, navigate, node.id, node.title, ui]
  );
  const handlers = data.actions || fallback;
  const actions = useMemo(() => workflowNodeActions(node, handlers), [handlers, node]);
  useContextMenuResolver(
    useCallback(
      (context) =>
        context.target.closest<HTMLElement>('[data-workflow-node-id]')?.dataset.workflowNodeId === node.id
          ? actions
          : [],
      [actions, node.id]
    )
  );
  function stop(event: React.SyntheticEvent) {
    event.stopPropagation();
  }
  function openMenu() {
    const trigger = more.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    menu.open(actions, { x: rect.right - 8, y: rect.bottom + 5 }, trigger);
  }
  return (
    <article
      className={`workspace-node${selected ? ' selected' : ''}${running ? ' running' : ''}`}
      data-workflow-node-id={node.id}
      tabIndex={0}
    >
      <Handle type="target" position={Position.Left} />
      <header>
        <span>{node.role === 'workstream' ? workstreamLabel(node.category) : nodeLabels[node.type] || '任务'}</span>
        <i className={`node-state ${normalizeNodeStatus(node.status)}`}>{nodeStatusLabel(node.status)}</i>
      </header>
      <h3>{node.title}</h3>
      <p>{node.outcome || node.goal || '尚未定义可验收成果'}</p>
      <footer>
        <span data-tooltip="任务进度">
          <ListChecks size={12} />
          {node.completed_task_count || 0}/{node.task_count || 0}
        </span>
        <span data-tooltip="阻塞任务">
          <CircleAlert size={12} />
          {node.blocked_count || 0}
        </span>
        <span data-tooltip="输出">
          <FileOutput size={12} />
          {node.output_count || 0}
        </span>
        <span data-tooltip="待审批">
          <ShieldCheck size={12} />
          {node.pending_approval_count || 0}
        </span>
        <span data-tooltip="仓库目标">
          <GitBranch size={12} />
          {node.repository_status?.ready_count || 0}/{node.repository_status?.target_count || 0}
        </span>
      </footer>
      <div className="node-quick-actions nodrag" onPointerDown={stop} onClick={stop}>
        <IconButton label="进入工作区" onClick={handlers.enter}>
          <ArrowUpRight size={14} />
        </IconButton>
        <IconButton label="让智能助手优化" onClick={handlers.assist}>
          <Sparkles size={14} />
        </IconButton>
        <IconButton ref={more} label="更多节点操作" aria-haspopup="menu" onClick={openMenu}>
          <MoreHorizontal size={15} />
        </IconButton>
      </div>
      <Handle type="source" position={Position.Right} />
    </article>
  );
}

function workstreamLabel(value?: string | null) {
  return (
    (
      { deliverable: '交付成果', decision: '关键决策', coordination: '协同成果', operation: '运营成果' } as Record<
        string,
        string
      >
    )[value || ''] || '成果节点'
  );
}
