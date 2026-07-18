import { ReactFlowProvider } from '@xyflow/react';
import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useProject } from '../../api/queries';
import { FullPageState } from '../../components/common/FullPageState';
import { useAssistSurface } from '../../components/assist/semantic-actions';
import { useUi } from '../../state/ui';
import { WorkflowCanvas } from './canvas/WorkflowCanvas';

export function WorkflowPage() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  const setProject = useUi((state) => state.setProject);
  useEffect(() => { if (projectId) setProject(projectId); }, [projectId, setProject]);
  if (project.isLoading) return <FullPageState title="正在打开工作流" />;
  if (project.isError || !project.data) return <FullPageState title="工作流加载失败" detail={project.error?.message} retry={project.refetch} />;
  if (project.data.project.status === 'draft' || project.data.project.onboarding_state !== 'confirmed') return <Navigate to={`/projects/${project.data.project.id}/onboarding`} replace />;
  const workflow = [...project.data.workflows]
    .filter((item) => item.status !== 'archived')
    .sort((left, right) => Number(right.version || 0) - Number(left.version || 0) || String(right.created_at || right.id).localeCompare(String(left.created_at || left.id)))[0];
  if (!workflow) return <FullPageState title="项目缺少工作流" detail="请重新创建项目。" />;
  if (workflow.hierarchy_mode === 'legacy' || workflow.legacy_read_only) return <FullPageState title="工作流等待两级迁移" detail="Owner 批准升级批次后，系统会在活动 Run 结束时自动重构；旧工作流保持只读。" />;
  const allNodes = project.data.nodes.filter((node) => node.workflow_id === workflow.id);
  const nodes = allNodes.filter((node) => node.role === 'workstream').map((node) => {
    const tasks = allNodes.filter((item) => item.role === 'task' && item.parent_node_id === node.id), completed = tasks.filter((item) => item.status === 'completed').length;
    return { ...node, task_count: tasks.length, completed_task_count: completed, progress: tasks.length ? completed / tasks.length : 0, blocked_count: tasks.filter((item) => item.status === 'blocked').length };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const bundle = { ...project.data, workflows: [workflow], nodes, contracts: project.data.contracts.filter((contract) => nodeIds.has(contract.node_id)) };
  return <ActiveWorkflow bundle={bundle} workflow={workflow} />;
}

function ActiveWorkflow({ bundle, workflow }: { bundle: NonNullable<ReturnType<typeof useProject>['data']>; workflow: NonNullable<ReturnType<typeof useProject>['data']>['workflows'][number] }) {
  const contextNodeId = useUi((state) => state.contextNodeId);
  const setContextNode = useUi((state) => state.setContextNode);
  useEffect(() => { if (contextNodeId && !bundle.nodes.some((item) => item.id === contextNodeId)) setContextNode(null); }, [bundle.nodes, contextNodeId, setContextNode]);
  useAssistSurface({ id: `workflow-${workflow.id}`, revision: `${workflow.id}:v${Number(workflow.workflow_revision || workflow.version || 1)}` });
  return <ReactFlowProvider><WorkflowCanvas bundle={bundle} workflow={workflow} /></ReactFlowProvider>;
}
