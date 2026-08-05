import { ArrowRight, Check, CircleDashed, Code2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProjectBundle, Workflow, WorkflowExecutionSnapshot } from '../../api/types';
import type { WorkflowTaskDensity } from '../../state/ui';
import { WorkflowTaskInspector } from './WorkflowTaskDetails';
import { WorkflowTaskRow } from './WorkflowTaskRow';
import {
  buildWorkflowProcessViewModel,
  normalizeTaskStatus,
  workflowCategoryLabel,
  WORKFLOW_STAGES,
  type WorkflowTaskViewModel
} from './WorkflowTaskViewModel';
import { buildTaskTopologyFocus, WorkflowTopologyLayer } from './WorkflowTopology';
import {
  useWorkflowProcessLayout,
  useWorkflowTaskSelection,
  type WorkflowProcessLayout
} from './useWorkflowProcessController';

export function WorkflowFullProcess({
  bundle,
  workflow,
  execution,
  density
}: {
  bundle: ProjectBundle;
  workflow: Workflow;
  execution?: WorkflowExecutionSnapshot | null;
  density: WorkflowTaskDensity;
}) {
  const containerRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const process = useMemo(
    () => buildWorkflowProcessViewModel(bundle, workflow, execution),
    [bundle, execution, workflow]
  );
  const { layout, width } = useWorkflowProcessLayout(containerRef);
  const selection = useWorkflowTaskSelection(process.tasks, workflow.id);
  const displayedTask = process.tasks.find((item) => item.id === selection.displayedTaskId);
  const software = /software|code/i.test(workflow.project_classification || '');
  const canReplay = (bundle.membership?.role || bundle.project.current_user_role) !== 'viewer';

  return (
    <section
      ref={containerRef}
      className="workflow-full-process"
      aria-label="完整任务流程"
      data-density={density}
      data-layout={layout}
      data-container-width={Math.round(width)}
    >
      <div className="workflow-process-body">
        <div className="workflow-process-master">
          <header
            className="workflow-process-summary"
            aria-label={`流程覆盖：${process.tasks.length} 个任务，${process.workstreams.length} 个成果`}
          >
            <div className="workflow-coverage-title">
              <span>流程覆盖</span>
              <strong>{process.tasks.length} 个任务</strong>
            </div>
            <div className="workflow-phase-coverage" role="list" aria-label="六阶段覆盖">
              {WORKFLOW_STAGES.map(([key, label]) => (
                <PhaseState key={key} tag={key} label={label} tasks={process.tasks} software={software} />
              ))}
            </div>
          </header>
          <div className="workflow-process-streams">
            {process.workstreams.map((workstream, streamIndex) => (
              <section
                className="workflow-process-stream"
                key={workstream.node.id}
                aria-labelledby={`process-${workstream.node.id}`}
                data-assist-scope-type="workstream"
                data-assist-scope-id={workstream.node.id}
                data-assist-scope-label={workstream.displayTitle}
                data-assist-scope-breadcrumb={JSON.stringify([
                  bundle.project.title,
                  workflow.title,
                  workstream.displayTitle
                ])}
                data-assist-scope-status={workstream.node.status}
              >
                <header>
                  <div className="workflow-stream-band">
                    <div className="workflow-stream-index">{String(streamIndex + 1).padStart(2, '0')}</div>
                    <div className="workflow-stream-main">
                      <span>{workflowCategoryLabel(workstream.node.category)}</span>
                      <h2 id={`process-${workstream.node.id}`}>{workstream.displayTitle}</h2>
                      <p>{workstream.displayOutcome}</p>
                    </div>
                    <div className="workflow-stream-progress">
                      <strong>
                        {workstream.tasks.filter((item) => item.status === 'completed').length}/
                        {workstream.tasks.length}
                      </strong>
                      <span>已验收</span>
                    </div>
                    <div className="workflow-stream-actions">
                      {hasCodeWorkspace(workstream.node) && (
                        <Link
                          className="workflow-stream-code"
                          to={`/projects/${bundle.project.id}/nodes/${workstream.node.id}`}
                          aria-label={`查看代码：${workstream.displayTitle}`}
                        >
                          <Code2 size={15} />
                          <span>代码</span>
                        </Link>
                      )}
                      <Link
                        to={`/projects/${bundle.project.id}/workflow/${workstream.node.id}`}
                        aria-label={`进入成果节点：${workstream.displayTitle}`}
                        data-tooltip="任务总览"
                      >
                        <ArrowRight size={17} />
                      </Link>
                    </div>
                  </div>
                </header>
                <TaskDag
                  tasks={workstream.tasks}
                  projectId={bundle.project.id}
                  density={density}
                  layout={layout}
                  canReplay={canReplay}
                  pinnedTaskId={selection.pinnedTaskId}
                  displayedTaskId={selection.displayedTaskId}
                  setPin={selection.setPin}
                  togglePin={selection.togglePin}
                />
              </section>
            ))}
            {!process.workstreams.length && <div className="workflow-process-empty">当前工作流没有成果节点。</div>}
          </div>
        </div>
        {layout === 'master-detail' && (
          <WorkflowTaskInspector
            model={displayedTask}
            projectId={bundle.project.id}
            pinned={Boolean(displayedTask && displayedTask.id === selection.pinnedTaskId)}
            canReplay={canReplay}
            scrollPositions={scrollPositions}
            onTogglePin={() => {
              if (displayedTask) selection.togglePin(displayedTask.id);
            }}
          />
        )}
      </div>
    </section>
  );
}

