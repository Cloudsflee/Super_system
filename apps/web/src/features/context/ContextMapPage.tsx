import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  Braces,
  Check,
  Clipboard,
  Download,
  FileText,
  History,
  ListTree,
  Map as MapIcon,
  Network,
  Pin,
  RefreshCw,
  Search,
  X
} from 'lucide-react';
import { useMemo } from 'react';
import { api, describeOperation, json } from '../../api/client';
import type { ContextMapResponse, ContextNodeRecord, ContextNodeResponse, ContextPolicyRecord } from '../../api/types';
import { FullPageState } from '../../components/common/FullPageState';
import { IconButton } from '../../components/common/IconButton';
import { useUi } from '../../state/ui';
import {
  useContextMapController,
  type ContextDocumentTab as DocumentTab,
  type ContextMobilePane as MobilePane
} from './ContextMapController';
import { ContextWorkerStatus } from './ContextWorkerStatus';

export function ContextMapPage() {
  const controller = useContextMapController(),
    { mapQuery, nodeQuery } = controller;
  if (mapQuery.isLoading) return <FullPageState title="正在构建上下文地图" />;
  if (mapQuery.isError || !mapQuery.data)
    return <FullPageState title="上下文地图加载失败" detail={mapQuery.error?.message} retry={mapQuery.refetch} />;

  return (
    <section className="context-map-page">
      <ContextMapToolbar {...controller} map={mapQuery.data} />
      <ContextMobileTabs pane={controller.mobilePane} onPane={controller.setMobilePane} />
      <div className={`context-map-layout mobile-${controller.mobilePane}`}>
        <ContextDirectory
          map={mapQuery.data}
          nodes={controller.nodes}
          selectedId={controller.selectedId}
          searchActive={Boolean(controller.searchResult)}
          onSelect={controller.selectNode}
        />
        <ContextDocument
          value={nodeQuery.data}
          loading={nodeQuery.isLoading}
          error={nodeQuery.error}
          tab={controller.tab}
          setTab={controller.setTab}
          setVersionId={controller.setVersionId}
        />
        <ContextDetails
          map={mapQuery.data}
          value={nodeQuery.data}
          selectedId={controller.selectedId}
          onSelect={controller.selectNode}
        />
      </div>
    </section>
  );
}

function ContextMapToolbar({
  projectId,
  searchInput,
  setSearchInput,
  searchResult,
  submitSearch,
  clearSearch,
  mapQuery,
  map
}: ReturnType<typeof useContextMapController> & { map: ContextMapResponse }) {
  return (
    <header className="context-map-toolbar">
      <div className="context-map-title">
        <MapIcon size={18} />
        <div>
          <h1>上下文地图</h1>
          <span>
            {projectId ? '当前项目' : '全局'} · {map.nodes.length} 个节点
          </span>
        </div>
      </div>
      <form className="context-search" role="search" onSubmit={submitSearch}>
        <Search size={15} />
        <input
          aria-label="检索上下文"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="检索标题、事实或关系"
        />
        {searchResult && (
          <IconButton label="清除检索" onClick={clearSearch}>
            <X size={15} />
          </IconButton>
        )}
      </form>
      <ContextWorkerStatus />
      <IconButton label="刷新上下文地图" onClick={() => mapQuery.refetch()}>
        <RefreshCw size={16} />
      </IconButton>
    </header>
  );
}

function ContextMobileTabs({ pane, onPane }: { pane: MobilePane; onPane: (pane: MobilePane) => void }) {
  return (
    <nav className="context-mobile-tabs" aria-label="上下文地图区域">
      <PaneButton active={pane === 'map'} onClick={() => onPane('map')} icon={ListTree} label="目录" />
      <PaneButton active={pane === 'document'} onClick={() => onPane('document')} icon={FileText} label="正文" />
      <PaneButton active={pane === 'details'} onClick={() => onPane('details')} icon={Network} label="关系" />
    </nav>
  );
}

function ContextDirectory({
  map,
  nodes,
  selectedId,
  searchActive,
  onSelect
}: {
  map: ContextMapResponse;
  nodes: ContextNodeRecord[];
  selectedId: string | null;
  searchActive: boolean;
  onSelect: (id: string) => void;
}) {
  const byId = useMemo(() => new Map(map.nodes.map((node) => [node.id, node])), [map.nodes]);
  return (
    <aside className="context-directory" aria-label="有序上下文目录">
      <header>
        <strong>{searchActive ? '检索结果' : '有序目录'}</strong>
        <span>{nodes.length}</span>
      </header>
      <div className="context-directory-list">
        {nodes.map((node) => (
          <button
            key={node.id}
            className={node.id === selectedId ? 'active' : ''}
            onClick={() => onSelect(node.id)}
            style={{ paddingLeft: `${10 + Math.min(searchActive ? 0 : nodeDepth(node, byId), 5) * 15}px` }}
          >
            <NodeKindIcon kind={node.kind} />
            <span>
              <strong>{node.title}</strong>
              <small>
                {nodeKindLabel(node.kind)} · {freshnessLabel(node.freshness.status)}
              </small>
            </span>
          </button>
        ))}
      </div>
      {map.coverage && (
        <footer>
          {map.coverage.projected_records}/{map.coverage.source_records} 条源记录已投影
        </footer>
      )}
    </aside>
  );
}

