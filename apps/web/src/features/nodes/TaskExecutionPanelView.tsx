import { Check, Database, ShieldCheck, X } from 'lucide-react';
import type { TaskExecutionDetails } from '../../api/types';
import { assetTypeLabel } from '../../components/common/display-labels';
import { EffectClaimReview, type EffectClaimReviewItem } from './TaskEffectClaimReview';
import {
  ExecutionInput,
  ExecutionOutput,
  HandoffSummary,
  PullRequestCheckpoint,
  SnapshotColumn,
  TaskExecutionHeader
} from './TaskExecutionDetailsView';
import type { ManualUsageOption } from './task-execution-manual-domain';
import { reasonLabel, short } from './task-execution-labels';

export type TaskExecutionPanelViewProps = {
  value: TaskExecutionDetails;
  canWrite: boolean;
  busy: string;
  candidates: TaskExecutionDetails['outputs'];
  claims: EffectClaimReviewItem[];
  acceptedClaimIds: string[];
  contributionReviewRequired: boolean;
  manualValues: Record<string, string>;
  manualUsage: Record<string, string[]>;
  manualReasons: Record<string, string>;
  usageOptions: ManualUsageOption[];
  onRetry: () => void;
  onValueChange: (key: string, content: string) => void;
  onUsageChange: (key: string, id: string, checked: boolean) => void;
  onReasonChange: (id: string, reason: string) => void;
  onManualSubmit: () => void;
  onClaimChange: (claimId: string, checked: boolean) => void;
  onDecision: (decision: 'approve' | 'reject') => void;
  onApprovePullRequest: (action: 'create_pr' | 'merge_pr') => Promise<void>;
};

export function TaskExecutionPanelView(props: TaskExecutionPanelViewProps) {
  const { value, canWrite, busy } = props,
    execution = value.task_execution,
    intent = value.pull_request_intent;
  return (
    <section className="task-execution-panel">
      <TaskExecutionHeader execution={execution} canWrite={canWrite} busy={Boolean(busy)} onRetry={props.onRetry} />
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
      <ManualCheckpoint {...props} />
      <CandidateCheckpoint {...props} />
      {canWrite && execution.executor === 'repository_integrate' && intent && (
        <PullRequestCheckpoint intent={intent} busy={busy} onApprove={props.onApprovePullRequest} />
      )}
      <WaitingReasons reasons={execution.readiness?.reasons || []} />
    </section>
  );
}

function ManualCheckpoint(props: TaskExecutionPanelViewProps) {
  const { value } = props,
    visible =
      props.canWrite &&
      value.task_execution.status === 'awaiting_human' &&
      value.task_execution.executor === 'manual' &&
      !value.outputs.length;
  if (!visible) return null;
  return (
    <ManualTaskCheckpoint
      contract={value.contract}
      manualValues={props.manualValues}
      manualUsage={props.manualUsage}
      manualReasons={props.manualReasons}
      usageOptions={props.usageOptions}
      busy={Boolean(props.busy)}
      onValueChange={props.onValueChange}
      onUsageChange={props.onUsageChange}
      onReasonChange={props.onReasonChange}
      onSubmit={props.onManualSubmit}
      submitLabel={props.contributionReviewRequired ? '提交候选输出' : '提交并验收'}
    />
  );
}

function CandidateCheckpoint(props: TaskExecutionPanelViewProps) {
  if (!props.canWrite || props.value.task_execution.status !== 'awaiting_human' || !props.candidates.length)
    return null;
  return (
    <HumanOutputCheckpoint
      candidates={props.candidates}
      claims={props.contributionReviewRequired ? props.claims : []}
      acceptedClaimIds={props.acceptedClaimIds}
      busy={Boolean(props.busy)}
      onClaimChange={props.onClaimChange}
      onDecision={props.onDecision}
    />
  );
}

function HumanOutputCheckpoint({
  candidates,
  claims,
  acceptedClaimIds,
  busy,
  onClaimChange,
  onDecision
}: {
  candidates: TaskExecutionDetails['outputs'];
  claims: EffectClaimReviewItem[];
  acceptedClaimIds: string[];
  busy: boolean;
  onClaimChange: (claimId: string, checked: boolean) => void;
  onDecision: (decision: 'approve' | 'reject') => void;
}) {
  const missingRequiredClaim = claims.some((item) => item.required && !acceptedClaimIds.includes(item.claimId));
  return (
    <>
      {claims.length > 0 && (
        <EffectClaimReview claims={claims} acceptedClaimIds={acceptedClaimIds} onChange={onClaimChange} />
      )}
      <div className="task-checkpoint-actions">
        <span>
          <ShieldCheck size={15} />
          <strong>{candidates.length} 项候选输出</strong>
          <small>{candidates.map((item) => `${item.key}@${short(item.version?.id)}`).join(' · ')}</small>
        </span>
        <button className="button secondary danger" disabled={busy} onClick={() => onDecision('reject')}>
          <X size={14} />
          退回
        </button>
        <button
          className="button primary"
          disabled={busy || missingRequiredClaim}
          onClick={() => onDecision('approve')}
        >
          <Check size={14} />
          验收
        </button>
      </div>
    </>
  );
}

