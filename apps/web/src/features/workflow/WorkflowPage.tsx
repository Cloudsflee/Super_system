import { ReactFlowProvider } from '@xyflow/react';
import { GitPullRequest, LayoutDashboard, ListTree } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useProject } from '../../api/queries';
import type { ProjectBundle, Workflow } from '../../api/types';
import { FullPageState } from '../../components/common/FullPageState';
import { useAssistSurface } from '../../components/assist/semantic-actions';
import { useUi } from '../../state/ui';
import { WorkflowCanvas } from './canvas/WorkflowCanvas';
import { WorkflowFullProcess } from './WorkflowFullProcess';
import { WorkflowMigrationGate } from './WorkflowMigrationGate';
import { WorkflowReplanPanel } from './WorkflowReplanPanel';

type WorkflowView = 'outcomes' | 'process';

export function WorkflowPage() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  const setProject = useUi((state) => state.setProject);
  useEffect(() => { if (projectId) setProject(projectId); }, [projectId, setProject]);
  if (project.isLoading) return <FullPageState title="正在打开工作流" />;
  if (project.isError || !project.data) return <FullPageState title="工作流加载失败" detail={project.error?.message} retry={project.refetch} />;
  if (project.data.project.status === 'draft' || project.data.project.onboarding_state !== 'confirmed') return <Navigate to={`/projects/${project.data.project.id}/onboarding`} replace />;
  const workflow = [...project.data.workflows]
    .filter((item) => item.status !== 'archived')
    .sort((left, right) => Number(right.version || 0) - Number(left.version || 0) || String(right.created_at || right.id).localeCompare(String(left.created_at || left.id)))[0];
  if (!workflow) return <FullPageState title="项目缺少工作流" detail="请重新创建项目。" />;
  if (workflow.hierarchy_mode === 'legacy' || workflow.legacy_read_only) return <WorkflowMigrationGate project={project.data.project} membership={project.data.membership} workflow={workflow} />;
  const allNodes = project.data.nodes.filter((node) => node.workflow_id === workflow.id);
  const workstreamNodes = allNodes.filter((node) => node.role === 'workstream').map((node) => {
    const tasks = allNodes.filter((item) => item.role === 'task' && item.parent_node_id === node.id), completed = tasks.filter((item) => item.status === 'completed').length;
    return { ...node, task_count: tasks.length, completed_task_count: completed, progress: tasks.length ? completed / tasks.length : 0, blocked_count: tasks.filter((item) => item.status === 'blocked').length };
  });
  const allNodeIds = new Set(allNodes.map((node) => node.id)), workstreamIds = new Set(workstreamNodes.map((node) => node.id));
  const bundle: ProjectBundle = { ...project.data, workflows: [workflow], nodes: allNodes, contracts: project.data.contracts.filter((contract) => allNodeIds.has(contract.node_id)) };
  const canvasBundle: ProjectBundle = { ...bundle, nodes: workstreamNodes, contracts: bundle.contracts.filter((contract) => workstreamIds.has(contract.node_id)) };
  return <ActiveWorkflow bundle={bundle} canvasBundle={canvasBundle} workflow={workflow} />;
}

function ActiveWorkflow({ bundle, canvasBundle, workflow }: { bundle: ProjectBundle; canvasBundle: ProjectBundle; workflow: Workflow }) {
  const contextNodeId = useUi((state) => state.contextNodeId);
  const setContextNode = useUi((state) => state.setContextNode);
  const [view, setView] = useState<WorkflowView>(() => workflow.planning_quality === 'verified' ? 'process' : 'outcomes');
  const [replanOpen, setReplanOpen] = useState(false);
  useEffect(() => { if (contextNodeId && !bundle.nodes.some((item) => item.id === contextNodeId)) setContextNode(null); }, [bundle.nodes, contextNodeId, setContextNode]);
  useEffect(() => {
    if (workflow.planning_quality === 'verified') setView('process');
  }, [workflow.id, workflow.planning_quality, workflow.version, workflow.workflow_revision]);
  useAssistSurface({ id: `workflow-${workflow.id}`, revision: `${workflow.id}:v${Number(workflow.workflow_revision || workflow.version || 1)}` });
  const role = bundle.membership?.role || bundle.project.current_user_role;
  return <section className="workflow-view-shell">
    <header className="workflow-viewbar">
      <div className="workflow-view-title"><h1>{workflow.title}</h1><span>v{Number(workflow.workflow_revision || workflow.version || 1)} · {canvasBundle.nodes.length} 个成果 · {bundle.nodes.length - canvasBundle.nodes.length} 个任务</span></div>
      <div className="workflow-view-switch" role="tablist" aria-label="工作流视图">
        <button role="tab" aria-selected={view === 'outcomes'} onClick={() => setView('outcomes')}><LayoutDashboard size={15} />成果视图</button>
        <button role="tab" aria-selected={view === 'process'} onClick={() => setView('process')}><ListTree size={15} />完整流程</button>
      </div>
      <button className="button secondary workflow-replan-open" aria-expanded={replanOpen} disabled={role === 'viewer'} onClick={() => setReplanOpen((value) => !value)}><GitPullRequest size={15} />重新规划</button>
    </header>
    <div className={`workflow-view-layout ${replanOpen ? 'replan-open' : ''}`}>
      <div className="workflow-view-content">
        {view === 'outcomes' ? <ReactFlowProvider><WorkflowCanvas bundle={canvasBundle} workflow={workflow} /></ReactFlowProvider> : <WorkflowFullProcess bundle={bundle} workflow={workflow} />}
      </div>
      {replanOpen && <WorkflowReplanPanel projectId={bundle.project.id} workflow={workflow} canWrite={role !== 'viewer'} onClose={() => setReplanOpen(false)} />}
    </div>
  </section>;
}
