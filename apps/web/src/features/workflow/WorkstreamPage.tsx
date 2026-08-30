import { ProjectWorkflowPage } from '../project';
import type { WorkspacePageProps } from '../../workspace';
export function WorkstreamPage(props: WorkspacePageProps) { return <ProjectWorkflowPage {...props} initialSection="workflow" />; }
export default WorkstreamPage;
