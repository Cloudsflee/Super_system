import { Database, ExternalLink, GitCommitHorizontal, GitPullRequest, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';

import type { PullRequestIntentRecord, TaskExecutionDetails, TaskExecutionInput } from '../../api/types';
import {
  assetTypeLabel,
  checkStatusLabel,
  displayStatus,
  executorLabel,
  pullRequestStatusLabel
} from '../../components/common/display-labels';
import { effectLabel, executionInputSource, reasonLabel, short } from './task-execution-labels';

type Handoff = NonNullable<TaskExecutionDetails['handoff']>;

export function HandoffSummary({ value }: { value: TaskExecutionDetails }) {
  const handoff = value.handoff;
  if (!handoff) return null;
  return (
    <div className={`task-handoff-summary ${handoff.handoff_status}`}>
      <span>
        <GitCommitHorizontal size={15} />
        <strong>{handoffStatusLabel(handoff.handoff_status)}</strong>
      </span>
      <HandoffCounters handoff={handoff} />
      {handoff.semantic_gaps.map((item, index) => (
        <code key={`${item.code}-${index}`}>{reasonLabel(item.code)}</code>
      ))}
      <HandoffInputEffects handoff={handoff} />
      <HandoffContextEffects handoff={handoff} />
      <HandoffRoutes handoff={handoff} />
    </div>
  );
}

function HandoffCounters({ handoff }: { handoff: Handoff }) {
  const diagnostic = [
      'aiws.task_handoff_diagnostics.v2',
      'aiws.task_handoff_diagnostics.v3',
      'aiws.task_handoff_diagnostics.v4'
    ].includes(handoff.schema_version),
    contributionDiagnostics = ['aiws.task_handoff_diagnostics.v3', 'aiws.task_handoff_diagnostics.v4'].includes(
      handoff.schema_version
    );
  return (
    <>
      <small>使用资产 {handoff.used_inputs.length}</small>
      <small>未使用资产 {handoff.not_used_inputs.length}</small>
      <small>上下文 {handoff.context_used.length}</small>
      <small>导出 {handoff.exported_outputs.filter((item) => item.version_id).length}</small>
      {diagnostic && contributionDiagnostics && (
        <>
          <small>
            已验收贡献 {handoff.contribution_statuses?.filter((item) => item.status === 'accepted').length || 0}
          </small>
          <small>
            结构已核验{' '}
            {handoff.contribution_statuses?.filter((item) => item.status === 'structurally_verified').length || 0}
          </small>
        </>
      )}
      {diagnostic && !contributionDiagnostics && (
        <small>有效作用 {(handoff.input_effects?.length || 0) + (handoff.context_effects?.length || 0)}</small>
      )}
      {diagnostic && (
        <small>交付路由 {handoff.exported_outputs.reduce((total, item) => total + (item.route_count || 0), 0)}</small>
      )}
    </>
  );
}

function HandoffInputEffects({ handoff }: { handoff: Handoff }) {
  return handoff.input_effects?.map((effect, index) => (
    <span className="task-effect-line" key={`${effect.input_key}-${effect.effect}-${index}`}>
      <strong>{effect.input_key}</strong>
      <small>
        {effect.output_keys.join(' · ')}
        {effect.criterion_ids?.length ? ` · ${effect.criterion_ids.length} 项标准` : ''}
        {effect.contribution_id ? ` · ${contributionStatus(handoff, effect.contribution_id)}` : ''}
      </small>
      <span>{effect.statement}</span>
    </span>
  ));
}

function HandoffContextEffects({ handoff }: { handoff: Handoff }) {
  return handoff.context_effects?.map((effect, index) => (
    <span className="task-effect-line" key={`${effect.document_version_id}-${effect.effect}-${index}`}>
      <strong>上下文 {short(effect.document_version_id)}</strong>
      <small>{effect.output_keys.join(' · ')}</small>
      <span>{effect.statement}</span>
    </span>
  ));
}

function HandoffRoutes({ handoff }: { handoff: Handoff }) {
  return handoff.exported_outputs.flatMap((output) =>
    (output.routes || []).map((route, index) => (
      <span className="task-route-line" key={`${output.output_key}-${route.route_type}-${index}`}>
        <strong>{output.output_key}</strong>
        <small>
          {route.route_type === 'workstream_boundary'
            ? '成果节点边界'
            : `${route.consumer_task_title || route.consumer_task_id} · ${route.input_key}`}
        </small>
        {(route.expected_effect || route.purpose) && <span>{route.expected_effect || route.purpose}</span>}
        {route.route_id && <code>{short(route.route_id)}</code>}
      </span>
    ))
  );
}

export function TaskExecutionEmpty({ title, detail }: { title: string; detail: string }) {
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

export function TaskExecutionHeader({
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

export function PullRequestCheckpoint({
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

export function SnapshotColumn({
  title,
  icon,
  empty,
  children
}: {
  title: string;
  icon: ReactNode;
  empty: string;
  children: ReactNode;
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

export function ExecutionOutput({ item }: { item: TaskExecutionDetails['outputs'][number] }) {
  const metadata = item.version?.manifest?.metadata || {},
    prUrl = text(metadata.pull_request_url),
    prNumber = text(metadata.pull_request_number),
    branch = text(metadata.branch),
    hash = [item.version?.content_sha256, item.version?.repository_sha].filter(Boolean).join(' · ');
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

export function ExecutionInput({ input }: { input: TaskExecutionInput }) {
  const origin = input.resolved_from,
    originTitle = origin?.workstream_title || origin?.task_title;
  return (
    <span className="task-execution-input">
      <strong>
        {input.key} · {executionInputSource(input.source)}
      </strong>
      {originTitle && <small>{originTitle}</small>}
      {input.purpose && <small>{input.purpose}</small>}
      {input.contribution && (
        <small>
          {effectLabel(input.contribution.effect)} · {input.contribution.target_criterion_ids.length} 项验收标准 ·{' '}
          {short(input.contribution.id)}
        </small>
      )}
      {input.target_output_keys?.length ? (
        <small>
          {input.application_policy === 'required' ? '必须产生作用' : '按需采用'} ·{' '}
          {input.target_output_keys.join(' · ')}
        </small>
      ) : null}
      <InputVersions input={input} />
    </span>
  );
}

function InputVersions({ input }: { input: TaskExecutionInput }) {
  const versions = input.asset_versions || [],
    selectedByVersion = new Map((input.resolved_from?.selected_outputs || []).map((item) => [item.version_id, item]));
  if (!versions.length) return <code>{input.selector || input.ref_id || '当前版本'}</code>;
  return versions.map((item) => {
    const selected = selectedByVersion.get(item.version_id);
    return (
      <code key={item.version_id}>
        {selected?.producer_task_title ? `${selected.producer_task_title} -> ` : ''}
        {item.output_key || assetTypeLabel(item.asset_type)} · {short(item.version_id)} · {short(item.content_sha256)}
      </code>
    );
  });
}

function contributionStatus(handoff: Handoff, contributionId: string) {
  return handoff.contribution_statuses?.find((item) => item.contribution_id === contributionId)?.status === 'accepted'
    ? '已验收'
    : '结构已核验';
}

function handoffStatusLabel(status: string) {
  return status === 'ready' ? '交付就绪' : status === 'incomplete' ? '交付有缺口' : '等待交付';
}

function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
