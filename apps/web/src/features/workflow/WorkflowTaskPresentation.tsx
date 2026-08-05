import { Clock3, Database, GitBranch, GitFork, Globe2, LockKeyhole, PackageCheck, SquareTerminal } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TaskMetricValues, TaskObjectiveValue } from './WorkflowTaskViewModel';

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

export function TaskObjective({ content, children }: { content: TaskObjectiveValue; children: ReactNode }) {
  return (
    <div className="workflow-task-objective">
      <div className="workflow-task-copy">
        <p lang={content.summaryLanguage}>{content.summary || content.fallback}</p>
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
