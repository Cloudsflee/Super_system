import { Ban, Check, CircleDashed, Clock3, RotateCcw, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, json } from '../../api/client';
import type { OutcomeEvaluation, OutcomeRequirement, OutcomeWaiver, WorkflowOutcomeSnapshot } from '../../api/types';
import { useUi } from '../../state/ui';

export function WorkflowOutcomePanel({
  executionId,
  value,
  loading,
  error,
  canApprove,
  onRefresh
}: {
  executionId: string;
  value?: WorkflowOutcomeSnapshot;
  loading: boolean;
  error?: Error | null;
  canApprove: boolean;
  onRefresh: () => Promise<unknown>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [busy, setBusy] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const toast = useUi((state) => state.toast);
  const evaluations = useMemo(
    () => new Map((value?.evaluations || []).map((item) => [item.requirement_id, item])),
    [value?.evaluations]
  );
  const selectable = (value?.requirements || []).filter((requirement) => {
    const status = evaluations.get(requirement.id)?.status;
    return requirement.waivable && !['satisfied', 'waived'].includes(status || 'pending');
  });

  async function grantWaiver() {
    setBusy('grant');
    try {
      await api(
        `/workflow-executions/${executionId}/outcome-waivers`,
        json(
          'POST',
          {
            requirement_ids: selected,
            reason: reason.trim(),
            evidence_refs: splitEvidence(evidence),
            expires_at: new Date(expiresAt).toISOString()
          },
          '创建 Outcome waiver'
        )
      );
      setSelected([]);
      setReason('');
      setEvidence('');
      await onRefresh();
      toast('Outcome waiver 已创建');
    } catch (requestError) {
      toast((requestError as Error).message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function revokeWaiver(waiver: OutcomeWaiver) {
    setBusy(waiver.id);
    try {
      await api(
        `/workflow-executions/${executionId}/outcome-waivers/${waiver.id}/revoke`,
        json('POST', { reason: revokeReason.trim(), evidence_refs: [] }, '撤销 Outcome waiver')
      );
      setRevoking(null);
      setRevokeReason('');
      await onRefresh();
      toast('Outcome waiver 已撤销');
    } catch (requestError) {
      toast((requestError as Error).message, 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="workflow-outcome-panel" aria-label="Outcome 验收结果">
      {loading && <p className="workflow-outcome-empty">正在评估 Outcome...</p>}
      {error && <p className="workflow-outcome-empty error">{error.message}</p>}
      {value && (
        <>
          <div className="workflow-outcome-summary">
            <OutcomeMetric label="满足" value={value.workflow_execution.outcome_summary?.satisfied || 0} tone="ok" />
            <OutcomeMetric label="缺口" value={value.workflow_execution.outcome_summary?.unsatisfied || 0} tone="gap" />
            <OutcomeMetric label="豁免" value={value.workflow_execution.outcome_summary?.waived || 0} tone="waived" />
            <OutcomeMetric
              label="Mandatory gap"
              value={value.workflow_execution.outcome_summary?.mandatory_gaps || 0}
              tone="gap"
            />
          </div>
          <div className="workflow-outcome-requirements">
            {value.requirements.map((requirement) => (
              <RequirementRow
                key={requirement.id}
                requirement={requirement}
                evaluation={evaluations.get(requirement.id)}
                selectable={canApprove && selectable.some((item) => item.id === requirement.id)}
                checked={selected.includes(requirement.id)}
                onCheck={(checked) =>
                  setSelected((current) =>
                    checked ? [...new Set([...current, requirement.id])] : current.filter((id) => id !== requirement.id)
                  )
                }
              />
            ))}
          </div>
          {canApprove && selectable.length > 0 && (
            <WaiverForm
              selectedCount={selected.length}
              reason={reason}
              evidence={evidence}
              expiresAt={expiresAt}
              busy={busy === 'grant'}
              onReasonChange={setReason}
              onEvidenceChange={setEvidence}
              onExpiryChange={setExpiresAt}
              onSubmit={() => void grantWaiver()}
            />
          )}
          {(value.waivers || []).length > 0 && (
            <WaiverHistory
              waivers={value.waivers}
              canApprove={canApprove}
              revoking={revoking}
              revokeReason={revokeReason}
              busy={busy}
              onStartRevoke={setRevoking}
              onReasonChange={setRevokeReason}
              onRevoke={(waiver) => void revokeWaiver(waiver)}
              onCancel={() => setRevoking(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

function WaiverForm({
  selectedCount,
  reason,
  evidence,
  expiresAt,
  busy,
  onReasonChange,
  onEvidenceChange,
  onExpiryChange,
  onSubmit
}: {
  selectedCount: number;
  reason: string;
  evidence: string;
  expiresAt: string;
  busy: boolean;
  onReasonChange: (value: string) => void;
  onEvidenceChange: (value: string) => void;
  onExpiryChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const disabled = busy || selectedCount === 0 || reason.trim().length < 10 || splitEvidence(evidence).length === 0;
  return (
    <div className="workflow-waiver-form">
      <label>
        <span>Waiver 理由</span>
        <textarea value={reason} onChange={(event) => onReasonChange(event.target.value)} rows={2} />
      </label>
      <label>
        <span>证据引用</span>
        <input value={evidence} onChange={(event) => onEvidenceChange(event.target.value)} placeholder="receipt:..." />
      </label>
      <label>
        <span>到期时间</span>
        <input
          type="datetime-local"
          value={expiresAt}
          max={maximumExpiry()}
          onChange={(event) => onExpiryChange(event.target.value)}
        />
      </label>
      <button className="button secondary" disabled={disabled} onClick={onSubmit}>
        <ShieldAlert size={14} />
        创建 waiver
      </button>
    </div>
  );
}

function WaiverHistory({
  waivers,
  canApprove,
  revoking,
  revokeReason,
  busy,
  onStartRevoke,
  onReasonChange,
  onRevoke,
  onCancel
}: {
  waivers: OutcomeWaiver[];
  canApprove: boolean;
  revoking: string | null;
  revokeReason: string;
  busy: string;
  onStartRevoke: (id: string) => void;
  onReasonChange: (value: string) => void;
  onRevoke: (waiver: OutcomeWaiver) => void;
  onCancel: () => void;
}) {
  return (
    <div className="workflow-waiver-history">
      <header>
        <Clock3 size={13} />
        <strong>Waiver 记录</strong>
      </header>
      {waivers.map((waiver) => (
        <div key={waiver.id} className={waiver.active ? 'active' : 'inactive'}>
          <span>
            <strong>{waiver.reason}</strong>
            <small>
              {waiver.active ? '有效' : waiver.revoked ? '已撤销' : '已过期'} · {formatTime(waiver.expires_at)}
            </small>
          </span>
          {canApprove && waiver.active && revoking !== waiver.id && (
            <button className="icon-button" aria-label="撤销 waiver" onClick={() => onStartRevoke(waiver.id)}>
              <Ban size={14} />
            </button>
          )}
          {revoking === waiver.id && (
            <span className="workflow-waiver-revoke">
              <input
                aria-label="撤销理由"
                value={revokeReason}
                onChange={(event) => onReasonChange(event.target.value)}
              />
              <button
                className="icon-button"
                aria-label="确认撤销 waiver"
                disabled={busy === waiver.id || revokeReason.trim().length < 3}
                onClick={() => onRevoke(waiver)}
              >
                <RotateCcw size={14} />
              </button>
              <button className="icon-button" aria-label="取消撤销" onClick={onCancel}>
                <X size={14} />
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function OutcomeMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className={tone}>
      <strong>{value}</strong>
      <small>{label}</small>
    </span>
  );
}

function RequirementRow({
  requirement,
  evaluation,
  selectable,
  checked,
  onCheck
}: {
  requirement: OutcomeRequirement;
  evaluation?: OutcomeEvaluation;
  selectable: boolean;
  checked: boolean;
  onCheck: (value: boolean) => void;
}) {
  const status = evaluation?.status || 'pending';
  const Icon =
    status === 'satisfied' ? Check : status === 'waived' ? ShieldCheck : status === 'pending' ? CircleDashed : X;
  return (
    <label className={`workflow-outcome-requirement ${status}`}>
      {selectable ? (
        <input type="checkbox" checked={checked} onChange={(event) => onCheck(event.target.checked)} />
      ) : (
        <Icon size={14} />
      )}
      <span>
        <strong>{requirement.title}</strong>
        <small>
          {requirement.mandatory ? 'Mandatory' : 'Optional'} · {requirement.evaluator} ·{' '}
          {evaluation?.reason_code || 'pending'}
        </small>
      </span>
      <em>{outcomeStatusLabel(status)}</em>
    </label>
  );
}

function outcomeStatusLabel(value: string) {
  return (
    (
      {
        pending: '待评估',
        satisfied: '满足',
        unsatisfied: '未满足',
        waived: '已豁免',
        error: '评估错误'
      } as Record<string, string>
    )[value] || value
  );
}

function splitEvidence(value: string) {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function defaultExpiry() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

function maximumExpiry() {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

function formatTime(value: string) {
  return new Date(value).toLocaleString();
}
