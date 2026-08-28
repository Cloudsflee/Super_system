import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createHashRouter, RouterProvider, useLocation, useNavigate, useRouteError } from 'react-router-dom';
import {
  Archive, BookOpen, ChevronDown, FileCheck2, FolderGit2, LayoutDashboard, ListChecks, LoaderCircle, ServerCog,
  Menu, MessageSquare, Settings, ShieldCheck, Terminal as TerminalIcon, Users,
  WifiOff, Workflow, X
} from 'lucide-react';
import { apiV2 } from './api';
import { AssistPage } from './features/assist';
import { ApprovalPage } from './features/approvals';
import { ConnectionsPage } from './features/connections';
import { ContextPage, McpSettingsPage } from './features/context';
import { FilesPage } from './features/files';
import { ExecutionPage } from './features/execution';
import { EvidencePage } from './features/evidence';
import { DeliveryPage } from './features/delivery';
import { IdentityAccessPage } from './features/identity';
import { OperationsPage } from './features/operations';
import { OutcomePage } from './features/outcome';
import { ProjectWorkflowPage } from './features/project';
import { CleanSetupPage, type SetupState } from './features/setup';
import { TerminalPage } from './features/terminal';
import type { Project } from './types';
import type { WorkspacePageProps, WorkspaceRoute } from './workspace';
import { clearWorkspaceScope, queryClient, workspaceQueryKey } from './query';
import { ProjectEventSynchronizer, type EventSyncState } from './events';
import { OutboxStatus } from './offline/OutboxStatus';

export type PageKey = WorkspaceRoute;

const NAV: Array<{ key: WorkspaceRoute; label: string; icon: ComponentType<{ size?: number }> }> = [
  { key: 'setup', label: 'Setup', icon: LayoutDashboard },
  { key: 'projects', label: 'Projects', icon: FolderGit2 },
  { key: 'brief', label: 'Brief', icon: BookOpen },
  { key: 'workflow', label: 'Workflow', icon: Workflow },
  { key: 'context', label: 'Context', icon: BookOpen },
  { key: 'assist', label: 'Assist', icon: MessageSquare },
  { key: 'execution', label: 'Execution', icon: ListChecks },
  { key: 'evidence', label: 'Evidence', icon: FileCheck2 },
  { key: 'outcome', label: 'Outcome', icon: ShieldCheck },
  { key: 'delivery', label: 'Delivery', icon: Archive },
  { key: 'operations', label: 'Operations', icon: ServerCog }
];

const ADMIN_NAV: Array<{ key: WorkspaceRoute; label: string; icon: ComponentType<{ size?: number }> }> = [
  { key: 'identity', label: 'Identity / ACL', icon: Users },
  { key: 'exchange', label: 'Exchange', icon: ShieldCheck },
  { key: 'gateway', label: 'Gateway', icon: ServerCog },
  { key: 'runner', label: 'Runner', icon: ListChecks },
  { key: 'parser', label: 'Parser', icon: FileCheck2 },
  { key: 'deployment', label: 'Deployment', icon: Archive },
  { key: 'backup', label: 'Backup / Restore', icon: Archive },
  { key: 'importer', label: 'Importer', icon: FolderGit2 },
  { key: 'terminals', label: 'Terminal', icon: TerminalIcon },
  { key: 'settings', label: 'Settings', icon: Settings }
];

const PAGE_LABELS: Record<WorkspaceRoute, string> = {
  setup: 'Setup',
  identity: 'Identity',
  projects: 'Projects',
  brief: 'Brief',
  workflow: 'Workflow',
  context: 'Context',
  assist: 'Assist',
  execution: 'Execution',
  evidence: 'Evidence',
  outcome: 'Outcome',
  delivery: 'Delivery',
  operations: 'Operations',
  files: 'Files',
  terminals: 'Terminal',
  approvals: 'Approval Center',
  connections: 'Connections',
  exchange: 'Exchange',
  gateway: 'Gateway',
  runner: 'Runner',
  parser: 'Parser',
  deployment: 'Deployment',
  backup: 'Backup & Restore',
  importer: 'Importer',
  settings: 'Settings'
};

