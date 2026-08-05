import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  Activity, Archive, Boxes, ChevronDown, ClipboardCheck, FolderGit2, LayoutDashboard,
  Menu, Settings, Workflow, X
} from 'lucide-react';
import { api } from './api';
import type { Project } from './types';
import {
  AssetsPage, AuditPage, ExecutionPage, ProjectsPage, SettingsPage, SetupPage, WorkflowPage,
  type WorkspacePageProps
} from './pages';

export type PageKey = 'setup' | 'projects' | 'workflow' | 'execution' | 'assets' | 'audit' | 'settings';

const NAV: Array<{ key: PageKey; label: string; icon: ComponentType<{ size?: number }> }> = [
  { key: 'setup', label: 'Setup', icon: LayoutDashboard },
  { key: 'projects', label: 'Projects', icon: FolderGit2 },
  { key: 'workflow', label: 'Workflow', icon: Workflow },
  { key: 'execution', label: 'Execution', icon: Activity },
  { key: 'assets', label: 'Assets', icon: Boxes },
  { key: 'audit', label: 'Audit', icon: ClipboardCheck },
  { key: 'settings', label: 'Settings', icon: Settings }
];

const PAGES: Record<PageKey, ComponentType<WorkspacePageProps>> = {
  setup: SetupPage,
  projects: ProjectsPage,
  workflow: WorkflowPage,
  execution: ExecutionPage,
  assets: AssetsPage,
  audit: AuditPage,
  settings: SettingsPage
};

function routeFromHash(): PageKey {
  const route = location.hash.replace(/^#\/?/, '') as PageKey;
  return NAV.some((item) => item.key === route) ? route : 'setup';
}

export function App() {
  const [page, setPage] = useState<PageKey>(routeFromHash);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(() => sessionStorage.getItem('aiws:v3:selected-project') || '');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const loadProjects = useCallback(async () => {
    const rows = await api<Project[]>('/api/v1/projects');
    setProjects(rows);
    setProjectId((current) => {
      const selected = rows.some((project) => project.id === current) ? current : rows[0]?.id || '';
      if (selected) sessionStorage.setItem('aiws:v3:selected-project', selected);
      return selected;
    });
  }, []);

  useEffect(() => { void loadProjects().catch(() => undefined); }, [loadProjects]);
  useEffect(() => {
    const handler = () => setPage(routeFromHash());
    addEventListener('hashchange', handler);
    return () => removeEventListener('hashchange', handler);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4200);
    return () => clearTimeout(timer);
  }, [notice]);

  const navigate = useCallback((next: PageKey) => {
    location.hash = `/${next}`;
    setPage(next);
    setMenuOpen(false);
  }, []);
  const selectProject = useCallback((id: string) => {
    setProjectId(id);
    sessionStorage.setItem('aiws:v3:selected-project', id);
  }, []);
  const notify = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => setNotice({ text, tone }), []);
  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId), [projectId, projects]);
  const Page = PAGES[page];

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`}>
        <div className="brand-row">
          <div className="brand-mark">A3</div>
          <div><strong>AIWS 3.0</strong><span>Local workspace</span></div>
          <button className="icon-button sidebar-close" aria-label="关闭导航" title="关闭导航" onClick={() => setMenuOpen(false)}><X size={18} /></button>
        </div>
        <nav aria-label="主导航">
          {NAV.map(({ key, label, icon: Icon }) => (
            <button key={key} className={page === key ? 'nav-item active' : 'nav-item'} onClick={() => navigate(key)}>
              <Icon size={18} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot"><Archive size={15} /><span>V2.3 cold archive</span></div>
      </aside>

      <div className="workspace-shell">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="打开导航" title="打开导航" onClick={() => setMenuOpen(true)}><Menu size={19} /></button>
          <div className="page-title"><span>{NAV.find((item) => item.key === page)?.label}</span></div>
          <label className="project-switcher">
            <span>Project</span>
            <div>
              <select value={projectId} onChange={(event) => selectProject(event.target.value)} aria-label="当前项目">
                {!projects.length && <option value="">No project</option>}
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              <ChevronDown size={15} />
            </div>
          </label>
          <span className="local-pill"><span />127.0.0.1</span>
        </header>
        <main>
          <Page
            projectId={projectId}
            selectedProject={selectedProject}
            selectProject={selectProject}
            refreshProjects={loadProjects}
            notify={notify}
            navigate={navigate}
          />
        </main>
      </div>
      {notice && <div className={`toast ${notice.tone}`} role="status">{notice.text}</div>}
      {menuOpen && <button className="nav-scrim" aria-label="关闭导航" onClick={() => setMenuOpen(false)} />}
    </div>
  );
}
