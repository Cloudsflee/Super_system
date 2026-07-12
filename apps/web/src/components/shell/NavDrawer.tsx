import { Boxes, FolderKanban, GitBranch, ScrollText, Settings, X } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useUi } from '../../state/ui';
import { IconButton } from '../common/IconButton';

export function NavDrawer() {
  const { navOpen, setNav, activeProjectId } = useUi();
  const links = [
    { to: '/projects', label: '项目', icon: FolderKanban },
    { to: activeProjectId ? `/projects/${activeProjectId}/workflow` : '/projects', label: '工作空间', icon: GitBranch },
    { to: '/assets', label: '资产', icon: Boxes },
    { to: '/audit', label: '审计', icon: ScrollText },
    { to: '/settings', label: '设置', icon: Settings }
  ];
  return (
    <aside className={`nav-drawer drawer left ${navOpen ? 'open' : ''}`} aria-hidden={!navOpen} inert={!navOpen}>
      <div className="drawer-head">
        <div><span className="overline">LOCAL WORKSPACE</span><h2>AI Workspace</h2></div>
        <IconButton label="关闭导航" onClick={() => setNav(false)}><X size={18} /></IconButton>
      </div>
      <nav className="primary-nav">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink key={label} to={to} onClick={() => setNav(false)} className={({ isActive }) => isActive ? 'active' : ''}>
            <Icon size={19} /><span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="drawer-foot"><span className="status-dot" /> JSON-local<br /><small>Owner workspace · V1.4</small></div>
    </aside>
  );
}
