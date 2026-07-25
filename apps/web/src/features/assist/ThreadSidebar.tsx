import { Archive, ArchiveRestore, GitFork, LockKeyhole, Pencil, Pin, PinOff, Plus, Search, Trash2, Undo2 } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { AssistV3Session } from '../../api/types';
import { useContextMenu, type ContextMenuAction } from '../../components/common/ContextMenu';
import { IconButton } from '../../components/common/IconButton';
import { assistScopeLabel, assistScopePath, sessionIsReadOnly } from './scope-display';

type Props = {
  sessions: AssistV3Session[]; selectedId?: string; search: string; archived: boolean; loading: boolean;
  onSearch: (value: string) => void; onArchived: (value: boolean) => void; onSelect: (id: string) => void;
  onCreate: () => void; onRename: (item: AssistV3Session) => void; onPin: (item: AssistV3Session) => void;
  onArchive: (item: AssistV3Session) => void; onFork: (item: AssistV3Session) => void;
  onDelete: (item: AssistV3Session) => void; onRestoreDeleted: (item: AssistV3Session) => void;
};

export function ThreadSidebar(props: Props) {
  const menu = useContextMenu(), tree = sessionTree(props.sessions);
  const actions = (item: AssistV3Session): ContextMenuAction[] => item.deleted_at ? [
    { id: `restore:${item.id}`, label: '撤销删除', icon: Undo2, onSelect: () => props.onRestoreDeleted(item) }
  ] : [
    { id: `open:${item.id}`, label: '打开', onSelect: () => props.onSelect(item.id) },
    { id: `rename:${item.id}`, label: '重命名', icon: Pencil, onSelect: () => props.onRename(item) },
    { id: `pin:${item.id}`, label: item.pinned ? '取消置顶' : '置顶', icon: item.pinned ? PinOff : Pin, onSelect: () => props.onPin(item) },
    { id: `fork:${item.id}`, label: '创建线程分支', icon: GitFork, onSelect: () => props.onFork(item) },
    { id: `archive:${item.id}`, label: props.archived ? '恢复归档' : '归档', icon: props.archived ? ArchiveRestore : Archive, onSelect: () => props.onArchive(item) },
    ...(item.forked_from_session_id ? [{ id: `delete:${item.id}`, label: '删除分支', icon: Trash2, danger: true, onSelect: () => props.onDelete(item) }] : [])
  ];
  const row = (node: TreeNode): React.ReactNode => {
    const item = node.item, style = { '--thread-depth': node.depth } as CSSProperties;
    const scopePath = assistScopePath(item.scope_breadcrumb || []), readOnly = sessionIsReadOnly(item);
    return <div className="thread-tree-node" key={item.id}>{item.deleted_at
      ? <div className="thread-tombstone" style={style}><span>已删除分支</span><button onClick={() => props.onRestoreDeleted(item)}>撤销</button></div>
      : <article className={`${item.id === props.selectedId ? 'active' : ''}${readOnly ? ' read-only' : ''}`} style={style} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); menu.open(actions(item), { x: event.clientX, y: event.clientY }, event.currentTarget); }}>
        <button className="thread-main" onClick={() => props.onSelect(item.id)} onDoubleClick={() => props.onRename(item)}>
          <span><strong>{item.title}</strong>{item.pinned && <Pin size={11} />}{readOnly && <LockKeyhole size={11} aria-label="只读" />}</span>
          <small className="thread-scope" data-tooltip={scopePath}><b>{item.scope_label || assistScopeLabel(item.scope_type)}</b><span>{scopePath || item.scope_id}</span></small>
          <small>{item.turn_count ? `${item.turn_count} 轮` : '尚无对话'}{readOnly ? ' · 只读' : ''}</small>
        </button>
      </article>}{node.children.map(row)}</div>;
  };
  return <aside className="assist-threads">
    <header><strong>线程</strong><IconButton label="新建线程" onClick={props.onCreate}><Plus size={16} /></IconButton></header>
    <label className="assist-search"><Search size={14} /><input aria-label="搜索智能助手线程" value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="搜索线程和消息" /></label>
    <div className="thread-filter"><button className={!props.archived ? 'active' : ''} onClick={() => props.onArchived(false)}>进行中</button><button className={props.archived ? 'active' : ''} onClick={() => props.onArchived(true)}>已归档</button></div>
    <div className="thread-list">{tree.map(row)}{!tree.length && <div className="thread-empty">{props.loading ? '正在加载线程' : props.archived ? '没有已归档线程' : '创建第一个智能助手线程'}</div>}</div>
  </aside>;
}

type TreeNode = { item: AssistV3Session; depth: number; children: TreeNode[] };
export function sessionTree(items: AssistV3Session[]) {
  const byId = new Map(items.map((item) => [item.id, item])), children = new Map<string, AssistV3Session[]>();
  for (const item of items) { const parent = item.forked_from_session_id && byId.has(item.forked_from_session_id) ? item.forked_from_session_id : ''; children.set(parent, [...(children.get(parent) || []), item]); }
  const sort = (rows: AssistV3Session[]) => [...rows].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || String(b.updated_at).localeCompare(String(a.updated_at)));
  const build = (parent: string, depth: number): TreeNode[] => sort(children.get(parent) || []).map((item) => ({ item, depth, children: build(item.id, depth + 1) }));
  return build('', 0);
}
