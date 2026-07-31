import { Boxes, Check, Download, FileText, Filter, Fingerprint, GitFork, ShieldCheck, Users, X } from 'lucide-react';

import type { AssetVersionDetails } from '../../api/types';
import { FullPageState } from '../../components/common/FullPageState';
import {
  assetTypeLabel,
  attestationDecisionLabel,
  attestorTypeLabel,
  confirmationPolicyLabel,
  consumerTypeLabel,
  displayStatus,
  manifestRoleLabel,
  payloadKindLabel,
  relationTypeLabel
} from '../../components/common/display-labels';
import type { AssetsPageController } from './AssetsPage';
import { downloadUrl, formatBytes, isTextMedia, pretty, short } from './asset-presentation';

const PREVIEW_LIMIT = 1024 * 1024;

export function AssetsPageView({ controller }: { controller: AssetsPageController }) {
  if (controller.assets.isLoading) return <FullPageState title="正在加载资产" />;
  if (controller.assets.isError)
    return (
      <FullPageState title="资产加载失败" detail={controller.assets.error.message} retry={controller.assets.refetch} />
    );
  return (
    <section className="data-page assets-inspector-page">
      <AssetsHeading controller={controller} />
      <div className="asset-inspector">
        <AssetList controller={controller} />
        <AssetDetail controller={controller} />
      </div>
    </section>
  );
}

function AssetsHeading({ controller }: { controller: AssetsPageController }) {
  return (
    <header className="page-heading">
      <div>
        <span className="overline">不可变证据</span>
        <h1>资产</h1>
        <p>{controller.rows.length} 项内容寻址结果</p>
      </div>
      <label className="compact-filter">
        <Filter size={14} />
        <select
          id="assets-status-filter"
          value={controller.status}
          onChange={(event) => controller.setStatus(event.target.value)}
        >
          <option value="all">全部状态</option>
          <option value="candidate">待确认</option>
          <option value="confirmed">已确认</option>
          <option value="rejected">已拒绝</option>
          <option value="stale">已过期</option>
          <option value="disputed">有争议</option>
          <option value="superseded">已取代</option>
        </select>
      </label>
    </header>
  );
}

function AssetList({ controller }: { controller: AssetsPageController }) {
  return (
    <aside className="asset-master" aria-label="资产列表">
      {controller.rows.map((asset) => (
        <button
          key={asset.id}
          className={asset.id === controller.selectedId ? 'active' : ''}
          onClick={() => controller.setSelectedId(asset.id)}
        >
          <Boxes size={15} />
          <span>
            <strong>{asset.title}</strong>
            <small>
              {assetTypeLabel(asset.asset_type || asset.type)} ·{' '}
              {asset.current_version ? `v${asset.current_version.version}` : '无版本'}
            </small>
          </span>
          <i className={`status ${asset.status}`}>{displayStatus(asset.status)}</i>
        </button>
      ))}
      {!controller.rows.length && (
        <div className="quiet-empty">
          <Boxes size={24} />
          <p>当前筛选下没有资产</p>
        </div>
      )}
    </aside>
  );
}

function AssetDetail({ controller }: { controller: AssetsPageController }) {
  if (controller.detail.isLoading)
    return (
      <main className="asset-detail">
        <div className="asset-detail-empty">正在读取资产版本</div>
      </main>
    );
  if (!controller.current || !controller.selected)
    return (
      <main className="asset-detail">
        <div className="asset-detail-empty">选择一个资产查看正文与证据</div>
      </main>
    );
  return (
    <main className="asset-detail">
      <AssetDetailHeading controller={controller} />
      <AssetVersionTabs controller={controller} />
      <AssetMetadata controller={controller} />
      <AssetAttestationActions controller={controller} />
      <AssetPreview controller={controller} />
      <ManifestEntries
        version={controller.version.data}
        activePath={controller.previewPath}
        onPreview={controller.setPreviewPath}
      />
      <div className="asset-evidence-grid">
        <Evidence value={controller.version.data} />
        <Attestations value={controller.version.data} />
        <Lineage value={controller.version.data} />
        <Consumers value={controller.version.data} />
      </div>
    </main>
  );
}

