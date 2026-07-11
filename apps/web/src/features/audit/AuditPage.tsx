import { CircleDot, Filter, GitPullRequest } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { ChangeProposal, TraceRecord } from '../../api/types';
import { FullPageState } from '../../components/common/FullPageState';
import { useUi } from '../../state/ui';
import { useAssistSurface } from '../../components/assist/semantic-actions';

type Review = {
  traces: TraceRecord[]; change_proposals: ChangeProposal[];
  agent_sessions: Array<{ id: string; title: string; scope_type: string; parent_session_id?: string }>;
  submissions: Array<{ id: string; title: string; from_session_id: string; to_session_id: string; status: string }>;
};
export function AuditPage() {
  const [kind, setKind] = useState('all');
  useAssistSurface({ id: 'audit-page', filters: { 'audit.event_type': { label: 'Trace 事件类型', elementId: 'audit-event-filter', values: ['all', 'file', 'runner', 'change_proposal', 'assist', 'git'], set: (value) => setKind(String(value || 'all')) } } });
  const query = useQuery({ queryKey: ['review'], queryFn: () => api<Review>('/review') });
  const showProposal = useUi((state) => state.showProposal);
  if (query.isLoading) return <FullPageState title="正在加载审计记录" />;
  if (query.isError || !query.data) return <FullPageState title="审计记录加载失败" detail={query.error?.message} retry={query.refetch} />;
  const traces = kind === 'all' ? query.data.traces : query.data.traces.filter((trace) => trace.event_type.startsWith(kind));
  return (
    <section className="data-page audit-page"><header className="page-heading"><div><span className="overline">TRACE & APPROVAL</span><h1>审计</h1><p>{query.data.traces.length} 条不可变事件</p></div><label className="compact-filter"><Filter size={14} /><select id="audit-event-filter" value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">全部事件</option><option value="file">文件</option><option value="runner">运行</option><option value="change_proposal">审批</option><option value="assist">Assist</option><option value="git">Git</option></select></label></header>
      <div className="audit-layout"><section><h2><CircleDot size={17} />Trace</h2><div className="audit-traces">{traces.slice().reverse().map((trace) => <article key={trace.id}><i /><div><strong>{trace.event_type}</strong><p>{trace.summary}</p><time>{new Date(trace.created_at || trace.occurred_at || 0).toLocaleString()}</time></div></article>)}</div></section><aside><h2><GitPullRequest size={17} />变更提案</h2>{query.data.change_proposals.slice().reverse().map((item) => <button key={item.id} onClick={() => showProposal(item.id)}><span className={`status ${item.status}`}>{item.status}</span><strong>{item.title}</strong><small>{item.change_type}</small></button>)}<div className="hierarchy-audit"><h2>层级会话</h2>{query.data.agent_sessions.slice().reverse().map((item) => <article key={item.id}><strong>{item.title}</strong><small>{item.scope_type}{item.parent_session_id ? ` · parent ${item.parent_session_id.slice(0, 10)}` : ' · top'}</small></article>)}<h2>Submissions</h2>{query.data.submissions.slice().reverse().map((item) => <article key={item.id}><strong>{item.title}</strong><small>{item.status} · {item.from_session_id.slice(0, 8)} → {item.to_session_id?.slice(0, 8)}</small></article>)}</div></aside></div>
    </section>
  );
}
