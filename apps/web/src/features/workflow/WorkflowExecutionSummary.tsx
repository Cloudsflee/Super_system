import { ChevronDown, GitBranch, ListChecks, Pause, Play, RotateCcw, ShieldCheck, ShieldX, Square } from 'lucide-react';
import { useRef, useState } from 'react';
import type {
  RepositoryLineRecord,
  TaskExecutionRecord,
  WorkflowExecutionRecord,
  WorkflowExecutionSnapshot
} from '../../api/types';
import { displayStatus } from '../../components/common/display-labels';
import { ToolbarMenu } from '../../components/common/ToolbarMenu';
import { Tooltip } from '../../components/common/Tooltip';

export function WorkflowExecutionSummary({
  snapshot,
  execution,
  tasks,
  lines,
  workflowRevision,
  outcomesOpen,
  canWrite,
  busy,
  onToggleOutcomes,
  onStart,
  onControl
}: {
  snapshot?: WorkflowExecutionSnapshot | null;
  execution?: WorkflowExecutionRecord;
  tasks: TaskExecutionRecord[];
  lines: RepositoryLineRecord[];
  workflowRevision: number;
  outcomesOpen: boolean;
  canWrite: boolean;
  busy: string;
  onToggleOutcomes: () => void;
  onStart: () => void;
  onControl: (action: 'pause' | 'resume' | 'cancel') => Promise<void>;
}) {
  return (
    <div className="workflow-execution-row">
      <ExecutionState execution={execution} workflowRevision={workflowRevision} />
      {snapshot && <ExecutionFrontier snapshot={snapshot} tasks={tasks} />}
      {execution?.completion_status && <WorkflowCompletionBadge execution={execution} />}
      {lines[0] && <RepositoryLine line={lines[0]} />}
      {lines.length > 1 && <RepositoryLinesMenu lines={lines.slice(1)} />}
      {lines.length > 0 && <RepositoryLinesMenu lines={lines} mobile />}
      {execution?.completion_status && (
        <button
          type="button"
          className="workflow-outcome-toggle"
          aria-expanded={outcomesOpen}
          aria-controls={`workflow-outcomes-${execution.id}`}
          onClick={onToggleOutcomes}
        >
          <ListChecks size={14} />
          <span>Outcome</span>
          <ChevronDown size={13} />
        </button>
      )}
      <ExecutionActions execution={execution} canWrite={canWrite} busy={busy} onStart={onStart} onControl={onControl} />
    </div>
  );
}

function ExecutionState({
  execution,
  workflowRevision
}: {
  execution?: WorkflowExecutionRecord;
  workflowRevision: number;
}) {
  return (
    <div className="workflow-execution-state">
      <span className={`execution-dot ${execution?.status || 'not_started'}`} aria-hidden="true" />
      <div>
        <strong>{execution ? statusLabel(execution.status) : '尚未启动'}</strong>
        <small>
          修订版 {execution?.workflow_revision || workflowRevision}
          {execution ? ` · ${short(execution.id)}` : ''}
        </small>
      </div>
    </div>
  );
}

function ExecutionFrontier({ snapshot, tasks }: { snapshot: WorkflowExecutionSnapshot; tasks: TaskExecutionRecord[] }) {
  const completed = tasks.filter((item) => item.status === 'completed').length;
  return (
    <div
      className="workflow-frontier"
      aria-label={`可执行 ${snapshot.frontier.length}，等待中 ${snapshot.waiting_reasons.length}，已完成 ${completed}/${tasks.length}`}
    >
      <span>
        <strong>{snapshot.frontier.length}</strong>
        <small>可执行</small>
      </span>
      <span>
        <strong>{snapshot.waiting_reasons.length}</strong>
        <small>等待中</small>
      </span>
      <span>
        <strong>
          {completed}/{tasks.length}
        </strong>
        <small>已完成</small>
      </span>
    </div>
  );
}

function WorkflowCompletionBadge({ execution }: { execution: WorkflowExecutionRecord }) {
  const eligible = execution.release_eligible === true;
  return (
    <Tooltip label={eligible ? 'Release eligible' : 'Release blocked'}>
      <span
        className={`workflow-completion-badge ${execution.completion_status} ${eligible ? 'eligible' : 'ineligible'}`}
      >
        {eligible ? <ShieldCheck size={13} /> : <ShieldX size={13} />}
        <span>{completionStatusLabel(execution.completion_status || 'pending')}</span>
      </span>
    </Tooltip>
  );
}

