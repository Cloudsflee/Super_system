import { McpSettings } from './McpSettings';
import type { WorkspacePageProps } from '../../workspace';

export function McpSettingsPage({ projectId, notify, navigate }: WorkspacePageProps) {
  return <div className="page settings-page">
    <div className="page-heading"><div><p className="eyebrow">范围传输访问</p><h1>MCP 与交换</h1></div></div>
    <div className="settings-tabs" role="tablist" aria-label="设置视图">
      <button className="active" aria-selected="true">MCP 与交换</button>
      <button onClick={() => navigate('connections')}>Windows Bridge</button>
    </div>
    <McpSettings projectId={projectId} notify={notify} />
  </div>;
}
