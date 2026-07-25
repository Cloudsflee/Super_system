import {
  ArrowRight,
  Braces,
  Check,
  CircleDashed,
  GitBranch,
  Link2,
  LockKeyhole,
  Pin,
  PinOff,
  SquareTerminal,
  Tags
} from 'lucide-react';
import { useLayoutEffect, useRef, type MutableRefObject } from 'react';
import { Link } from 'react-router-dom';
import type { WorkflowTaskDensity } from '../../state/ui';
import { assetTypeLabel, confirmationPolicyLabel, inputKindLabel } from '../../components/common/display-labels';
import { TaskMetrics, TaskObjective } from './WorkflowTaskPresentation';
import { normalizeTaskStatus, workflowCategoryLabel, type WorkflowTaskViewModel } from './WorkflowTaskViewModel';

export function WorkflowTaskInlineDetails({
  model,
  density
}: {
  model: WorkflowTaskViewModel;
  density: WorkflowTaskDensity;
}) {
  return (
    <div
      className="workflow-task-details"
      id={model.detailsId}
      role="region"
      aria-label={`任务详情：${model.task.title}`}
    >
      <div className="workflow-task-details-band">
        <WorkflowTaskDetailSections model={model} includeContext={density !== 'detailed'} fullContext={false} />
      </div>
    </div>
  );
}

