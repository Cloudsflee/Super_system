import { Boxes, Check, Download, FileText, Filter, Fingerprint, GitFork, ShieldCheck, Users, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, apiUrl, json } from '../../api/client';
import type { AssetDetails, AssetRecord, AssetVersionDetails, TaskExecutionDetails } from '../../api/types';
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
import { useAssistSurface } from '../../components/assist/semantic-actions';
import { useUi } from '../../state/ui';

const PREVIEW_LIMIT = 1024 * 1024;

function useAssetsPageController() {
  const projectId = useUi((state) => state.activeProjectId),
    toast = useUi((state) => state.toast);
  const [status, setStatus] = useState('all'),
    [selectedId, setSelectedId] = useState('');
  const [versionId, setVersionId] = useState(''),
    [previewPath, setPreviewPath] = useState<string | null>(null),
    [busy, setBusy] = useState('');
  useAssistSurface({
    id: 'assets-page',
    filters: {
      'assets.status': {
        label: '资产状态',
        elementId: 'assets-status-filter',
        values: ['all', 'candidate', 'confirmed', 'rejected', 'stale', 'disputed', 'superseded'],
        set: (value) => setStatus(String(value || 'all'))
      }
    }
  });
  const assets = useQuery({
    queryKey: ['assets', projectId],
    queryFn: () => api<AssetRecord[]>(`/assets${projectId ? `?project_id=${projectId}` : ''}`)
  });
  const rows = useMemo(
    () => (assets.data || []).filter((item) => status === 'all' || item.status === status),
    [assets.data, status]
  );
  useEffect(() => {
    if (!rows.some((item) => item.id === selectedId)) setSelectedId(rows[0]?.id || '');
  }, [rows, selectedId]);
  const detail = useQuery({
    queryKey: ['asset', selectedId],
    queryFn: () => api<AssetDetails>(`/assets/${selectedId}`),
    enabled: Boolean(selectedId)
  });
  useEffect(() => {
    const next = detail.data?.current?.id || detail.data?.versions[0]?.id || '';
    setVersionId(next);
    setPreviewPath(null);
  }, [detail.data?.asset.id, detail.data?.current?.id]);
  const version = useQuery({
    queryKey: ['asset-version', versionId],
    queryFn: () => api<AssetVersionDetails>(`/asset-versions/${versionId}`),
    enabled: Boolean(versionId)
  });
  const executionId = detail.data?.asset.task_execution_id || '';
  const task = useQuery({
    queryKey: ['task-execution', executionId],
    queryFn: () => api<TaskExecutionDetails>(`/task-executions/${executionId}`),
    enabled: Boolean(executionId)
  });
  const entry = version.data?.version.manifest?.entries?.find((item) => item.path === previewPath);
  const previewMedia = entry?.media_type || version.data?.version.media_type || '';
  const previewSize =
    entry?.size_bytes ??
    (version.data?.version.manifest?.entries?.length && version.data.version.manifest.entries.length > 1
      ? 0
      : version.data?.version.size_bytes || 0);
  const canPreview =
    Boolean(versionId) &&
    previewSize <= PREVIEW_LIMIT &&
    (previewPath
      ? isTextMedia(previewMedia)
      : isTextMedia(previewMedia) || (version.data?.version.manifest?.entries?.length || 0) > 1);
  const preview = useQuery({
    queryKey: ['asset-content', versionId, previewPath],
    queryFn: () => readPreview(versionId, previewPath, previewMedia),
    enabled: canPreview
  });

  async function decide(decision: 'accepted' | 'rejected') {
    const asset = detail.data?.asset,
      selected = version.data?.version;
    if (!asset || !selected?.content_sha256) return;
    setBusy(decision);
    try {
      if (asset.task_execution_id) {
        const candidates =
          task.data?.outputs.filter(
            (item) =>
              item.asset?.status === 'candidate' && !item.bound && item.version?.id && item.version.content_sha256
          ) || [];
        if (!candidates.length) throw new Error('任务执行没有可验收的候选输出');
        await api(
          `/task-executions/${asset.task_execution_id}/human-approve`,
          json(
            'POST',
            {
              decision: decision === 'accepted' ? 'approve' : 'reject',
              expected_versions: candidates.map((item) => ({
                version_id: item.version?.id,
                content_sha256: item.version?.content_sha256
              }))
            },
            decision === 'accepted' ? '验收任务输出' : '退回任务输出'
          )
        );
      } else {
        await api(
          `/asset-versions/${selected.id}/attestations`,
          json(
            'POST',
            { decision, expected_sha256: selected.content_sha256 },
            decision === 'accepted' ? '确认资产版本' : '拒绝资产版本'
          )
        );
      }
      await Promise.all([assets.refetch(), detail.refetch(), version.refetch(), task.refetch()]);
      toast(decision === 'accepted' ? '资产版本已验收' : '资产版本已退回');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy('');
    }
  }

  const selected = version.data?.version,
    current = detail.data?.asset;
  const canAttest =
    current?.status === 'candidate' &&
    current.current_version_id === selected?.id &&
    current.confirmation_policy !== 'system_evidence' &&
    Boolean(selected?.content_sha256);
  return {
    assets,
    rows,
    status,
    setStatus,
    selectedId,
    setSelectedId,
    detail,
    selected,
    current,
    setVersionId,
    previewPath,
    setPreviewPath,
    canAttest,
    executionId,
    busy,
    task,
    decide,
    preview,
    canPreview,
    version
  };
}

