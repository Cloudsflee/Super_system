import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, ArrowUp, Bot, GitBranch } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { api, json } from '../../api/client';
import { keys, useProject } from '../../api/queries';
import type { ChangeProposal, Project, TaskKind, Workflow, WorkflowNode } from '../../api/types';
import { FullPageState } from '../../components/common/FullPageState';
import { IconButton } from '../../components/common/IconButton';
import { useAssistSurface } from '../../components/assist/semantic-actions';
import { useUi } from '../../state/ui';
import { WorkstreamHeader, WorkstreamTabs, type WorkstreamViewMode } from './WorkstreamChrome';

type GraphResponse = {
  project: Project;
  workflow: Workflow;
  parent: WorkflowNode;
  parent_node_id: string;
  revision: number;
  nodes: WorkflowNode[];
  graph: {
    nodes: Array<{ id: string; type: string; label: string; position: { x: number; y: number } }>;
    edges: Array<{ id: string; source: string; target: string }>;
  };
};
type ViewMode = WorkstreamViewMode;

export function WorkstreamPage() {
  const { projectId, workstreamId } = useParams(),
    navigate = useNavigate(),
    ui = useUi(),
    client = useQueryClient();
  const project = useProject(projectId);
  const workflow = project.data?.workflows
    .filter((item) => item.status !== 'archived')
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
  const graph = useQuery({
    queryKey: ['workstream-graph', workflow?.id, workstreamId],
    queryFn: () =>
      api<GraphResponse>(`/workflows/${workflow?.id}/graph?parent_node_id=${encodeURIComponent(workstreamId || '')}`),
    enabled: Boolean(workflow?.id && workstreamId)
  });
  const [view, setView] = useState<ViewMode>('list');
  useEffect(() => {
    if (workstreamId) ui.setContextNode(workstreamId);
  }, [workstreamId, ui.setContextNode]);
  const proposal = useMutation({
    mutationFn: (operations: unknown[]) =>
      api<ChangeProposal>(
        `/workflows/${workflow?.id}/graph-proposals`,
        json(
          'POST',
          { parent_node_id: workstreamId, expected_revision: graph.data?.revision, operations },
          '创建任务图变更提案'
        )
      ),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: keys.proposals(projectId) });
      ui.showProposal(result.id);
    },
    onError: (error) => ui.toast(error.message, 'error')
  });
  useAssistSurface({
    id: `workstream-${workstreamId || 'unknown'}`,
    revision: `${workstreamId || 'unknown'}:v${graph.data?.revision || 1}`
  });

  if (project.isLoading || graph.isLoading) return <FullPageState title="正在打开成果节点" />;
  if (project.isError || graph.isError || !project.data || !graph.data)
    return (
      <FullPageState
        title="成果节点加载失败"
        detail={(project.error || graph.error)?.message}
        retry={() => {
          void project.refetch();
          void graph.refetch();
        }}
      />
    );
  if (project.data.project.status === 'draft') return <Navigate to={`/projects/${projectId}/onboarding`} replace />;
  const { parent, nodes: tasks } = graph.data;

  function selectTask(task: WorkflowNode) {
    ui.setContextNode(task.id);
  }
  function assistTask(task: WorkflowNode) {
    selectTask(task);
    ui.setAssist(true);
    window.dispatchEvent(new CustomEvent('aiws:assist-prefill', { detail: { prompt: `协助任务“${task.title}”：` } }));
  }
  function move(task: WorkflowNode, delta: number) {
    const ids = tasks.map((item) => item.id),
      index = ids.indexOf(task.id),
      next = Math.max(0, Math.min(ids.length - 1, index + delta));
    if (index === next) return;
    ids.splice(index, 1);
    ids.splice(next, 0, task.id);
    proposal.mutate([{ type: 'reorder_nodes', ids }]);
  }
  function addTask() {
    proposal.mutate([
      {
        type: 'add_node',
        node: {
          role: 'task',
          parent_node_id: parent.id,
          title: '新执行任务',
          goal: '完成成果节点中的一项可验证工作',
          task_kind: 'manual',
          execution_mode: 'manual',
          required: true,
          dependency_ids: []
        }
      }
    ]);
  }

  return (
    <WorkstreamView
      projectId={projectId || ''}
      projectTitle={project.data.project.title}
      response={graph.data}
      view={view}
      onViewChange={setView}
      onBack={() => navigate(`/projects/${projectId}/workflow`)}
      onSelect={selectTask}
      onEnter={(task) => navigate(`/projects/${projectId}/nodes/${task.id}`)}
      onAssist={assistTask}
      onMove={move}
      onAdd={addTask}
      onSelectParent={() => ui.setContextNode(parent.id)}
    />
  );
}

