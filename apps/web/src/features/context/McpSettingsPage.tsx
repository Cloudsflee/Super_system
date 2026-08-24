import { McpSettings } from './McpSettings';
import type { WorkspacePageProps } from '../../workspace';

export function McpSettingsPage({ projectId, notify, navigate }: WorkspacePageProps) {
  return <div className="page settings-page">
    <div className="page-heading"><div><p className="eyebrow">Scoped transport access</p><h1>MCP &amp; Exchange</h1></div></div>
    <div className="settings-tabs" role="tablist" aria-label="Settings views">
      <button className="active" aria-selected="true">MCP &amp; Exchange</button>
      <button onClick={() => navigate('connections')}>Windows Bridge</button>
    </div>
    <McpSettings projectId={projectId} notify={notify} />
  </div>;
}
