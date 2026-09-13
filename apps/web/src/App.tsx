import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createHashRouter, RouterProvider, useLocation, useNavigate, useRouteError } from 'react-router-dom';
import {
  BookOpen, ChevronDown, FileCheck2, FolderGit2, ListChecks, LoaderCircle, Menu,
  MessageSquare, Paperclip, ServerCog, Settings, ShieldCheck, Terminal as TerminalIcon,
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
import { ProjectOnboardingPage, ProjectWorkflowPage } from './features/project';
import {
  CleanSetupPage, SystemOnboarding, hasSystemOnboardingCompletion,
  type OnboardingAccount, type OnboardingCredential, type OnboardingProfile,
  type SetupState, type SystemOnboardingSnapshot
} from './features/setup';
import { SettingsPage } from './features/settings';
import { TerminalPage } from './features/terminal';
import { FinalBusinessParityPage } from './features/p10';
import type { Project } from './types';
import type { WorkspacePageProps, WorkspaceRoute } from './workspace';
import { projectDeepLink } from './api';
export { projectDeepLink } from './api';
import { clearWorkspaceScope, queryClient, workspaceQueryKey } from './query';
import { ProjectEventSynchronizer, type EventSyncState } from './events';
import { OutboxStatus } from './offline/OutboxStatus';
import { statusLabel } from './i18n';

export type PageKey = WorkspaceRoute;

const PRIMARY_NAV: Array<{ key: WorkspaceRoute; label: string; icon: ComponentType<{ size?: number }> }> = [
  { key: 'projects', label: '项目', icon: FolderGit2 },
  { key: 'workflow', label: '工作区', icon: Workflow },
  { key: 'evidence', label: '资产', icon: FileCheck2 },
  { key: 'context', label: '上下文', icon: BookOpen },
  { key: 'operations', label: '审计', icon: ServerCog },
  { key: 'settings', label: '设置', icon: Settings }
];

const PAGE_LABELS: Record<WorkspaceRoute, string> = {
  setup: '系统配置', identity: '身份', projects: '项目', onboarding: '项目引导', brief: 'Brief', repository: '代码仓库', workflow: '工作区', context: '上下文',
  assist: 'Assist', execution: '执行', evidence: '资产', outcome: '结果', delivery: '交付', operations: '审计', files: '文件',
  terminals: '终端', approvals: '审批', connections: '连接', exchange: '交换', gateway: '网关', runner: '执行器', parser: '解析器',
  deployment: '部署', backup: '备份与恢复', importer: '导入器', settings: '设置', governance: '项目控制'
};

const PAGES: Record<WorkspaceRoute, ComponentType<WorkspacePageProps>> = {
  setup: CleanSetupPage,
  identity: IdentityAccessPage,
  projects: (props) => <ProjectWorkflowPage {...props} initialSection="overview" />,
  onboarding: ProjectOnboardingPage,
  brief: (props) => <ProjectWorkflowPage {...props} initialSection="brief" />,
  repository: (props) => <ProjectWorkflowPage {...props} initialSection="repository" />,
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
  settings: SettingsPage,
  governance: FinalBusinessParityPage
};

const ROUTES = new Set<WorkspaceRoute>(Object.keys(PAGES) as WorkspaceRoute[]);
const PROJECT_ROUTES = new Set<WorkspaceRoute>(['onboarding', 'brief', 'repository', 'workflow', 'context', 'governance', 'execution', 'assist', 'outcome', 'delivery']);
const SETTINGS_ROUTES = new Set<WorkspaceRoute>(['settings', 'identity', 'exchange', 'gateway', 'runner', 'connections']);

export function routeFromPath(pathname: string): WorkspaceRoute {
  const clean = String(pathname || '').split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, '');
  const projectTail = clean.match(/^projects\/[^/]+\/(.+)$/)?.[1] || '';
  const projectView = projectTail ? projectTail.split('/', 1)[0] : '';
  const aliases: Record<string, WorkspaceRoute> = {
    assets: 'evidence', asset: 'evidence', audit: 'operations', workstream: 'workflow', workstreams: 'workflow',
    node: 'workflow', nodes: 'workflow', repository: 'repository', terminal: 'terminals', approval: 'approvals',
    github: 'settings', 'github/install': 'settings', 'github/callback': 'settings', 'integrations/github/install/setup': 'settings', 'integrations/github/install/callback': 'settings'
  };
  const route = (aliases[projectView] || aliases[clean] || aliases[clean.split('/', 1)[0]] || projectView || clean) as WorkspaceRoute;
  return ROUTES.has(route) ? route : 'projects';
}

