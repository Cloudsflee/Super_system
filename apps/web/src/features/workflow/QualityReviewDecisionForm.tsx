import { Check, Loader2 } from 'lucide-react';
import type { QualityReviewDimension, QualityReviewRubric } from '../../api/execution-types';
import type { QualityReviewScores } from './quality-review-view-model';

export function QualityReviewDecisionForm({
  rubric,
  scores,
  scoreTotal,
  threshold,
  decisionReason,
  canApprove,
  busy,
  canSubmit,
  onScore,
  onReason,
  onSubmit
}: {
  rubric: QualityReviewRubric | null;
  scores: QualityReviewScores;
  scoreTotal: number;
  threshold: number;
  decisionReason: string;
  canApprove: boolean;
  busy: boolean;
  canSubmit: boolean;
  onScore: (id: string, value: { score: string; reason: string }) => void;
  onReason: (value: string) => void;
  onSubmit: () => void;
}) {
  if (!rubric) return null;
  return (
    <div className="quality-review-decision">
      <div className="quality-review-decision-heading">
        <strong>人工最终评分</strong>
        <small>{canApprove ? '模型建议仅供参考，请独立逐维度评分。' : '当前账号无审批权限，只能查看报告。'}</small>
      </div>
      <div className="quality-review-score-list">
        {rubric.dimensions
          .filter((item) => item.enabled)
          .map((dimension) => (
            <ScoreRow
              key={dimension.id}
              dimension={dimension}
              value={scores[dimension.id]}
              canApprove={canApprove}
              onScore={onScore}
            />
          ))}
      </div>
      <div className="quality-review-score-total">
        <span>冻结权重计算总分</span>
        <strong>{scoreTotal.toFixed(2)}</strong>
        <em>{scoreTotal >= threshold ? `达到阈值 ${threshold} · 预计通过` : `低于阈值 ${threshold} · 预计需要修改`}</em>
      </div>
      <label className="quality-review-decision-reason">
        <span>最终裁决理由</span>
        <textarea
          value={decisionReason}
          disabled={!canApprove}
          rows={2}
          placeholder="说明最终裁决（至少 3 个字符）"
          onChange={(event) => onReason(event.target.value)}
        />
      </label>
      {canApprove && (
        <button className="button primary" disabled={!canSubmit || busy} onClick={onSubmit}>
          {busy ? <Loader2 size={14} className="quality-review-spin" /> : <Check size={14} />}
          {busy ? '提交中…' : '提交人工裁决'}
        </button>
      )}
    </div>
  );
}

function ScoreRow({
  dimension,
  value,
  canApprove,
  onScore
}: {
  dimension: QualityReviewDimension;
  value: { score: string; reason: string } | undefined;
  canApprove: boolean;
  onScore: (id: string, value: { score: string; reason: string }) => void;
}) {
  const current = value || { score: '', reason: '' };
  return (
    <div className="quality-review-score-row">
      <div>
        <strong>{dimension.title}</strong>
        <small>权重 {dimension.weight}</small>
      </div>
      <input
        type="number"
        min={0}
        max={100}
        value={current.score}
        disabled={!canApprove}
        placeholder="0-100"
        aria-label={`${dimension.title} 分数`}
        onChange={(event) => onScore(dimension.id, { ...current, score: event.target.value })}
      />
      <textarea
        value={current.reason}
        disabled={!canApprove}
        rows={2}
        placeholder="填写该维度评分理由"
        aria-label={`${dimension.title} 评分理由`}
        onChange={(event) => onScore(dimension.id, { ...current, reason: event.target.value })}
      />
    </div>
  );
}