function TaskDag({
  tasks,
  projectId,
  density,
  layout,
  canReplay,
  pinnedTaskId,
  displayedTaskId,
  setPin,
  togglePin
}: {
  tasks: WorkflowTaskViewModel[];
  projectId: string;
  density: WorkflowTaskDensity;
  layout: WorkflowProcessLayout;
  canReplay: boolean;
  pinnedTaskId: string | null;
  displayedTaskId: string | null;
  setPin: (taskId: string) => void;
  togglePin: (taskId: string) => void;
}) {
  const [directFocusTaskId, setDirectFocusTaskId] = useState<string | null>(null);
  const selectedTopologyTaskId = layout === 'master-detail' ? pinnedTaskId : null;
  const activeTaskId = directFocusTaskId || selectedTopologyTaskId;
  const nodes = useMemo(() => tasks.map((item) => item.task), [tasks]);
  const topology = useMemo(() => buildTaskTopologyFocus(nodes, activeTaskId), [activeTaskId, nodes]);
  const layoutRevision = `${density}:${layout}${layout === 'accordion' ? `:${pinnedTaskId || ''}` : ''}`;
  return (
    <div className={`workflow-task-dag${activeTaskId ? ' topology-focused' : ''}`} role="list">
      <WorkflowTopologyLayer tasks={nodes} activeTaskId={activeTaskId} layoutRevision={layoutRevision} />
      {tasks.map((model, index) => (
        <WorkflowTaskRow
          key={model.id}
          model={model}
          projectId={projectId}
          density={density}
          index={index}
          layout={layout}
          canReplay={canReplay}
          expanded={layout === 'accordion' && pinnedTaskId === model.id}
          pinned={pinnedTaskId === model.id}
          selected={layout === 'master-detail' ? displayedTaskId === model.id : pinnedTaskId === model.id}
          topologyRelation={topology.relations.get(model.id) || 'neutral'}
          onTopologyFocus={setDirectFocusTaskId}
          onSetPin={() => setPin(model.id)}
          onTogglePin={() => togglePin(model.id)}
        />
      ))}
    </div>
  );
}

function PhaseState({
  tag,
  label,
  tasks,
  software
}: {
  tag: string;
  label: string;
  tasks: WorkflowTaskViewModel[];
  software: boolean;
}) {
  const matched = tasks.filter((item) => item.phaseTags.includes(tag));
  const completed = matched.length > 0 && matched.every((item) => normalizeTaskStatus(item.status) === 'completed');
  const active = matched.some((item) =>
    ['running', 'verifying', 'awaiting_human', 'failed'].includes(normalizeTaskStatus(item.status))
  );
  const state = !matched.length
    ? software
      ? 'missing'
      : 'merged'
    : completed
      ? 'completed'
      : active
        ? 'active'
        : 'planned';
  const stateLabel = matched.length ? `${matched.length} 个任务` : software ? '缺失' : '已合并';
  return (
    <div role="listitem" aria-label={`${label}：${stateLabel}`} className={`workflow-phase ${state}`}>
      <span>
        {completed ? <Check size={11} /> : <CircleDashed size={11} />}
        <b>{label}</b>
      </span>
      <small>{matched.length || (software ? '!' : '合')}</small>
    </div>
  );
}

function hasCodeWorkspace(node: ProjectBundle['nodes'][number]) {
  return node.type === 'execution' || Boolean(node.repository_target_ids?.length);
}
