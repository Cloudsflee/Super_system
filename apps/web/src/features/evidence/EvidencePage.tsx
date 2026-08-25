import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  BadgeCheck, FileCheck2, FilePlus2, LoaderCircle, Play, RefreshCw, RotateCcw,
  ShieldCheck, Square, Trash2
} from 'lucide-react';
import { ApiError, apiV2, formatBytes, formatTime, mutateV2, shortHash } from '../../api';
import type { WorkspacePageProps } from '../../workspace';

type AssetVersion = { id: string; asset_id: string; version_no: number; parser_run_id: string | null; source_sha256: string; content_sha256: string; metadata: Record<string, unknown>; metadata_sha256: string; created_at: string };
type Asset = { id: string; project_id: string; execution_id: string | null; logical_name: string; asset_kind: string; source_type: string; source_ref: string; current_version_id: string; current_version: number; current: AssetVersion | null; status: string; revision: number; updated_at: string };
type Relation = { id: string; from_asset_id: string; to_asset_id: string; relation_type: string; input_sha256: string; output_sha256: string; created_at: string };
type Attestation = { id: string; attestation_type: string; subject_sha256: string; statement_sha256: string; validity: string; signature: string; created_at: string };
type ParserFormat = { id: string; format_key: string; label: string; family: string; status: string; extensions: string[] };
type ParserRun = { id: string; status: string; attempt_no: number; retry_of_parser_run_id: string | null; output_asset_version_id: string | null; receipt_sha256: string; error_code: string; revision: number; completed_at: string | null };
type Operation = { operation_id: string; resource_id: string; status: string; error_code?: string };

