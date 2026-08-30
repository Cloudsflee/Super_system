import { ProjectWorkflowPage } from '../project';
import type { WorkspacePageProps } from '../../workspace';
export function ProjectsPage(props: WorkspacePageProps) { return <ProjectWorkflowPage {...props} initialSection="overview" />; }
export default ProjectsPage;
