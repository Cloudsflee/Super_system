import { AlertTriangle, CheckCircle2, CircleDashed, FileCheck2, History, Loader2, Play, X } from 'lucide-react';
import type {
  QualityReviewHistory,
  QualityReviewPrepare,
  QualityReviewRubric,
  QualityReviewSnapshot,
  QualityReviewRun
} from '../../api/execution-types';
import { QualityReviewDecisionForm } from './QualityReviewDecisionForm';
import { QualityReviewDrawer } from './QualityReviewDrawer';
import { QualityReviewReportView } from './QualityReviewReport';
import { buildQualityReviewModel, type QualityReviewScores } from './quality-review-view-model';
import { qualityStatusLabel, qualityStatusTone, qualityStepTone } from './quality-review-ui';

type SectionProps = {
  preparation?: QualityReviewPrepare;
  snapshot?: QualityReviewSnapshot;
  history?: QualityReviewHistory;
  selectedRunId: string | null;
  canRun: boolean;
  canApprove: boolean;
  busy: string;
  drawerOpen: boolean;
  rubric: QualityReviewRubric | null;
  included: string[];
  exclusions: Record<string, string>;
  scores: QualityReviewScores;
  decisionReason: string;
  onOpen: () => void;
  onSelectRun: (value: string | null) => void;
  onClose: () => void;
  onStart: () => void;
  onCancel: () => void;
  onIncluded: (value: string[]) => void;
  onExclusion: (id: string, reason: string) => void;
  onRubric: (value: QualityReviewRubric) => void;
  onScore: (id: string, value: { score: string; reason: string }) => void;
  onDecisionReason: (value: string) => void;
  onDecision: () => void;
};

export function QualityReviewSection(props: SectionProps) {
  const model = buildQualityReviewModel({
    preparation: props.preparation,
    snapshot: props.snapshot,
    rubric: props.rubric,
    scores: props.scores,
    canApprove: props.canApprove
  });
  return (
    <section className="quality-review-section" aria-label="Quality Review 内容质量评审">
      <QualityReviewHeader
        preparation={props.preparation}
        model={model}
        historyCount={props.history?.items.length || 0}
      />
      <QualityReviewHistorySelect
        history={props.history}
        selectedRunId={props.selectedRunId}
        onSelect={props.onSelectRun}
      />
      <QualityReviewNotices preparation={props.preparation} model={model} />
      <QualityReviewProgress model={model} canRun={props.canRun} busy={props.busy} onCancel={props.onCancel} />
      <QualityReviewReportView report={model.report} run={model.run} />
      {model.awaitingHuman && (
        <QualityReviewDecisionForm
          rubric={model.scoringRubric}
          scores={props.scores}
          scoreTotal={model.scoreTotal}
          threshold={model.threshold}
          decisionReason={props.decisionReason}
          canApprove={props.canApprove}
          busy={props.busy === 'quality-decision'}
          canSubmit={model.canSubmitDecision && props.decisionReason.trim().length >= 3}
          onScore={props.onScore}
          onReason={props.onDecisionReason}
          onSubmit={props.onDecision}
        />
      )}
      <QualityReviewDecisionSummary decision={model.run?.decision} score={model.run?.score} />
      <QualityReviewActions
        model={model}
        preparation={props.preparation}
        canRun={props.canRun}
        busy={props.busy}
        hasActive={Boolean(props.history?.active)}
        onOpen={props.onOpen}
      />
      <QualityReviewDrawer
        open={props.drawerOpen}
        preparation={props.preparation}
        rubric={model.selectedRubric}
        included={props.included}
        exclusions={props.exclusions}
        weightTotal={model.weightTotal}
        busy={props.busy === 'quality-start'}
        onClose={props.onClose}
        onStart={props.onStart}
        onIncluded={props.onIncluded}
        onExclusion={props.onExclusion}
        onRubric={props.onRubric}
      />
    </section>
  );
}

function QualityReviewHeader({
  preparation,
  model,
  historyCount
}: {
  preparation?: QualityReviewPrepare;
  model: ReturnType<typeof buildQualityReviewModel>;
  historyCount: number;
}) {
  return (
    <header className="quality-review-header">
      <QualityReviewTitle preparation={preparation} />
      <QualityReviewStatus status={model.status} stale={model.run?.stale} />
      <QualityReviewMeta preparation={preparation} ready={model.ready} historyCount={historyCount} />
    </header>
  );
}

function QualityReviewTitle({ preparation }: { preparation?: QualityReviewPrepare }) {
  return (
    <span className="quality-review-title">
      <FileCheck2 size={15} />
      <strong>Quality Review</strong>
      <small>
        {preparation?.mandatory ? 'Mandatory · 阈值 ' : '可选 · 阈值 '}
        {preparation?.threshold ?? '—'}
      </small>
    </span>
  );
}

function QualityReviewStatus({ status, stale }: { status: string; stale?: boolean }) {
  return (
    <span className={`quality-review-status ${qualityStatusTone(status, stale)}`}>
      <QualityReviewStatusIcon status={status} stale={stale} />
      {stale ? '已过期' : qualityStatusLabel(status)}
    </span>
  );
}

function QualityReviewMeta({
  preparation,
  ready,
  historyCount
}: {
  preparation?: QualityReviewPrepare;
  ready: boolean;
  historyCount: number;
}) {
  const profile = preparation?.reviewer_readiness.profile;
  return (
    <div className="quality-review-meta">
      <span>历史评审 {historyCount}</span>
      <span className={ready ? 'ready' : 'not-ready'}>
        {ready ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}Reviewer{' '}
        {preparation?.reviewer_readiness.status || 'checking'}
      </span>
      {profile && (
        <span>
          {String(profile.provider || 'provider')} / {String(profile.model || 'default')}
        </span>
      )}
    </div>
  );
}