function navIsActive(nav: WorkspaceRoute, page: WorkspaceRoute) {
  if (nav === 'projects') return ['projects', 'onboarding', 'brief', 'repository'].includes(page);
  if (nav === 'workflow') return ['workflow', 'assist', 'execution', 'outcome', 'delivery'].includes(page);
  if (nav === 'evidence') return ['evidence', 'files', 'parser'].includes(page);
  if (nav === 'operations') return ['operations', 'deployment', 'backup', 'importer'].includes(page);
  if (nav === 'settings') return SETTINGS_ROUTES.has(page);
  return nav === page;
}

function WorkspaceLayout() {
  const location = useLocation();
  const routerNavigate = useNavigate();
  const page = routeFromPath(location.pathname);
  const deepLinkMatch = location.pathname.match(/^\/projects\/([^/]+)/);
  const deepLinkProjectId = deepLinkMatch?.[1] ? decodeURIComponent(deepLinkMatch[1]) : '';
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(() => sessionStorage.getItem('aiws:v3:selected-project') || '');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [setup, setSetup] = useState<Pick<SetupState, 'status' | 'complete' | 'revision'> | null>(null);
  const [systemSnapshot, setSystemSnapshot] = useState<SystemOnboardingSnapshot | null>(null);
  const [bootstrapLoaded, setBootstrapLoaded] = useState(false);
  const [bootstrapFailure, setBootstrapFailure] = useState('');
  const [pendingInteractions, setPendingInteractions] = useState(0);
  const [quickTool, setQuickTool] = useState<Extract<WorkspaceRoute, 'assist' | 'approvals' | 'files' | 'terminals'> | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const quickToolButtonRef = useRef<HTMLButtonElement>(null);
  const quickToolReturnFocusRef = useRef<HTMLElement | null>(null);

  const loadProjects = useCallback(async (scopeActorId?: string) => {
    const actorId = scopeActorId || sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor';
    const response = await queryClient.fetchQuery({
      queryKey: workspaceQueryKey({ actorId, teamId: '', projectId: '' }, 'projects'),
      queryFn: () => apiV2<{ projects: Project[] }>('/api/v2/projects')
    });
    const rows = response.data.projects || [];
    setProjects(rows);
    setProjectId((current) => {
      const linked = deepLinkProjectId && rows.some((project) => project.id === deepLinkProjectId) ? deepLinkProjectId : '';
      const selected = linked || (rows.some((project) => project.id === current) ? current : rows[0]?.id || '');
      if (selected) sessionStorage.setItem('aiws:v3:selected-project', selected);
      else sessionStorage.removeItem('aiws:v3:selected-project');
      return selected;
    });
    return rows;
  }, [deepLinkProjectId]);

  const refreshSetup = useCallback(async () => {
    try {
      const response = await apiV2<{ needs_setup: boolean; actor_count: number; bootstrap_actor_id?: string }>('/api/v2/setup');
      const state = response.data;
      const cleanState: Pick<SetupState, 'status' | 'complete' | 'revision'> = { status: state.needs_setup ? 'blocked' : 'ready', complete: !state.needs_setup, revision: 0 };
      setSetup(cleanState);
      if (state.needs_setup) {
        setProjects([]);
        setProjectId('');
        sessionStorage.removeItem('aiws:v3:actor-id');
        setSystemSnapshot({ needsSetup: true, account: null, credentials: [], profiles: [], projectCount: 0 });
      } else {
        const accountResult = await apiV2<{ account?: OnboardingAccount }>('/api/v2/account');
        const account = accountResult.data.account || null;
        if (account?.id) sessionStorage.setItem('aiws:v3:actor-id', account.id);
        const [rows, credentialResult, profileResult] = await Promise.all([
          loadProjects(account?.id),
          apiV2<{ credentials?: OnboardingCredential[] }>('/api/v2/credentials'),
          apiV2<{ profiles?: OnboardingProfile[] }>('/api/v2/profiles')
        ]);
        setSystemSnapshot({
          needsSetup: false,
          account,
          credentials: credentialResult.data.credentials || [],
          profiles: profileResult.data.profiles || [],
          projectCount: rows.length
        });
      }
      setBootstrapFailure('');
    } catch (error) {
      setBootstrapFailure(error instanceof Error ? error.message : '系统状态加载失败');
    } finally {
      setBootstrapLoaded(true);
    }
  }, [loadProjects]);

  useEffect(() => { void refreshSetup(); }, [refreshSetup]);

  useEffect(() => {
    if (!deepLinkProjectId || !projects.some((project) => project.id === deepLinkProjectId)) return;
    setProjectId(deepLinkProjectId);
    sessionStorage.setItem('aiws:v3:selected-project', deepLinkProjectId);
  }, [deepLinkProjectId, projects]);

  const setupReady = setup?.status === 'ready' && setup.complete;
  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId), [projectId, projects]);

  useEffect(() => {
    if (!['workflow', 'repository', 'context', 'assist', 'execution', 'outcome', 'delivery'].includes(page) || !selectedProject || selectedProject.status !== 'draft') return;
    routerNavigate(`/projects/${encodeURIComponent(selectedProject.id)}/onboarding`, { replace: true });
  }, [page, routerNavigate, selectedProject]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4200);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!setupReady || !projectId) { setPendingInteractions(0); return; }
    let disposed = false;
    const load = async () => {
      try {
        const query = `?project_id=${encodeURIComponent(projectId)}&status=pending`;
        const [approvals, inputs] = await Promise.all([
          apiV2<{ approvals: unknown[] }>(`/api/v2/approvals${query}`),
          apiV2<{ inputs: unknown[] }>(`/api/v2/user-inputs${query}`)
        ]);
        if (!disposed) setPendingInteractions((approvals.data.approvals || []).length + (inputs.data.inputs || []).length);
      } catch { if (!disposed) setPendingInteractions(0); }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [page, projectId, setupReady]);

  const closeNavigation = useCallback(() => {
    const restoreFocus = drawerRef.current?.classList.contains('is-open') === true;
    setMenuOpen(false);
    if (restoreFocus) requestAnimationFrame(() => menuButtonRef.current?.focus());
  }, []);

  const closeQuickTool = useCallback(() => {
    const returnFocus = quickToolReturnFocusRef.current;
    quickToolReturnFocusRef.current = null;
    setQuickTool(null);
    requestAnimationFrame(() => (returnFocus?.isConnected ? returnFocus : quickToolButtonRef.current)?.focus());
  }, []);

  const openQuickTool = useCallback((tool: Extract<WorkspaceRoute, 'assist' | 'approvals' | 'files' | 'terminals'>) => {
    quickToolReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuickTool(tool);
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focus = requestAnimationFrame(() => drawerRef.current?.querySelector<HTMLElement>('.nav-item')?.focus());
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeNavigation(); } };
    document.addEventListener('keydown', onKeyDown);
    return () => { cancelAnimationFrame(focus); document.body.style.overflow = priorOverflow; document.removeEventListener('keydown', onKeyDown); };
  }, [closeNavigation, menuOpen]);
  useEffect(() => {
    if (!quickTool) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeQuickTool(); } };
    document.addEventListener('keydown', onKeyDown);
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKeyDown); document.body.style.overflow = priorOverflow; };
  }, [closeQuickTool, quickTool]);

  const trapDrawerFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !drawerRef.current) return;
    const controls = [...drawerRef.current.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || !drawerRef.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !drawerRef.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  };

  const navigateProject = useCallback((id: string, next: WorkspaceRoute, query?: Record<string, string>) => {
    const project = projects.find((item) => item.id === id);
    const target = next === 'workflow' && project?.status === 'draft' ? 'onboarding' : next;
    routerNavigate(projectDeepLink(id, target, query).slice(1));
    setNotice(null);
    closeNavigation();
  }, [closeNavigation, projects, routerNavigate]);

  const navigate = useCallback((next: WorkspaceRoute) => {
    if (!setupReady && next !== 'setup') { setNotice({ tone: 'error', text: '请先完成系统配置' }); closeNavigation(); return; }
    if (PROJECT_ROUTES.has(next)) {
      if (!projectId) { routerNavigate('/projects'); setNotice({ tone: 'error', text: '请先创建项目' }); closeNavigation(); return; }
      navigateProject(projectId, next);
      return;
    }
    routerNavigate(`/${next}`);
    closeNavigation();
  }, [closeNavigation, navigateProject, projectId, routerNavigate, setupReady]);

  const selectProject = useCallback((id: string) => {
    const actorId = sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor';
    const current = projects.find((item) => item.id === projectId) as Project & { team_id?: string } | undefined;
    void clearWorkspaceScope({ actorId, teamId: current?.team_id || 'default-team', projectId });
    setProjectId(id);
    sessionStorage.setItem('aiws:v3:selected-project', id);
    if (PROJECT_ROUTES.has(page)) navigateProject(id, page);
  }, [navigateProject, page, projectId, projects]);

  const notify = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => setNotice({ text, tone }), []);
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
    if (import.meta.env.MODE === 'test' || import.meta.env.VITE_AIWS_E2E === '1') return undefined;
    if (!setupReady || !projectId) { setEventState('idle'); return undefined; }
    let active = true;
    const actorId = sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor';
    const sync = new ProjectEventSynchronizer({ actorId, projectId, onState: (state) => { if (active) setEventState(state); } });
    void sync.start().catch((error) => { if (active && String((error as Error)?.message || '').includes('denied')) setEventState('denied'); });
    return () => { active = false; sync.stop(); };
  }, [projectId, setupReady]);

  if (!bootstrapLoaded) return <div className="onboarding-loader"><LoaderCircle className="spin" size={20} />加载本地工作区</div>;
  if (bootstrapFailure && !systemSnapshot && !online) return <div className="onboarding-loader" role="status"><WifiOff size={22} />离线</div>;
  if (bootstrapFailure && !systemSnapshot) return <div className="onboarding-loader error" role="alert">{bootstrapFailure}<button className="button" onClick={() => void refreshSetup()}>重试</button></div>;

  const systemOnboardingRequired = Boolean(systemSnapshot && (!setupReady || (systemSnapshot.account && !hasSystemOnboardingCompletion(systemSnapshot))));
  if (systemSnapshot && systemOnboardingRequired) {
    return <SystemOnboarding snapshot={systemSnapshot} refresh={refreshSetup} onComplete={async () => { await refreshSetup(); routerNavigate('/projects', { replace: true }); }} />;
  }

  const Page = PAGES[page];
  const pageProps: WorkspacePageProps = { projectId, selectedProject, selectProject, refreshProjects: async () => { await loadProjects(); }, notify, navigate, navigateProject, setupReady: Boolean(setupReady), refreshSetup };
  const projectToolsDisabled = !setupReady || !projectId;

  return <div className="app-shell" data-route={page} data-setup-ready={String(setupReady)} data-setup-status={setup?.status || 'pending'}>
    {menuOpen && <button className="nav-scrim" tabIndex={-1} aria-label="关闭导航" onClick={closeNavigation} />}
    <aside ref={drawerRef} id="workspace-navigation" className={`sidebar ${menuOpen ? 'is-open' : ''}`} role="dialog" aria-modal="true" aria-label="工作区导航" aria-hidden={!menuOpen} onKeyDown={trapDrawerFocus}>
      <div className="brand-row"><div className="brand-mark">A3</div><div><strong>AIWS 3.0</strong><span>本地工作区</span></div><button tabIndex={menuOpen ? 0 : -1} className="icon-button sidebar-close" aria-label="关闭导航" title="关闭导航" onClick={closeNavigation}><X size={18} /></button></div>
      <nav aria-label="一级导航">{PRIMARY_NAV.map(({ key, label, icon: Icon }) => <button tabIndex={menuOpen ? 0 : -1} key={key} className={navIsActive(key, page) ? 'nav-item active' : 'nav-item'} onClick={() => navigate(key)}><Icon size={18} /><span>{label}</span></button>)}</nav>
      <div className="sidebar-foot"><FolderGit2 size={15} /><span>{selectedProject?.name || '未选择项目'}</span></div>
    </aside>

    <div className="workspace-shell">
      <header className="topbar">
        <button ref={menuButtonRef} className="icon-button menu-button" aria-label="打开导航" title="打开导航" aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(true)}><Menu size={19} /></button>
        <div className="page-title"><span>{PAGE_LABELS[page]}</span>{eventState !== 'idle' && <small className={`sync-state ${eventState}`} role="status">{statusLabel(eventState)}</small>}</div>
        <label className="project-switcher"><span>项目</span><div><select value={projectId} disabled={!setupReady} onChange={(event) => selectProject(event.target.value)} aria-label="当前项目">{!projects.length && <option value="">无项目</option>}{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown size={15} /></div></label>
        <div className="topbar-tools" aria-label="项目工具">
          <button ref={quickToolButtonRef} className="icon-button topbar-tool" disabled={projectToolsDisabled} aria-label="Assist" title="Assist" onClick={() => openQuickTool('assist')}><MessageSquare size={17} /></button>
          <button className="icon-button topbar-tool topbar-approval" disabled={projectToolsDisabled} aria-label={`审批中心，${pendingInteractions} 项待处理`} title="审批中心" onClick={() => openQuickTool('approvals')}><ShieldCheck size={17} />{pendingInteractions > 0 && <span>{pendingInteractions > 99 ? '99+' : pendingInteractions}</span>}</button>
          <button className="icon-button topbar-tool" disabled={projectToolsDisabled} aria-label="文件" title="文件" onClick={() => openQuickTool('files')}><Paperclip size={17} /></button>
          <button className="icon-button topbar-tool" disabled={projectToolsDisabled} aria-label="终端" title="终端" onClick={() => openQuickTool('terminals')}><TerminalIcon size={17} /></button>
          <OutboxStatus actorId={sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor'} teamId={String((selectedProject as Project & { team_id?: string } | undefined)?.team_id || 'default-team')} projectId={projectId} />
        </div>
        {!online && <span className="network-pill offline" role="status"><WifiOff size={14} />离线</span>}
        {updateAvailable && <button className="network-pill update" onClick={() => window.location.reload()}>更新</button>}
        <span className="local-pill"><span />127.0.0.1</span>
      </header>
      <main className={!online ? 'offline-main' : undefined}><Page {...pageProps} />{!online && <div className="offline-overlay" role="status"><WifiOff size={24} /><div><strong>离线</strong><small>已加载内容保留；受保护的网络操作将在恢复连接后继续。</small></div></div>}</main>
    </div>
    {quickTool && <QuickToolDrawer tool={quickTool} pageProps={pageProps} onClose={closeQuickTool} />}
    {notice && <div className={`toast ${notice.tone}`} role="status">{notice.text}</div>}
  </div>;
}

function QuickToolDrawer({ tool, pageProps, onClose }: { tool: Extract<WorkspaceRoute, 'assist' | 'approvals' | 'files' | 'terminals'>; pageProps: WorkspacePageProps; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const focus = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled)')?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !ref.current) return;
      const controls = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];
      if (!controls.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => { cancelAnimationFrame(focus); document.removeEventListener('keydown', onKeyDown, true); };
  }, []);
  const Page = PAGES[tool];
  return <div className="quick-tool-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside ref={ref} className="quick-tool-drawer" role="dialog" aria-modal="true" aria-label={`${PAGE_LABELS[tool]} 抽屉`}><header><strong>{PAGE_LABELS[tool]}</strong><div><button className="button" onClick={() => { window.location.hash = pageProps.projectId ? projectDeepLink(pageProps.projectId, tool) : `#/${tool}`; onClose(); }}>打开完整页面</button><button className="icon-button" aria-label="关闭工具抽屉" title="关闭" onClick={onClose}><X size={16} /></button></div></header><div className="quick-tool-content"><Page {...pageProps} /></div></aside></div>;
}

function RouteErrorBoundary() {
  const error = useRouteError();
  return <div className="page error-page" role="alert"><h1>工作区路由错误</h1><p>{error instanceof Error ? error.message : '请求的工作区页面不可用。'}</p></div>;
}

export function App() {
  const [router] = useState(() => createHashRouter([{ path: '*', element: <WorkspaceLayout />, errorElement: <RouteErrorBoundary /> }]));
  useEffect(() => import.meta.env.MODE === 'development' ? undefined : () => router.dispose(), [router]);
  return <QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>;
}
