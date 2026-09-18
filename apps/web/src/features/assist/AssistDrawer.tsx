import type { WorkspacePageProps } from '../../workspace';
import { AssistPage } from './AssistPage';

/** Compact Assist surface used by the global workspace drawer. */
export function AssistDrawer(props: WorkspacePageProps) {
  return <AssistPage {...props} surface="drawer" />;
}
