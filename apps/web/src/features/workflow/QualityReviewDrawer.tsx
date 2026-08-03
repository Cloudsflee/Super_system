import { FileText, Loader2, Play, Sparkles, X } from 'lucide-react';
import type {
  QualityReviewAsset,
  QualityReviewDimension,
  QualityReviewPrepare,
  QualityReviewRubric
} from '../../api/execution-types';
import { formatBytes } from './quality-review-ui';

export function QualityReviewDrawer({
  open,
  preparation,
  rubric,
  included,
  exclusions,
  weightTotal,
  busy,
  onClose,
  onStart,
  onIncluded,
  onExclusion,
  onRubric
}: {
  open: boolean;
  preparation?: QualityReviewPrepare;
  rubric: QualityReviewRubric | null;
  included: string[];
  exclusions: Record<string, string>;
  weightTotal: number;
  busy: boolean;
  onClose: () => void;
  onStart: () => void;
  onIncluded: (value: string[]) => void;
  onExclusion: (id: string, reason: string) => void;
  onRubric: (value: QualityReviewRubric) => void;
}) {
  if (!open || !preparation || !rubric) return null;
  const invalidExclusions = preparation.assets.filter(
    (asset) => !included.includes(asset.asset_version_id) && !exclusions[asset.asset_version_id]?.trim()
  );
  const requiredExcluded = preparation.assets.some(
    (asset) => asset.required && !included.includes(asset.asset_version_id)
  );
  const valid = weightTotal === 100 && invalidExclusions.length === 0 && !requiredExcluded && included.length > 0;
  return (
    <div className="quality-review-drawer" role="dialog" aria-label="启动 Quality Review">
      <DrawerHeader onClose={onClose} />
      <div className="quality-review-drawer-body">
        <AssetSelection
          preparation={preparation}
          included={included}
          exclusions={exclusions}
          onIncluded={onIncluded}
          onExclusion={onExclusion}
        />
        <RubricEditor rubric={rubric} weightTotal={weightTotal} onRubric={onRubric} />
      </div>
      <DrawerFooter
        valid={valid}
        weightTotal={weightTotal}
        requiredExcluded={requiredExcluded}
        invalidExclusions={invalidExclusions.length > 0}
        busy={busy}
        onClose={onClose}
        onStart={onStart}
      />
    </div>
  );
}

function DrawerHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="quality-review-drawer-header">
      <div>
        <strong>启动评审</strong>
        <small>选择当前有效资产并冻结 Rubric</small>
      </div>
      <button className="icon-button" aria-label="关闭启动评审" onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  );
}

function AssetSelection({
  preparation,
  included,
  exclusions,
  onIncluded,
  onExclusion
}: {
  preparation: QualityReviewPrepare;
  included: string[];
  exclusions: Record<string, string>;
  onIncluded: (value: string[]) => void;
  onExclusion: (id: string, reason: string) => void;
}) {
  return (
    <div className="quality-review-drawer-section">
      <h4>
        <FileText size={13} />
        纳入评审的资产
      </h4>
      <p className="quality-review-help">必需输出不能排除；范围外资产仅记录为限制说明，不会计入质量评分。</p>
      <div className="quality-review-assets">
        {preparation.assets.map((asset) => (
          <AssetRow
            key={asset.asset_version_id}
            asset={asset}
            included={included.includes(asset.asset_version_id)}
            exclusion={exclusions[asset.asset_version_id] || ''}
            onIncluded={onIncluded}
            selected={included}
            onExclusion={onExclusion}
          />
        ))}
        {preparation.out_of_scope_assets.map((asset) => (
          <OutOfScopeAsset key={asset.asset_version_id} asset={asset} />
        ))}
        {!preparation.assets.length && !preparation.out_of_scope_assets.length && (
          <p className="quality-review-help">没有可评审资产。</p>
        )}
      </div>
    </div>
  );
}

