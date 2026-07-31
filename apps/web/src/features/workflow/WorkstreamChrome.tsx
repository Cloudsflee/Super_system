import { ArrowLeft, Boxes, ChevronRight, Code2, List, Plus, Rows3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { WorkflowNode } from '../../api/types';
import { IconButton } from '../../components/common/IconButton';

export type WorkstreamViewMode = 'list' | 'board' | 'structure';

export function WorkstreamHeader({
  projectId,
  projectTitle,
  workflowTitle,
  parent,
  tasks,
  onBack,
  onAdd,
  onSelectParent
}: {
  projectId: string;
  projectTitle: string;
  workflowTitle: string;
  parent: WorkflowNode;
  tasks: WorkflowNode[];
  onBack: () => void;
  onAdd: () => void;
  onSelectParent: () => void;
}) {
  const completed = tasks.filter((item) => item.status === 'completed').length;
  const blocked = tasks.filter((item) => item.status === 'blocked').length;
  return (
    <>
      <nav className="workflow-breadcrumb" aria-label="层级导航">
        <Link to="/projects">{projectTitle}</Link>
        <ChevronRight size={14} />
        <Link to={`/projects/${projectId}/workflow`}>{workflowTitle}</Link>
        <ChevronRight size={14} />
        <button type="button" onClick={onSelectParent}>
          {parent.title}
        </button>
      </nav>
      <header className="workstream-header">
        <IconButton label="返回顶层工作流" onClick={onBack}>
          <ArrowLeft size={18} />
        </IconButton>
        <div>
          <span>{categoryLabel(parent.category)}</span>
          <h1>{parent.title}</h1>
          <p>{parent.outcome || parent.goal}</p>
        </div>
        <div className="workstream-metrics">
          <strong>
            {completed}/{tasks.length}
          </strong>
          <span>任务</span>
          <strong>{blocked}</strong>
          <span>阻塞</span>
        </div>
        <div className="workstream-header-actions">
          {hasCodeWorkspace(parent) && (
            <Link
              className="button secondary workstream-code-link"
              to={`/projects/${projectId}/nodes/${parent.id}`}
              aria-label={`查看代码：${parent.title}`}
            >
              <Code2 size={15} />
              查看代码
            </Link>
          )}
          <IconButton label="添加任务" onClick={onAdd}>
            <Plus size={18} />
          </IconButton>
        </div>
      </header>
    </>
  );
}

export function WorkstreamTabs({
  view,
  onChange
}: {
  view: WorkstreamViewMode;
  onChange: (view: WorkstreamViewMode) => void;
}) {
  return (
    <div className="workstream-tabs" role="tablist" aria-label="任务视图">
      <button role="tab" aria-selected={view === 'list'} onClick={() => onChange('list')}>
        <List size={16} />
        列表
      </button>
      <button role="tab" aria-selected={view === 'board'} onClick={() => onChange('board')}>
        <Rows3 size={16} />
        看板
      </button>
      <button role="tab" aria-selected={view === 'structure'} onClick={() => onChange('structure')}>
        <Boxes size={16} />
        结构
      </button>
    </div>
  );
}

function categoryLabel(value?: string | null) {
  return (
    (
      { deliverable: '交付成果', decision: '关键决策', coordination: '协同成果', operation: '运营成果' } as Record<
        string,
        string
      >
    )[value || ''] || '成果节点'
  );
}

function hasCodeWorkspace(node: WorkflowNode) {
  return node.type === 'execution' || Boolean(node.repository_target_ids?.length);
}
