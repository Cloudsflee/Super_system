import { ArrowRight, ChevronDown, Clock3, LockKeyhole, Pin, PinOff } from 'lucide-react';
import { useRef, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import type { WorkflowTaskDensity } from '../../state/ui';
import {
  pointerCanHover,
  TaskAttention,
  TaskMetrics,
  TaskObjective,
  TaskQuickPreview
} from './WorkflowTaskPresentation';
import { WorkflowTaskInlineDetails } from './WorkflowTaskDetails';
import { primaryTaskObjective, type WorkflowTaskViewModel } from './WorkflowTaskViewModel';
import type { TopologyRelation } from './WorkflowTopology';
import type { WorkflowProcessLayout } from './useWorkflowProcessController';
import { taskAssistScopeAttributes } from './workflow-assist-scope';

export function WorkflowTaskRow({
  model,
  projectId,
  density,
  index,
  layout,
  canReplay,
  expanded,
  pinned,
  selected,
  previewAnchor,
  topologyRelation,
  onTopologyFocus,
  onPreviewPointerEnter,
  onPreviewPointerLeave,
  onPreviewFocus,
  onPreviewBlur,
  onSetPin,
  onTogglePin
}: {
  model: WorkflowTaskViewModel;
  projectId: string;
  density: WorkflowTaskDensity;
  index: number;
  layout: WorkflowProcessLayout;
  canReplay: boolean;
  expanded: boolean;
  pinned: boolean;
  selected: boolean;
  previewAnchor: HTMLElement | null;
  topologyRelation: TopologyRelation;
  onTopologyFocus: (taskId: string | null) => void;
  onPreviewPointerEnter: (taskId: string, anchor: HTMLElement, pointerType: string) => void;
  onPreviewPointerLeave: () => void;
  onPreviewFocus: (taskId: string, anchor: HTMLElement) => void;
  onPreviewBlur: () => void;
  onSetPin: () => void;
  onTogglePin: () => void;
}) {
  const previewAnchorRef = useRef<HTMLDivElement>(null);
  const anchor = (fallback: HTMLElement) => previewAnchorRef.current || fallback;
  const hasSchedule = model.objective.times.length > 0 || Boolean(model.objective.timezone);
  const className = [
    'workflow-process-task',
    model.status,
    expanded ? 'expanded' : '',
    pinned ? 'pinned' : '',
    selected ? 'selected' : '',
    model.actionLocked ? 'locked' : '',
    topologyRelation !== 'neutral' ? `topology-${topologyRelation}` : ''
  ]
    .filter(Boolean)
    .join(' ');
  const handleSummaryClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (layout !== 'master-detail' || isInteractiveTarget(event.target)) return;
    onSetPin();
  };
  return (
    <>
      <article
        className={className}
        {...taskAssistScopeAttributes(model)}
        data-task-id={model.id}
        data-selected={selected ? 'true' : 'false'}
        role="listitem"
        onClick={handleSummaryClick}
        onPointerEnter={(event) => {
          if (!pointerCanHover(event.pointerType)) return;
          onTopologyFocus(model.id);
          onPreviewPointerEnter(model.id, anchor(event.currentTarget), event.pointerType);
        }}
        onPointerLeave={(event) => {
          if (!event.currentTarget.contains(document.activeElement)) onTopologyFocus(null);
          onPreviewPointerLeave();
        }}
        onFocusCapture={(event) => {
          onTopologyFocus(model.id);
          onPreviewFocus(model.id, anchor(event.currentTarget));
        }}
        onBlurCapture={(event) => {
          if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) {
            onTopologyFocus(null);
            onPreviewBlur();
          }
        }}
      >
        <div className="workflow-task-summary">
          <TaskSummaryBand
            model={model}
            projectId={projectId}
            density={density}
            index={index}
            layout={layout}
            expanded={expanded}
            pinned={pinned}
            hasSchedule={hasSchedule}
            previewAnchorRef={previewAnchorRef}
            onTogglePin={onTogglePin}
          />
        </div>
        {layout === 'accordion' && expanded && (
          <WorkflowTaskInlineDetails model={model} density={density} canReplay={canReplay} />
        )}
      </article>
      {layout === 'accordion' && previewAnchor && !expanded && (
        <TaskQuickPreview anchor={previewAnchor} model={model} />
      )}
    </>
  );
}