const PAGES: Record<WorkspaceRoute, ComponentType<WorkspacePageProps>> = {
  setup: CleanSetupPage,
  identity: IdentityAccessPage,
  projects: (props) => <ProjectWorkflowPage {...props} initialSection="overview" />,
  brief: (props) => <ProjectWorkflowPage {...props} initialSection="brief" />,
  workflow: (props) => <ProjectWorkflowPage {...props} initialSection="workflow" />,
  context: ContextPage,
  assist: AssistPage,
  execution: ExecutionPage,
  evidence: EvidencePage,
  outcome: OutcomePage,
  delivery: DeliveryPage,
  operations: OperationsPage,
  files: FilesPage,
  terminals: TerminalPage,
  approvals: ApprovalPage,
  connections: ConnectionsPage,
  exchange: McpSettingsPage,
  gateway: McpSettingsPage,
  runner: ConnectionsPage,
  parser: EvidencePage,
  deployment: OperationsPage,
  backup: OperationsPage,
  importer: OperationsPage,
  settings: McpSettingsPage
};

const ROUTES = new Set<WorkspaceRoute>(Object.keys(PAGES) as WorkspaceRoute[]);
const SETUP_GATED_PAGES = new Set<WorkspaceRoute>([...ROUTES].filter((route) => route !== 'setup'));

function routeFromPath(pathname: string): WorkspaceRoute {
  const route = pathname.replace(/^\/+|\/+$/g, '') as WorkspaceRoute;
  return ROUTES.has(route) ? route : 'setup';
}

function navIsActive(nav: WorkspaceRoute, page: WorkspaceRoute) {
  return nav === page || (nav === 'assist' && page === 'files') || (nav === 'settings' && page === 'connections');
}