type ManualCheckpointProps = {
  contract: TaskExecutionDetails['contract'];
  manualValues: Record<string, string>;
  manualUsage: Record<string, string[]>;
  manualReasons: Record<string, string>;
  usageOptions: ManualUsageOption[];
  busy: boolean;
  onValueChange: (key: string, content: string) => void;
  onUsageChange: (key: string, id: string, checked: boolean) => void;
  onReasonChange: (id: string, reason: string) => void;
  onSubmit: () => void;
  submitLabel: string;
};

function ManualTaskCheckpoint(props: ManualCheckpointProps) {
  const used = new Set(Object.values(props.manualUsage).flat()),
    effectAware = props.usageOptions.some((option) => option.effectAware),
    invalid = invalidManualCheckpoint(props, used, effectAware);
  return (
    <div className="task-manual-checkpoint">
      {props.contract.expected_outputs.map((slot) => (
        <ManualOutputEditor key={slot.key} slot={slot} props={props} />
      ))}
      <ManualReasonFields props={props} used={used} effectAware={effectAware} />
      <button className="button primary" disabled={props.busy || invalid} onClick={props.onSubmit}>
        <Check size={15} />
        {props.submitLabel}
      </button>
    </div>
  );
}

function ManualOutputEditor({
  slot,
  props
}: {
  slot: TaskExecutionDetails['contract']['expected_outputs'][number];
  props: ManualCheckpointProps;
}) {
  return (
    <div className="task-manual-output">
      <label htmlFor={`manual-output-${slot.key}`}>
        {slot.key}
        <small>{assetTypeLabel(slot.asset_type)}</small>
      </label>
      <textarea
        id={`manual-output-${slot.key}`}
        value={props.manualValues[slot.key] || ''}
        onChange={(event) => props.onValueChange(slot.key, event.target.value)}
      />
      {props.usageOptions.length > 0 && (
        <span className="task-manual-usage">
          <small>实际使用</small>
          {props.usageOptions.map((option) => (
            <label key={`${slot.key}-${option.id}`}>
              <input
                type="checkbox"
                checked={(props.manualUsage[slot.key] || []).includes(option.id)}
                onChange={(event) => props.onUsageChange(slot.key, option.id, event.target.checked)}
              />
              <span>{option.label}</span>
              {(option.applicationPolicy === 'required' || option.consumptionPolicy === 'must_use') && (
                <small>必须产生作用</small>
              )}
            </label>
          ))}
        </span>
      )}
    </div>
  );
}

function ManualReasonFields({
  props,
  used,
  effectAware
}: {
  props: ManualCheckpointProps;
  used: Set<string>;
  effectAware: boolean;
}) {
  return props.usageOptions
    .filter((option) => (effectAware ? used.has(option.id) : !used.has(option.id) && option.explicitPolicy))
    .map((option) => (
      <label className="task-manual-reason" key={`reason-${option.id}`}>
        <span>
          {option.label} · {effectAware ? '对输出产生的具体作用' : '未使用原因'}
        </span>
        <input
          type="text"
          value={props.manualReasons[option.id] || ''}
          onChange={(event) => props.onReasonChange(option.id, event.target.value)}
        />
      </label>
    ));
}

function invalidManualCheckpoint(props: ManualCheckpointProps, used: Set<string>, effectAware: boolean) {
  if (props.contract.expected_outputs.some((slot) => !(props.manualValues[slot.key] || '').trim())) return true;
  if (effectAware)
    return props.usageOptions.some(
      (option) =>
        (option.applicationPolicy === 'required' &&
          option.targetOutputKeys.some((key) => !(props.manualUsage[key] || []).includes(option.id))) ||
        (used.has(option.id) && (props.manualReasons[option.id] || '').trim().length < 12)
    );
  return props.usageOptions.some(
    (option) =>
      (option.consumptionPolicy === 'must_use' && !used.has(option.id)) ||
      (!used.has(option.id) && option.explicitPolicy && !(props.manualReasons[option.id] || '').trim())
  );
}

function WaitingReasons({ reasons }: { reasons: Array<{ code: string }> }) {
  if (!reasons.length) return null;
  return (
    <div className="task-waiting-reasons">
      {reasons.map((item, index) => (
        <span key={`${item.code}-${index}`}>{reasonLabel(item.code)}</span>
      ))}
    </div>
  );
}
