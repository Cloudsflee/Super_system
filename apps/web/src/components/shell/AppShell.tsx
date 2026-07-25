import { Bot, Menu, PanelLeftClose, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useProject, useProjects } from '../../api/queries';
import { useUi } from '../../state/ui';
import { IconButton } from '../common/IconButton';
import { ApprovalCenter } from '../approvals/ApprovalCenter';
import { ApprovalPrompt } from '../approvals/ApprovalPrompt';
import { NavDrawer } from './NavDrawer';
import { ToastHost } from './ToastHost';
import { AssistCenter } from '../../features/assist/AssistCenter';
import { OperationDiagnosticsButton } from '../../operations/OperationFeedback';
import type { AssistScopeBreadcrumbItem, AssistScopeType } from '../../api/types';
import { RouteToolbarHostProvider } from './RouteToolbarHost';
import { useCompactWorkflowHeader, WorkflowHeaderActions, WorkflowProjectBreadcrumb } from './WorkflowShellHeader';

export function AppShell() {
  const ui = useUi();
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const canvasRoute = /^\/projects\/[^/]+\/workflow(?:\/|$)/.test(location.pathname);
  const projects = useProjects();
  const canvasProject = useProject(params.projectId);
  const routeProject = projects.data?.find((item) => item.id === params.projectId);
  const selectedProject = projects.data?.find((item) => item.id === ui.activeProjectId);
  const current = canvasProject.data?.project || routeProject || (!params.projectId ? selectedProject || projects.data?.[0] : undefined);
  const projectId = current?.id;
  const section = sectionName(location.pathname);
  const compactWorkflowHeader = useCompactWorkflowHeader();
  const [routeToolbarHost, setRouteToolbarHost] = useState<HTMLDivElement | null>(null);
  const commandDock = /^\/projects\/[^/]+(?:\/|$)/.test(location.pathname);
  const activeWorkflow = canvasProject.data?.workflows?.filter((item) => item.status !== 'archived').sort((left, right) => Number(right.version || 0) - Number(left.version || 0))[0];
  const allNodes = canvasProject.data?.nodes || [];
  const contextNode = allNodes.find((item) => item.id === ui.contextNodeId);
  const routeWorkstream = allNodes.find((item) => item.id === params.workstreamId && item.role === 'workstream');
  const contextualTask = params.workstreamId && contextNode?.role === 'task' && contextNode.parent_node_id === params.workstreamId ? contextNode : undefined;
  const selectedNode = params.nodeId ? allNodes.find((item) => item.id === params.nodeId) : params.workstreamId ? contextualTask || routeWorkstream : canvasRoute && contextNode?.role === 'workstream' ? contextNode : undefined;
  const selectedNodeId = selectedNode?.id;
  const assistScopeType: AssistScopeType | undefined = params.nodeId ? (selectedNode?.role === 'workstream' ? 'workstream' : 'task') : params.workstreamId ? (selectedNode?.role === 'task' ? 'task' : 'workstream') : canvasRoute ? (selectedNode?.role === 'workstream' ? 'workstream' : 'workflow') : projectId ? 'project' : undefined;
  const assistScopeId = assistScopeType === 'project' ? projectId : assistScopeType === 'workflow' ? activeWorkflow?.id : selectedNodeId;
  const scopedWorkflow = canvasProject.data?.workflows?.find((item) => item.id === selectedNode?.workflow_id) || activeWorkflow;
  const parentWorkstream = selectedNode?.role === 'task' ? allNodes.find((item) => item.id === selectedNode.parent_node_id && item.role === 'workstream') : undefined;
  const assistScopeBreadcrumb = buildAssistBreadcrumb(current, scopedWorkflow, parentWorkstream, selectedNode, assistScopeType);
  const overlayOpen = ui.navOpen || ui.assistOpen || ui.approvalCenterOpen || Boolean(ui.proposalId) || Boolean(ui.inspectorNodeId);

  useEffect(() => {
    if (routeProject?.id && routeProject.id !== ui.activeProjectId) ui.setProject(routeProject.id);
  }, [routeProject?.id, ui.activeProjectId, ui.setProject]);

  useEffect(() => {
    if (!ui.activeProjectId && current?.id) ui.setProject(current.id);
  }, [current?.id, ui.activeProjectId, ui.setProject]);

  useEffect(() => {
    if (!canvasRoute && ui.inspectorNodeId) ui.inspect(null);
  }, [canvasRoute, ui.inspectorNodeId, ui.inspect]);

  useEffect(() => {
    if (!overlayOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // ApprovalPrompt owns Escape because closing it must persist a defer decision.
      if (ui.proposalId) return;
      event.preventDefault();
      if (ui.navOpen) ui.setNav(false);
      else if (ui.approvalCenterOpen) ui.openApprovalCenter(false);
      else if (ui.contextLane === 'inspector' && ui.inspectorNodeId) ui.inspect(null);
      else if (ui.contextLane === 'assist' && ui.assistOpen) ui.setAssist(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [overlayOpen, ui.proposalId, ui.navOpen, ui.approvalCenterOpen, ui.inspectorNodeId, ui.assistOpen, ui.contextLane, ui.setNav, ui.openApprovalCenter, ui.inspect, ui.setAssist]);

  function selectProject(id: string) {
    ui.setProject(id);
    const target = projects.data?.find((item) => item.id === id);
    const onboarding = target?.status === 'draft' || Boolean(target?.onboarding_state && target.onboarding_state !== 'confirmed');
    navigate(`/projects/${id}/${onboarding ? 'onboarding' : 'workflow'}`);
  }

  return <RouteToolbarHostProvider host={routeToolbarHost}>
    <div className={`app-shell${canvasRoute ? ' canvas-route' : ''}${canvasRoute && ui.focusMode ? ' focus-mode' : ''}${commandDock && !ui.assistOpen ? ' has-command-dock' : ''}${ui.contextLane ? ` context-${ui.contextLane}` : ''}`} style={{ '--assist-dock-width': `${ui.assistDockWidth}px` } as CSSProperties}>
      <header className="app-bar">
        <IconButton className="app-nav-trigger" label="打开导航" onClick={() => ui.setNav(true)}><Menu size={19} /></IconButton>
        {canvasRoute ? <>
          <WorkflowProjectBreadcrumb projects={projects.data || []} current={current} onSelect={selectProject} />
          <div ref={setRouteToolbarHost} className="route-toolbar-host" />
          <span className="workflow-toolbar-divider" aria-hidden="true" />
          <WorkflowHeaderActions compact={compactWorkflowHeader} />
        </> : <>
          <div className="brand-mark" aria-label="AI 工作空间">AW</div>
          <div className="location-title"><strong>{section}</strong><span>{current?.title || 'AI 工作空间'}</span></div>
          <div className="app-bar-spacer" />
          <select aria-label="当前项目" value={projectId || ''} onChange={(event) => selectProject(event.target.value)} disabled={!projects.data?.length}>
            {!projects.data?.length && <option value="">暂无项目</option>}
            {projects.data?.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
          </select>
          <OperationDiagnosticsButton />
          <IconButton label="审批队列" active={ui.approvalCenterOpen || Boolean(ui.proposalId)} onClick={() => ui.openApprovalCenter(!ui.approvalCenterOpen)}><ShieldCheck size={18} /></IconButton>
          <IconButton label="打开 Codex 智能助手" active={ui.assistOpen && ui.contextLane === 'assist'} onClick={() => ui.setAssist(!(ui.assistOpen && ui.contextLane === 'assist'))}><Bot size={19} /></IconButton>
        </>}
      </header>
      <main className="route-stage"><Outlet /></main>
      <NavDrawer />
      <AssistCenter project={current} scopeType={assistScopeType} scopeId={assistScopeId} scopeBreadcrumb={assistScopeBreadcrumb} commandDock={commandDock} />
      <ApprovalCenter projectId={projectId} />
      <ApprovalPrompt projectId={projectId} />
      <ToastHost />
      {(ui.navOpen || ui.approvalCenterOpen) && <button className="scrim" aria-label="关闭浮层" onClick={() => ui.navOpen ? ui.setNav(false) : ui.openApprovalCenter(false)}><PanelLeftClose /></button>}
    </div>
  </RouteToolbarHostProvider>;
}

function buildAssistBreadcrumb(project: { id: string; title: string } | undefined, workflow: { id: string; title: string } | undefined, parent: { id: string; title: string } | undefined, node: { id: string; title: string } | undefined, scopeType?: AssistScopeType): AssistScopeBreadcrumbItem[] {
  if (!project || !scopeType) return [];
  const items: AssistScopeBreadcrumbItem[] = [{ type: 'project', id: project.id, label: project.title }];
  if (scopeType === 'project') return items;
  if (workflow) items.push({ type: 'workflow', id: workflow.id, label: workflow.title });
  if (scopeType === 'workflow') return items;
  if (scopeType === 'task' && parent) items.push({ type: 'workstream', id: parent.id, label: parent.title });
  if (node) items.push({ type: scopeType, id: node.id, label: node.title });
  return items;
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
