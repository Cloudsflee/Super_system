import { CircleDot, Filter, GitPullRequest } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { ChangeProposal, TraceRecord } from '../../api/types';
import { FullPageState } from '../../components/common/FullPageState';
import { useUi } from '../../state/ui';
import { useAssistSurface } from '../../components/assist/semantic-actions';
import {
  changeTypeLabel,
  displayStatus,
  scopeTypeLabel,
  traceEventLabel
} from '../../components/common/display-labels';

type Review = {
  traces: TraceRecord[];
  change_proposals: ChangeProposal[];
  agent_sessions: Array<{ id: string; title: string; scope_type: string; parent_session_id?: string }>;
  submissions: Array<{
    id: string;
    title: string;
    from_session_id?: string | null;
    to_session_id?: string | null;
    status: string;
  }>;
};
export function AuditPage() {
  const [kind, setKind] = useState('all');
  useAssistSurface({
    id: 'audit-page',
    filters: {
      'audit.event_type': {
        label: '审计事件类型',
        elementId: 'audit-event-filter',
        values: ['all', 'file', 'runner', 'change_proposal', 'assist', 'git'],
        set: (value) => setKind(String(value || 'all'))
      }
    }
  });
  const query = useQuery({ queryKey: ['review'], queryFn: () => api<Review>('/review') });
  const showProposal = useUi((state) => state.showProposal);
  if (query.isLoading) return <FullPageState title="正在加载审计记录" />;
  if (query.isError || !query.data)
    return <FullPageState title="审计记录加载失败" detail={query.error?.message} retry={query.refetch} />;
  const traces =
    kind === 'all' ? query.data.traces : query.data.traces.filter((trace) => trace.event_type.startsWith(kind));
  return (
    <section className="data-page audit-page">
      <header className="page-heading">
        <div>
          <span className="overline">追踪与审批</span>
          <h1>审计</h1>
          <p>{query.data.traces.length} 条不可变事件</p>
        </div>
        <label className="compact-filter">
          <Filter size={14} />
          <select id="audit-event-filter" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">全部事件</option>
            <option value="file">文件</option>
            <option value="runner">运行</option>
            <option value="change_proposal">审批</option>
            <option value="assist">智能助手</option>
            <option value="git">Git</option>
          </select>
        </label>
      </header>
      <div className="audit-layout">
        <section>
          <h2>
            <CircleDot size={17} />
            事件追踪
          </h2>
          <div className="audit-traces">
            {traces
              .slice()
              .reverse()
              .map((trace) => (
                <article key={trace.id}>
                  <i />
                  <div>
                    <strong>{traceEventLabel(trace.event_type)}</strong>
                    <p>{trace.summary}</p>
                    <time>{new Date(trace.created_at || trace.occurred_at || 0).toLocaleString()}</time>
                  </div>
                </article>
              ))}
          </div>
        </section>
        <aside>
          <h2>
            <GitPullRequest size={17} />
            变更提案
          </h2>
          {query.data.change_proposals
            .slice()
            .reverse()
            .map((item) => (
              <button key={item.id} onClick={() => showProposal(item.id)}>
                <span className={`status ${item.status}`}>{displayStatus(item.status)}</span>
                <strong>{item.title}</strong>
                <small>{changeTypeLabel(item.change_type)}</small>
              </button>
            ))}
          <div className="hierarchy-audit">
            <h2>层级会话</h2>
            {query.data.agent_sessions
              .slice()
              .reverse()
              .map((item) => (
                <article key={item.id}>
                  <strong>{item.title}</strong>
                  <small>
                    {scopeTypeLabel(item.scope_type)}
                    {item.parent_session_id ? ` · 上级 ${shortId(item.parent_session_id, 10)}` : ' · 顶层'}
                  </small>
                </article>
              ))}
            <h2>提交记录</h2>
            {query.data.submissions
              .slice()
              .reverse()
              .map((item) => (
                <article key={item.id}>
                  <strong>{item.title}</strong>
                  <small>
                    {displayStatus(item.status)} · {shortId(item.from_session_id)} → {shortId(item.to_session_id)}
                  </small>
                </article>
              ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

function shortId(value?: string | null, length = 8) {
  return value ? value.slice(0, length) : '未知';
}