function WorkstreamView({
  projectId,
  projectTitle,
  response,
  view,
  onViewChange,
  onBack,
  onSelect,
  onEnter,
  onAssist,
  onMove,
  onAdd,
  onSelectParent
}: {
  projectId: string;
  projectTitle: string;
  response: GraphResponse;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  onBack: () => void;
  onSelect: (task: WorkflowNode) => void;
  onEnter: (task: WorkflowNode) => void;
  onAssist: (task: WorkflowNode) => void;
  onMove: (task: WorkflowNode, delta: number) => void;
  onAdd: () => void;
  onSelectParent: () => void;
}) {
  const { parent, nodes: tasks } = response;
  return (
    <section className="workstream-page">
      <WorkstreamHeader
        projectId={projectId}
        projectTitle={projectTitle}
        workflowTitle={response.workflow.title}
        parent={parent}
        tasks={tasks}
        onBack={onBack}
        onAdd={onAdd}
        onSelectParent={onSelectParent}
      />
      <WorkstreamTabs view={view} onChange={onViewChange} />
      <div className="workstream-content">
        {view === 'list' && (
          <TaskList tasks={tasks} onSelect={onSelect} onEnter={onEnter} onAssist={onAssist} onMove={onMove} />
        )}
        {view === 'board' && <TaskBoard tasks={tasks} onSelect={onSelect} onEnter={onEnter} />}
        {view === 'structure' && (
          <ReactFlowProvider>
            <TaskStructure response={response} onSelect={onSelect} onEnter={onEnter} />
          </ReactFlowProvider>
        )}
      </div>
    </section>
  );
}

