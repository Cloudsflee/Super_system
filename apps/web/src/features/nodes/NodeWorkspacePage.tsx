import { ArrowLeft, Bot, FileCheck2, History, Play } from 'lucide-react';
import { Suspense, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import type { NodeWorkspace } from '../../api/types';
import { FullPageState } from '../../components/common/FullPageState';
import { IconButton } from '../../components/common/IconButton';
import { displayStatus } from '../../components/common/display-labels';
import { useUi } from '../../state/ui';
import { ContractPanel } from './panels/ContractPanel';
import { ActivityPanel } from './panels/ActivityPanel';
import { rendererFor } from './registry';
import { useAssistSurface } from '../../components/assist/semantic-actions';
import { TaskExecutionPanel } from './TaskExecutionPanel';
import { useNodeWorkspaceController } from './NodeWorkspaceController';

type Tab = 'work' | 'contract' | 'activity';

export function NodeWorkspacePage() {
  const { projectId, nodeId } = useParams(),
    navigate = useNavigate(),
    [tab, setTab] = useState<Tab>('work'),
    setAssist = useUi((state) => state.setAssist),
    controller = useNodeWorkspaceController(nodeId);
  useAssistSurface({
    id: 'node-workspace',
    tabs: {
      work: { label: '工作内容', read: () => tab, select: () => setTab('work') },
      contract: { label: '任务契约', read: () => tab, select: () => setTab('contract') },
      activity: { label: '运行与轨迹', read: () => tab, select: () => setTab('activity') }
    }
  });
  const { query, runningNode, runNode } = controller;
  if (query.isLoading) return <FullPageState title="正在打开节点工作区" />;
  if (query.isError || !query.data)
    return <FullPageState title="节点工作区加载失败" detail={query.error?.message} retry={query.refetch} />;
  if (query.data.project.id !== projectId)
    return <Navigate to={`/projects/${query.data.project.id}/nodes/${query.data.node.id}`} replace />;
  const controlledWorkflow = query.data.workflow.planning_quality === 'verified' && query.data.node.role === 'task';
  return (
    <NodeWorkspaceView
      value={query.data}
      tab={tab}
      onTab={setTab}
      controlledWorkflow={controlledWorkflow}
      runningNode={runningNode}
      onRunNode={runNode}
      onSaved={query.refetch}
      onBack={() => navigate(`/projects/${projectId}/workflow`)}
      onAssist={() => setAssist(true)}
    />
  );
}

function NodeWorkspaceView({
  value,
  tab,
  onTab,
  controlledWorkflow,
  runningNode,
  onRunNode,
  onSaved,
  onBack,
  onAssist
}: {
  value: NodeWorkspace;
  tab: Tab;
  onTab: (tab: Tab) => void;
  controlledWorkflow: boolean;
  runningNode: boolean;
  onRunNode: (repositoryWorkspaceId?: string) => Promise<void>;
  onSaved: () => Promise<unknown>;
  onBack: () => void;
  onAssist: () => void;
}) {
  const definition = rendererFor(value.node.type),
    Renderer = definition.component;
  return (
    <section className="node-workspace-page">
      <NodeWorkspaceHeader
        value={value}
        definition={definition}
        controlled={controlledWorkflow}
        running={runningNode}
        onRun={() => void onRunNode()}
        onBack={onBack}
        onAssist={onAssist}
      />
      <NodeWorkspaceTabs tab={tab} onTab={onTab} />
      <div className="workspace-content">
        {tab === 'work' &&
          (controlledWorkflow ? (
            <TaskExecutionPanel taskId={value.node.id} canWrite={value.project.current_user_role !== 'viewer'} />
          ) : (
            <Suspense fallback={<FullPageState title="正在加载节点工具" />}>
              <Renderer
                key={value.node.id}
                value={value}
                onSaved={onSaved}
                onRunNode={(id) => void onRunNode(id)}
                runningNode={runningNode}
              />
            </Suspense>
          ))}
        {tab === 'contract' && <ContractPanel value={value} />}
        {tab === 'activity' && <ActivityPanel value={value} onSaved={onSaved} />}
      </div>
    </section>
  );
}

function NodeWorkspaceHeader({
  value,
  definition,
  controlled,
  running,
  onRun,
  onBack,
  onAssist
}: {
  value: NodeWorkspace;
  definition: ReturnType<typeof rendererFor>;
  controlled: boolean;
  running: boolean;
  onRun: () => void;
  onBack: () => void;
  onAssist: () => void;
}) {
  return (
    <header className="workspace-header">
      <IconButton label="返回工作流" onClick={onBack}>
        <ArrowLeft size={18} />
      </IconButton>
      <definition.icon size={19} />
      <div>
        <span>{definition.label}</span>
        <h1>{value.node.title}</h1>
      </div>
      <span className={`status ${value.node.status}`}>{displayStatus(value.node.status)}</span>
      <div className="workspace-header-spacer" />
      {!controlled && (
        <button className="button primary" aria-label="运行节点" disabled={running} onClick={onRun}>
          <Play size={15} />
          {running ? '运行中' : '运行节点'}
        </button>
      )}
      <IconButton label="打开当前节点智能助手" onClick={onAssist}>
        <Bot size={19} />
      </IconButton>
    </header>
  );
}

function NodeWorkspaceTabs({ tab, onTab }: { tab: Tab; onTab: (tab: Tab) => void }) {
  return (
    <nav className="workspace-tabs" aria-label="节点视图">
      <button className={tab === 'work' ? 'active' : ''} onClick={() => onTab('work')}>
        <Play size={15} />
        工作内容
      </button>
      <button className={tab === 'contract' ? 'active' : ''} onClick={() => onTab('contract')}>
        <FileCheck2 size={15} />
        任务契约
      </button>
      <button className={tab === 'activity' ? 'active' : ''} onClick={() => onTab('activity')}>
        <History size={15} />
        运行与轨迹
      </button>
    </nav>
  );
}
