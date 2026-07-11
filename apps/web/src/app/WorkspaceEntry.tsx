import { Navigate } from 'react-router-dom';
import { useProjects } from '../api/queries';
import { FullPageState } from '../components/common/FullPageState';
import { useUi } from '../state/ui';

export function WorkspaceEntry() {
  const projects = useProjects();
  const activeProjectId = useUi((state) => state.activeProjectId);
  if (projects.isLoading) return <FullPageState title="正在恢复工作空间" />;
  const target = projects.data?.find((item) => item.id === activeProjectId) || projects.data?.[0];
  if (!target) return <Navigate to="/projects" replace />;
  const onboarding = target.status === 'draft' || Boolean(target.onboarding_state && target.onboarding_state !== 'confirmed');
  return <Navigate to={`/projects/${target.id}/${onboarding ? 'onboarding' : 'workflow'}`} replace />;
}
