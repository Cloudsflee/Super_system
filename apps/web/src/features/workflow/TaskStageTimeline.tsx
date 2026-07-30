import { AlertTriangle, Check, CircleDashed, Clock3, ListChecks, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, json } from '../../api/client';
import type {
  ExecutionStage,
  ExecutionStageCheckpoint,
  FailureEnvelope,
  TaskExecutionRecord,
  TaskStageSnapshot
} from '../../api/types';
import { useUi } from '../../state/ui';

const STAGES: ExecutionStage[] = ['preflight', 'execute', 'collect', 'verify', 'attest', 'promote', 'finalize'];
const REPLAYABLE = new Set<ExecutionStage>(['verify', 'attest', 'promote', 'finalize']);

export function TaskStageTimeline({ execution, canReplay }: { execution?: TaskExecutionRecord; canReplay: boolean }) {
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<TaskStageSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const toast = useUi((state) => state.toast);
  const refresh = useCallback(async () => {
    if (!execution) return null;
    try {
      const next = await api<TaskStageSnapshot>(`/task-executions/${execution.id}/stages`);
      setSnapshot(next);
      setError(null);
      return next;
    } catch (requestError) {
      setError(requestError as Error);
      return null;
    }
  }, [execution?.id]);
  useEffect(() => {
    if (!execution) return;
    let disposed = false;
    let timer = 0;
    const poll = async () => {
      await refresh();
      if (!disposed && ['queued', 'running', 'verifying'].includes(execution.status))
        timer = window.setTimeout(poll, 1_000);
    };
    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [execution?.id, execution?.status, refresh]);
  if (!execution) return null;
  const latest = latestByStage(snapshot?.stages || []);
  const failure = snapshot?.failure || execution.failure || null;

  async function replay(stage: ExecutionStage) {
    setBusy(true);
    try {
      await api(`/task-executions/${execution!.id}/stages/${stage}/replay`, json('POST', {}, `重放 ${stage} 阶段`));
      await refresh();
      toast(`${stageLabel(stage)} 阶段已重放`);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="workflow-task-stages workflow-detail-span-all">
      <header>
        <ListChecks size={14} />
        <strong>执行阶段</strong>
        <small>{snapshot?.replay_count || execution.replay_count || 0} 次重放</small>
      </header>
      {error && <p className="workflow-stage-load-error">{error.message}</p>}
      <ol className="task-stage-timeline">
        {STAGES.map((stage) => {
          const checkpoint = latest.get(stage);
          const state = checkpoint?.status || (snapshot?.current_stage === stage ? 'running' : 'pending');
          return (
            <li key={stage} className={state}>
              <StageIcon state={state} />
              <span>
                <strong>{stageLabel(stage)}</strong>
                <small>
                  {checkpoint
                    ? `第 ${checkpoint.attempt} 次 · ${formatDuration(checkpoint.duration_ms)}`
                    : stateLabel(state)}
                </small>
              </span>
              {checkpoint?.status === 'failed' && canReplay && REPLAYABLE.has(stage) && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`仅重放 ${stageLabel(stage)} 阶段`}
                  disabled={busy}
                  onClick={() => void replay(stage)}
                >
                  <RotateCcw size={13} />
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {failure && <FailureDetails failure={failure} />}
    </section>
  );
}

function FailureDetails({ failure }: { failure: FailureEnvelope }) {
  return (
    <div className="task-stage-failure">
      <AlertTriangle size={14} />
      <span>
        <strong>{failure.code}</strong>
        <small>
          {stageLabel(failure.stage)} · {failure.category} · {failure.retryable ? '可重试' : '确定性失败'}
        </small>
        {failure.message && <p>{failure.message}</p>}
        {failure.field_path && <code>{failure.field_path}</code>}
      </span>
    </div>
  );
}

function StageIcon({ state }: { state: string }) {
  if (state === 'completed') return <Check size={13} />;
  if (state === 'failed') return <X size={13} />;
  if (state === 'running') return <Clock3 size={13} />;
  return <CircleDashed size={13} />;
}

function latestByStage(checkpoints: ExecutionStageCheckpoint[]) {
  const map = new Map<ExecutionStage, ExecutionStageCheckpoint>();
  for (const checkpoint of checkpoints) {
    const existing = map.get(checkpoint.stage);
    if (!existing || checkpoint.sequence > existing.sequence) map.set(checkpoint.stage, checkpoint);
  }
  return map;
}

function stageLabel(value: ExecutionStage) {
  return (
    {
      preflight: 'Preflight',
      execute: 'Execute',
      collect: 'Collect',
      verify: 'Verify',
      attest: 'Attest',
      promote: 'Promote',
      finalize: 'Finalize'
    } as Record<ExecutionStage, string>
  )[value];
}

function stateLabel(value: string) {
  return (
    ({ pending: '待执行', running: '执行中', completed: '完成', failed: '失败' } as Record<string, string>)[value] ||
    value
  );
}

function formatDuration(value: number) {
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}
