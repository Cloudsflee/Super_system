import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban, BookOpen, Box, Check, CircleAlert, Clock3, FileSearch, History, LoaderCircle,
  Pin, RefreshCw, RotateCcw, Search, Square, X
} from 'lucide-react';
import { ApiError, apiV2, formatTime, mutateOfflineV2, mutateV2, shortHash } from '../../api';
import type { PageKey } from '../../App';
import type { Project } from '../../types';
import type { ContextDocument, ContextMap, ContextNode, ContextPackView, ContextPolicy, ContextSelection, ProjectionStatus } from './types';

export interface ContextPageProps {
  projectId: string;
  selectedProject?: Project;
  selectProject: (id: string) => void;
  refreshProjects: () => Promise<void>;
  notify: (text: string, tone?: 'ok' | 'error') => void;
  navigate: (page: PageKey) => void;
  setupReady: boolean;
  refreshSetup: () => Promise<void>;
}

type ViewTab = 'tree' | 'document' | 'packs';

function Status({ value }: { value: string }) {
  const tone = ['ready', 'active', 'completed', 'current'].includes(value) ? 'positive' : ['queued', 'running', 'indexing'].includes(value) ? 'working' : ['failed', 'unavailable'].includes(value) ? 'negative' : 'neutral';
  return <span className={`status ${tone}`}><span />{value.replaceAll('_', ' ')}</span>;
}

