import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useProject } from '../../api/queries';
import type { ProjectBundle, Workflow, WorkflowExecutionSnapshot } from '../../api/types';
import { FullPageState } from '../../components/common/FullPageState';
import { RouteToolbarPortal } from '../../components/shell/RouteToolbarHost';
import { useAssistSurface } from '../../components/assist/semantic-actions';
import { useUi } from '../../state/ui';
import { WorkflowCanvas } from './canvas/WorkflowCanvas';
import { WorkflowFullProcess } from './WorkflowFullProcess';
import { WorkflowMigrationGate } from './WorkflowMigrationGate';
import { WorkflowReplanPanel } from './WorkflowReplanPanel';
import { WorkflowExecutionBar } from './WorkflowExecutionBar';
import { WorkflowRouteToolbar, type WorkflowView } from './WorkflowRouteToolbar';

export function WorkflowPage() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  const setProject = useUi((state) => state.setProject);
  useEffect(() => {
    if (projectId) setProject(projectId);
  }, [projectId, setProject]);
  if (project.isLoading) return <FullPageState title="正在打开工作流" />;
  if (project.isError || !project.data)
    return <FullPageState title="工作流加载失败" detail={project.error?.message} retry={project.refetch} />;
  if (project.data.project.status === 'draft' || project.data.project.onboarding_state !== 'confirmed')
    return <Navigate to={`/projects/${project.data.project.id}/onboarding`} replace />;
  const workflow = [...project.data.workflows]
    .filter((item) => item.status !== 'archived')
    .sort(
      (left, right) =>
        Number(right.version || 0) - Number(left.version || 0) ||
        String(right.created_at || right.id).localeCompare(String(left.created_at || left.id))
    )[0];
  if (!workflow) return <FullPageState title="项目缺少工作流" detail="请重新创建项目。" />;
  if (workflow.hierarchy_mode === 'legacy' || workflow.legacy_read_only)
    return (
      <WorkflowMigrationGate project={project.data.project} membership={project.data.membership} workflow={workflow} />
    );
  const allNodes = project.data.nodes.filter((node) => node.workflow_id === workflow.id);
  const workstreamNodes = allNodes
    .filter((node) => node.role === 'workstream')
    .map((node) => {
      const tasks = allNodes.filter((item) => item.role === 'task' && item.parent_node_id === node.id),
        completed = tasks.filter((item) => item.status === 'completed').length;
      return {
        ...node,
        task_count: tasks.length,
        completed_task_count: completed,
        progress: tasks.length ? completed / tasks.length : 0,
        blocked_count: tasks.filter((item) => item.status === 'blocked').length
      };
    });
  const allNodeIds = new Set(allNodes.map((node) => node.id)),
    workstreamIds = new Set(workstreamNodes.map((node) => node.id));
  const bundle: ProjectBundle = {
    ...project.data,
    workflows: [workflow],
    nodes: allNodes,
    contracts: project.data.contracts.filter((contract) => allNodeIds.has(contract.node_id))
  };
  const canvasBundle: ProjectBundle = {
    ...bundle,
    nodes: workstreamNodes,
    contracts: bundle.contracts.filter((contract) => workstreamIds.has(contract.node_id))
  };
  return (
    <ActiveWorkflow
      bundle={bundle}
      canvasBundle={canvasBundle}
      workflow={workflow}
      onRefresh={() => void project.refetch()}
    />
  );
}

function ActiveWorkflow({
  bundle,
  canvasBundle,
  workflow,
  onRefresh
}: {
  bundle: ProjectBundle;
  canvasBundle: ProjectBundle;
  workflow: Workflow;
  onRefresh: () => void;
}) {
  const contextNodeId = useUi((state) => state.contextNodeId);
  const setContextNode = useUi((state) => state.setContextNode);
  const taskDensity = useUi((state) => state.workflowTaskDensity);
  const setTaskDensity = useUi((state) => state.setWorkflowTaskDensity);
  const [view, setView] = useState<WorkflowView>(() =>
    workflow.planning_quality === 'verified' ? 'process' : 'outcomes'
  );
  const [replanOpen, setReplanOpen] = useState(false);
  const [execution, setExecution] = useState<WorkflowExecutionSnapshot | null>(null);
  useEffect(() => {
    if (contextNodeId && !bundle.nodes.some((item) => item.id === contextNodeId)) setContextNode(null);
  }, [bundle.nodes, contextNodeId, setContextNode]);
  useEffect(() => {
    if (workflow.planning_quality === 'verified') setView('process');
  }, [workflow.id, workflow.planning_quality, workflow.version, workflow.workflow_revision]);
  useAssistSurface({
    id: `workflow-${workflow.id}`,
    revision: `${workflow.id}:v${Number(workflow.workflow_revision || workflow.version || 1)}`
  });
  const role = bundle.membership?.role || bundle.project.current_user_role;
  return (
    <section
      className={`workflow-view-shell${workflow.planning_quality === 'verified' ? ' workflow-execution-enabled' : ''}`}
    >
      <h1 className="sr-only">{workflow.title}</h1>
      <RouteToolbarPortal>
        <WorkflowRouteToolbar
          view={view}
          density={taskDensity}
          replanOpen={replanOpen}
          canReplan={role !== 'viewer'}
          onView={setView}
          onDensity={setTaskDensity}
          onReplan={() => setReplanOpen((value) => !value)}
        />
      </RouteToolbarPortal>
      {workflow.planning_quality === 'verified' && (
        <WorkflowExecutionBar
          bundle={bundle}
          workflow={workflow}
          canWrite={role !== 'viewer'}
          onRefresh={onRefresh}
          onSnapshot={setExecution}
        />
      )}
      <div className={`workflow-view-layout ${view}-view ${replanOpen ? 'replan-open' : ''}`}>
        <div className="workflow-view-content">
          {view === 'outcomes' ? (
            <ReactFlowProvider>
              <WorkflowCanvas bundle={canvasBundle} workflow={workflow} />
            </ReactFlowProvider>
          ) : (
            <WorkflowFullProcess bundle={bundle} workflow={workflow} execution={execution} density={taskDensity} />
          )}
        </div>
        {replanOpen && (
          <WorkflowReplanPanel
            projectId={bundle.project.id}
            workflow={workflow}
            canWrite={role !== 'viewer'}
            onClose={() => setReplanOpen(false)}
          />
        )}
      </div>
    </section>
  );
}