function TaskList({
  tasks,
  onSelect,
  onEnter,
  onAssist,
  onMove
}: {
  tasks: WorkflowNode[];
  onSelect: (task: WorkflowNode) => void;
  onEnter: (task: WorkflowNode) => void;
  onAssist: (task: WorkflowNode) => void;
  onMove: (task: WorkflowNode, delta: number) => void;
}) {
  if (!tasks.length) return <div className="task-empty">暂无任务</div>;
  return (
    <div className="task-list" role="list">
      {tasks.map((task, index) => (
        <article
          key={task.id}
          role="listitem"
          className={task.status === 'blocked' ? 'blocked' : ''}
          onClick={() => onSelect(task)}
        >
          <span className={`task-kind ${task.task_kind || 'manual'}`}>{taskKindLabel(task.task_kind)}</span>
          <div>
            <strong>{task.title}</strong>
            <p>{task.goal}</p>
          </div>
          <span className={`task-status ${task.status}`}>{statusLabel(task.status)}</span>
          <span className="task-target">
            <GitBranch size={14} />
            {task.repository_target_ids?.length || 0}
          </span>
          <div className="task-actions" onClick={(event) => event.stopPropagation()}>
            <IconButton label="上移" disabled={index === 0} onClick={() => onMove(task, -1)}>
              <ArrowUp size={15} />
            </IconButton>
            <IconButton label="下移" disabled={index === tasks.length - 1} onClick={() => onMove(task, 1)}>
              <ArrowDown size={15} />
            </IconButton>
            <IconButton label="任务智能助手" onClick={() => onAssist(task)}>
              <Bot size={15} />
            </IconButton>
            <button
              className="button task-open-primary"
              aria-label={`进入任务工作台：${task.title}`}
              onClick={() => onEnter(task)}
            >
              进入
              <ArrowRight size={15} />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function TaskBoard({
  tasks,
  onSelect,
  onEnter
}: {
  tasks: WorkflowNode[];
  onSelect: (task: WorkflowNode) => void;
  onEnter: (task: WorkflowNode) => void;
}) {
  const columns = [
    { key: 'ready', label: '待执行' },
    { key: 'running', label: '进行中' },
    { key: 'needs_review', label: '待验收' },
    { key: 'completed', label: '已完成' },
    { key: 'blocked', label: '阻塞' }
  ];
  return (
    <div className="task-board">
      {columns.map((column) => (
        <section key={column.key}>
          <header>
            <strong>{column.label}</strong>
            <span>{tasks.filter((task) => normalizeStatus(task.status) === column.key).length}</span>
          </header>
          {tasks
            .filter((task) => normalizeStatus(task.status) === column.key)
            .map((task) => (
              <button
                key={task.id}
                onClick={() => {
                  onSelect(task);
                  onEnter(task);
                }}
              >
                <span>{taskKindLabel(task.task_kind)}</span>
                <strong>{task.title}</strong>
                <small>{executionModeLabel(task.execution_mode)}</small>
              </button>
            ))}
        </section>
      ))}
    </div>
  );
}

function TaskStructure({
  response,
  onSelect,
  onEnter
}: {
  response: GraphResponse;
  onSelect: (task: WorkflowNode) => void;
  onEnter: (task: WorkflowNode) => void;
}) {
  const records = new Map(response.nodes.map((item) => [item.id, item]));
  const nodes = useMemo<Node[]>(
    () =>
      response.graph.nodes.map((item) => ({
        id: item.id,
        position: item.position,
        data: { label: records.get(item.id)?.title || item.label },
        className: `task-graph-node ${records.get(item.id)?.status || 'ready'}`
      })),
    [response]
  );
  const edges = useMemo<Edge[]>(
    () => response.graph.edges.map((item) => ({ ...item, animated: records.get(item.target)?.status === 'running' })),
    [response]
  );
  return (
    <div className="task-structure">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        colorMode="dark"
        onNodeClick={(_, node) => {
          const task = records.get(node.id);
          if (task) onSelect(task);
        }}
        onNodeDoubleClick={(_, node) => {
          const task = records.get(node.id);
          if (task) onEnter(task);
        }}
        fitView
        minZoom={0.35}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function taskKindLabel(value?: TaskKind | null) {
  return (
    {
      research: '研究',
      analysis: '分析',
      design: '设计',
      content: '内容',
      code: '编码',
      test: '测试',
      review: '审查',
      deploy: '部署',
      manual: '人工',
      integration: '集成'
    } as Record<string, string>
  )[value || 'manual'];
}
function normalizeStatus(value: string) {
  return value === 'draft' ? 'ready' : value === 'queued' ? 'ready' : value === 'succeeded' ? 'completed' : value;
}
function statusLabel(value: string) {
  return (
    (
      {
        ready: '待执行',
        running: '进行中',
        needs_review: '待验收',
        completed: '已完成',
        blocked: '阻塞',
        draft: '草稿'
      } as Record<string, string>
    )[normalizeStatus(value)] || '状态未知'
  );
}
function executionModeLabel(value?: string | null) {
  return (
    (
      {
        manual: '人工执行',
        codex: 'Codex 自动执行',
        codex_docker: 'Codex 容器执行',
        repository_integrate: '代码仓库集成'
      } as Record<string, string>
    )[value || 'manual'] || '自动执行'
  );
}