function ContextDocument({
  value,
  loading,
  error,
  tab,
  setTab,
  setVersionId
}: {
  value?: ContextNodeResponse;
  loading: boolean;
  error: Error | null;
  tab: DocumentTab;
  setTab: (tab: DocumentTab) => void;
  setVersionId: (id: string | null) => void;
}) {
  const toast = useUi((state) => state.toast);
  if (loading)
    return (
      <main className="context-document">
        <div className="quiet-empty">正在读取规范正文</div>
      </main>
    );
  if (error || !value)
    return (
      <main className="context-document">
        <div className="quiet-empty">{error?.message || '请选择一个上下文节点'}</div>
      </main>
    );
  const contextDocument = value;
  const tabs: Array<{ id: DocumentTab; label: string; icon: typeof FileText }> = [
    { id: 'summary', label: '摘要', icon: FileText },
    { id: 'source', label: '原文', icon: Clipboard },
    { id: 'structure', label: '结构', icon: Braces },
    { id: 'relations', label: '关系', icon: Network },
    { id: 'history', label: '历史', icon: History }
  ];

  async function copyMarkdown() {
    await navigator.clipboard.writeText(contextDocument.markdown);
    toast('已复制规范 Markdown');
  }

  function downloadMarkdown() {
    const url = URL.createObjectURL(new Blob([contextDocument.markdown], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFilename(contextDocument.node.title)}-${contextDocument.version.version}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="context-document">
      <header className="context-document-heading">
        <div>
          <span>{value.node.uri}</span>
          <h2>{value.node.title}</h2>
          <p>
            {value.node.source_collection || '系统目录'} · v{value.version.version}
          </p>
        </div>
        <div>
          <IconButton label="复制 Markdown" onClick={copyMarkdown}>
            <Clipboard size={16} />
          </IconButton>
          <IconButton label="导出 Markdown" onClick={downloadMarkdown}>
            <Download size={16} />
          </IconButton>
        </div>
      </header>
      <nav className="context-document-tabs" aria-label="正文视图">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            <Icon size={14} />
            {label}
          </button>
        ))}
      </nav>
      <div className="context-document-body">
        {tab === 'summary' && <SummaryView value={value} />}
        {tab === 'source' && <pre className="context-markdown-source">{value.markdown}</pre>}
        {tab === 'structure' && <pre>{JSON.stringify(value.facts, null, 2)}</pre>}
        {tab === 'relations' && <RelationList value={value} />}
        {tab === 'history' && (
          <div className="context-history">
            {value.history.map((version) => (
              <button key={version.id} onClick={() => setVersionId(version.id)}>
                <span className={version.id === value.version.id ? 'status active' : 'status'}>v{version.version}</span>
                <strong>{new Date(version.created_at).toLocaleString()}</strong>
                <code>{shortHash(version.content_sha256)}</code>
                {version.id === value.node.current_version_id && <Check size={15} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function SummaryView({ value }: { value: ContextNodeResponse }) {
  return (
    <div className="context-summary-view">
      <section>
        <span>确定性摘要</span>
        <p>{value.node.summary}</p>
      </section>
      <dl>
        <div>
          <dt>权威级</dt>
          <dd>{authorityLabel(value.node.authority)}</dd>
        </div>
        <div>
          <dt>新鲜度</dt>
          <dd>{freshnessLabel(value.node.freshness.status)}</dd>
        </div>
        <div>
          <dt>敏感级</dt>
          <dd>{sensitivityLabel(value.node.sensitivity)}</dd>
        </div>
        <div>
          <dt>令牌</dt>
          <dd>{value.version.token_estimate}</dd>
        </div>
        <div>
          <dt>源版本</dt>
          <dd>{value.node.source_version}</dd>
        </div>
        <div>
          <dt>正文哈希</dt>
          <dd>
            <code>{shortHash(value.version.content_sha256)}</code>
          </dd>
        </div>
      </dl>
      <section>
        <span>脱敏清单</span>
        {value.version.redactions.length ? (
          <ul>
            {value.version.redactions.map((item) => (
              <li key={`${item.path}-${item.reason}`}>
                <code>{item.path}</code> · {item.reason}
              </li>
            ))}
          </ul>
        ) : (
          <p>当前版本没有字段脱敏。</p>
        )}
      </section>
    </div>
  );
}

function RelationList({ value }: { value: ContextNodeResponse }) {
  const related = new Map(value.related_nodes.map((node) => [node.id, node]));
  return (
    <div className="context-relation-list">
      {value.edges.length ? (
        value.edges.map((edge) => {
          const outbound = edge.source_node_id === value.node.id;
          const other = related.get(outbound ? edge.target_node_id : edge.source_node_id);
          return (
            <div key={edge.id}>
              <span>{edgeTypeLabel(edge.type)}</span>
              <strong>
                {outbound ? '指向' : '来自'} {other?.title || '未知节点'}
              </strong>
              <code>{other?.uri}</code>
            </div>
          );
        })
      ) : (
        <div className="quiet-empty">没有已记录关系</div>
      )}
    </div>
  );
}

function ContextDetails({
  map,
  value,
  selectedId,
  onSelect
}: {
  map: ContextMapResponse;
  value?: ContextNodeResponse;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);
  const policyMutation = useMutation({
    mutationFn: (policy: ContextPolicyRecord) =>
      api<ContextPolicyRecord>(
        '/context/v1/policy',
        json(
          'PUT',
          { ...policy, project_id: map.project_id },
          describeOperation('更新上下文取用策略', { safeRetry: true })
        )
      ),
    onSuccess: () => {
      toast('上下文策略已更新');
      queryClient.invalidateQueries({ queryKey: ['context-map', map.project_id || 'global'] });
    }
  });
  const policy = map.policy;
  const pinned = Boolean(selectedId && policy.pinned_node_ids.includes(selectedId));
  const excluded = Boolean(selectedId && policy.excluded_node_ids.includes(selectedId));
  const mapNodeIds = new Set(map.nodes.map((node) => node.id));
  const relations = (value?.related_nodes || []).filter((node) => mapNodeIds.has(node.id));

  function updatePolicy(mode: 'pin' | 'exclude') {
    if (!selectedId) return;
    const pinSet = new Set(policy.pinned_node_ids),
      excludeSet = new Set(policy.excluded_node_ids);
    if (mode === 'pin') {
      if (pinSet.has(selectedId)) pinSet.delete(selectedId);
      else {
        pinSet.add(selectedId);
        excludeSet.delete(selectedId);
      }
    } else if (excludeSet.has(selectedId)) excludeSet.delete(selectedId);
    else {
      excludeSet.add(selectedId);
      pinSet.delete(selectedId);
    }
    policyMutation.mutate({ ...policy, pinned_node_ids: [...pinSet], excluded_node_ids: [...excludeSet] });
  }

  return (
    <aside className="context-details" aria-label="关系与来源">
      <section className="context-policy-actions">
        <header>
          <strong>取用策略</strong>
          <span>修订 {policy.revision}</span>
        </header>
        <div>
          <button
            className={pinned ? 'active' : ''}
            disabled={!selectedId || policyMutation.isPending}
            onClick={() => updatePolicy('pin')}
          >
            <Pin size={15} />
            {pinned ? '取消固定' : '固定节点'}
          </button>
          <button
            className={excluded ? 'active danger' : ''}
            disabled={!selectedId || policyMutation.isPending}
            onClick={() => updatePolicy('exclude')}
          >
            <Ban size={15} />
            {excluded ? '取消排除' : '排除节点'}
          </button>
        </div>
      </section>
      <section>
        <header>
          <strong>关系</strong>
          <span>{relations.length}</span>
        </header>
        <div className="context-related-nodes">
          {relations.map((node) => (
            <button key={node.id} onClick={() => onSelect(node.id)}>
              <NodeKindIcon kind={node.kind} />
              <span>
                <strong>{node.title}</strong>
                <small>{nodeKindLabel(node.kind)}</small>
              </span>
            </button>
          ))}
          {!relations.length && <p className="context-muted">当前节点没有外部关系。</p>}
        </div>
      </section>
      <section className="context-source-meta">
        <header>
          <strong>来源与版本</strong>
        </header>
        <dl>
          <div>
            <dt>集合</dt>
            <dd>{value?.node.source_collection || 'system_context'}</dd>
          </div>
          <div>
            <dt>源 ID</dt>
            <dd>
              <code>{value?.node.source_id || value?.node.id}</code>
            </dd>
          </div>
          <div>
            <dt>文档版本</dt>
            <dd>{value?.version.version || '-'}</dd>
          </div>
          <div>
            <dt>更新时间</dt>
            <dd>{formatTime(value?.node.freshness.source_updated_at)}</dd>
          </div>
        </dl>
      </section>
      <SelectionAudit map={map} />
    </aside>
  );
}

function SelectionAudit({ map }: { map: ContextMapResponse }) {
  const selection = map.latest_selection;
  const nodes = new Map(map.nodes.map((node) => [node.id, node]));
  return (
    <section className="context-selection-audit">
      <header>
        <strong>本轮取用</strong>
        {selection && (
          <span>
            {selection.token_used}/{selection.token_budget} 令牌
          </span>
        )}
      </header>
      {!selection ? (
        <p className="context-muted">当前范围还没有选择记录。</p>
      ) : (
        <>
          <div className="context-token-meter">
            <i
              style={{
                width: `${Math.min(100, selection.token_budget ? (selection.token_used / selection.token_budget) * 100 : 0)}%`
              }}
            />
          </div>
          <h3>纳入 {selection.included.length}</h3>
          {selection.included.slice(0, 20).map((item) => (
            <div className="context-selection-row included" key={item.node_id}>
              <Check size={13} />
              <span>
                <strong>{nodes.get(item.node_id)?.title || shortHash(item.node_id)}</strong>
                <small>
                  版本 {shortHash(item.document_version_id)} · {inclusionLabel(item.reason)}
                </small>
              </span>
              <em>{item.token_estimate}</em>
            </div>
          ))}
          <h3>排除 {selection.excluded.length}</h3>
          {selection.excluded.slice(0, 20).map((item) => (
            <div className="context-selection-row" key={`${item.node_id}-${item.reason}`}>
              <X size={13} />
              <span>
                <strong>{nodes.get(item.node_id)?.title || shortHash(item.node_id)}</strong>
                <small>
                  版本 {shortHash(item.document_version_id)} · {exclusionLabel(item.reason)}
                </small>
              </span>
              <em>{item.token_estimate}</em>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function PaneButton({
  active,
  onClick,
  icon: Icon,
  label
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof MapIcon;
  label: string;
}) {
  return (
    <button className={active ? 'active' : ''} onClick={onClick}>
      <Icon size={15} />
      {label}
    </button>
  );
}

function NodeKindIcon({ kind }: { kind: string }) {
  const Icon = ['system', 'project', 'workflow', 'outcome', 'task'].includes(kind) ? ListTree : FileText;
  return <Icon size={15} aria-hidden />;
}

function nodeDepth(node: ContextNodeRecord, byId: Map<string, ContextNodeRecord>) {
  let depth = 0,
    current = node,
    guard = 0;
  while (current.parent_id && guard++ < 12) {
    depth += 1;
    const parent = byId.get(current.parent_id);
    if (!parent) break;
    current = parent;
  }
  return Math.max(0, depth - 1);
}

function shortHash(value?: string | null) {
  return value ? value.slice(0, 12) : '-';
}

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '-';
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'context';
}

function exclusionLabel(value: string) {
  return (
    (
      {
        permission_denied: '权限不足',
        cross_scope: '跨作用域',
        sensitive: '敏感',
        stale: '过期',
        budget_exceeded: '预算不足',
        user_excluded: '用户排除'
      } as Record<string, string>
    )[value] || value
  );
}

function inclusionLabel(value: string) {
  return enumLabel(value, {
    user_pinned: '用户固定',
    explicit_reference: '显式引用',
    current_anchor: '当前锚点',
    ranked_candidate: '排序候选'
  });
}

function nodeKindLabel(value: string) {
  return enumLabel(value, {
    system: '系统',
    project: '项目',
    workflow: '工作流',
    outcome: '成果',
    task: '任务',
    contracts: '契约',
    dependencies: '依赖',
    executions: '执行',
    assets: '资产',
    conversations: '对话',
    audit: '审计',
    uncategorized: '未分类',
    record: '记录',
    tombstone: '已删除'
  });
}

function freshnessLabel(value: string) {
  return enumLabel(value, {
    current: '当前',
    stale: '过期',
    superseded: '已替代',
    unavailable: '不可用'
  });
}

function authorityLabel(value: string) {
  return enumLabel(value, {
    authoritative: '权威',
    non_authoritative: '非权威',
    observed: '观测',
    draft: '草稿'
  });
}

function sensitivityLabel(value: string) {
  return enumLabel(value, {
    public: '公开',
    internal: '内部',
    restricted: '受限',
    secret: '密钥'
  });
}

function edgeTypeLabel(value: string) {
  return enumLabel(value, {
    contains: '包含',
    depends_on: '依赖于',
    produces: '产出',
    consumes: '使用',
    derived_from: '派生自',
    executes: '执行',
    discussed_in: '讨论于',
    evidenced_by: '证据来自',
    supersedes: '替代'
  });
}

function enumLabel(value: string, labels: Record<string, string>) {
  return labels[value] || value;
}