function TaskSummaryBand({
  model,
  projectId,
  density,
  index,
  layout,
  expanded,
  pinned,
  hasSchedule,
  previewAnchorRef,
  onTogglePin
}: {
  model: WorkflowTaskViewModel;
  projectId: string;
  density: WorkflowTaskDensity;
  index: number;
  layout: WorkflowProcessLayout;
  expanded: boolean;
  pinned: boolean;
  hasSchedule: boolean;
  previewAnchorRef: RefObject<HTMLDivElement | null>;
  onTogglePin: () => void;
}) {
  return (
    <div className="workflow-task-summary-band">
      <div className="workflow-task-sequence">
        <span>{String(index + 1).padStart(2, '0')}</span>
        <i data-topology-anchor aria-hidden="true" />
      </div>
      <div ref={previewAnchorRef} className="workflow-task-main" data-preview-anchor>
        <header>
          {density === 'detailed' && <span className="workflow-task-stage">{model.phase}</span>}
          <span className={`task-status ${model.status}`}>{model.statusText}</span>
          {model.execution && <span className="task-attempt">第 {model.execution.attempt} 次</span>}
        </header>
        <h3>{model.displayTitle}</h3>
        {density === 'compact' && model.blockers.length > 0 && <TaskAttention blockers={model.blockers} />}
        {density === 'comfortable' && <ComfortableTaskSummary model={model} hasSchedule={hasSchedule} />}
        {density === 'detailed' && (
          <>
            <TaskObjective content={model.objective}>
              <TaskMetrics title={model.displayTitle} values={model.metrics} />
            </TaskObjective>
            {model.blockers.length > 0 && <TaskAttention blockers={model.blockers} />}
          </>
        )}
      </div>
      <TaskRowActions
        model={model}
        projectId={projectId}
        layout={layout}
        expanded={expanded}
        pinned={pinned}
        onTogglePin={onTogglePin}
      />
    </div>
  );
}

function ComfortableTaskSummary({ model, hasSchedule }: { model: WorkflowTaskViewModel; hasSchedule: boolean }) {
  return (
    <div className="workflow-task-primary-line">
      {model.blockers.length > 0 ? (
        <TaskAttention blockers={model.blockers} />
      ) : (
        <p>{primaryTaskObjective(model.objective)}</p>
      )}
      {hasSchedule && (
        <span
          className="workflow-schedule-indicator"
          role="img"
          tabIndex={0}
          aria-label="已设置调度参数"
          data-tooltip="已设置调度"
        >
          <Clock3 size={12} />
        </span>
      )}
    </div>
  );
}

function TaskRowActions({
  model,
  projectId,
  layout,
  expanded,
  pinned,
  onTogglePin
}: {
  model: WorkflowTaskViewModel;
  projectId: string;
  layout: WorkflowProcessLayout;
  expanded: boolean;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  return (
    <div className="workflow-task-actions">
      {layout === 'master-detail' ? (
        <button
          type="button"
          className="workflow-task-pin"
          aria-label={`${pinned ? '取消固定' : '固定'}任务：${model.displayTitle}`}
          aria-pressed={pinned}
          data-tooltip={pinned ? '取消固定' : '固定任务'}
          onClick={onTogglePin}
        >
          {pinned ? <PinOff size={15} /> : <Pin size={15} />}
        </button>
      ) : (
        <button
          type="button"
          className="workflow-task-disclosure"
          aria-expanded={expanded}
          aria-controls={model.detailsId}
          aria-label={`${expanded ? '收起' : '展开'}任务详情：${model.displayTitle}`}
          data-tooltip={expanded ? '收起详情' : '展开详情'}
          onClick={onTogglePin}
        >
          <ChevronDown size={16} />
        </button>
      )}
      {model.actionLocked ? (
        <button
          type="button"
          className="workflow-task-enter locked"
          disabled
          aria-label={`任务已锁定：${model.displayTitle}`}
          data-tooltip={model.actionLockReason}
        >
          <LockKeyhole size={15} />
        </button>
      ) : (
        <Link
          className="workflow-task-enter"
          to={`/projects/${projectId}/nodes/${model.id}`}
          aria-label={`进入任务工作台：${model.displayTitle}`}
          data-tooltip="进入任务工作台"
        >
          <ArrowRight size={16} />
        </Link>
      )}
    </div>
  );
}

function isInteractiveTarget(target: EventTarget) {
  return (
    target instanceof Element && Boolean(target.closest('a,button,input,select,textarea,[role="button"],[data-nonpin]'))
  );
}