function AssetRow({
  asset,
  included,
  selected,
  exclusion,
  onIncluded,
  onExclusion
}: {
  asset: QualityReviewAsset;
  included: boolean;
  selected: string[];
  exclusion: string;
  onIncluded: (value: string[]) => void;
  onExclusion: (id: string, reason: string) => void;
}) {
  const nextSelection = (checked: boolean) =>
    onIncluded(
      checked
        ? [...new Set([...selected, asset.asset_version_id])]
        : selected.filter((id) => id !== asset.asset_version_id)
    );
  return (
    <div className={`quality-review-asset ${included ? 'included' : 'excluded'}`}>
      <label>
        <input
          type="checkbox"
          checked={included}
          disabled={asset.required}
          onChange={(event) => nextSelection(event.target.checked)}
        />
        <span>
          <strong>{asset.title}</strong>
          <small>
            {asset.output_key || asset.asset_type || 'asset'} · {formatBytes(asset.size_bytes)} ·{' '}
            {asset.required ? '必需' : '可选'}
          </small>
        </span>
      </label>
      {!included && (
        <input
          className="quality-review-exclusion"
          value={exclusion}
          placeholder="填写排除理由（必填）"
          onChange={(event) => onExclusion(asset.asset_version_id, event.target.value)}
        />
      )}
    </div>
  );
}

function OutOfScopeAsset({ asset }: { asset: QualityReviewAsset }) {
  return (
    <div className="quality-review-asset out-of-scope">
      <span className="quality-review-asset-marker">范围外</span>
      <span>
        <strong>{asset.title}</strong>
        <small>
          {asset.asset_type || asset.media_type || 'unknown'} · {formatBytes(asset.size_bytes)}
        </small>
      </span>
    </div>
  );
}

export function RubricEditor({
  rubric,
  weightTotal,
  onRubric,
  readOnly = false
}: {
  rubric: QualityReviewRubric;
  weightTotal: number;
  onRubric: (value: QualityReviewRubric) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="quality-review-drawer-section">
      <div className="quality-review-rubric-heading">
        <h4>
          <Sparkles size={13} />
          Rubric 编辑器
        </h4>
        <span className={weightTotal === 100 ? 'valid' : 'invalid'}>启用权重 {weightTotal}/100</span>
      </div>
      <p className="quality-review-help">
        阈值 <strong>{rubric.threshold}</strong> 只读；启动后此 Rubric 快照不可变。
      </p>
      <div className="quality-review-rubric">
        {rubric.dimensions.map((dimension) => (
          <RubricRow key={dimension.id} dimension={dimension} onRubric={onRubric} rubric={rubric} readOnly={readOnly} />
        ))}
      </div>
    </div>
  );
}

function RubricRow({
  rubric,
  dimension,
  onRubric,
  readOnly
}: {
  rubric: QualityReviewRubric;
  dimension: QualityReviewDimension;
  onRubric: (value: QualityReviewRubric) => void;
  readOnly: boolean;
}) {
  const update = (change: Partial<QualityReviewDimension>) =>
    onRubric({
      ...rubric,
      dimensions: rubric.dimensions.map((item) => (item.id === dimension.id ? { ...item, ...change } : item))
    });
  return (
    <div className={`quality-review-rubric-row ${dimension.enabled ? '' : 'disabled'}`}>
      <label className="quality-review-rubric-toggle">
        <input
          type="checkbox"
          checked={dimension.enabled}
          disabled={readOnly}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        <span>{dimension.title}</span>
      </label>
      <input
        type="number"
        min={0}
        max={100}
        value={dimension.weight}
        disabled={readOnly || !dimension.enabled}
        aria-label={`${dimension.title} 权重`}
        onChange={(event) => update({ weight: Number(event.target.value) || 0 })}
      />
      <input
        value={dimension.instructions || ''}
        disabled={readOnly}
        aria-label={`${dimension.title} 说明`}
        placeholder="补充评审说明"
        onChange={(event) => update({ instructions: event.target.value })}
      />
    </div>
  );
}

function DrawerFooter({
  valid,
  weightTotal,
  requiredExcluded,
  invalidExclusions,
  busy,
  onClose,
  onStart
}: {
  valid: boolean;
  weightTotal: number;
  requiredExcluded: boolean;
  invalidExclusions: boolean;
  busy: boolean;
  onClose: () => void;
  onStart: () => void;
}) {
  const validation =
    weightTotal !== 100
      ? '启用维度权重必须合计 100。'
      : requiredExcluded
        ? '必需输出不能排除。'
        : invalidExclusions
          ? '请为每个被排除的资产填写理由。'
          : '至少选择一个资产。';
  return (
    <div className="quality-review-drawer-footer">
      {!valid && <small className="quality-review-validation">{validation}</small>}
      <button className="button secondary" onClick={onClose}>
        取消
      </button>
      <button className="button primary" disabled={!valid || busy} onClick={onStart}>
        {busy ? <Loader2 size={14} className="quality-review-spin" /> : <Play size={14} />}
        {busy ? '启动中…' : '确认启动'}
      </button>
    </div>
  );
}
