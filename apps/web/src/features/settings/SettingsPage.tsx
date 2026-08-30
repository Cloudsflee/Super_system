import { useState } from 'react';
import { Activity, FileText, Network, Settings, ShieldCheck } from 'lucide-react';
import { ConnectionsPage } from '../connections';
import { McpSettingsPage } from '../context';
import { IdentityAccessPage } from '../identity';
import { BriefTemplatesPanel } from './BriefTemplatesPanel';
import type { WorkspacePageProps } from '../../workspace';

type SettingsView = 'identity' | 'provider' | 'templates' | 'exchange' | 'runtime';

const views = [
  { id: 'identity', label: '身份与权限', icon: ShieldCheck },
  { id: 'provider', label: 'Provider', icon: Activity },
  { id: 'templates', label: 'Brief templates', icon: FileText },
  { id: 'exchange', label: 'MCP / Exchange', icon: Network },
  { id: 'runtime', label: 'Runner / Bridge', icon: Settings }
] as const;

export function SettingsPage(props: WorkspacePageProps) {
  const [view, setView] = useState<SettingsView>('identity');
  return <div className="page settings-page">
    <div className="page-heading"><div><p className="eyebrow">Workspace settings</p><h1>设置</h1></div></div>
    <div className="settings-tabs" role="tablist" aria-label="设置分类">{views.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={view === id} className={view === id ? 'active' : ''} onClick={() => setView(id)}><Icon size={15} />{label}</button>)}</div>
    <div className="settings-content">
      {view === 'identity' && <IdentityAccessPage {...props} initialView="identity" />}
      {view === 'provider' && <IdentityAccessPage {...props} initialView="profiles" />}
      {view === 'templates' && <BriefTemplatesPanel notify={props.notify} />}
      {view === 'exchange' && <McpSettingsPage {...props} />}
      {view === 'runtime' && <ConnectionsPage {...props} />}
    </div>
  </div>;
}
