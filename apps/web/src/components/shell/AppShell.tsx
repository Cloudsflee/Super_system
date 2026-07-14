import { Bot, Menu, PanelLeftClose, ShieldCheck } from 'lucide-react';
import { lazy, Suspense, useEffect, type CSSProperties } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useProjects } from '../../api/queries';
import { useUi } from '../../state/ui';
import { IconButton } from '../common/IconButton';
import { ApprovalCenter } from '../approvals/ApprovalCenter';
import { ApprovalPrompt } from '../approvals/ApprovalPrompt';
import { NavDrawer } from './NavDrawer';
import { ToastHost } from './ToastHost';

const AssistWorkbench = lazy(() => import('../../features/assist/AssistWorkbench').then((module) => ({ default: module.AssistWorkbench })));

export function AppShell() {
  const ui = useUi();
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const projects = useProjects();
  const routeProject = projects.data?.find((item) => item.id === params.projectId);
  const selectedProject = projects.data?.find((item) => item.id === ui.activeProjectId);
  const current = routeProject || (!params.projectId ? selectedProject || projects.data?.[0] : undefined);
  const projectId = current?.id;
  const section = sectionName(location.pathname);
  const assistNodeId = params.nodeId || (location.pathname.includes('/workflow') ? ui.contextNodeId || undefined : undefined);
  const overlayOpen = ui.navOpen || ui.assistOpen || ui.approvalCenterOpen || Boolean(ui.proposalId) || Boolean(ui.inspectorNodeId);

  useEffect(() => {
    if (!overlayOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // ApprovalPrompt owns Escape because closing it must persist a defer decision.
      if (ui.proposalId) return;
      event.preventDefault();
      if (ui.navOpen) ui.setNav(false);
      else if (ui.approvalCenterOpen) ui.openApprovalCenter(false);
      else if (ui.inspectorNodeId) ui.inspect(null);
      else if (ui.assistOpen) ui.setAssist(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [overlayOpen, ui.proposalId, ui.navOpen, ui.approvalCenterOpen, ui.inspectorNodeId, ui.assistOpen, ui.setNav, ui.openApprovalCenter, ui.inspect, ui.setAssist]);

  function selectProject(id: string) {
    ui.setProject(id);
    const target = projects.data?.find((item) => item.id === id);
    const onboarding = target?.status === 'draft' || Boolean(target?.onboarding_state && target.onboarding_state !== 'confirmed');
    navigate(`/projects/${id}/${onboarding ? 'onboarding' : 'workflow'}`);
  }

  return (
    <div className={`app-shell${location.pathname.includes('/workflow') ? ' canvas-route' : ''}${ui.assistOpen && ui.assistSurface === 'docked' ? ' assist-docked' : ''}`} style={{ '--assist-dock-width': `${ui.assistDockWidth}px` } as CSSProperties}>
      <header className="app-bar">
        <IconButton label="打开导航" onClick={() => ui.setNav(true)}><Menu size={19} /></IconButton>
        <div className="brand-mark" aria-label="AI Workspace">AW</div>
        <div className="location-title"><strong>{section}</strong><span>{current?.title || 'AI Workspace'}</span></div>
        <div className="app-bar-spacer" />
        <select aria-label="当前项目" value={projectId || ''} onChange={(event) => selectProject(event.target.value)} disabled={!projects.data?.length}>
          {!projects.data?.length && <option value="">暂无项目</option>}
          {projects.data?.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
        </select>
        <IconButton label="审批队列" active={ui.approvalCenterOpen || Boolean(ui.proposalId)} onClick={() => ui.openApprovalCenter(!ui.approvalCenterOpen)}><ShieldCheck size={18} /></IconButton>
        <IconButton label="打开 Codex Assist" active={ui.assistOpen} onClick={() => ui.setAssist(!ui.assistOpen)}><Bot size={19} /></IconButton>
      </header>
      <main className="route-stage"><Outlet /></main>
      <NavDrawer />
      {ui.assistOpen && <Suspense fallback={null}><AssistWorkbench project={current} nodeId={assistNodeId} /></Suspense>}
      <ApprovalCenter projectId={projectId} />
      <ApprovalPrompt projectId={projectId} />
      <ToastHost />
      {(ui.navOpen || ui.approvalCenterOpen) && <button className="scrim" aria-label="关闭浮层" onClick={() => ui.navOpen ? ui.setNav(false) : ui.openApprovalCenter(false)}><PanelLeftClose /></button>}
    </div>
  );
}

function sectionName(pathname: string) {
  if (pathname.includes('/nodes/')) return '节点工作区';
  if (pathname.includes('/onboarding')) return '项目引导';
  if (pathname.includes('/workflow')) return '工作空间';
  if (pathname.startsWith('/assets')) return '资产';
  if (pathname.startsWith('/audit')) return '审计';
  if (pathname.startsWith('/settings')) return '设置';
  return '项目';
}
