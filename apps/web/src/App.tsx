import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  Archive, BookOpen, ChevronDown, FolderGit2, LayoutDashboard, ListChecks, LoaderCircle,
  Menu, MessageSquare, Settings, ShieldCheck, Terminal as TerminalIcon, Users,
  Workflow, X
} from 'lucide-react';
import { apiV2 } from './api';
import { AssistPage } from './features/assist';
import { ApprovalPage } from './features/approvals';
import { ConnectionsPage } from './features/connections';
import { ContextPage, McpSettingsPage } from './features/context';
import { FilesPage } from './features/files';
import { ExecutionPage } from './features/execution';
import { IdentityAccessPage } from './features/identity';
import { ProjectWorkflowPage } from './features/project';
import { CleanSetupPage, SetupPage, type SetupState } from './features/setup';
import { TerminalPage } from './features/terminal';
import type { Project } from './types';
import type { WorkspacePageProps, WorkspaceRoute } from './workspace';

export type PageKey = WorkspaceRoute;

const NAV: Array<{ key: WorkspaceRoute; label: string; icon: ComponentType<{ size?: number }> }> = [
  { key: 'setup', label: 'Setup', icon: LayoutDashboard },
  { key: 'identity', label: 'Identity', icon: Users },
  { key: 'projects', label: 'Projects', icon: FolderGit2 },
  { key: 'workflow', label: 'Workflow', icon: Workflow },
  { key: 'context', label: 'Context', icon: BookOpen },
  { key: 'assist', label: 'Assist', icon: MessageSquare },
  { key: 'execution', label: 'Execution', icon: ListChecks },
  { key: 'terminals', label: 'Terminal', icon: TerminalIcon },
  { key: 'settings', label: 'Settings', icon: Settings }
];

const PAGE_LABELS: Record<WorkspaceRoute, string> = {
  setup: 'Setup',
  identity: 'Identity',
  projects: 'Projects',
  workflow: 'Workflow',
  context: 'Context',
  assist: 'Assist',
  execution: 'Execution',
  files: 'Files',
  terminals: 'Terminal',
  approvals: 'Approval Center',
  connections: 'Connections',
  settings: 'Settings'
};

const PAGES: Record<WorkspaceRoute, ComponentType<WorkspacePageProps>> = {
  setup: CleanSetupPage,
  identity: IdentityAccessPage,
  projects: (props) => <ProjectWorkflowPage {...props} initialSection="overview" />,
  workflow: (props) => <ProjectWorkflowPage {...props} initialSection="workflow" />,
  context: ContextPage,
  assist: AssistPage,
  execution: ExecutionPage,
  files: FilesPage,
  terminals: TerminalPage,
  approvals: ApprovalPage,
  connections: ConnectionsPage,
  settings: McpSettingsPage
};

const ROUTES = new Set<WorkspaceRoute>(Object.keys(PAGES) as WorkspaceRoute[]);
const SETUP_GATED_PAGES = new Set<WorkspaceRoute>([...ROUTES].filter((route) => route !== 'setup'));

function routeFromHash(): WorkspaceRoute {
  const route = location.hash.replace(/^#\/?/, '') as WorkspaceRoute;
  return ROUTES.has(route) ? route : 'setup';
}

function navIsActive(nav: WorkspaceRoute, page: WorkspaceRoute) {
  return nav === page || (nav === 'assist' && page === 'files') || (nav === 'settings' && page === 'connections');
}

export function App() {
  const [page, setPage] = useState<WorkspaceRoute>(routeFromHash);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(() => sessionStorage.getItem('aiws:v3:selected-project') || '');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [setup, setSetup] = useState<Pick<SetupState, 'status' | 'complete' | 'revision'> | null>(null);
  const [pendingInteractions, setPendingInteractions] = useState(0);

  const loadProjects = useCallback(async () => {
    const response = await apiV2<{ projects: Project[] }>('/api/v2/projects');
    const rows = response.data.projects || [];
    setProjects(rows);
    setProjectId((current) => {
      const selected = rows.some((project) => project.id === current) ? current : rows[0]?.id || '';
      if (selected) sessionStorage.setItem('aiws:v3:selected-project', selected);
      return selected;
    });
  }, []);

  const refreshSetup = useCallback(async () => {
    const response = await apiV2<{ needs_setup: boolean; actor_count: number }>('/api/v2/setup');
    const state = response.data;
    const cleanState: Pick<SetupState, 'status' | 'complete' | 'revision'> = {
      status: state.needs_setup ? 'blocked' : 'ready',
      complete: !state.needs_setup,
      revision: 0
    };
    setSetup(cleanState);
    if (cleanState.status === 'ready' && cleanState.complete) await loadProjects();
    else {
      setProjects([]);
      setProjectId('');
    }
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

  useEffect(() => {
    if (!setupReady || !projectId) {
      setPendingInteractions(0);
      return;
    }
    let disposed = false;
    const load = async () => {
      try {
        const query = `?project_id=${encodeURIComponent(projectId)}&status=pending`;
        const [approvals, inputs] = await Promise.all([
          apiV2<{ approvals: unknown[] }>(`/api/v2/approvals${query}`),
          apiV2<{ inputs: unknown[] }>(`/api/v2/user-inputs${query}`)
        ]);
        if (!disposed) setPendingInteractions((approvals.data.approvals || []).length + (inputs.data.inputs || []).length);
      } catch {
        if (!disposed) setPendingInteractions(0);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [page, projectId, setupReady]);

  const navigate = useCallback((next: WorkspaceRoute) => {
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
          <button className="icon-button sidebar-close" aria-label="Close navigation" title="Close navigation" onClick={() => setMenuOpen(false)}><X size={18} /></button>
        </div>
        <nav aria-label="Workspace navigation">
          {NAV.map(({ key, label, icon: Icon }) => (
            <button key={key} className={navIsActive(key, page) ? 'nav-item active' : 'nav-item'} onClick={() => navigate(key)}>
              <Icon size={18} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot"><Archive size={15} /><span>V2.3 cold archive</span></div>
      </aside>

      <div className="workspace-shell">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="Open navigation" title="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={19} /></button>
          <div className="page-title"><span>{PAGE_LABELS[page]}</span></div>
          <label className="project-switcher">
            <span>Project</span>
            <div>
              <select value={projectId} disabled={!setupReady} onChange={(event) => selectProject(event.target.value)} aria-label="Current project">
                {!projects.length && <option value="">No project</option>}
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              <ChevronDown size={15} />
            </div>
          </label>
          <button className="topbar-approval" disabled={!setupReady} aria-label={`Approval Center, ${pendingInteractions} pending`} title="Approval Center" onClick={() => navigate('approvals')}>
            <ShieldCheck size={17} />
            {pendingInteractions > 0 && <span>{pendingInteractions > 99 ? '99+' : pendingInteractions}</span>}
          </button>
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
      {menuOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    </div>
  );
}
