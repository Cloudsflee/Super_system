import { CheckCircle2, CircleAlert, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, json } from '../../api/client';
import { keys, useWorkflowMigrations } from '../../api/queries';
import type {
  Project,
  ProjectMembership,
  Workflow,
  WorkflowMigrationBatch,
  WorkflowMigrationJob
} from '../../api/types';
import { useUi } from '../../state/ui';

type Props = { project: Project; membership?: ProjectMembership | null; workflow: Workflow };

export function WorkflowMigrationGate({ project, membership, workflow }: Props) {
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);
  const migration = useWorkflowMigrations();
  const batch =
    migration.data?.batch && migration.data.batch.workflow_ids.includes(workflow.id) ? migration.data.batch : null;
  const job = batch ? migration.data?.jobs.find((item) => item.workflow_id === workflow.id) || null : null;
  const isOwner = membership?.role === 'owner' || project.current_user_role === 'owner';
  const approve = useMutation({
    mutationFn: () => {
      if (!batch) throw new Error('workflow_migration_batch_not_found');
      return api<{ batch: WorkflowMigrationBatch }>(
        `/workflow-migrations/batches/${batch.id}/approve`,
        json(
          'POST',
          {},
          {
            name: '批准两级工作流迁移',
            feedback: 'foreground',
            timeoutMs: 120_000,
            safeRetry: true,
            idempotencyKey: `web-workflow-migration-${batch.id}`
          }
        )
      );
    },
    onSuccess: () => {
      toast('迁移已批准，正在生成两级工作流');
      void invalidateMigration(queryClient, project.id);
    },
    onError: (error) => toast(error.message, 'error')
  });
  const retry = useMutation({
    mutationFn: () => {
      if (!job) throw new Error('workflow_migration_job_not_found');
      return api(
        `/workflow-migrations/jobs/${job.id}/retry`,
        json(
          'POST',
          {},
          {
            name: '重试两级工作流迁移',
            feedback: 'foreground',
            timeoutMs: 120_000,
            safeRetry: true,
            idempotencyKey: `web-workflow-migration-retry-${job.id}`
          }
        )
      );
    },
    onSuccess: () => {
      toast('迁移已重新排队');
      void invalidateMigration(queryClient, project.id);
    },
    onError: (error) => toast(error.message, 'error')
  });

  useEffect(() => {
    if (job?.status === 'completed' || batch?.status === 'completed') void invalidateMigration(queryClient, project.id);
  }, [batch?.status, job?.status, project.id, queryClient]);

  if (migration.isLoading)
    return (
      <GateState
        icon={<LoaderCircle className="spin" aria-hidden />}
        title="正在读取迁移批次"
        detail="正在确认当前工作流的所有者批准状态。"
      />
    );
  if (migration.isError)
    return (
      <GateState
        icon={<CircleAlert aria-hidden />}
        title="迁移状态加载失败"
        detail={migration.error.message}
        error
        action={
          <button className="button secondary" onClick={() => void migration.refetch()}>
            <RefreshCw size={16} />
            重试
          </button>
        }
      />
    );
  if (!batch)
    return (
      <GateState
        icon={<CircleAlert aria-hidden />}
        title="迁移批次不可用"
        detail="当前工作流仍是旧层级，但没有找到对应的迁移批次。请刷新后再检查。"
        action={
          <button className="button secondary" onClick={() => void migration.refetch()}>
            <RefreshCw size={16} />
            刷新状态
          </button>
        }
      />
    );

  const state = migrationState(batch, job);
  const busy = approve.isPending || retry.isPending;
  if (state === 'pending_approval') {
    return (
      <GateState
        icon={<ShieldCheck aria-hidden />}
        title="工作流等待所有者批准"
        detail="旧工作流会保持只读。批准后，系统会保留原任务标识并生成两级工作流分组与任务结构。"
        batch={batch}
        job={job}
        action={
          isOwner ? (
            <button className="button primary" disabled={busy} onClick={() => approve.mutate()}>
              <ShieldCheck size={16} />
              {approve.isPending ? '正在提交批准' : '批准两级迁移'}
            </button>
          ) : (
            <span className="workflow-migration-owner-note">
              <LockKeyhole size={16} />
              只有项目所有者可以批准
            </span>
          )
        }
      />
    );
  }
  if (state === 'waiting_active_runs') {
    return (
      <GateState
        icon={<LoaderCircle className="spin" aria-hidden />}
        title="等待活动运行完成"
        detail="迁移不会中断正在执行的任务；全部运行结束后会自动继续。"
        batch={batch}
        job={job}
      />
    );
  }
  if (state === 'approved' || state === 'running') {
    return (
      <GateState
        icon={<LoaderCircle className="spin" aria-hidden />}
        title="正在生成两级工作流"
        detail="系统正在生成候选结构并执行一致性检查，页面会自动刷新。"
        batch={batch}
        job={job}
      />
    );
  }
  if (state === 'failed') {
    return (
      <GateState
        icon={<CircleAlert aria-hidden />}
        title="两级迁移失败"
        detail={job?.error_code ? `迁移失败代码：${job.error_code}` : '迁移没有完成，旧工作流仍保持只读。'}
        error
        batch={batch}
        job={job}
        action={
          isOwner && job?.status === 'failed' ? (
            <button className="button primary" disabled={busy} onClick={() => retry.mutate()}>
              <RefreshCw size={16} />
              {retry.isPending ? '正在重试' : '重试迁移'}
            </button>
          ) : (
            <span className="workflow-migration-owner-note">
              <LockKeyhole size={16} />
              请项目所有者处理
            </span>
          )
        }
      />
    );
  }
  if (state === 'completed')
    return (
      <GateState
        icon={<CheckCircle2 aria-hidden />}
        title="两级迁移已完成"
        detail="正在刷新工作流结构。"
        batch={batch}
        job={job}
      />
    );
  return (
    <GateState
      icon={<CircleAlert aria-hidden />}
      title="迁移批次已结束"
      detail={`当前状态：${migrationStatusLabel(batch.status)}`}
      batch={batch}
      job={job}
    />
  );
}

