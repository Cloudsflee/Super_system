import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban, BookOpen, Box, Check, CircleAlert, Clock3, FileSearch, History, LoaderCircle,
  Pin, RefreshCw, RotateCcw, Search, Square, X
} from 'lucide-react';
import { ApiError, apiV2, formatTime, mutateOfflineV2, mutateV2, shortHash } from '../../api';
import type { PageKey } from '../../App';
import type { Project } from '../../types';
import type { ContextDocument, ContextMap, ContextNode, ContextPackView, ContextPolicy, ContextSelection, ProjectionStatus } from './types';
import { statusLabel } from '../../i18n';

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
  return <span className={`status ${tone}`}><span />{statusLabel(value)}</span>;
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
      setError(caught instanceof Error ? caught.message : '上下文当前离线');
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
    } catch (caught) { setError(caught instanceof Error ? caught.message : '上下文文档不可用'); }
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

  if (!projectId) return <div className="empty-state"><BookOpen size={28} /><h2>尚未选择项目</h2><button className="button primary" onClick={() => navigate('projects')}>打开项目</button></div>;

  const run = async (key: string, action: () => Promise<boolean | void>, success: string) => {
    setBusy(key); setError('');
    try { const refresh = await action(); if (refresh !== false) await load(); notify(success); }
    catch (caught) {
      const message = caught instanceof ApiError && caught.code === 'revision_conflict' ? '上下文版本已变化，状态已刷新。' : caught instanceof Error ? caught.message : '上下文操作失败';
      setError(message); notify(message, 'error'); await load().catch(() => undefined);
    } finally { setBusy(''); }
  };
  const search = async () => {
    if (!query.trim()) { setSearchIds(null); return; }
    setBusy('search');
    try {
      const response = await cleanApi<{ results: Array<{ node_id: string | null }> }>(`/api/v2/projects/${projectId}/context/search?q=${encodeURIComponent(query)}&limit=100`);
      setSearchIds((response.results || []).map((item) => item.node_id).filter((value): value is string => Boolean(value)));
    } catch (caught) { setError(caught instanceof Error ? caught.message : '搜索失败'); }
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
      }, `上下文${mode === 'pin' ? '固定' : '排除'}策略已更新`);
  };
  const createSelection = () => run('selection', async () => {
    const result = await mutateOfflineV2(`/api/v2/projects/${projectId}/context/selections`, { query, token_budget: tokenBudget, node_ids: selectedNodeId ? [selectedNodeId] : undefined }, 'POST', { command: 'context.selection.create', scope: offlineScope, aggregateKey: `project:${projectId}:context-selection`, expectedRevision: 0 });
    return !('queued' in result);
  }, '选择已封存');
  const createPack = () => latestSelection && run('pack', async () => {
    await cleanMutation(`/api/v2/projects/${projectId}/context/packs`, { selection_id: latestSelection.id, schema_version: 'aiws.context_pack.v5', require_authoritative: false }, 'POST', 0);
  }, 'Context Pack v5 已封存');
  const rebuild = () => run('rebuild', async () => { await cleanMutation(`/api/v2/projects/${projectId}/context/rebuild`, { mode: 'full', defer: true }, 'POST', 0); }, '投影已排队');
  const cancel = () => projection?.id && run('cancel', async () => { await cleanMutation(`/api/v2/projects/${projectId}/context/jobs/${projection.id}/cancel`, {}, 'POST', projection.revision); }, '投影已取消');
  const retry = () => projection?.id && run('retry', async () => { await cleanMutation(`/api/v2/projects/${projectId}/context/jobs/${projection.id}/retry`, {}, 'POST', projection.revision); }, '投影重试已排队');

  return <div className="page context-page">
    <div className="page-heading context-heading"><div><p className="eyebrow">投影后的工作区记忆</p><h1>上下文</h1></div><div className="context-heading-actions"><Status value={projection?.index?.status || 'unavailable'} /><button className="icon-button" aria-label="刷新上下文" title="刷新上下文" onClick={() => void load()}><RefreshCw size={17} /></button><button className="button primary" disabled={busy === 'rebuild'} onClick={() => void rebuild()}>{busy === 'rebuild' ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}重建投影</button></div></div>
    {error && <div className="context-alert" role="alert"><CircleAlert size={16} /><span>{error}</span><button className="icon-button" aria-label="关闭错误" title="关闭错误" onClick={() => setError('')}><X size={14} /></button></div>}
    <div className="context-mobile-tabs" role="tablist">{(['tree', 'document', 'packs'] as ViewTab[]).map((item) => <button role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} key={item} onClick={() => setTab(item)}>{item === 'tree' ? '目录' : item === 'document' ? '文档' : '上下文包'}</button>)}</div>
    <div className="context-grid">
      <section className={`panel context-tree-panel ${tab === 'tree' ? 'mobile-active' : ''}`}>
        <div className="context-toolbar"><div className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search(); }} placeholder="搜索上下文" /><button className="icon-button" aria-label="搜索上下文" title="搜索上下文" disabled={busy === 'search'} onClick={() => void search()}>{busy === 'search' ? <LoaderCircle className="spin" size={14} /> : <FileSearch size={14} />}</button></div>{searchIds && <button className="icon-button" title="清除搜索" aria-label="清除搜索" onClick={() => { setSearchIds(null); setQuery(''); }}><X size={15} /></button>}</div>
        <div className="context-node-list">{visibleNodes.map((node) => <button key={node.id} className={`${selectedNodeId === node.id ? 'selected ' : ''}${node.status === 'tombstone' ? 'tombstone' : ''}`} onClick={() => { setSelectedNodeId(node.id); setVersionId(''); setTab('document'); }}><span className="context-kind">{(node.kind || node.node_kind || 'node').slice(0, 2).toUpperCase()}</span><span><strong>{node.title}</strong><small>{node.source_type || node.node_kind || '上下文'} · r{node.revision}</small></span>{policy?.policy.pinned_node_ids?.includes(node.id) && <Pin size={13} />}{policy?.policy.excluded_node_ids?.includes(node.id) && <Ban size={13} />}</button>)}{!visibleNodes.length && <div className="list-empty">暂无投影节点</div>}</div>
      </section>
      <section className={`panel context-inspector ${tab === 'document' ? 'mobile-active' : ''}`}>
        {selectedNode ? <><div className="section-title"><div><h2>{selectedNode.title}</h2><span className="mono">{selectedNode.uri}</span></div><div className="row-tools"><button className={`icon-button ${policy?.policy.pinned_node_ids?.includes(selectedNode.id) ? 'active' : ''}`} title="固定节点" aria-label="固定节点" onClick={() => updatePolicy('pin')}><Pin size={15} /></button><button className={`icon-button ${policy?.policy.excluded_node_ids?.includes(selectedNode.id) ? 'active' : ''}`} title="排除节点" aria-label="排除节点" onClick={() => updatePolicy('exclude')}><Ban size={15} /></button></div></div>
          <div className="context-meta"><span><b>权威性</b>{statusLabel(selectedNode.authority || 'derived')}</span><span><b>新鲜度</b>{statusLabel(selectedNode.freshness?.status || 'unknown')}</span><span><b>哈希</b><code>{shortHash(selectedNode.source_hash)}</code></span><span><b>范围</b>{selectedNode.required_scopes?.join(', ') || 'context:read'}</span></div>
          <div className="context-versionbar"><History size={15} /><select aria-label="文档版本" value={versionId} onChange={(event) => setVersionId(event.target.value)}>{versions.map((item) => <option value={item.id} key={item.id}>v{item.version} · {shortHash(item.content_hash)} · {formatTime(item.created_at)}</option>)}</select><span>{selectedNode.document?.token_estimate || 0} 个令牌</span></div>
          <pre className="context-content">{selectedNode.document?.content || '暂无文档内容'}</pre>
        </> : <div className="empty-state"><BookOpen size={24} /><h2>请选择上下文节点</h2></div>}
      </section>
      <aside className={`context-side ${tab === 'packs' ? 'mobile-active' : ''}`}>
        <section className="panel context-projection-panel"><div className="section-title"><div><h2>投影</h2><span>{statusLabel(projection?.mode || 'full')} · 第 {projection?.attempt || 0} 次尝试</span></div><Status value={projection?.status || 'queued'} /></div><dl className="definition-list"><div><dt>节点</dt><dd>{contextMap?.nodes.length || 0}</dd></div><div><dt>文档</dt><dd>{projection?.index?.document_count || 0}</dd></div><div><dt>快照</dt><dd className="mono">{shortHash(projection?.index?.snapshot_hash || '')}</dd></div></dl><div className="context-job-actions">{['queued', 'running', 'indexing'].includes(projection?.status || '') && <button className="button" onClick={() => void cancel()}><Square size={14} />取消</button>}{['failed', 'cancelled'].includes(projection?.status || '') && <button className="button" onClick={() => void retry()}><RotateCcw size={14} />重试</button>}</div></section>
        <section className="panel context-selection-panel"><div className="section-title"><div><h2>选择内容</h2><span>策略 r{policy?.revision || 0}</span></div><span className="mono">{shortHash(latestSelection?.selection_hash || '')}</span></div><label><span>令牌预算</span><input type="number" min={256} max={128000} step={256} value={tokenBudget} onChange={(event) => setTokenBudget(Number(event.target.value))} /></label><button className="button" disabled={!selectedNodeId || busy === 'selection'} onClick={() => void createSelection()}>{busy === 'selection' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}创建选择</button>{latestSelection && <div className="selection-summary"><span>包含 {latestSelection.included.length}</span><span>排除 {latestSelection.excluded.length}</span><span>{latestSelection.token_used || 0} 个令牌</span></div>}</section>
        <section className="panel context-pack-panel"><div className="section-title"><div><h2>上下文包</h2><span>{packs.length} 个不可变包</span></div><Box size={17} /></div><button className="button primary" disabled={!latestSelection || !canSeal || busy === 'pack'} title={!canSeal ? '需要已确认的 Brief 与已应用的 Workflow' : '封存 Context Pack v5'} onClick={() => void createPack()}><Box size={15} />封存 Pack v5</button><div className="context-pack-list">{packs.map((pack) => <div key={pack.id}><span><strong className="mono">{shortHash(pack.pack_hash)}</strong><small>{formatTime(pack.created_at)}</small></span><span>{(pack.memory_manifest?.document_version_ids || pack.pack?.memory_manifest?.document_version_ids || []).length} 个文档</span></div>)}{!packs.length && <div className="list-empty">暂无上下文包</div>}</div></section>
      </aside>
    </div>
  </div>;
}