function WorkspaceLayout() {
  const location = useLocation();
  const routerNavigate = useNavigate();
  const page = routeFromPath(location.pathname);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(() => sessionStorage.getItem('aiws:v3:selected-project') || '');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [setup, setSetup] = useState<Pick<SetupState, 'status' | 'complete' | 'revision'> | null>(null);
  const [pendingInteractions, setPendingInteractions] = useState(0);

  const loadProjects = useCallback(async () => {
    const actorId = sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor';
    const response = await queryClient.fetchQuery({
      queryKey: workspaceQueryKey({ actorId, teamId: '', projectId: '' }, 'projects'),
      queryFn: () => apiV2<{ projects: Project[] }>('/api/v2/projects')
    });
    const rows = response.data.projects || [];
    setProjects(rows);
    setProjectId((current) => {
      const selected = rows.some((project) => project.id === current) ? current : rows[0]?.id || '';
      if (selected) sessionStorage.setItem('aiws:v3:selected-project', selected);
      return selected;
    });
  }, []);

  const refreshSetup = useCallback(async () => {
    const response = await queryClient.fetchQuery({
      queryKey: workspaceQueryKey({ actorId: 'anonymous', teamId: '', projectId: '' }, 'setup'),
      queryFn: () => apiV2<{ needs_setup: boolean; actor_count: number; bootstrap_actor_id?: string }>('/api/v2/setup')
    });
    const state = response.data;
    if (state.bootstrap_actor_id) sessionStorage.setItem('aiws:v3:actor-id', state.bootstrap_actor_id);
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
      if (SETUP_GATED_PAGES.has(page)) {
        routerNavigate('/setup', { replace: true });
      }
    });
  }, [refreshSetup]);

  const setupReady = setup?.status === 'ready' && setup.complete;

  useEffect(() => {
    if (setup && !setupReady && SETUP_GATED_PAGES.has(page)) {
      routerNavigate('/setup', { replace: true });
    }
  }, [page, setup, setupReady]);

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
      routerNavigate('/setup');
      setNotice({ tone: 'error', text: 'Complete Setup before using workspace commands.' });
      setMenuOpen(false);
      return;
    }
    routerNavigate(`/${next}`);
    setMenuOpen(false);
  }, [routerNavigate, setupReady]);

  const selectProject = useCallback((id: string) => {
    const actorId = sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor';
    const current = projects.find((item) => item.id === projectId) as Project & { team_id?: string } | undefined;
    void clearWorkspaceScope({ actorId, teamId: current?.team_id || 'default-team', projectId });
    setProjectId(id);
    sessionStorage.setItem('aiws:v3:selected-project', id);
  }, [projectId, projects]);
  const notify = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => setNotice({ text, tone }), []);
  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId), [projectId, projects]);
  const gatedPagePending = SETUP_GATED_PAGES.has(page) && !setupReady;
  const Page = gatedPagePending ? CleanSetupPage : PAGES[page];

  const [eventState, setEventState] = useState<EventSyncState>('idle');
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => { setOnline(false); setEventState('offline'); };
    const update = () => setUpdateAvailable(true);
    addEventListener('online', connected); addEventListener('offline', disconnected); addEventListener('aiws:pwa-update', update);
    return () => { removeEventListener('online', connected); removeEventListener('offline', disconnected); removeEventListener('aiws:pwa-update', update); };
  }, []);
  useEffect(() => {
    if (import.meta.env.MODE === 'test') return undefined;
    if (!setupReady || !projectId) { setEventState('idle'); return undefined; }
    let active = true;
    const actorId = sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor';
    const sync = new ProjectEventSynchronizer({ actorId, projectId, onState: (state) => { if (active) setEventState(state); } });
    void sync.start().catch((error) => {
      if (active && String((error as Error)?.message || '').includes('denied')) setEventState('denied');
    });
    return () => { active = false; sync.stop(); };
  }, [projectId, setupReady]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`}>
        <div className="brand-row">
          <div className="brand-mark">A3</div>
          <div><strong>AIWS 3.0</strong><span>Local workspace</span></div>
          <button className="icon-button sidebar-close" aria-label="Close navigation" title="Close navigation" onClick={() => setMenuOpen(false)}><X size={18} /></button>
        </div>
        <nav aria-label="Workspace navigation">
          <span className="nav-group-label">Project chain</span>
          {NAV.map(({ key, label, icon: Icon }) => (
            <button key={key} className={navIsActive(key, page) ? 'nav-item active' : 'nav-item'} onClick={() => navigate(key)}>
              <Icon size={18} /><span>{label}</span>
            </button>
          ))}
          <span className="nav-group-label">Management</span>
          {ADMIN_NAV.map(({ key, label, icon: Icon }) => (
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
          <div className="page-title"><span>{PAGE_LABELS[page]}</span>{eventState !== 'idle' && <small className={`sync-state ${eventState}`} role="status">{eventState.replaceAll('_', ' ')}</small>}</div>
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
          <OutboxStatus actorId={sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor'} teamId={String((selectedProject as Project & { team_id?: string } | undefined)?.team_id || 'default-team')} projectId={projectId} />
          {!online && <span className="network-pill offline" role="status"><WifiOff size={14} />Offline</span>}
          {updateAvailable && <button className="network-pill update" onClick={() => window.location.reload()}>Update</button>}
          <span className="local-pill"><span />127.0.0.1</span>
        </header>
        <main>
          {!online ? <div className="page offline-workspace" role="status"><WifiOff size={24} /><h1>Offline</h1></div> : gatedPagePending && !setup ? <div className="page-loader"><LoaderCircle className="spin" />Loading setup</div> : <Page
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

function RouteErrorBoundary() {
  const error = useRouteError();
  return <div className="page error-page" role="alert"><h1>Workspace route error</h1><p>{error instanceof Error ? error.message : 'The requested workspace view is unavailable.'}</p></div>;
}

export function App() {
  const [router] = useState(() => createHashRouter([
    { path: '*', element: <WorkspaceLayout />, errorElement: <RouteErrorBoundary /> }
  ]));
  useEffect(() => () => router.dispose(), [router]);
  return <QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>;
}
