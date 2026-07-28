import { ShieldCheck } from 'lucide-react';

export type EffectClaimReviewItem = {
  claimId: string;
  effectLabel: string;
  sourceLabel: string;
  statement: string;
  outputKeys: string[];
  criterionIds: string[];
  required: boolean;
};

export function EffectClaimReview({
  claims,
  acceptedClaimIds,
  onChange
}: {
  claims: EffectClaimReviewItem[];
  acceptedClaimIds: string[];
  onChange: (claimId: string, checked: boolean) => void;
}) {
  return (
    <div className="task-effect-review">
      <header>
        <ShieldCheck size={16} />
        <strong>作用声明验收</strong>
        <small>
          已选择 {claims.filter((item) => acceptedClaimIds.includes(item.claimId)).length}/{claims.length}
        </small>
      </header>
      <div>
        {claims.map((claim) => (
          <label key={claim.claimId}>
            <input
              type="checkbox"
              aria-label={`验收作用声明 ${claim.sourceLabel}`}
              checked={acceptedClaimIds.includes(claim.claimId)}
              onChange={(event) => onChange(claim.claimId, event.target.checked)}
            />
            <span>
              <strong>{claim.sourceLabel}</strong>
              <small>
                {claim.effectLabel} · {claim.outputKeys.join(' · ')} · {claim.criterionIds.length} 项标准 ·{' '}
                {claim.required ? '必须验收' : '按实际作用验收'}
              </small>
              <span>{claim.statement}</span>
              <code>{claim.claimId.slice(0, 12)}</code>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
