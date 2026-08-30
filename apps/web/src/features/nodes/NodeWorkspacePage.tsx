import { ProjectWorkflowPage } from '../project';
import type { WorkspacePageProps } from '../../workspace';
export function NodeWorkspacePage(props: WorkspacePageProps) { return <ProjectWorkflowPage {...props} initialSection="workflow" />; }
export default NodeWorkspacePage;
