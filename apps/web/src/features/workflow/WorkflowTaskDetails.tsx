import {
  ArrowRight,
  Braces,
  Check,
  CircleDashed,
  FileText,
  GitBranch,
  Link2,
  ListTree,
  LockKeyhole,
  Pin,
  PinOff,
  SquareTerminal,
  Tags
} from 'lucide-react';
import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { Link } from 'react-router-dom';
import type { WorkflowTaskDensity } from '../../state/ui';
import { assetTypeLabel, confirmationPolicyLabel, inputKindLabel } from '../../components/common/display-labels';
import { TaskMetrics } from './WorkflowTaskPresentation';
import { normalizeTaskStatus, workflowCategoryLabel, type WorkflowTaskViewModel } from './WorkflowTaskViewModel';
import { taskAssistScopeAttributes } from './workflow-assist-scope';
import { TaskStageTimeline } from './TaskStageTimeline';

export function WorkflowTaskInlineDetails({
  model,
  density,
  canReplay = false
}: {
  model: WorkflowTaskViewModel;
  density: WorkflowTaskDensity;
  canReplay?: boolean;
}) {
  return (
    <div
      className="workflow-task-details"
      {...taskAssistScopeAttributes(model)}
      id={model.detailsId}
      role="region"
      aria-label={`任务详情：${model.displayTitle}`}
    >
      <div className="workflow-task-details-band">
        <WorkflowTaskDetailSections model={model} includeContext={density !== 'detailed'} canReplay={canReplay} />
      </div>
    </div>
  );
}

export function WorkflowTaskInspector({
  model,
  projectId,
  pinned,
  canReplay,
  scrollPositions,
  onTogglePin,
  onPointerEnter,
  onPointerLeave
}: {
  model?: WorkflowTaskViewModel;
  projectId: string;
  pinned: boolean;
  canReplay: boolean;
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
      {...(model ? taskAssistScopeAttributes(model) : {})}
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
                  ? `${workflowCategoryLabel(model.workstream.category)} · ${model.workstreamDisplayTitle || model.workstream.title}`
                  : '流程任务'}
              </span>
              <small>{model.phase}</small>
              <h2 id={titleId}>{model.displayTitle}</h2>
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
                aria-label={`${pinned ? '取消固定' : '固定'}任务：${model.displayTitle}`}
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
          </header>
          <div className="workflow-task-inspector-sections">
            <WorkflowTaskDetailSections model={model} includeContext canReplay={canReplay} />
          </div>
        </>
      )}
    </aside>
  );
}

function WorkflowTaskDetailSections({
  model,
  includeContext,
  canReplay
}: {
  model: WorkflowTaskViewModel;
  includeContext: boolean;
  canReplay: boolean;
}) {
  return (
    <>
      {includeContext && <WorkflowTaskContext key={model.id} model={model} />}
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
      <TaskStageTimeline execution={model.execution} canReplay={canReplay} />
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

function WorkflowTaskContext({ model }: { model: WorkflowTaskViewModel }) {
  const [view, setView] = useState<'summary' | 'source'>('summary');
  return (
    <section className="workflow-task-context workflow-detail-span-all">
      <header>
        <SquareTerminal size={14} />
        <strong>目标与执行上下文</strong>
        <div className="workflow-context-view-switch" role="group" aria-label={`${model.displayTitle} 上下文视图`}>
          <button type="button" aria-pressed={view === 'summary'} onClick={() => setView('summary')}>
            <ListTree size={12} />
            <span>摘要</span>
          </button>
          <button type="button" aria-pressed={view === 'source'} onClick={() => setView('source')}>
            <FileText size={12} />
            <span>原文</span>
          </button>
        </div>
      </header>
      <div
        className="workflow-context-view"
        role="region"
        aria-label={`${model.displayTitle} ${view === 'summary' ? '上下文摘要' : '上下文原文'}`}
      >
        {view === 'summary' ? (
          <TaskContextSummary model={model} />
        ) : (
          <pre className="workflow-context-source" tabIndex={0}>
            {model.objective.raw}
          </pre>
        )}
      </div>
      <TaskMetrics title={model.displayTitle} values={model.metrics} />
    </section>
  );
}

function TaskContextSummary({ model }: { model: WorkflowTaskViewModel }) {
  const objective = model.objective;
  const schedule = [...objective.times, objective.timezone].filter(Boolean).join(' · ');
  return (
    <dl className="workflow-context-summary">
      <div className="primary">
        <dt>核心目标</dt>
        <dd>{objective.summary}</dd>
      </div>
      <div>
        <dt>执行状态</dt>
        <dd>
          {model.phase} · {model.statusText}
        </dd>
      </div>
      {objective.keyPoints.length > 0 && (
        <div>
          <dt>关键要点</dt>
          <dd>
            <ul>
              {objective.keyPoints.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </dd>
        </div>
      )}
      {objective.command && (
        <div>
          <dt>执行命令</dt>
          <dd>
            <code aria-label={`命令行：${objective.command}`}>{objective.command}</code>
          </dd>
        </div>
      )}
      {schedule && (
        <div>
          <dt>调度</dt>
          <dd className="workflow-context-schedule" aria-label={schedule}>
            {objective.times.map((time) => (
              <span key={time}>{time}</span>
            ))}
            {objective.timezone && <span>{objective.timezone}</span>}
          </dd>
        </div>
      )}
      {model.blockers.length > 0 && (
        <div>
          <dt>当前门禁</dt>
          <dd>
            {model.blockers[0]}
            {model.blockers.length > 1 && ` · 另有 ${model.blockers.length - 1} 项`}
          </dd>
        </div>
      )}
    </dl>
  );
}
