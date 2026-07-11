import { ReactFlowProvider } from '@xyflow/react';
import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useProject } from '../../api/queries';
import { FullPageState } from '../../components/common/FullPageState';
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
  const workflow = project.data.workflows[0];
  if (!workflow) return <FullPageState title="项目缺少工作流" detail="请重新创建项目。" />;
  return <ReactFlowProvider><WorkflowCanvas bundle={project.data} workflow={workflow} /></ReactFlowProvider>;
}