function GateState({
  icon,
  title,
  detail,
  batch,
  job,
  action,
  error = false
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  batch?: WorkflowMigrationBatch;
  job?: WorkflowMigrationJob | null;
  action?: ReactNode;
  error?: boolean;
}) {
  return (
    <main className={`full-state workflow-migration-state${error ? ' error' : ''}`}>
      <section className="workflow-migration-panel" role={error ? 'alert' : undefined}>
        <div className="workflow-migration-icon">{icon}</div>
        <span className="overline">工作流治理</span>
        <h1>{title}</h1>
        <p>{detail}</p>
        {batch && (
          <dl className="workflow-migration-meta">
            <div>
              <dt>迁移批次</dt>
              <dd>{batch.id}</dd>
            </div>
            <div>
              <dt>批次状态</dt>
              <dd>
                <span className={`status ${batch.status}`}>{migrationStatusLabel(batch.status)}</span>
              </dd>
            </div>
            {job && (
              <div>
                <dt>当前任务</dt>
                <dd>
                  <span className={`status ${job.status}`}>{migrationStatusLabel(job.status)}</span>
                </dd>
              </div>
            )}
          </dl>
        )}
        {action && <footer className="workflow-migration-actions">{action}</footer>}
      </section>
    </main>
  );
}

function migrationState(batch: WorkflowMigrationBatch, job: WorkflowMigrationJob | null) {
  if (job?.status === 'failed' || batch.status === 'completed_with_failures') return 'failed';
  if (job?.status === 'waiting_active_runs' || batch.status === 'waiting_active_runs') return 'waiting_active_runs';
  if (job?.status === 'completed' || batch.status === 'completed') return 'completed';
  if (batch.status === 'pending_approval') return 'pending_approval';
  if (['approved', 'running'].includes(batch.status) || ['generating', 'critic'].includes(job?.status || ''))
    return 'running';
  return batch.status;
}

function migrationStatusLabel(value: string) {
  return (
    (
      {
        pending_approval: '待所有者批准',
        approved: '已批准',
        running: '执行中',
        generating: '生成候选',
        critic: '一致性检查',
        waiting_active_runs: '等待活动运行',
        failed: '失败',
        completed: '已完成',
        completed_with_failures: '部分失败',
        cancelled: '已取消',
        pending: '等待执行'
      } as Record<string, string>
    )[value] || '其他状态'
  );
}

async function invalidateMigration(queryClient: QueryClient, projectId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.workflowMigrations }),
    queryClient.invalidateQueries({ queryKey: keys.project(projectId) }),
    queryClient.invalidateQueries({ queryKey: keys.projects })
  ]);
}