export function EvidencePage({ projectId, notify }: WorkspacePageProps) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedId, setSelectedId] = useState(() => sessionStorage.getItem('aiws:v3:selected-asset') || '');
  const [asset, setAsset] = useState<Asset | null>(null);
  const [versions, setVersions] = useState<AssetVersion[]>([]);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [attestations, setAttestations] = useState<Attestation[]>([]);
  const [formats, setFormats] = useState<ParserFormat[]>([]);
  const [formatKey, setFormatKey] = useState('');
  const [parserRun, setParserRun] = useState<ParserRun | null>(null);
  const [preview, setPreview] = useState<{ kind: 'text' | 'restricted'; value: string; mediaType: string } | null>(null);
  const [upload, setUpload] = useState<File | null>(null);
  const [busy, setBusy] = useState('');
  const [fault, setFault] = useState('');
  const [confirmTombstone, setConfirmTombstone] = useState(false);

  const loadList = useCallback(async () => {
    if (!projectId) { setAssets([]); setSelectedId(''); return; }
    const [assetResult, formatResult] = await Promise.all([
      apiV2<{ assets: Asset[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets`),
      apiV2<{ formats: ParserFormat[] }>('/api/v2/parser/formats')
    ]);
    const rows = assetResult.data.assets || []; const formatRows = formatResult.data.formats || [];
    setAssets(rows); setFormats(formatRows);
    setSelectedId((current) => rows.some((item) => item.id === current) ? current : rows[0]?.id || '');
    setFormatKey((current) => formatRows.some((item) => item.format_key === current) ? current : formatRows[0]?.format_key || '');
  }, [projectId]);

  const loadDetail = useCallback(async (id = selectedId) => {
    if (!id) { setAsset(null); setVersions([]); setRelations([]); setAttestations([]); setParserRun(null); setPreview(null); return; }
    const [assetResult, versionResult, relationResult, attestationResult] = await Promise.all([
      apiV2<{ asset: Asset }>(`/api/v2/assets/${encodeURIComponent(id)}`),
      apiV2<{ versions: AssetVersion[] }>(`/api/v2/assets/${encodeURIComponent(id)}/versions`),
      apiV2<{ relations: Relation[] }>(`/api/v2/assets/${encodeURIComponent(id)}/relations`),
      apiV2<{ attestations: Attestation[] }>(`/api/v2/assets/${encodeURIComponent(id)}/attestations`)
    ]);
    const nextAsset = assetResult.data.asset; const nextVersions = versionResult.data.versions || [];
    setAsset(nextAsset); setVersions(nextVersions); setRelations(relationResult.data.relations || []); setAttestations(attestationResult.data.attestations || []);
    const runId = nextVersions.find((item) => item.id === nextAsset.current_version_id)?.parser_run_id;
    if (runId) setParserRun((await apiV2<{ parser_run: ParserRun }>(`/api/v2/parser-runs/${encodeURIComponent(runId)}`)).data.parser_run);
    else setParserRun(null);
    await loadPreview(nextAsset, nextAsset.current_version_id, setPreview);
    setFault('');
  }, [selectedId]);

  useEffect(() => { void loadList().catch((error) => report(error, setFault, notify)); }, [loadList, notify]);
  useEffect(() => { if (selectedId) sessionStorage.setItem('aiws:v3:selected-asset', selectedId); setConfirmTombstone(false); void loadDetail(selectedId).catch((error) => report(error, setFault, notify)); }, [loadDetail, notify, selectedId]);
  useEffect(() => {
    if (!parserRun || !['queued', 'running'].includes(parserRun.status)) return;
    const timer = setInterval(() => void apiV2<{ parser_run: ParserRun }>(`/api/v2/parser-runs/${encodeURIComponent(parserRun.id)}`).then((value) => setParserRun(value.data.parser_run)).catch((error) => report(error, setFault, notify)), 1000);
    return () => clearInterval(timer);
  }, [notify, parserRun]);

  const refresh = async () => { setBusy('refresh'); try { await loadList(); await loadDetail(); } catch (error) { report(error, setFault, notify); } finally { setBusy(''); } };
  const capture = async () => {
    if (!upload || !projectId) return; setBusy('capture');
    try {
      if (upload.size > 25 * 1024 * 1024) throw new Error('Asset exceeds 25 MiB');
      const result = await mutateV2<{ asset: Asset }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets`, {
        logical_name: upload.name, asset_kind: 'other', source_type: 'manual', source_ref: `web:${upload.name}`,
        media_type: upload.type || 'application/octet-stream', content_base64: bytesToBase64(new Uint8Array(await upload.arrayBuffer()))
      }, 'POST', 0);
      setUpload(null); setSelectedId(result.data.asset.id); await loadList(); notify('Asset captured');
    } catch (error) { report(error, setFault, notify); } finally { setBusy(''); }
  };
  const startParse = async () => {
    if (!asset?.current_version_id || !formatKey) return; setBusy('parse');
    try {
      const response = await mutateV2<Operation>(`/api/v2/assets/${encodeURIComponent(asset.id)}/versions/${encodeURIComponent(asset.current_version_id)}/parse`, { format_key: formatKey }, 'POST', asset.revision);
      const operation = await waitOperation(response.data);
      if (operation.status !== 'succeeded') throw new Error(operation.error_code || 'Parser run failed');
      const run = await apiV2<{ parser_run: ParserRun }>(`/api/v2/parser-runs/${encodeURIComponent(operation.resource_id)}`);
      setParserRun(run.data.parser_run); await loadList(); notify('Parser run completed');
    } catch (error) { report(error, setFault, notify); } finally { setBusy(''); }
  };
  const mutateParser = async (action: 'cancel' | 'retry') => {
    if (!parserRun) return; setBusy(action);
    try {
      const response = await mutateV2<ParserRun | Operation>(`/api/v2/parser-runs/${encodeURIComponent(parserRun.id)}/${action}`, {}, 'POST', parserRun.revision);
      if (action === 'retry') {
        const operation = await waitOperation(response.data as Operation);
        const run = await apiV2<{ parser_run: ParserRun }>(`/api/v2/parser-runs/${encodeURIComponent(operation.resource_id)}`); setParserRun(run.data.parser_run);
      } else setParserRun((response.data as { parser_run?: ParserRun }).parser_run || parserRun);
      notify(`Parser ${action} accepted`);
    } catch (error) { report(error, setFault, notify); } finally { setBusy(''); }
  };
  const attest = async () => {
    if (!asset?.current) return; setBusy('attest');
    try {
      await mutateV2(`/api/v2/assets/${encodeURIComponent(asset.id)}/attestations`, { version_id: asset.current.id, attestation_type: 'integrity', validity: 'valid', statement: { content_sha256: asset.current.content_sha256 } }, 'POST', asset.revision);
      await loadDetail(asset.id); notify('Asset attested');
    } catch (error) { report(error, setFault, notify); } finally { setBusy(''); }
  };
  const tombstone = async () => {
    if (!asset) return; setBusy('tombstone');
    try { await mutateV2(`/api/v2/assets/${encodeURIComponent(asset.id)}/tombstone`, { reason: 'removed from active evidence' }, 'POST', asset.revision); await Promise.all([loadList(), loadDetail(asset.id)]); notify('Asset tombstoned'); }
    catch (error) { report(error, setFault, notify); } finally { setBusy(''); setConfirmTombstone(false); }
  };

  const totalBytes = useMemo(() => assets.reduce((sum, item) => sum + Number(item.current?.metadata?.byte_length || 0), 0), [assets]);
  if (!projectId) return <div className="empty-state"><FileCheck2 size={26} /><h2>No project selected</h2></div>;

  return <div className="page evidence-page-p7">
    <div className="page-heading"><div><p className="eyebrow">Trusted asset chain</p><h1>Evidence</h1></div><div className="evidence-heading-actions"><span className="count-label">{assets.length} assets · {formatBytes(totalBytes)}</span><button className="icon-button" title="Refresh Evidence" aria-label="Refresh Evidence" onClick={() => void refresh()}>{busy === 'refresh' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button></div></div>
    {fault && <div className="execution-fault" role="alert"><ShieldCheck size={16} /><span>{fault.replaceAll('_', ' ')}</span></div>}
    <div className="evidence-capture-bar"><label className="file-picker"><FilePlus2 size={16} /><span>{upload?.name || 'Select asset'}</span><input type="file" aria-label="Select asset" onChange={(event: ChangeEvent<HTMLInputElement>) => setUpload(event.target.files?.[0] || null)} /></label><button className="button primary" disabled={!upload || Boolean(busy)} onClick={() => void capture()}>{busy === 'capture' ? <LoaderCircle className="spin" size={16} /> : <FilePlus2 size={16} />}Capture</button></div>
    <div className="evidence-layout-p7">
      <section className="panel evidence-asset-list"><div className="section-title"><div><h2>Assets</h2><span>{assets.filter((item) => item.status === 'active').length} active</span></div></div><div className="evidence-list-p7">{assets.map((item) => <button key={item.id} className={item.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(item.id)}><FileCheck2 size={16} /><span><strong>{item.logical_name}</strong><small>{item.asset_kind} · v{item.current_version} · {shortHash(item.current?.content_sha256)}</small></span><Status value={item.status} /></button>)}{!assets.length && <div className="list-empty">No assets</div>}</div></section>
      <section className="panel evidence-asset-detail"><div className="section-title"><div><h2>{asset?.logical_name || 'Asset detail'}</h2><span>{asset ? `${asset.source_type} · updated ${formatTime(asset.updated_at)}` : 'No asset selected'}</span></div>{asset && <Status value={asset.status} />}</div>{asset ? <><div className="evidence-facts"><span><small>Revision</small><strong>r{asset.revision}</strong></span><span><small>Version</small><strong>v{asset.current_version}</strong></span><span><small>Content</small><strong className="mono">{shortHash(asset.current?.content_sha256)}</strong></span><span><small>Execution</small><strong className="mono">{shortHash(asset.execution_id || '')}</strong></span></div><div className="evidence-actions"><select aria-label="Parser format" value={formatKey} onChange={(event) => setFormatKey(event.target.value)}>{formats.map((format) => <option value={format.format_key} key={format.id}>{format.label} · {format.family}</option>)}</select><button className="button" disabled={asset.status !== 'active' || Boolean(busy)} onClick={() => void startParse()}><Play size={15} />Parse</button><button className="icon-button" title="Attest current version" aria-label="Attest current version" disabled={asset.status !== 'active' || Boolean(busy)} onClick={() => void attest()}><BadgeCheck size={16} /></button>{confirmTombstone ? <><button className="button danger" disabled={Boolean(busy)} onClick={() => void tombstone()}>Confirm tombstone</button><button className="icon-button" title="Cancel tombstone" aria-label="Cancel tombstone" onClick={() => setConfirmTombstone(false)}><RotateCcw size={15} /></button></> : <button className="icon-button danger" title="Tombstone asset" aria-label="Tombstone asset" disabled={asset.status !== 'active'} onClick={() => setConfirmTombstone(true)}><Trash2 size={15} /></button>}</div></> : <div className="list-empty">No asset selected</div>}</section>
      <section className="panel evidence-preview"><div className="section-title"><div><h2>Restricted preview</h2><span>{preview?.mediaType || 'No content'}</span></div></div>{preview?.kind === 'text' ? <pre>{preview.value}</pre> : <div className="list-empty">{preview?.value || 'No preview'}</div>}</section>
      <section className="panel evidence-parser"><div className="section-title"><div><h2>Parser run</h2><span>{parserRun ? `attempt ${parserRun.attempt_no}` : 'No run'}</span></div>{parserRun && <Status value={parserRun.status} />}</div>{parserRun ? <><dl className="definition-list compact"><div><dt>Receipt</dt><dd className="mono">{shortHash(parserRun.receipt_sha256)}</dd></div><div><dt>Output</dt><dd className="mono">{shortHash(parserRun.output_asset_version_id || '')}</dd></div><div><dt>Error</dt><dd>{parserRun.error_code || 'none'}</dd></div></dl><div className="evidence-actions"><button className="icon-button" title="Cancel parser run" aria-label="Cancel parser run" disabled={!['queued', 'running'].includes(parserRun.status) || Boolean(busy)} onClick={() => void mutateParser('cancel')}><Square size={15} /></button><button className="icon-button" title="Retry parser run" aria-label="Retry parser run" disabled={!['failed', 'invalid', 'resource_exceeded', 'cancelled'].includes(parserRun.status) || parserRun.attempt_no >= 3 || Boolean(busy)} onClick={() => void mutateParser('retry')}><RotateCcw size={15} /></button></div></> : <div className="list-empty">No parser run</div>}</section>
      <section className="panel evidence-lineage"><div className="section-title"><div><h2>Versions & lineage</h2><span>{versions.length} versions · {relations.length} relations</span></div></div><div className="evidence-sublist">{versions.map((item) => <div key={item.id}><span><strong>Version {item.version_no}</strong><small>{formatTime(item.created_at)}</small></span><code>{shortHash(item.content_sha256)}</code></div>)}{relations.map((item) => <div key={item.id}><span><strong>{item.relation_type}</strong><small>{shortHash(item.from_asset_id)} → {shortHash(item.to_asset_id)}</small></span><code>{shortHash(item.output_sha256)}</code></div>)}{!versions.length && !relations.length && <div className="list-empty">No lineage</div>}</div></section>
      <section className="panel evidence-attestations"><div className="section-title"><div><h2>Attestations</h2><span>{attestations.length} immutable statements</span></div></div><div className="evidence-sublist">{attestations.map((item) => <div key={item.id}><span><strong>{item.attestation_type}</strong><small>{item.validity} · {formatTime(item.created_at)}</small></span><code>{shortHash(item.statement_sha256)}</code></div>)}{!attestations.length && <div className="list-empty">No attestations</div>}</div></section>
    </div>
  </div>;
}

async function loadPreview(asset: Asset, versionId: string, setPreview: (value: { kind: 'text' | 'restricted'; value: string; mediaType: string } | null) => void) {
  if (!asset || asset.status !== 'active' || !versionId) { setPreview(null); return; }
  const response = await fetch(`/api/v2/assets/${encodeURIComponent(asset.id)}/versions/${encodeURIComponent(versionId)}/content`, { credentials: 'same-origin', headers: { accept: 'application/octet-stream' } });
  if (!response.ok) { setPreview({ kind: 'restricted', value: `Preview ${response.status}`, mediaType: 'unavailable' }); return; }
  const mediaType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength <= 240_000 && (mediaType.startsWith('text/') || ['application/json', 'application/xml', 'image/svg+xml'].includes(mediaType))) setPreview({ kind: 'text', value: new TextDecoder().decode(bytes), mediaType });
  else setPreview({ kind: 'restricted', value: `${formatBytes(bytes.byteLength)} binary`, mediaType });
}
async function waitOperation(initial: Operation) { let value = initial; for (let attempt = 0; attempt < 200 && ['accepted', 'queued', 'running', 'paused'].includes(value.status); attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 25)); value = (await apiV2<Operation>(`/api/v2/operations/${encodeURIComponent(value.operation_id)}`)).data; } return value; }
function bytesToBase64(bytes: Uint8Array) { let binary = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(binary); }
function Status({ value }: { value: string }) { const tone = ['active', 'parsed', 'valid', 'succeeded'].includes(value) ? 'positive' : ['queued', 'running'].includes(value) ? 'working' : ['failed', 'invalid', 'resource_exceeded', 'tombstoned', 'cancelled'].includes(value) ? 'negative' : 'neutral'; return <span className={`status ${tone}`}><span />{value.replaceAll('_', ' ')}</span>; }
function report(error: unknown, setFault: (value: string) => void, notify: WorkspacePageProps['notify']) { const code = error instanceof ApiError ? error.code : error instanceof Error ? error.message : 'evidence_request_failed'; setFault(code); notify(error instanceof Error ? error.message : 'Evidence request failed', 'error'); }
