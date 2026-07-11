import { Archive, ArchiveRestore, GitFork, Pencil, Pin, PinOff, Plus, Search } from 'lucide-react';
import type { AssistV3Session } from '../../api/types';

type Props = {
  sessions: AssistV3Session[]; selectedId?: string; search: string; archived: boolean; loading: boolean;
  onSearch: (value: string) => void; onArchived: (value: boolean) => void; onSelect: (id: string) => void;
  onCreate: () => void; onRename: (item: AssistV3Session) => void; onPin: (item: AssistV3Session) => void;
  onArchive: (item: AssistV3Session) => void; onFork: (item: AssistV3Session) => void;
};

export function ThreadSidebar(props: Props) {
  return <aside className="assist-threads">
    <header><strong>线程</strong><button className="row-icon" aria-label="新建线程" onClick={props.onCreate}><Plus size={16} /></button></header>
    <label className="assist-search"><Search size={14} /><input aria-label="搜索 Assist 线程" value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="搜索线程和消息" /></label>
    <div className="thread-filter"><button className={!props.archived ? 'active' : ''} onClick={() => props.onArchived(false)}>进行中</button><button className={props.archived ? 'active' : ''} onClick={() => props.onArchived(true)}>已归档</button></div>
    <div className="thread-list">
      {props.sessions.map((item) => <article className={item.id === props.selectedId ? 'active' : ''} key={item.id}>
        <button className="thread-main" onClick={() => props.onSelect(item.id)} onDoubleClick={() => props.onRename(item)}><span><strong>{item.title}</strong>{item.pinned && <Pin size={11} />}</span><small>{item.last_turn ? `${modeName(item.last_turn.mode)} · ${item.last_turn.status}` : '尚无 Turn'} · {item.turn_count || 0}</small></button>
        <div className="thread-actions">
          {!props.archived && <button aria-label={item.pinned ? '取消置顶' : '置顶'} onClick={() => props.onPin(item)}>{item.pinned ? <PinOff size={12} /> : <Pin size={12} />}</button>}
          {!props.archived && <button aria-label="重命名线程" onClick={() => props.onRename(item)}><Pencil size={12} /></button>}
          {!props.archived && <button aria-label="Fork 线程" onClick={() => props.onFork(item)}><GitFork size={12} /></button>}
          <button aria-label={props.archived ? '恢复线程' : '归档线程'} onClick={() => props.onArchive(item)}>{props.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}</button>
        </div>
      </article>)}
      {!props.sessions.length && <div className="thread-empty">{props.loading ? '正在加载线程' : props.archived ? '没有已归档线程' : '创建第一个 Assist 线程'}</div>}
    </div>
  </aside>;
}

function modeName(value: string) { return ({ ask: 'Ask', plan: 'Plan', agent: 'Agent' } as Record<string, string>)[value] || value; }