export function AssetsPage() {
  const {
    assets,
    rows,
    status,
    setStatus,
    selectedId,
    setSelectedId,
    detail,
    selected,
    current,
    setVersionId,
    previewPath,
    setPreviewPath,
    canAttest,
    executionId,
    busy,
    task,
    decide,
    preview,
    canPreview,
    version
  } = useAssetsPageController();
  if (assets.isLoading) return <FullPageState title="正在加载资产" />;
  if (assets.isError)
    return <FullPageState title="资产加载失败" detail={assets.error.message} retry={assets.refetch} />;
  return (
    <section className="data-page assets-inspector-page">
      <header className="page-heading">
        <div>
          <span className="overline">不可变证据</span>
          <h1>资产</h1>
          <p>{rows.length} 项内容寻址结果</p>
        </div>
        <label className="compact-filter">
          <Filter size={14} />
          <select id="assets-status-filter" value={status} onChange={(event) => setStatus(event.target.value)}>
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
      <div className="asset-inspector">
        <aside className="asset-master" aria-label="资产列表">
          {rows.map((asset) => (
            <button
              key={asset.id}
              className={asset.id === selectedId ? 'active' : ''}
              onClick={() => setSelectedId(asset.id)}
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
          {!rows.length && (
            <div className="quiet-empty">
              <Boxes size={24} />
              <p>当前筛选下没有资产</p>
            </div>
          )}
        </aside>
        <main className="asset-detail">
          {detail.isLoading ? (
            <div className="asset-detail-empty">正在读取资产版本</div>
          ) : current && selected ? (
            <>
              <header className="asset-detail-heading">
                <div>
                  <span>{assetTypeLabel(current.asset_type || current.type)}</span>
                  <h2>{current.title}</h2>
                  <p>{current.summary || '无摘要'}</p>
                </div>
                <i className={`status ${current.status}`}>{displayStatus(current.status)}</i>
              </header>
              <div className="asset-version-tabs" role="tablist" aria-label="资产版本">
                {detail.data?.versions.map((item) => (
                  <button
                    role="tab"
                    aria-selected={item.id === selected.id}
                    className={item.id === selected.id ? 'active' : ''}
                    key={item.id}
                    onClick={() => {
                      setVersionId(item.id);
                      setPreviewPath(null);
                    }}
                  >
                    v{item.version}
                    <small>{short(item.content_sha256)}</small>
                  </button>
                ))}
              </div>
              <section className="asset-metadata">
                <Metric label="SHA-256" value={selected.content_sha256 || '旧版未验证'} wide />
                <Metric label="载荷格式" value={payloadKindLabel(selected.payload_kind || 'legacy')} />
                <Metric label="媒体类型" value={selected.media_type || '未知'} />
                <Metric label="大小" value={formatBytes(selected.size_bytes)} />
                <Metric label="代码仓库 SHA" value={selected.repository_sha || '未绑定'} />
              </section>
              {canAttest && (
                <div className="asset-attestation-actions">
                  <span>
                    <ShieldCheck size={16} />
                    <strong>等待版本验收</strong>
                    <small>{executionId ? '将一次性验收该任务的全部候选输出' : '预期版本与哈希已固定'}</small>
                  </span>
                  <button
                    className="button secondary danger"
                    disabled={Boolean(busy) || task.isLoading}
                    onClick={() => void decide('rejected')}
                  >
                    <X size={14} />
                    退回
                  </button>
                  <button
                    className="button primary"
                    disabled={Boolean(busy) || task.isLoading}
                    onClick={() => void decide('accepted')}
                  >
                    <Check size={14} />
                    验收
                  </button>
                </div>
              )}
              <section className="asset-preview">
                <header>
                  <span>
                    <FileText size={15} />
                    <strong>{previewPath || '正文预览'}</strong>
                  </span>
                  <a className="button secondary" href={downloadUrl(selected.id, previewPath)}>
                    <Download size={14} />
                    下载
                  </a>
                </header>
                {preview.isLoading ? (
                  <pre>正在校验并读取 CAS...</pre>
                ) : preview.isError ? (
                  <pre>{preview.error.message}</pre>
                ) : canPreview ? (
                  <pre>{preview.data || '（空载荷）'}</pre>
                ) : (
                  <div className="asset-preview-unavailable">该载荷不适合内联预览，请下载后检查。</div>
                )}
              </section>
              <ManifestEntries version={version.data} activePath={previewPath} onPreview={setPreviewPath} />
              <div className="asset-evidence-grid">
                <Evidence value={version.data} />
                <Attestations value={version.data} />
                <Lineage value={version.data} />
                <Consumers value={version.data} />
              </div>
            </>
          ) : (
            <div className="asset-detail-empty">选择一个资产查看正文与证据</div>
          )}
        </main>
      </div>
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
            {consumerTypeLabel(item.type)} ·{' '}
            {item.consumption_status === 'consumed'
              ? '已实际消费'
              : item.consumption_status === 'evidenced'
                ? '作为验收证据'
                : '仅固定为输入'}{' '}
            · {displayStatus(item.status)}
          </b>
          <code>
            {short(item.id)} · {(item.input_keys || []).join(', ')}
          </code>
        </span>
      ))}
      {!value?.consumers.length && <small>尚无下游使用</small>}
    </section>
  );
}
async function readPreview(versionId: string, path: string | null, mediaType: string) {
  const response = await fetch(downloadUrl(versionId, path, false));
  if (!response.ok) throw new Error(`正文读取失败（HTTP ${response.status}）`);
  const text = await response.text();
  if (mediaType.includes('json') || (!path && text.trimStart().startsWith('{'))) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}
function downloadUrl(versionId: string, path: string | null, download = true) {
  const suffix = path ? `?path=${encodeURIComponent(path)}` : '';
  return apiUrl(`/asset-versions/${versionId}/${download ? 'download' : 'content'}${suffix}`);
}
function isTextMedia(value: string) {
  return (
    value.startsWith('text/') ||
    value.includes('json') ||
    value.includes('xml') ||
    value.includes('yaml') ||
    value.includes('javascript')
  );
}
function formatBytes(value?: number) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}
function short(value?: string | null) {
  return value ? value.slice(0, 12) : '未绑定';
}
function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}