function AssetDetailHeading({ controller }: { controller: AssetsPageController }) {
  const current = controller.current!;
  return (
    <header className="asset-detail-heading">
      <div>
        <span>{assetTypeLabel(current.asset_type || current.type)}</span>
        <h2>{current.title}</h2>
        <p>{current.summary || '无摘要'}</p>
      </div>
      <i className={`status ${current.status}`}>{displayStatus(current.status)}</i>
    </header>
  );
}

function AssetVersionTabs({ controller }: { controller: AssetsPageController }) {
  return (
    <div className="asset-version-tabs" role="tablist" aria-label="资产版本">
      {controller.detail.data?.versions.map((item) => (
        <button
          role="tab"
          aria-selected={item.id === controller.selected?.id}
          className={item.id === controller.selected?.id ? 'active' : ''}
          key={item.id}
          onClick={() => {
            controller.setVersionId(item.id);
            controller.setPreviewPath(null);
          }}
        >
          v{item.version}
          <small>{short(item.content_sha256)}</small>
        </button>
      ))}
    </div>
  );
}

function AssetMetadata({ controller }: { controller: AssetsPageController }) {
  const selected = controller.selected!;
  return (
    <section className="asset-metadata">
      <Metric label="SHA-256" value={selected.content_sha256 || '旧版未验证'} wide />
      <Metric label="载荷格式" value={payloadKindLabel(selected.payload_kind || 'legacy')} />
      <Metric label="媒体类型" value={selected.media_type || '未知'} />
      <Metric label="大小" value={formatBytes(selected.size_bytes)} />
      <Metric label="代码仓库 SHA" value={selected.repository_sha || '未绑定'} />
    </section>
  );
}

function Metric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <span className={wide ? 'wide' : ''}>
      <small>{label}</small>
      <code>{value}</code>
    </span>
  );
}

function AssetAttestationActions({ controller }: { controller: AssetsPageController }) {
  if (!controller.canAttest) return null;
  const disabled = Boolean(controller.busy) || controller.task.isLoading;
  return (
    <div className="asset-attestation-actions">
      <span>
        <ShieldCheck size={16} />
        <strong>等待版本验收</strong>
        <small>{controller.executionId ? '将一次性验收该任务的全部候选输出' : '预期版本与哈希已固定'}</small>
      </span>
      <button
        className="button secondary danger"
        disabled={disabled}
        onClick={() => void controller.decide('rejected')}
      >
        <X size={14} />
        退回
      </button>
      <button className="button primary" disabled={disabled} onClick={() => void controller.decide('accepted')}>
        <Check size={14} />
        验收
      </button>
    </div>
  );
}

function AssetPreview({ controller }: { controller: AssetsPageController }) {
  return (
    <section className="asset-preview">
      <header>
        <span>
          <FileText size={15} />
          <strong>{controller.previewPath || '正文预览'}</strong>
        </span>
        <a className="button secondary" href={downloadUrl(controller.selected!.id, controller.previewPath)}>
          <Download size={14} />
          下载
        </a>
      </header>
      <AssetPreviewBody controller={controller} />
    </section>
  );
}

function AssetPreviewBody({ controller }: { controller: AssetsPageController }) {
  if (controller.preview.isLoading) return <pre>正在校验并读取 CAS...</pre>;
  if (controller.preview.isError) return <pre>{controller.preview.error.message}</pre>;
  if (controller.canPreview) return <pre>{controller.preview.data || '（空载荷）'}</pre>;
  return <div className="asset-preview-unavailable">该载荷不适合内联预览，请下载后检查。</div>;
}

