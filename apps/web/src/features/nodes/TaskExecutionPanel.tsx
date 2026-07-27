import { useQuery } from '@tanstack/react-query';
import {
  Check,
  Database,
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  RotateCcw,
  ShieldCheck,
  X
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, json } from '../../api/client';
import type { PullRequestIntentRecord, TaskExecutionDetails, TaskExecutionInput, TaskReadiness } from '../../api/types';
import {
  assetTypeLabel,
  checkStatusLabel,
  displayStatus,
  executorLabel,
  pullRequestStatusLabel
} from '../../components/common/display-labels';
import { useUi } from '../../state/ui';

export function TaskExecutionPanel({ taskId, canWrite = true }: { taskId: string; canWrite?: boolean }) {
  const toast = useUi((state) => state.toast),
    [busy, setBusy] = useState('');
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [manualUsage, setManualUsage] = useState<Record<string, string[]>>({});
  const [manualReasons, setManualReasons] = useState<Record<string, string>>({});
  const readiness = useQuery({
    queryKey: ['task-readiness', taskId],
    queryFn: () => api<TaskReadiness>(`/tasks/${taskId}/readiness`),
    refetchInterval: 1_000
  });
  const executionId = readiness.data?.task_execution_id || '';
  const details = useQuery({
    queryKey: ['task-execution', executionId],
    queryFn: () => api<TaskExecutionDetails>(`/task-executions/${executionId}`),
    enabled: Boolean(executionId),
    refetchInterval: (query) => (terminal(query.state.data?.task_execution.status) ? false : 1_000)
  });
  const value = details.data,
    execution = value?.task_execution;
  const candidates = useMemo(
    () => value?.outputs.filter((item) => item.asset?.status === 'candidate' && !item.bound) || [],
    [value?.outputs]
  );
  const usageOptions = useMemo(() => manualUsageOptions(value), [value]);
  async function refresh() {
    await Promise.all([readiness.refetch(), details.refetch()]);
  }
  async function retry() {
    if (!execution) return;
    await act('retry', () => api(`/task-executions/${execution.id}/retry`, json('POST', {}, '重试任务执行')));
  }
  async function decide(decision: 'approve' | 'reject') {
    if (!execution || !candidates.length) return;
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
            }))
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
  if (!executionId) return <TaskExecutionEmpty title="尚未启动" detail="工作流执行" />;
  if (details.isLoading || !value || !execution)
    return <TaskExecutionEmpty title="正在读取任务执行" detail={short(executionId)} />;
  const intent = value.pull_request_intent;
  return (
    <section className="task-execution-panel">
      <TaskExecutionHeader
        execution={execution}
        canWrite={canWrite}
        busy={Boolean(busy)}
        onRetry={() => void retry()}
      />
      <div className="task-execution-snapshot">
        <SnapshotColumn title="固定输入" icon={<Database size={14} />} empty="无固定输入">
          {value.inputs.map((input) => (
            <ExecutionInput key={input.key} input={input} />
          ))}
        </SnapshotColumn>
        <SnapshotColumn title="输出载荷" icon={<ShieldCheck size={14} />} empty="等待输出">
          {value.outputs.map((item) => (
            <ExecutionOutput key={`${item.asset_id}-${item.version_id}`} item={item} />
          ))}
        </SnapshotColumn>
      </div>
      <HandoffSummary value={value} />
      {canWrite &&
        execution.status === 'awaiting_human' &&
        execution.executor === 'manual' &&
        !value.outputs.length && (
          <ManualTaskCheckpoint
            contract={value.contract}
            manualValues={manualValues}
            manualUsage={manualUsage}
            manualReasons={manualReasons}
            usageOptions={usageOptions}
            busy={Boolean(busy)}
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
            onSubmit={() => void submitManual()}
          />
        )}
      {canWrite && execution.status === 'awaiting_human' && candidates.length > 0 && (
        <div className="task-checkpoint-actions">
          <span>
            <ShieldCheck size={15} />
            <strong>{candidates.length} 项候选输出</strong>
            <small>{candidates.map((item) => `${item.key}@${short(item.version?.id)}`).join(' · ')}</small>
          </span>
          <button className="button secondary danger" disabled={Boolean(busy)} onClick={() => void decide('reject')}>
            <X size={14} />
            退回
          </button>
          <button className="button primary" disabled={Boolean(busy)} onClick={() => void decide('approve')}>
            <Check size={14} />
            验收
          </button>
        </div>
      )}
      {canWrite && execution.executor === 'repository_integrate' && intent && (
        <PullRequestCheckpoint intent={intent} busy={busy} onApprove={approvePullRequest} />
      )}
      {execution.readiness?.reasons?.length ? (
        <div className="task-waiting-reasons">
          {execution.readiness.reasons.map((item, index) => (
            <span key={`${item.code}-${index}`}>{reasonLabel(item.code)}</span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function buildManualSubmission(
  value: TaskExecutionDetails,
  manualValues: Record<string, string>,
  manualUsage: Record<string, string[]>,
  manualReasons: Record<string, string>,
  usageOptions: ReturnType<typeof manualUsageOptions>
) {
  const globallyUsed = new Set(Object.values(manualUsage).flat()),
    dispositions = usageOptions
      .filter((option) => globallyUsed.has(option.id) || option.explicitPolicy)
      .map((option) => ({
        id: option.id,
        disposition: globallyUsed.has(option.id) ? ('used' as const) : ('not_used' as const),
        reason: globallyUsed.has(option.id) ? '人工输出明确使用该输入。' : (manualReasons[option.id] || '').trim()
      })),
    outputs = value.contract.expected_outputs.map((slot) => {
      const outputUsage = manualUsage[slot.key] || [];
      return {
        output_key: slot.key,
        asset_type: slot.asset_type,
        title: `${value.task.title} ${slot.key}`,
        summary: manualValues[slot.key] || '',
        payload: {
          payload_kind: 'text',
          media_type: 'text/plain; charset=utf-8',
          content: manualValues[slot.key] || ''
        },
        evidence_refs: [],
        consumed_input_versions: outputUsage
          .filter((item) => item.startsWith('asset:'))
          .map((item) => item.slice('asset:'.length)),
        consumed_context_document_versions: outputUsage
          .filter((item) => item.startsWith('context:'))
          .map((item) => item.slice('context:'.length)),
        input_dispositions: dispositions
          .filter((item) => item.id.startsWith('asset:'))
          .map((item) => ({
            version_id: item.id.slice('asset:'.length),
            disposition: outputUsage.includes(item.id) ? ('used' as const) : ('not_used' as const),
            reason: outputDispositionReason(item, outputUsage, 'asset')
          })),
        context_dispositions: dispositions
          .filter((item) => item.id.startsWith('context:'))
          .map((item) => ({
            document_version_id: item.id.slice('context:'.length),
            disposition: outputUsage.includes(item.id) ? ('used' as const) : ('not_used' as const),
            reason: outputDispositionReason(item, outputUsage, 'context')
          })),
        purpose: slot.purpose || `交付 ${slot.key}`,
        consumer_hint: slot.consumer_hint || '',
        unresolved_questions: [],
        limitations: []
      };
    });
  return {
    outputs,
    consumed_input_versions: [...new Set(outputs.flatMap((item) => item.consumed_input_versions))],
    input_dispositions: dispositions
      .filter((item) => item.id.startsWith('asset:'))
      .map((item) => ({
        version_id: item.id.slice('asset:'.length),
        disposition: item.disposition,
        reason: item.reason
      })),
    consumed_context_document_versions: [
      ...new Set(outputs.flatMap((item) => item.consumed_context_document_versions))
    ],
    context_dispositions: dispositions
      .filter((item) => item.id.startsWith('context:'))
      .map((item) => ({
        document_version_id: item.id.slice('context:'.length),
        disposition: item.disposition,
        reason: item.reason
      }))
  };
}

function outputDispositionReason(
  item: { id: string; disposition: 'used' | 'not_used'; reason: string },
  outputUsage: string[],
  kind: 'asset' | 'context'
) {
  if (outputUsage.includes(item.id))
    return kind === 'asset' ? '该输出明确使用此资产版本。' : '该输出明确使用此上下文版本。';
  if (item.disposition === 'used') return '该输入用于其他输出，本输出未使用。';
  return item.reason;
}

function ManualTaskCheckpoint({
  contract,
  manualValues,
  manualUsage,
  manualReasons,
  usageOptions,
  busy,
  onValueChange,
  onUsageChange,
  onReasonChange,
  onSubmit
}: {
  contract: TaskExecutionDetails['contract'];
  manualValues: Record<string, string>;
  manualUsage: Record<string, string[]>;
  manualReasons: Record<string, string>;
  usageOptions: ReturnType<typeof manualUsageOptions>;
  busy: boolean;
  onValueChange: (key: string, content: string) => void;
  onUsageChange: (key: string, id: string, checked: boolean) => void;
  onReasonChange: (id: string, reason: string) => void;
  onSubmit: () => void;
}) {
  const incompleteOutput = contract.expected_outputs.some((slot) => !(manualValues[slot.key] || '').trim()),
    used = new Set(Object.values(manualUsage).flat()),
    invalidUsage = usageOptions.some(
      (option) =>
        (option.consumptionPolicy === 'must_use' && !used.has(option.id)) ||
        (!used.has(option.id) && option.explicitPolicy && !(manualReasons[option.id] || '').trim())
    );
  return (
    <div className="task-manual-checkpoint">
      {contract.expected_outputs.map((slot) => (
        <div className="task-manual-output" key={slot.key}>
          <label htmlFor={`manual-output-${slot.key}`}>
            {slot.key}
            <small>{assetTypeLabel(slot.asset_type)}</small>
          </label>
          <textarea
            id={`manual-output-${slot.key}`}
            value={manualValues[slot.key] || ''}
            onChange={(event) => onValueChange(slot.key, event.target.value)}
          />
          {usageOptions.length > 0 && (
            <span className="task-manual-usage">
              <small>实际使用</small>
              {usageOptions.map((option) => (
                <label key={`${slot.key}-${option.id}`}>
                  <input
                    type="checkbox"
                    checked={(manualUsage[slot.key] || []).includes(option.id)}
                    onChange={(event) => onUsageChange(slot.key, option.id, event.target.checked)}
                  />
                  <span>{option.label}</span>
                  {option.consumptionPolicy === 'must_use' && <small>必须使用</small>}
                </label>
              ))}
            </span>
          )}
        </div>
      ))}
      {usageOptions
        .filter((option) => !used.has(option.id) && option.explicitPolicy)
        .map((option) => (
          <label className="task-manual-reason" key={`reason-${option.id}`}>
            <span>{option.label} · 未使用原因</span>
            <input
              type="text"
              value={manualReasons[option.id] || ''}
              onChange={(event) => onReasonChange(option.id, event.target.value)}
            />
          </label>
        ))}
      <button className="button primary" disabled={busy || incompleteOutput || invalidUsage} onClick={onSubmit}>
        <Check size={15} />
        提交并验收
      </button>
    </div>
  );
}

function manualUsageOptions(value?: TaskExecutionDetails) {
  if (!value) return [];
  const options = value.inputs.flatMap((input) =>
    (input.asset_versions || []).map((version) => ({
      id: `asset:${version.version_id}`,
      label: `${input.key} · ${version.title || short(version.version_id)}`,
      required: input.required !== false,
      consumptionPolicy: input.consumption_policy || (input.required !== false ? 'must_use' : 'available'),
      explicitPolicy: Boolean(input.consumption_policy)
    }))
  );
  for (const document of value.context_documents || [])
    options.push({
      id: `context:${document.document_version_id}`,
      label: `${document.title || document.source_collection || '上下文'} · ${short(document.document_version_id)}`,
      required: document.required === true,
      consumptionPolicy: document.consumption_policy || (document.required === true ? 'must_use' : 'available'),
      explicitPolicy: Boolean(document.consumption_policy)
    });
  const unique = new Map<string, (typeof options)[number]>();
  for (const option of options) {
    const previous = unique.get(option.id);
    unique.set(option.id, {
      ...option,
      required: option.required || previous?.required === true,
      consumptionPolicy:
        option.consumptionPolicy === 'must_use' || previous?.consumptionPolicy === 'must_use'
          ? 'must_use'
          : option.consumptionPolicy,
      explicitPolicy: option.explicitPolicy || previous?.explicitPolicy === true
    });
  }
  return [...unique.values()];
}

function HandoffSummary({ value }: { value: TaskExecutionDetails }) {
  const handoff = value.handoff;
  if (!handoff) return null;
  return (
    <div className={`task-handoff-summary ${handoff.handoff_status}`}>
      <span>
        <GitCommitHorizontal size={15} />
        <strong>
          {handoff.handoff_status === 'ready'
            ? '交付就绪'
            : handoff.handoff_status === 'incomplete'
              ? '交付有缺口'
              : '等待交付'}
        </strong>
      </span>
      <small>使用资产 {handoff.used_inputs.length}</small>
      <small>未使用资产 {handoff.not_used_inputs.length}</small>
      <small>上下文 {handoff.context_used.length}</small>
      <small>导出 {handoff.exported_outputs.filter((item) => item.version_id).length}</small>
      {handoff.semantic_gaps.map((item, index) => (
        <code key={`${item.code}-${index}`}>{reasonLabel(item.code)}</code>
      ))}
    </div>
  );
}

function TaskExecutionEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <section className="task-execution-panel empty">
      <header>
        <Database size={17} />
        <div>
          <strong>{title}</strong>
          <small>{detail}</small>
        </div>
      </header>
    </section>
  );
}

function TaskExecutionHeader({
  execution,
  canWrite,
  busy,
  onRetry
}: {
  execution: TaskExecutionDetails['task_execution'];
  canWrite: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <header className="task-execution-heading">
      <span className={`execution-dot ${execution.status}`} />
      <div>
        <strong>{displayStatus(execution.status)}</strong>
        <small>
          {executorLabel(execution.executor)} · 第 {execution.attempt} 次尝试 · {short(execution.id)}
        </small>
      </div>
      {execution.error_code && <code>{execution.error_code}</code>}
      {canWrite && execution.status === 'failed' && (
        <button className="button secondary" disabled={busy} onClick={onRetry}>
          <RotateCcw size={14} />
          重试
        </button>
      )}
    </header>
  );
}

function PullRequestCheckpoint({
  intent,
  busy,
  onApprove
}: {
  intent: PullRequestIntentRecord;
  busy: string;
  onApprove: (action: 'create_pr' | 'merge_pr') => Promise<void>;
}) {
  const create = intent.status === 'proposed',
    merge = ['draft_open', 'ready'].includes(intent.status);
  return (
    <div className="pull-request-checkpoint">
      <span>
        <GitPullRequest size={16} />
        <strong>
          {intent.pr_number ? `合并请求 #${intent.pr_number}` : `${intent.head_ref} -> ${intent.base_ref}`}
        </strong>
        <small>
          {pullRequestStatusLabel(intent.status)} · {checkStatusLabel(intent.checks_status)} · 已批准{' '}
          {intent.approvals.length}/2
        </small>
      </span>
      {intent.pr_url && (
        <a href={intent.pr_url} target="_blank" rel="noreferrer">
          打开合并请求
        </a>
      )}
      {create && (
        <button className="button primary" disabled={Boolean(busy)} onClick={() => void onApprove('create_pr')}>
          <GitPullRequest size={14} />
          批准创建
        </button>
      )}
      {merge && (
        <button className="button primary" disabled={Boolean(busy)} onClick={() => void onApprove('merge_pr')}>
          <GitCommitHorizontal size={14} />
          批准合并
        </button>
      )}
    </div>
  );
}
function SnapshotColumn({
  title,
  icon,
  empty,
  children
}: {
  title: string;
  icon: React.ReactNode;
  empty: string;
  children: React.ReactNode;
}) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <div>
      <h3>
        {icon}
        {title}
      </h3>
      {items.some(Boolean) ? children : <span>{empty}</span>}
    </div>
  );
}
function ExecutionOutput({ item }: { item: TaskExecutionDetails['outputs'][number] }) {
  const metadata = item.version?.manifest?.metadata || {},
    prUrl = text(metadata.pull_request_url),
    prNumber = text(metadata.pull_request_number),
    branch = text(metadata.branch);
  const hash = [item.version?.content_sha256, item.version?.repository_sha].filter(Boolean).join(' · ');
  return (
    <span className="task-execution-output">
      <strong>
        {item.asset?.title || item.key} · {displayStatus(item.asset?.status)}
      </strong>
      {item.asset?.summary && <small>{item.asset.summary}</small>}
      {branch && <small>{branch}</small>}
      {hash && <code aria-label={`内容标识 ${hash}`}>{hash}</code>}
      {prUrl && (
        <a href={prUrl} target="_blank" rel="noreferrer">
          合并请求{prNumber ? ` #${prNumber}` : ''}
          <ExternalLink size={11} />
        </a>
      )}
    </span>
  );
}

function ExecutionInput({ input }: { input: TaskExecutionInput }) {
  const versions = input.asset_versions || [],
    origin = input.resolved_from,
    originTitle = origin?.workstream_title || origin?.task_title,
    selectedByVersion = new Map((origin?.selected_outputs || []).map((item) => [item.version_id, item]));
  return (
    <span className="task-execution-input">
      <strong>
        {input.key} · {executionInputSource(input.source)}
      </strong>
      {originTitle && <small>{originTitle}</small>}
      {versions.length ? (
        versions.map((item) => {
          const selected = selectedByVersion.get(item.version_id);
          return (
            <code key={item.version_id}>
              {selected?.producer_task_title ? `${selected.producer_task_title} -> ` : ''}
              {item.output_key || assetTypeLabel(item.asset_type)} · {short(item.version_id)} ·{' '}
              {short(item.content_sha256)}
            </code>
          );
        })
      ) : (
        <code>{input.selector || input.ref_id || '当前版本'}</code>
      )}
    </span>
  );
}

function executionInputSource(source: string) {
  return (
    (
      {
        dependency: '前置任务交付',
        workstream_dependency: '前置成果交付',
        brief: '项目简报',
        decision: '项目决策',
        repository_workspace: '代码仓库快照',
        asset: '固定资产',
        asset_version: '固定资产版本',
        inline: '任务声明'
      } as Record<string, string>
    )[source] || source
  );
}
function terminal(value?: string) {
  return ['completed', 'failed', 'cancelled', 'superseded'].includes(value || '');
}
function reasonLabel(value: string) {
  return (
    (
      {
        manual_input_required: '等待人工输入',
        pull_request_create_approval_required: '等待批准创建合并请求',
        pull_request_merge_approval_required: '等待批准合并代码',
        task_dependency_waiting: '等待上游任务',
        required_input_missing: '必需输入缺失',
        workstream_dependency_waiting: '等待前置成果节点完成',
        workstream_input_missing: '前置成果版本尚未就绪'
      } as Record<string, string>
    )[value] || '等待执行条件'
  );
}
function short(value?: string | null) {
  return value ? value.slice(0, 12) : '待绑定';
}
function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
