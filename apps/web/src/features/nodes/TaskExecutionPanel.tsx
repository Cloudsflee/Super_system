import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, json } from '../../api/client';
import type { PullRequestIntentRecord, TaskExecutionDetails, TaskReadiness } from '../../api/types';
import { useUi } from '../../state/ui';
import { TaskExecutionEmpty } from './TaskExecutionDetailsView';
import { TaskExecutionPanelView } from './TaskExecutionPanelView';
import { buildManualSubmission, effectClaimsForReview, manualUsageOptions } from './task-execution-manual-domain';
import { short } from './task-execution-labels';

export function TaskExecutionPanel({ taskId, canWrite = true }: { taskId: string; canWrite?: boolean }) {
  const toast = useUi((state) => state.toast),
    [busy, setBusy] = useState(''),
    [manualValues, setManualValues] = useState<Record<string, string>>({}),
    [manualUsage, setManualUsage] = useState<Record<string, string[]>>({}),
    [manualReasons, setManualReasons] = useState<Record<string, string>>({}),
    [acceptedEffectClaims, setAcceptedEffectClaims] = useState<string[]>([]),
    readiness = useQuery({
      queryKey: ['task-readiness', taskId],
      queryFn: () => api<TaskReadiness>(`/tasks/${taskId}/readiness`),
      refetchInterval: 1_000
    }),
    executionId = readiness.data?.task_execution_id || '',
    details = useQuery({
      queryKey: ['task-execution', executionId],
      queryFn: () => api<TaskExecutionDetails>(`/task-executions/${executionId}`),
      enabled: Boolean(executionId),
      refetchInterval: (query) => (terminal(query.state.data?.task_execution.status) ? false : 1_000)
    }),
    value = details.data,
    execution = value?.task_execution,
    candidates = useMemo(
      () => value?.outputs.filter((item) => item.asset?.status === 'candidate' && !item.bound) || [],
      [value?.outputs]
    ),
    usageOptions = useMemo(() => manualUsageOptions(value), [value]),
    contributionReview = useMemo(() => effectClaimsForReview(value, candidates), [value, candidates]),
    contributionReviewRequired = execution?.context_snapshot?.schema_version === 'aiws.task_execution_context.v5';
  useEffect(() => setAcceptedEffectClaims([]), [executionId]);

  async function refresh() {
    await Promise.all([readiness.refetch(), details.refetch()]);
  }
  async function act(name: string, operation: () => Promise<unknown>) {
    setBusy(name);
    try {
      await operation();
      await refresh();
      toast('人工确认点已更新');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy('');
    }
  }
  async function retry() {
    if (!execution) return;
    await act('retry', () => api(`/task-executions/${execution.id}/retry`, json('POST', {}, '重试任务执行')));
  }
  async function decide(decision: 'approve' | 'reject') {
    if (!execution || !candidates.length) return;
    const availableClaimIds = new Set(contributionReview.map((item) => item.claimId));
    await act(decision, () =>
      api(
        `/task-executions/${execution.id}/human-approve`,
        json(
          'POST',
          {
            decision,
            expected_versions: candidates.map((item) => ({
              version_id: item.version?.id,
              content_sha256: item.version?.content_sha256
            })),
            ...(contributionReviewRequired
              ? {
                  accepted_effect_claim_ids:
                    decision === 'approve'
                      ? acceptedEffectClaims.filter((claimId) => availableClaimIds.has(claimId))
                      : []
                }
              : {})
          },
          decision === 'approve' ? '验收任务输出' : '退回任务输出'
        )
      )
    );
  }
  async function submitManual() {
    if (!execution || !value) return;
    const payload = buildManualSubmission(value, manualValues, manualUsage, manualReasons, usageOptions);
    await act('manual', () =>
      api(`/task-executions/${execution.id}/manual-submit`, json('POST', payload, '提交人工确认点'))
    );
  }
  async function approvePullRequest(action: 'create_pr' | 'merge_pr') {
    const intent = value?.pull_request_intent;
    if (!intent) return;
    await act(action, async () => {
      const approved = await api<{ intent: PullRequestIntentRecord }>(
        `/pull-request-intents/${intent.id}/approve`,
        json(
          'POST',
          { action, expected_revision: intent.revision, expected_snapshot_hash: intent.snapshot_hash },
          action === 'create_pr' ? '批准创建合并请求' : '批准合并请求'
        )
      );
      return api(
        `/pull-request-intents/${intent.id}/execute`,
        json(
          'POST',
          {
            action,
            expected_revision: approved.intent.revision,
            expected_snapshot_hash: approved.intent.snapshot_hash
          },
          action === 'create_pr' ? '创建合并请求' : '合并代码变更'
        )
      );
    });
  }
  if (!executionId) return <TaskExecutionEmpty title="尚未启动" detail="工作流执行" />;
  if (details.isLoading || !value || !execution)
    return <TaskExecutionEmpty title="正在读取任务执行" detail={short(executionId)} />;
  return (
    <TaskExecutionPanelView
      value={value}
      canWrite={canWrite}
      busy={busy}
      candidates={candidates}
      claims={contributionReview}
      acceptedClaimIds={acceptedEffectClaims}
      contributionReviewRequired={contributionReviewRequired}
      manualValues={manualValues}
      manualUsage={manualUsage}
      manualReasons={manualReasons}
      usageOptions={usageOptions}
      onRetry={() => void retry()}
      onValueChange={(key, content) => setManualValues((current) => ({ ...current, [key]: content }))}
      onUsageChange={(key, id, checked) =>
        setManualUsage((current) => ({
          ...current,
          [key]: checked
            ? [...new Set([...(current[key] || []), id])]
            : (current[key] || []).filter((item) => item !== id)
        }))
      }
      onReasonChange={(id, reason) => setManualReasons((current) => ({ ...current, [id]: reason }))}
      onManualSubmit={() => void submitManual()}
      onClaimChange={(claimId, checked) =>
        setAcceptedEffectClaims((current) =>
          checked ? [...new Set([...current, claimId])] : current.filter((item) => item !== claimId)
        )
      }
      onDecision={(decision) => void decide(decision)}
      onApprovePullRequest={approvePullRequest}
    />
  );
}

function terminal(value?: string) {
  return ['completed', 'failed', 'cancelled', 'superseded'].includes(value || '');
}