function ManifestEntries({
  version,
  activePath,
  onPreview
}: {
  version?: AssetVersionDetails;
  activePath: string | null;
  onPreview: (path: string) => void;
}) {
  const entries = version?.version.manifest?.entries || [];
  if (!entries.length) return null;
  return (
    <section className="asset-manifest">
      <header>
        <strong>文件清单</strong>
        <small>{entries.length} 个条目</small>
      </header>
      {entries.map((item) => (
        <div key={item.path} className={activePath === item.path ? 'active' : ''}>
          <button
            disabled={!isTextMedia(item.media_type) || item.size_bytes > PREVIEW_LIMIT}
            onClick={() => onPreview(item.path)}
          >
            <FileText size={13} />
            <span>{item.path}</span>
            <small>
              {manifestRoleLabel(item.role)} · {formatBytes(item.size_bytes)} · {short(item.sha256)}
            </small>
          </button>
          <a aria-label={`下载 ${item.path}`} href={downloadUrl(version!.version.id, item.path)}>
            <Download size={14} />
          </a>
        </div>
      ))}
    </section>
  );
}

function Evidence({ value }: { value?: AssetVersionDetails }) {
  const evidence = value?.version.evidence_refs || [];
  return (
    <section>
      <header>
        <Fingerprint size={14} />
        <strong>证据与来源</strong>
      </header>
      {evidence.map((item) => (
        <code key={item}>{item}</code>
      ))}
      {value?.version.provenance && <pre>{pretty(value.version.provenance)}</pre>}
      {!evidence.length && !value?.version.provenance && <small>无证据引用</small>}
    </section>
  );
}

function Attestations({ value }: { value?: AssetVersionDetails }) {
  return (
    <section>
      <header>
        <ShieldCheck size={14} />
        <strong>验收记录</strong>
      </header>
      {value?.attestations.map((item) => (
        <span key={item.id}>
          <b>
            {attestationDecisionLabel(item.decision)} · {attestorTypeLabel(item.attestor_type)}
          </b>
          <code>
            {short(item.id)} · {new Date(item.created_at).toLocaleString()}
          </code>
          <small>{item.summary || confirmationPolicyLabel(item.confirmation_policy)}</small>
        </span>
      ))}
      {!value?.attestations.length && <small>尚未验收</small>}
    </section>
  );
}

function Lineage({ value }: { value?: AssetVersionDetails }) {
  const relations = [...(value?.lineage.upstream || []), ...(value?.lineage.downstream || [])];
  return (
    <section>
      <header>
        <GitFork size={14} />
        <strong>版本脉络</strong>
      </header>
      {relations.map((item) => (
        <span key={item.id}>
          <b>{relationTypeLabel(item.relation_type)}</b>
          <code>
            {short(item.source_asset_version_id)} -&gt; {short(item.target_asset_version_id)}
          </code>
        </span>
      ))}
      {!relations.length && <small>无上下游版本关系</small>}
    </section>
  );
}

function Consumers({ value }: { value?: AssetVersionDetails }) {
  return (
    <section>
      <header>
        <Users size={14} />
        <strong>下游使用</strong>
      </header>
      {value?.consumers.map((item) => (
        <span key={`${item.type}-${item.id}`}>
          <b>
            {consumerTypeLabel(item.type)} · {consumptionLabel(item.consumption_status)} · {displayStatus(item.status)}
          </b>
          <code>
            {short(item.id)} · {(item.input_keys || []).join(', ')}
          </code>
          {item.effects?.map((effect, index) => (
            <small key={`${effect.input_key}-${effect.effect}-${index}`}>{effect.statement}</small>
          ))}
        </span>
      ))}
      {!value?.consumers.length && <small>尚无下游使用</small>}
    </section>
  );
}

function consumptionLabel(status?: string) {
  if (status === 'applied') return '已影响下游输出';
  if (status === 'consumed') return '已实际消费';
  if (status === 'evidenced') return '作为验收证据';
  return '仅固定为输入';
}
