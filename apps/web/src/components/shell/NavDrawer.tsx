import { Boxes, FolderKanban, GitBranch, ScrollText, Settings, X } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useUi } from '../../state/ui';
import { IconButton } from '../common/IconButton';

export function NavDrawer() {
  const { navOpen, setNav, activeProjectId } = useUi();
  const links = [
    { to: '/projects', label: '项目', icon: FolderKanban, end: true },
    { to: activeProjectId ? `/projects/${activeProjectId}/workflow` : '/projects', label: '工作空间', icon: GitBranch, end: false },
    { to: '/assets', label: '资产', icon: Boxes, end: false },
    { to: '/audit', label: '审计', icon: ScrollText, end: false },
    { to: '/settings', label: '设置', icon: Settings, end: false }
  ];
  return (
    <aside className={`nav-drawer drawer left ${navOpen ? 'open' : ''}`} aria-hidden={!navOpen} inert={!navOpen}>
      <div className="drawer-head">
        <div><span className="overline">本地工作空间</span><h2>AI 工作空间</h2></div>
        <IconButton label="关闭导航" onClick={() => setNav(false)}><X size={18} /></IconButton>
      </div>
      <nav className="primary-nav">
        {links.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={label} to={to} end={end} onClick={() => setNav(false)} className={({ isActive }) => isActive ? 'active' : ''}>
            <Icon size={19} /><span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="drawer-foot"><span className="status-dot" /> 本地 JSON 存储<br /><small>所有者工作空间 · V1.7</small></div>
    </aside>
  );
}