export function ContextPage({ projectId, selectedProject, navigate, notify }: ContextPageProps) {
  const [projectBundle, setProjectBundle] = useState<Project | null>(null);
  const [contextMap, setContextMap] = useState<ContextMap | null>(null);
  const [policy, setPolicy] = useState<ContextPolicy | null>(null);
  const [selections, setSelections] = useState<ContextSelection[]>([]);
  const [packs, setPacks] = useState<ContextPackView[]>([]);
  const [projection, setProjection] = useState<ProjectionStatus | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [selectedNode, setSelectedNode] = useState<ContextNode | null>(null);
  const [versions, setVersions] = useState<ContextDocument[]>([]);
  const [versionId, setVersionId] = useState('');
  const [query, setQuery] = useState('');
  const [searchIds, setSearchIds] = useState<string[] | null>(null);
  const [tokenBudget, setTokenBudget] = useState(4096);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<ViewTab>('tree');
  const offlineScope = useMemo(() => ({
    actorId: sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor',
    teamId: String((selectedProject as Project & { team_id?: string } | undefined)?.team_id || 'default-team'),
    projectId
  }), [projectId, selectedProject]);

  const cleanApi = useCallback(async <T,>(path: string): Promise<T> => (await apiV2<T>(path)).data, []);
  const cleanMutation = useCallback(async <T,>(path: string, body: Record<string, unknown> = {}, method = 'POST', expectedRevision?: number): Promise<T> => {
    return (await mutateV2<T>(path, body, method, expectedRevision)).data;
  }, []);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError('');
    try {
      const [mapValue, policyValue, selectionRows, packRows, statusValue, projectValue] = await Promise.all([
        cleanApi<ContextMap>(`/api/v2/projects/${projectId}/context/map`),
        cleanApi<ContextPolicy>(`/api/v2/projects/${projectId}/context/policy`),
        cleanApi<{ selections: ContextSelection[] }>(`/api/v2/projects/${projectId}/context/selections`),
        cleanApi<{ packs: ContextPackView[] }>(`/api/v2/projects/${projectId}/context/packs`),
        cleanApi<ProjectionStatus>(`/api/v2/projects/${projectId}/context/status`),
        cleanApi<{ project: Project }>(`/api/v2/projects/${projectId}`)
      ]);
      setContextMap(mapValue); setPolicy(policyValue); setSelections(selectionRows.selections || []); setPacks(packRows.packs || []); setProjection(statusValue); setProjectBundle(projectValue.project || (projectValue as unknown as Project));
      setSelectedNodeId((current) => mapValue.nodes.some((node) => node.id === current) ? current : mapValue.nodes.find((node) => node.kind !== 'root' && node.status === 'active')?.id || mapValue.nodes[0]?.id || '');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Context is offline');
    }
  }, [cleanApi, projectId]);

  const loadNode = useCallback(async () => {
    if (!projectId || !selectedNodeId) { setSelectedNode(null); setVersions([]); return; }
    try {
      const [node, history] = await Promise.all([
        cleanApi<ContextNode>(`/api/v2/projects/${projectId}/context/nodes/${selectedNodeId}${versionId ? `?version_id=${encodeURIComponent(versionId)}` : ''}`),
        cleanApi<{ versions: ContextDocument[] }>(`/api/v2/projects/${projectId}/context/nodes/${selectedNodeId}/versions`)
      ]);
      setSelectedNode(node); setVersions(history.versions || []); setVersionId((current) => current && (history.versions || []).some((item) => item.id === current) ? current : node.current_document_version_id || history.versions?.at(-1)?.id || '');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Context document unavailable'); }
  }, [cleanApi, projectId, selectedNodeId, versionId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadNode(); }, [loadNode]);
  useEffect(() => {
    const active = projection?.jobs?.find((job) => ['queued', 'running', 'indexing'].includes(job.status));
    if (!projectId || !active) return;
    const stream = new EventSource(`/api/v2/projects/${projectId}/context/jobs/${active.id}/events?cursor=${encodeURIComponent(String(active.cursor || '0'))}`);
    stream.onmessage = () => void load();
    stream.addEventListener('context.projection.completed', () => void load());
    stream.addEventListener('context.projection.failed', () => void load());
    const timer = window.setInterval(() => void load(), 1500);
    return () => { stream.close(); window.clearInterval(timer); };
  }, [load, projectId, projection?.jobs]);

  const visibleNodes = useMemo(() => {
    const rows = contextMap?.nodes || [];
    return searchIds ? rows.filter((node) => searchIds.includes(node.id)) : rows;
  }, [contextMap, searchIds]);
  const latestSelection = selections[0];
  const project = projectBundle || selectedProject;
  const canSeal = Boolean(project?.confirmed_brief_revision && project?.workflow?.revision);

  if (!projectId) return <div className="empty-state"><BookOpen size={28} /><h2>No project selected</h2><button className="button primary" onClick={() => navigate('projects')}>Open projects</button></div>;

  const run = async (key: string, action: () => Promise<boolean | void>, success: string) => {
    setBusy(key); setError('');
    try { const refresh = await action(); if (refresh !== false) await load(); notify(success); }
    catch (caught) {
      const message = caught instanceof ApiError && caught.code === 'revision_conflict' ? 'Context revision changed. State refreshed.' : caught instanceof Error ? caught.message : 'Context command failed';
      setError(message); notify(message, 'error'); await load().catch(() => undefined);
    } finally { setBusy(''); }
  };
  const search = async () => {
    if (!query.trim()) { setSearchIds(null); return; }
    setBusy('search');
    try {
      const response = await cleanApi<{ results: Array<{ node_id: string | null }> }>(`/api/v2/projects/${projectId}/context/search?q=${encodeURIComponent(query)}&limit=100`);
      setSearchIds((response.results || []).map((item) => item.node_id).filter((value): value is string => Boolean(value)));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Search failed'); }
    finally { setBusy(''); }
  };
  const updatePolicy = (mode: 'pin' | 'exclude') => {
    if (!policy || !selectedNodeId) return;
    const pinned = new Set(policy.policy.pinned_node_ids || []);
    const excluded = new Set(policy.policy.excluded_node_ids || []);
    const target = mode === 'pin' ? pinned : excluded;
    const other = mode === 'pin' ? excluded : pinned;
    if (target.has(selectedNodeId)) target.delete(selectedNodeId); else { target.add(selectedNodeId); other.delete(selectedNodeId); }
    void run(`policy-${mode}`, async () => {
      await cleanMutation(`/api/v2/projects/${projectId}/context/policy`, { policy: { ...policy.policy, pinned_node_ids: [...pinned], excluded_node_ids: [...excluded] } }, 'PATCH', policy.revision);
    }, `Context ${mode} policy updated`);
  };
  const createSelection = () => run('selection', async () => {
    const result = await mutateOfflineV2(`/api/v2/projects/${projectId}/context/selections`, { query, token_budget: tokenBudget, node_ids: selectedNodeId ? [selectedNodeId] : undefined }, 'POST', { command: 'context.selection.create', scope: offlineScope, aggregateKey: `project:${projectId}:context-selection`, expectedRevision: 0 });
    return !('queued' in result);
  }, 'Selection sealed');
  const createPack = () => latestSelection && run('pack', async () => {
    await cleanMutation(`/api/v2/projects/${projectId}/context/packs`, { selection_id: latestSelection.id, schema_version: 'aiws.context_pack.v5', require_authoritative: false }, 'POST', 0);
  }, 'Context Pack v5 sealed');
  const rebuild = () => run('rebuild', async () => { await cleanMutation(`/api/v2/projects/${projectId}/context/rebuild`, { mode: 'full', defer: true }, 'POST', 0); }, 'Projection queued');
  const cancel = () => projection?.id && run('cancel', async () => { await cleanMutation(`/api/v2/projects/${projectId}/context/jobs/${projection.id}/cancel`, {}, 'POST', projection.revision); }, 'Projection cancelled');
  const retry = () => projection?.id && run('retry', async () => { await cleanMutation(`/api/v2/projects/${projectId}/context/jobs/${projection.id}/retry`, {}, 'POST', projection.revision); }, 'Projection retry queued');

  return <div className="page context-page">
    <div className="page-heading context-heading"><div><p className="eyebrow">Projected workspace memory</p><h1>Context</h1></div><div className="context-heading-actions"><Status value={projection?.index?.status || 'unavailable'} /><button className="icon-button" aria-label="Refresh Context" title="Refresh Context" onClick={() => void load()}><RefreshCw size={17} /></button><button className="button primary" disabled={busy === 'rebuild'} onClick={() => void rebuild()}>{busy === 'rebuild' ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}Rebuild</button></div></div>
    {error && <div className="context-alert" role="alert"><CircleAlert size={16} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" title="Dismiss error" onClick={() => setError('')}><X size={14} /></button></div>}
    <div className="context-mobile-tabs" role="tablist">{(['tree', 'document', 'packs'] as ViewTab[]).map((item) => <button role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} key={item} onClick={() => setTab(item)}>{item}</button>)}</div>
    <div className="context-grid">
      <section className={`panel context-tree-panel ${tab === 'tree' ? 'mobile-active' : ''}`}>
        <div className="context-toolbar"><div className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search(); }} placeholder="Search Context" /><button className="icon-button" aria-label="Run Context search" title="Run Context search" disabled={busy === 'search'} onClick={() => void search()}>{busy === 'search' ? <LoaderCircle className="spin" size={14} /> : <FileSearch size={14} />}</button></div>{searchIds && <button className="icon-button" title="Clear search" aria-label="Clear search" onClick={() => { setSearchIds(null); setQuery(''); }}><X size={15} /></button>}</div>
        <div className="context-node-list">{visibleNodes.map((node) => <button key={node.id} className={`${selectedNodeId === node.id ? 'selected ' : ''}${node.status === 'tombstone' ? 'tombstone' : ''}`} onClick={() => { setSelectedNodeId(node.id); setVersionId(''); setTab('document'); }}><span className="context-kind">{(node.kind || node.node_kind || 'node').slice(0, 2).toUpperCase()}</span><span><strong>{node.title}</strong><small>{node.source_type || node.node_kind || 'context'} · r{node.revision}</small></span>{policy?.policy.pinned_node_ids?.includes(node.id) && <Pin size={13} />}{policy?.policy.excluded_node_ids?.includes(node.id) && <Ban size={13} />}</button>)}{!visibleNodes.length && <div className="list-empty">No projected nodes</div>}</div>
      </section>
      <section className={`panel context-inspector ${tab === 'document' ? 'mobile-active' : ''}`}>
        {selectedNode ? <><div className="section-title"><div><h2>{selectedNode.title}</h2><span className="mono">{selectedNode.uri}</span></div><div className="row-tools"><button className={`icon-button ${policy?.policy.pinned_node_ids?.includes(selectedNode.id) ? 'active' : ''}`} title="Pin node" aria-label="Pin node" onClick={() => updatePolicy('pin')}><Pin size={15} /></button><button className={`icon-button ${policy?.policy.excluded_node_ids?.includes(selectedNode.id) ? 'active' : ''}`} title="Exclude node" aria-label="Exclude node" onClick={() => updatePolicy('exclude')}><Ban size={15} /></button></div></div>
          <div className="context-meta"><span><b>Authority</b>{selectedNode.authority || 'projected'}</span><span><b>Freshness</b>{selectedNode.freshness?.status || 'unknown'}</span><span><b>Hash</b><code>{shortHash(selectedNode.source_hash)}</code></span><span><b>Scope</b>{selectedNode.required_scopes?.join(', ') || 'context:read'}</span></div>
          <div className="context-versionbar"><History size={15} /><select aria-label="Document version" value={versionId} onChange={(event) => setVersionId(event.target.value)}>{versions.map((item) => <option value={item.id} key={item.id}>v{item.version} · {shortHash(item.content_hash)} · {formatTime(item.created_at)}</option>)}</select><span>{selectedNode.document?.token_estimate || 0} tokens</span></div>
          <pre className="context-content">{selectedNode.document?.content || 'No document content'}</pre>
        </> : <div className="empty-state"><BookOpen size={24} /><h2>Select a Context node</h2></div>}
      </section>
      <aside className={`context-side ${tab === 'packs' ? 'mobile-active' : ''}`}>
        <section className="panel context-projection-panel"><div className="section-title"><div><h2>Projection</h2><span>{projection?.mode || 'full'} · attempt {projection?.attempt || 0}</span></div><Status value={projection?.status || 'queued'} /></div><dl className="definition-list"><div><dt>Nodes</dt><dd>{contextMap?.nodes.length || 0}</dd></div><div><dt>Documents</dt><dd>{projection?.index?.document_count || 0}</dd></div><div><dt>Snapshot</dt><dd className="mono">{shortHash(projection?.index?.snapshot_hash || '')}</dd></div></dl><div className="context-job-actions">{['queued', 'running', 'indexing'].includes(projection?.status || '') && <button className="button" onClick={() => void cancel()}><Square size={14} />Cancel</button>}{['failed', 'cancelled'].includes(projection?.status || '') && <button className="button" onClick={() => void retry()}><RotateCcw size={14} />Retry</button>}</div></section>
        <section className="panel context-selection-panel"><div className="section-title"><div><h2>Selection</h2><span>Policy r{policy?.revision || 0}</span></div><span className="mono">{shortHash(latestSelection?.selection_hash || '')}</span></div><label><span>Token budget</span><input type="number" min={256} max={128000} step={256} value={tokenBudget} onChange={(event) => setTokenBudget(Number(event.target.value))} /></label><button className="button" disabled={!selectedNodeId || busy === 'selection'} onClick={() => void createSelection()}>{busy === 'selection' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Create Selection</button>{latestSelection && <div className="selection-summary"><span>{latestSelection.included.length} included</span><span>{latestSelection.excluded.length} excluded</span><span>{latestSelection.token_used || 0} tokens</span></div>}</section>
        <section className="panel context-pack-panel"><div className="section-title"><div><h2>Context Packs</h2><span>{packs.length} immutable</span></div><Box size={17} /></div><button className="button primary" disabled={!latestSelection || !canSeal || busy === 'pack'} title={!canSeal ? 'Confirmed Brief and applied Workflow required' : 'Seal Context Pack v5'} onClick={() => void createPack()}><Box size={15} />Seal Pack v5</button><div className="context-pack-list">{packs.map((pack) => <div key={pack.id}><span><strong className="mono">{shortHash(pack.pack_hash)}</strong><small>{formatTime(pack.created_at)}</small></span><span>{(pack.memory_manifest?.document_version_ids || pack.pack?.memory_manifest?.document_version_ids || []).length} docs</span></div>)}{!packs.length && <div className="list-empty">No Context Packs</div>}</div></section>
      </aside>
    </div>
  </div>;
}