export function WorkflowTaskInspector({
  model,
  projectId,
  pinned,
  scrollPositions,
  onTogglePin,
  onPointerEnter,
  onPointerLeave
}: {
  model?: WorkflowTaskViewModel;
  projectId: string;
  pinned: boolean;
  scrollPositions: MutableRefObject<Map<string, number>>;
  onTogglePin: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const asideRef = useRef<HTMLElement>(null);
  const titleId = model ? `${model.detailsId}-inspector-title` : 'workflow-task-inspector-empty-title';
  useLayoutEffect(() => {
    const aside = asideRef.current;
    if (!aside || !model) return;
    aside.scrollTop = scrollPositions.current.get(model.id) || 0;
    return () => {
      scrollPositions.current.set(model.id, aside.scrollTop);
    };
  }, [model?.id, scrollPositions]);
  return (
    <aside
      ref={asideRef}
      className="workflow-task-inspector"
      aria-labelledby={titleId}
      data-detail-task-id={model?.id || ''}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocusCapture={onPointerEnter}
    >
      {!model ? (
        <div className="workflow-task-inspector-empty">
          <CircleDashed size={20} />
          <h2 id={titleId}>暂无任务</h2>
          <p>当前流程没有可展示的任务。</p>
        </div>
      ) : (
        <>
          <header className="workflow-task-inspector-header">
            <div className="workflow-task-inspector-heading">
              <span>
                {model.workstream
                  ? `${workflowCategoryLabel(model.workstream.category)} · ${model.workstream.title}`
                  : '流程任务'}
              </span>
              <small>{model.phase}</small>
              <h2 id={titleId}>{model.task.title}</h2>
              <div className="workflow-task-inspector-state">
                <span className={`task-status ${model.status}`}>{model.statusText}</span>
                {model.execution && <span className="task-attempt">第 {model.execution.attempt} 次尝试</span>}
                {model.actionLocked && (
                  <small>
                    <LockKeyhole size={11} />
                    {model.actionLockReason}
                  </small>
                )}
              </div>
            </div>
            <div className="workflow-task-inspector-actions">
              <button
                type="button"
                className="workflow-task-pin"
                aria-label={`${pinned ? '取消固定' : '固定'}任务：${model.task.title}`}
                aria-pressed={pinned}
                data-tooltip={pinned ? '取消固定' : '固定任务'}
                onClick={onTogglePin}
              >
                {pinned ? <PinOff size={16} /> : <Pin size={16} />}
              </button>
              {model.actionLocked ? (
                <button
                  type="button"
                  className="workflow-task-enter locked"
                  disabled
                  aria-label={`任务已锁定：${model.task.title}`}
                  data-tooltip={model.actionLockReason}
                >
                  <LockKeyhole size={15} />
                </button>
              ) : (
                <Link
                  className="workflow-task-enter"
                  to={`/projects/${projectId}/nodes/${model.id}`}
                  aria-label={`进入任务工作台：${model.task.title}`}
                  data-tooltip="进入任务工作台"
                >
                  <ArrowRight size={16} />
                </Link>
              )}
            </div>
          </header>
          <div className="workflow-task-inspector-sections">
            <WorkflowTaskDetailSections model={model} includeContext fullContext />
          </div>
        </>
      )}
    </aside>
  );
}

function WorkflowTaskDetailSections({
  model,
  includeContext,
  fullContext
}: {
  model: WorkflowTaskViewModel;
  includeContext: boolean;
  fullContext: boolean;
}) {
  return (
    <>
      {includeContext && (
        <section className="workflow-task-context workflow-detail-span-all">
          <header>
            <SquareTerminal size={14} />
            <strong>目标与执行上下文</strong>
            <small>目标、命令行与调度</small>
          </header>
          <TaskObjective content={model.objective} full={fullContext}>
            <TaskMetrics title={model.task.title} values={model.metrics} />
          </TaskObjective>
        </section>
      )}
      <section className="workflow-task-dependencies">
        <header>
          <GitBranch size={14} />
          <strong>依赖与就绪</strong>
          <small>{model.dependencies.length} 项前置</small>
        </header>
        <div className="workflow-detail-list">
          {model.dependencies.length ? (
            model.dependencies.map((item) => (
              <span key={item.id}>
                {normalizeTaskStatus(item.status) === 'completed' ? <Check size={12} /> : <CircleDashed size={12} />}
                <span>{item.title}</span>
              </span>
            ))
          ) : (
            <span className="workflow-detail-empty">无前置依赖</span>
          )}
          {model.blockers.map((item) => (
            <em key={item}>
              <LockKeyhole size={12} />
              <span>{item}</span>
            </em>
          ))}
        </div>
      </section>
      <section className="workflow-task-contract">
        <header>
          <Braces size={14} />
          <strong>类型化契约</strong>
          <small>{model.inputs.length + model.outputs.length} 个字段</small>
        </header>
        <div className="workflow-contract-columns">
          <div>
            <strong>输入</strong>
            {model.inputs.map((slot) => (
              <span key={slot.key}>
                <code>{slot.key}</code>
                <small>
                  {inputKindLabel(slot.kind)} · {slot.required ? '必需' : '可选'}
                </small>
              </span>
            ))}
            {!model.inputs.length && <span className="workflow-detail-empty">无输入字段</span>}
          </div>
          <div>
            <strong>输出</strong>
            {model.outputs.map((slot) => (
              <span key={slot.key}>
                <code>{slot.key}</code>
                <small>
                  {assetTypeLabel(slot.asset_type)} · {confirmationPolicyLabel(slot.confirmation_policy)}
                </small>
              </span>
            ))}
            {!model.outputs.length && <span className="workflow-detail-empty">无输出字段</span>}
          </div>
        </div>
      </section>
      <section className="workflow-task-assets">
        <header>
          <Link2 size={14} />
          <strong>资产与版本</strong>
          <small>{model.metrics.versions} 个精确版本</small>
        </header>
        <div className="workflow-detail-list asset-versions">
          {model.versions.map((item) => (
            <span key={item.key}>
              {item.label}
              {item.meta && <small>{item.meta}</small>}
            </span>
          ))}
        </div>
      </section>
      <section className="workflow-task-tags-section workflow-detail-span-all">
        <header>
          <Tags size={14} />
          <strong>能力与简报覆盖</strong>
          <small>{model.capabilityTags.length + model.coverage.length} 项映射</small>
        </header>
        <div className="workflow-task-tags">
          {model.capabilityTags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
          {model.coverage.map((item) => (
            <span className="brief-map" key={item}>
              {item}
            </span>
          ))}
          {!model.capabilityTags.length && !model.coverage.length && (
            <span className="workflow-detail-empty">暂无能力或简报映射</span>
          )}
        </div>
      </section>
    </>
  );
}
