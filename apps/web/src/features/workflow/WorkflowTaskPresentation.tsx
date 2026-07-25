import { Clock3, Database, GitBranch, GitFork, Globe2, LockKeyhole, PackageCheck, SquareTerminal } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { TaskMetricValues, TaskObjectiveValue, WorkflowTaskViewModel } from './WorkflowTaskViewModel';

function TaskMetric({ icon, value, label }: { icon: ReactNode; value: number; label: string }) {
  return (
    <span>
      {icon}
      <strong>{value}</strong>
      <small>{label}</small>
    </span>
  );
}

export function TaskMetrics({ title, values }: { title: string; values: TaskMetricValues }) {
  return (
    <div className="workflow-task-overview" aria-label={`${title} 执行摘要`}>
      <TaskMetric icon={<GitBranch size={14} />} value={values.dependencies} label="前置" />
      <TaskMetric icon={<Database size={14} />} value={values.inputs} label="输入" />
      <TaskMetric icon={<PackageCheck size={14} />} value={values.outputs} label="输出" />
      <TaskMetric icon={<GitFork size={14} />} value={values.versions} label="版本" />
    </div>
  );
}

export function TaskAttention({ blockers }: { blockers: string[] }) {
  return (
    <div className="workflow-task-attention">
      <LockKeyhole size={12} />
      <span>{blockers[0]}</span>
      {blockers.length > 1 && <small>+{blockers.length - 1}</small>}
    </div>
  );
}

export function TaskObjective({
  content,
  children,
  full = false
}: {
  content: TaskObjectiveValue;
  children: ReactNode;
  full?: boolean;
}) {
  return (
    <div className="workflow-task-objective">
      <div className="workflow-task-copy">
        {full ? (
          <p>{content.chinese || content.detail || content.fallback}</p>
        ) : (
          <>
            {content.chinese && <p lang="zh-CN">{content.chinese}</p>}
            {!content.chinese && content.english && <p lang="en">{content.english}</p>}
            {!content.chinese && !content.english && <p>{content.fallback}</p>}
          </>
        )}
      </div>
      <div className="workflow-task-support">
        {(content.command || content.times.length || content.timezone) && (
          <div className="workflow-task-highlights">
            {content.command && (
              <span className="workflow-code-bubble" aria-label={`命令行：${content.command}`}>
                <SquareTerminal size={12} />
                <HighlightedCommand value={content.command} />
              </span>
            )}
            {content.times.map((time) => (
              <span className="workflow-task-fact" key={time}>
                <Clock3 size={11} />
                <strong>{time}</strong>
                <small>调度</small>
              </span>
            ))}
            {content.timezone && (
              <span className="workflow-task-fact">
                <Globe2 size={11} />
                <strong>{content.timezone}</strong>
              </span>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function TaskQuickPreview({ anchor, model }: { anchor: HTMLElement; model: WorkflowTaskViewModel }) {
  const root = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ left: 8, top: 8, visibility: 'hidden' });
  useLayoutEffect(() => {
    let frame = 0;
    const dock = document.querySelector<HTMLElement>('.command-dock');
    const update = () => {
      frame = 0;
      const element = root.current;
      if (!element) return;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth,
        viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const anchorRect = anchor.getBoundingClientRect(),
        previewRect = element.getBoundingClientRect();
      const width = previewRect.width || Math.min(380, viewportWidth - 16),
        height = previewRect.height || 220,
        dockRect = dock?.getBoundingClientRect();
      const safeBottom =
        dockRect && dockRect.height > 0 && dockRect.top < viewportHeight
          ? Math.min(viewportHeight - 8, dockRect.top - 8)
          : viewportHeight - 8;
      const maxTop = Math.max(8, safeBottom - height),
        below = anchorRect.bottom + 8 + height <= safeBottom;
      setStyle({
        left: clamp(anchorRect.left, 8, Math.max(8, viewportWidth - width - 8)),
        top: clamp(below ? anchorRect.bottom + 8 : anchorRect.top - height - 8, 8, maxTop),
        maxHeight: Math.max(80, safeBottom - 16),
        visibility: 'visible'
      });
    };
    const schedule = () => {
      if (!frame)
        frame = window.requestAnimationFrame ? window.requestAnimationFrame(update) : window.setTimeout(update, 0);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    if (root.current) observer?.observe(root.current);
    observer?.observe(anchor);
    if (dock) observer?.observe(dock);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    update();
    return () => {
      observer?.disconnect();
      if (frame) {
        if (window.cancelAnimationFrame) window.cancelAnimationFrame(frame);
        else window.clearTimeout(frame);
      }
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [anchor]);
  return createPortal(
    <div
      ref={root}
      className="workflow-task-quick-preview"
      role="tooltip"
      aria-label={`任务快速预览：${model.task.title}`}
      data-task-preview={model.id}
      style={style}
    >
      <header>
        <span>{model.phase}</span>
        <strong>{model.task.title}</strong>
        <span className={`task-status ${model.status}`}>{model.statusText}</span>
      </header>
      <TaskObjective content={model.objective}>
        <TaskMetrics title={model.task.title} values={model.metrics} />
      </TaskObjective>
      {model.blockers.length > 0 && <TaskAttention blockers={model.blockers} />}
    </div>,
    document.body
  );
}

export function pointerCanHover(pointerType: string) {
  if (pointerType === 'touch') return false;
  if (pointerType === 'mouse') return true;
  return typeof window.matchMedia !== 'function' || window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function HighlightedCommand({ value }: { value: string }) {
  const [executable = '', entrypoint = '', ...args] = value.trim().split(/\s+/);
  return (
    <code>
      <b>{executable}</b>
      {entrypoint && (
        <>
          {' '}
          <span>{entrypoint}</span>
        </>
      )}
      {args.length > 0 && (
        <>
          {' '}
          <i>{args.join(' ')}</i>
        </>
      )}
    </code>
  );
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
