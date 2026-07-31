import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, json } from '../../api/client';
import { keys } from '../../api/queries';
import type { ChangeProposal, NodeWorkspace } from '../../api/types';
import { useUi } from '../../state/ui';

export function useNodeWorkspaceController(nodeId?: string) {
  const [runningNode, setRunningNode] = useState(false),
    query = useQuery({
      queryKey: keys.workspace(nodeId || ''),
      queryFn: () => api<NodeWorkspace>(`/nodes/${nodeId}/workspace`),
      enabled: Boolean(nodeId),
      refetchInterval: (current) =>
        (current.state.data as NodeWorkspace | undefined)?.runs.some((run) =>
          ['queued', 'running'].includes(run.status)
        )
          ? 1000
          : false
    });
  async function executeApproved(approvalId: string, repositoryWorkspaceId?: string) {
    if (!nodeId) return;
    setRunningNode(true);
    try {
      await executeApprovedNodeRun(nodeId, approvalId, repositoryWorkspaceId);
      await query.refetch();
      useUi.getState().toast('节点运行已启动');
    } catch (error) {
      useUi.getState().toast((error as Error).message, 'error');
    } finally {
      setRunningNode(false);
    }
  }
  useApprovedNodeRunEvents(nodeId, executeApproved);
  async function runNode(repositoryWorkspaceId = query.data?.project.default_repository_workspace_id || undefined) {
    if (!query.data || runningNode) return;
    try {
      const proposal = await requestNodeRunProposal(query.data, repositoryWorkspaceId);
      useUi.getState().showProposal(proposal.id);
    } catch (error) {
      useUi.getState().toast((error as Error).message, 'error');
    }
  }
  return { query, runningNode, runNode };
}

function useApprovedNodeRunEvents(
  nodeId: string | undefined,
  executeApproved: (approvalId: string, repositoryWorkspaceId?: string) => Promise<void>
) {
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          proposal?: ChangeProposal;
          applied?: { type?: string; node_id?: string; repository_workspace_id?: string | null };
        }>
      ).detail;
      if (
        detail?.applied?.type === 'node_run_authorization' &&
        detail.applied.node_id === nodeId &&
        detail.proposal?.id
      )
        void executeApproved(detail.proposal.id, detail.applied.repository_workspace_id || undefined);
    };
    window.addEventListener('aiws:proposal-applied', listener);
    return () => window.removeEventListener('aiws:proposal-applied', listener);
  }, [nodeId]);
}

function requestNodeRunProposal(value: NodeWorkspace, repositoryWorkspaceId?: string) {
  const repositoryBinding = repositoryWorkspaceId ? { repository_workspace_id: repositoryWorkspaceId } : {};
  return api<ChangeProposal>(
    '/change-proposals',
    json(
      'POST',
      {
        project_id: value.project.id,
        workspace_id: value.workspace.id,
        node_id: value.node.id,
        change_type: 'node_run_write',
        title: `运行节点：${value.node.title}`,
        summary: 'Codex 将在固定代码仓库工作副本上执行并生成可验证资产',
        before: null,
        after: { runner: 'codex_docker', ...repositoryBinding },
        impact: ['代码仓库工作副本', '节点运行资产与执行轨迹'],
        risks: ['模型可能产生非预期文件变更'],
        apply_action: {
          type: 'node_run_authorization',
          node_id: value.node.id,
          runner: 'codex_docker',
          ...repositoryBinding
        }
      },
      '创建节点运行授权提案'
    )
  );
}

function executeApprovedNodeRun(nodeId: string, approvalId: string, repositoryWorkspaceId?: string) {
  return api(
    `/nodes/${nodeId}/run/start`,
    json(
      'POST',
      {
        runner: 'codex_docker',
        approval_id: approvalId,
        ...(repositoryWorkspaceId ? { repository_workspace_id: repositoryWorkspaceId } : {})
      },
      '启动节点运行'
    )
  );
}
