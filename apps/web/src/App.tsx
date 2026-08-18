import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  Activity, Archive, BookOpen, Boxes, ChevronDown, ClipboardCheck, FolderGit2, LayoutDashboard,
  LoaderCircle, Menu, MessageSquare, Settings, ShieldCheck, Terminal as TerminalIcon, Workflow, X
} from 'lucide-react';
import { api } from './api';
import { ContextPage } from './features/context';
import { AssistPage } from './features/assist';
import { SetupPage, type SetupState } from './features/setup';
import { WorkflowPage as R4WorkflowPage } from './features/workflow';
import type { Project } from './types';
import {
  ApprovalPage, AssetsPage, AuditPage, ExecutionPage, ProjectsPage, SettingsPage, TerminalPage,
  type WorkspacePageProps
} from './pages';

export type PageKey = 'setup' | 'projects' | 'workflow' | 'context' | 'assist' | 'execution' | 'terminals' | 'approvals' | 'assets' | 'audit' | 'settings';

const NAV: Array<{ key: PageKey; label: string; icon: ComponentType<{ size?: number }> }> = [
  { key: 'setup', label: 'Setup', icon: LayoutDashboard },
  { key: 'projects', label: 'Projects', icon: FolderGit2 },
  { key: 'workflow', label: 'Workflow', icon: Workflow },
  { key: 'context', label: 'Context', icon: BookOpen },
  { key: 'assist', label: 'Assist', icon: MessageSquare },
  { key: 'execution', label: 'Execution', icon: Activity },
  { key: 'terminals', label: 'Terminal', icon: TerminalIcon },
  { key: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { key: 'assets', label: 'Assets', icon: Boxes },
  { key: 'audit', label: 'Audit', icon: ClipboardCheck },
  { key: 'settings', label: 'Settings', icon: Settings }
];

const PAGES: Record<PageKey, ComponentType<WorkspacePageProps>> = {
  setup: SetupPage,
  projects: ProjectsPage,
  workflow: R4WorkflowPage,
  context: ContextPage,
  assist: AssistPage,
  execution: ExecutionPage,
  terminals: TerminalPage,
  approvals: ApprovalPage,
  assets: AssetsPage,
  audit: AuditPage,
  settings: SettingsPage
};

const SETUP_GATED_PAGES = new Set<PageKey>(['projects', 'workflow', 'context', 'assist', 'execution', 'terminals', 'approvals', 'assets']);

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
  const [setup, setSetup] = useState<Pick<SetupState, 'status' | 'complete' | 'revision'> | null>(null);

  const loadProjects = useCallback(async () => {
    const rows = await api<Project[]>('/api/v1/projects');
    setProjects(rows);
    setProjectId((current) => {
      const selected = rows.some((project) => project.id === current) ? current : rows[0]?.id || '';
      if (selected) sessionStorage.setItem('aiws:v3:selected-project', selected);
      return selected;
    });
  }, []);

  const refreshSetup = useCallback(async () => {
    const state = await api<SetupState>('/api/v1/setup');
    setSetup({ status: state.status, complete: state.complete, revision: state.revision });
    if (state.status === 'ready' && state.complete) await loadProjects();
    else { setProjects([]); setProjectId(''); }
  }, [loadProjects]);

  useEffect(() => {
    void refreshSetup().catch(() => {
      setSetup(null);
      if (SETUP_GATED_PAGES.has(routeFromHash())) {
        location.hash = '/setup';
        setPage('setup');
      }
    });
  }, [refreshSetup]);
  const setupReady = setup?.status === 'ready' && setup.complete;
  useEffect(() => {
    if (setup && !setupReady && SETUP_GATED_PAGES.has(page)) {
      location.hash = '/setup';
      setPage('setup');
    }
  }, [page, setup, setupReady]);
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
    if (!setupReady && SETUP_GATED_PAGES.has(next)) {
      location.hash = '/setup';
      setPage('setup');
      setNotice({ tone: 'error', text: 'Complete Setup before using workspace commands.' });
      setMenuOpen(false);
      return;
    }
    location.hash = `/${next}`;
    setPage(next);
    setMenuOpen(false);
  }, [setupReady]);
  const selectProject = useCallback((id: string) => {
    setProjectId(id);
    sessionStorage.setItem('aiws:v3:selected-project', id);
  }, []);
  const notify = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => setNotice({ text, tone }), []);
  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId), [projectId, projects]);
  const gatedPagePending = SETUP_GATED_PAGES.has(page) && !setupReady;
  const Page = gatedPagePending && setup ? SetupPage : PAGES[page];

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
              <select value={projectId} disabled={!setupReady} onChange={(event) => selectProject(event.target.value)} aria-label="当前项目">
                {!projects.length && <option value="">No project</option>}
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              <ChevronDown size={15} />
            </div>
          </label>
          <span className="local-pill"><span />127.0.0.1</span>
        </header>
        <main>
          {gatedPagePending && !setup ? <div className="page-loader"><LoaderCircle className="spin" />Loading setup</div> : <Page
            projectId={projectId}
            selectedProject={selectedProject}
            selectProject={selectProject}
            refreshProjects={loadProjects}
            notify={notify}
            navigate={navigate}
            setupReady={setupReady}
            refreshSetup={refreshSetup}
          />}
        </main>
      </div>
      {notice && <div className={`toast ${notice.tone}`} role="status">{notice.text}</div>}
      {menuOpen && <button className="nav-scrim" aria-label="关闭导航" onClick={() => setMenuOpen(false)} />}
    </div>
  );
}
