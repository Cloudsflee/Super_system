import { McpSettings } from './McpSettings';
import type { WorkspacePageProps } from '../../pages';

export function McpSettingsPage({ projectId, notify }: WorkspacePageProps) {
  return <div className="page settings-page">
    <div className="page-heading"><div><p className="eyebrow">Scoped transport access</p><h1>MCP &amp; Exchange</h1></div></div>
    <McpSettings projectId={projectId} notify={notify} />
  </div>;
}