function ExecutionActions({
  execution,
  canWrite,
  busy,
  onStart,
  onControl
}: {
  execution?: WorkflowExecutionRecord;
  canWrite: boolean;
  busy: string;
  onStart: () => void;
  onControl: (action: 'pause' | 'resume' | 'cancel') => Promise<void>;
}) {
  if (!canWrite) return null;
  if (!execution)
    return (
      <div className="workflow-execution-actions">
        <button className="button primary" disabled={busy === 'start'} onClick={onStart}>
          <Play size={15} />
          启动工作流
        </button>
      </div>
    );
  if (execution.status === 'running')
    return (
      <div className="workflow-execution-actions">
        <button className="button secondary" disabled={Boolean(busy)} onClick={() => void onControl('pause')}>
          <Pause size={15} />
          暂停
        </button>
        <button
          className="button secondary danger-subtle"
          disabled={Boolean(busy)}
          onClick={() => void onControl('cancel')}
        >
          <Square size={14} />
          取消
        </button>
      </div>
    );
  if (execution.status === 'paused')
    return (
      <div className="workflow-execution-actions">
        <button className="button primary" disabled={Boolean(busy)} onClick={() => void onControl('resume')}>
          <RotateCcw size={15} />
          继续
        </button>
        <button className="button secondary" disabled={Boolean(busy)} onClick={() => void onControl('cancel')}>
          <Square size={14} />
          取消
        </button>
      </div>
    );
  const label = execution.status === 'completed' ? '再次运行' : '重新运行';
  return (
    <div className="workflow-execution-actions">
      <button className="button secondary" disabled={busy === 'start'} onClick={onStart}>
        <RotateCcw size={15} />
        {label}
      </button>
    </div>
  );
}

function RepositoryLine({ line, menu = false }: { line: RepositoryLineRecord; menu?: boolean }) {
  const sha = line.merged_sha || line.head_sha || line.base_sha;
  const label = `${line.branch} · ${sha || '待绑定'} · ${displayStatus(line.status)}`;
  if (menu)
    return (
      <div className="repository-line-menuitem" role="menuitem" tabIndex={-1} aria-label={label}>
        <GitBranch size={13} />
        <span>{line.branch}</span>
        <code>{sha || '待绑定'}</code>
        <i className={`status ${line.status}`}>{displayStatus(line.status)}</i>
      </div>
    );
  return (
    <Tooltip label={label}>
      <div className="repository-line-summary" tabIndex={0} aria-label={label}>
        <GitBranch size={13} />
        <span>{line.branch}</span>
        <code>{short(sha)}</code>
        <i className={`status ${line.status}`}>{displayStatus(line.status)}</i>
      </div>
    </Tooltip>
  );
}

function RepositoryLinesMenu({ lines, mobile = false }: { lines: RepositoryLineRecord[]; mobile?: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuLabel = mobile ? '全部仓库线' : '其余仓库线';
  return (
    <div className={`repository-lines-menu${mobile ? ' mobile' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={mobile ? `查看全部仓库线，共 ${lines.length} 条` : `查看其余 ${lines.length} 条仓库线`}
        onClick={() => setOpen((value) => !value)}
      >
        {mobile ? `${lines.length} 条` : `+${lines.length} 条仓库线`}
      </button>
      <ToolbarMenu open={open} label={menuLabel} triggerRef={triggerRef} onClose={() => setOpen(false)}>
        {lines.map((line) => (
          <RepositoryLine key={line.id} line={line} menu />
        ))}
      </ToolbarMenu>
    </div>
  );
}

function statusLabel(value: string) {
  return (
    (
      {
        running: '任务流程运行中',
        paused: '任务流程已暂停',
        completed: '任务流程已完成',
        cancelled: '任务流程已取消',
        failed: '任务流程失败'
      } as Record<string, string>
    )[value] || '任务流程状态未知'
  );
}

function completionStatusLabel(value: string) {
  return (
    (
      {
        pending: '结果待评估',
        completed: '真实完成',
        completed_with_gaps: '完成但有缺口',
        waived: '已授权豁免',
        failed: '交付失败',
        legacy_unassessed: '历史未评估'
      } as Record<string, string>
    )[value] || value
  );
}

function short(value?: string | null) {
  return value ? value.slice(0, 10) : '待绑定';
}
