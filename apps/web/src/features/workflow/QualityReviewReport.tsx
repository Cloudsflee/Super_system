import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { QualityReviewReport, QualityReviewRun, QualityReviewSnapshot } from '../../api/execution-types';
import { formatQualityReviewTime } from './quality-review-ui';

export function QualityReviewReportView({
  report,
  run
}: {
  report: QualityReviewReport | null;
  run: QualityReviewRun | null;
}) {
  if (!report) return null;
  return (
    <div className="quality-review-report">
      <div className="quality-review-report-heading">
        <strong>自动检查与模型建议</strong>
        <small>
          {report.generated_at ? formatQualityReviewTime(report.generated_at) : ''} · 报告 hash{' '}
          {run?.report_sha256 ? `${run.report_sha256.slice(0, 12)}…` : '—'}
        </small>
      </div>
      <div className="quality-review-checks">
        {report.deterministic_checks.map((item) => (
          <DeterministicCheck key={item.id} item={item} />
        ))}
      </div>
      {report.advice.status !== 'completed' && (
        <p className="quality-review-notice">
          <strong>{report.advice.status === 'invalid' ? 'Advice invalid' : 'Advice unavailable'}</strong>
          {report.advice.limitations.length > 0 ? ` · ${report.advice.limitations.join('；')}` : ''}
        </p>
      )}
      <div className="quality-review-advice">
        {report.advice.dimensions.map((item) => (
          <AdviceDimension key={item.criterion_id} item={item} />
        ))}
      </div>
      {report.limitations.length > 0 && <Limitations items={report.limitations} />}
    </div>
  );
}

function DeterministicCheck({ item }: { item: QualityReviewReport['deterministic_checks'][number] }) {
  return (
    <div className={`quality-review-check ${item.status}`}>
      <span>{item.status === 'passed' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}</span>
      <span>
        <strong>{item.id}</strong>
        <small>{item.message}</small>
      </span>
    </div>
  );
}

function AdviceDimension({ item }: { item: QualityReviewReport['advice']['dimensions'][number] }) {
  return (
    <article>
      <header>
        <strong>{item.criterion_id}</strong>
        {item.recommendation == null ? <span>无建议</span> : <span>建议 {item.recommendation}/100</span>}
      </header>
      <p>{item.rationale}</p>
      {item.evidence_anchors.length > 0 && (
        <small className="quality-review-anchors">
          证据锚点：
          {item.evidence_anchors.map((anchor) => `${anchor.anchor_id} · ${anchor.path}:${anchor.locator}`).join('；')}
        </small>
      )}
      {(item.limitations || []).length > 0 && (
        <small className="quality-review-limitations">限制：{item.limitations?.join('；')}</small>
      )}
    </article>
  );
}

function Limitations({ items }: { items: string[] }) {
  return (
    <div className="quality-review-limitations-block">
      <strong>限制说明</strong>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