function QualityReviewNotices({
  preparation,
  model
}: {
  preparation?: QualityReviewPrepare;
  model: ReturnType<typeof buildQualityReviewModel>;
}) {
  return (
    <>
      {!model.ready && <ReviewerUnavailable preparation={preparation} />}
      {model.run?.stale && (
        <p className="quality-review-notice stale">
          资产版本或 Rubric 已变化。该报告不能产生当前 Outcome，需重新启动评审。
        </p>
      )}
      {model.run?.error_code && (
        <p className="quality-review-notice error">
          运行失败：{model.run.error_code}
          {model.run.retryable ? '（可重新启动）' : ''}
        </p>
      )}
      {!preparation && <p className="quality-review-notice">正在准备 Quality Review...</p>}
    </>
  );
}

function ReviewerUnavailable({ preparation }: { preparation?: QualityReviewPrepare }) {
  const failures = Object.entries(preparation?.reviewer_readiness.checks || {}).filter(
    ([, item]) => item.ready !== true
  );
  return (
    <div className="quality-review-notice error" role="status">
      <strong>Advice unavailable</strong>
      {failures.length > 0 && (
        <span className="quality-review-readiness-checks">
          {failures.map(([name, item]) => (
            <small key={name}>
              {name}: {item.code || item.status}
            </small>
          ))}
        </span>
      )}
    </div>
  );
}

function QualityReviewProgress({
  model,
  canRun,
  busy,
  onCancel
}: {
  model: ReturnType<typeof buildQualityReviewModel>;
  canRun: boolean;
  busy: string;
  onCancel: () => void;
}) {
  if (!model.active) return null;
  return (
    <div className="quality-review-progress">
      <div className="quality-review-progress-line">
        <Loader2 size={14} className="quality-review-spin" />
        <strong>{qualityStatusLabel(model.status)}</strong>
        <span>{model.run?.phase || model.status}</span>
        {canRun && (
          <button className="button danger compact" disabled={busy === 'quality-cancel'} onClick={onCancel}>
            取消
          </button>
        )}
      </div>
      <div className="quality-review-steps">
        {['queued', 'preparing', 'checking', 'reviewing', 'awaiting_human'].map((phase) => (
          <span key={phase} className={qualityStepTone(model.status, phase)}>
            {qualityStatusLabel(phase)}
          </span>
        ))}
      </div>
    </div>
  );
}

function QualityReviewDecisionSummary({ decision, score }: { decision?: string | null; score?: number | null }) {
  if (!decision) return null;
  const passed = decision === 'pass';
  return (
    <div className={`quality-review-decision-summary ${passed ? 'pass' : 'changes'}`}>
      {passed ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
      <span>
        人工裁决：<strong>{passed ? '通过' : '需要修改'}</strong> · 总分 {score ?? '—'}
      </span>
    </div>
  );
}

function QualityReviewActions({
  model,
  preparation,
  canRun,
  busy,
  hasActive,
  onOpen
}: {
  model: ReturnType<typeof buildQualityReviewModel>;
  preparation?: QualityReviewPrepare;
  canRun: boolean;
  busy: string;
  hasActive: boolean;
  onOpen: () => void;
}) {
  if (!canRun || hasActive || model.active || model.awaitingHuman) return null;
  return (
    <div className="quality-review-actions">
      <button className="button secondary" onClick={onOpen} disabled={!preparation || busy === 'quality-start'}>
        <Play size={14} />
        {model.run?.status === 'failed' || model.run?.status === 'cancelled' || model.run?.stale
          ? '重新评审'
          : '启动 Quality Review'}
      </button>
      {preparation && <small>启动后 Rubric、资产范围和 Outcome 阈值会冻结。</small>}
    </div>
  );
}

function QualityReviewHistorySelect({
  history,
  selectedRunId,
  onSelect
}: {
  history?: QualityReviewHistory;
  selectedRunId: string | null;
  onSelect: (value: string | null) => void;
}) {
  if (!history?.items.length) return null;
  return (
    <label className="quality-review-history-select">
      <History size={13} />
      <span>评审记录</span>
      <select
        aria-label="选择 Quality Review 历史记录"
        value={selectedRunId || history.active?.id || history.current?.id || history.latest?.id || ''}
        onChange={(event) => onSelect(event.target.value || null)}
      >
        {history.items.map((item) => (
          <option key={item.id} value={item.id}>
            {historyLabel(item)}
          </option>
        ))}
      </select>
    </label>
  );
}

function historyLabel(run: QualityReviewRun) {
  const advice = run.report?.advice.status || 'none',
    score = run.score == null ? '—' : String(run.score),
    stale = run.stale ? ' · stale' : '';
  return `${formatHistoryTime(run.updated_at)} · ${qualityStatusLabel(run.status)} · ${score} · ${advice}${stale}`;
}

function formatHistoryTime(value: string) {
  return new Date(value).toLocaleString();
}

function QualityReviewStatusIcon({ status, stale }: { status: string; stale?: boolean }) {
  if (stale) return <AlertTriangle size={12} />;
  if (status === 'completed') return <CheckCircle2 size={12} />;
  if (status === 'failed' || status === 'cancelled') return <X size={12} />;
  if (status === 'not_started') return <CircleDashed size={12} />;
  return <Loader2 size={12} className="quality-review-spin" />;
}
