import { CheckCircle2, CircleDot, FileDiff, Gauge, Globe2, ListTodo, Search, ShieldAlert, TerminalSquare, Wrench } from 'lucide-react';
import type { AssistV3Event } from '../../api/types';
import { useUi } from '../../state/ui';
import { AssistMarkdown } from './AssistMarkdown';

export function TypedEvent({ event }: { event: AssistV3Event }) {
  const showApproval = useUi((state) => state.showProposal);
  const data = event.data;
  if (event.type === 'text') return <article className="typed-event text-event"><AssistMarkdown>{visibleStreamingText(data.text)}</AssistMarkdown></article>;
  if (event.type === 'plan') return <EventCard icon={ListTodo} title={data.source === 'codex-native' ? 'Codex 原生计划' : '计划'} status={data.status}><AssistMarkdown>{text(data.text) || '计划已更新'}</AssistMarkdown></EventCard>;
  if (event.type === 'command') return <EventCard icon={TerminalSquare} title={text(data.command) || '命令'} status={data.status}><details><summary>命令输出{data.exit_code != null ? ` · exit ${data.exit_code}` : ''}</summary><pre>{text(data.output) || '暂无输出'}</pre></details></EventCard>;
  if (event.type === 'file_change') return <EventCard icon={FileDiff} title="文件变更" status={data.status}><ul>{array(data.changes).map((item, index) => <li key={index}>{text(item.kind) || 'changed'} · {text(item.path)}</li>)}</ul></EventCard>;
  if (event.type === 'diff') return <EventCard icon={FileDiff} title="累计 Diff" status={data.status}><details><summary>查看 diff</summary><pre>{text(data.diff)}</pre></details></EventCard>;
  if (event.type === 'test') return <EventCard icon={CheckCircle2} title={text(data.name) || '测试'} status={data.status}><p>{text(data.summary)}</p></EventCard>;
  if (event.type === 'mcp') return <EventCard icon={Wrench} title={`MCP · ${text(data.server)}`} status={data.status}><p>{text(data.tool)}</p></EventCard>;
  if (event.type === 'search') return <EventCard icon={Search} title="搜索" status={data.status}><p>{text(data.query)}</p></EventCard>;
  if (event.type === 'usage') return <EventCard icon={Gauge} title="用量"><div className="usage-row">{Object.entries(data).map(([key, value]) => <span key={key}><strong>{Number(value).toLocaleString()}</strong>{key.replaceAll('_', ' ')}</span>)}</div></EventCard>;
  if (event.type === 'approval') return <EventCard icon={ShieldAlert} title="需要 Runtime Approval" status={data.status}><p>{approvalSummary(data)}</p>{typeof data.approval_id === 'string' && <button className="button primary" onClick={() => showApproval(String(data.approval_id))}>立即审查</button>}</EventCard>;
  if (event.type === 'reasoning_summary') return <EventCard icon={CircleDot} title="Reasoning summary"><AssistMarkdown>{text(data.summary)}</AssistMarkdown></EventCard>;
  if (event.type === 'terminal') return <EventCard icon={TerminalSquare} title={`CLI · ${text(data.runtime) || 'terminal'}`} status={data.status}><p>{data.exit_code == null ? `Session ${text(data.terminal_session_id)}` : `exit ${text(data.exit_code)}`}</p></EventCard>;
  if (event.type === 'started') return <details className="typed-event low-value-event"><summary><CircleDot size={12} />Turn 已启动 · {profileSummary(data.profile)}</summary><p>{data.collaboration_mode === 'plan' ? 'Codex 原生 Plan · readOnly' : text(data.code_access)}</p></details>;
  if (event.type === 'queued') return <details className="typed-event low-value-event"><summary><CircleDot size={12} />已加入队列</summary><p>队列位置 {text(data.queue_position) || '—'}</p></details>;
  if (event.type === 'completed') return <EventCard icon={CheckCircle2} title="Turn 已完成" status="completed"><p>{completionSummary(data)}</p></EventCard>;
  if (event.type === 'interrupted' && data.follow_up_turn_id) return <EventCard icon={Globe2} title="Turn 已中断并接管"><p>Follow-up {text(data.follow_up_turn_id)}</p></EventCard>;
  if (['failed', 'stopped', 'interrupted'].includes(event.type)) return <EventCard icon={ShieldAlert} title={`Turn ${event.type}`} status="failed"><p>{failureMessage(data.error || data.reason)}</p></EventCard>;
  if (event.type === 'steered') return <EventCard icon={Globe2} title="Turn 已 Steer"><p>Follow-up {text(data.follow_up_turn_id)}</p></EventCard>;
  return <EventCard icon={CircleDot} title={event.type} status={data.status}><p>{text(data.status)}</p></EventCard>;
}

function EventCard({ icon: Icon, title, status, children }: { icon: typeof CircleDot; title: string; status?: unknown; children?: React.ReactNode }) {
  return <article className={`typed-event event-card ${String(status || '')}`}><header><Icon size={14} /><strong>{title}</strong>{status != null && <span>{String(status)}</span>}</header><div>{children}</div></article>;
}
function text(value: unknown) { return value == null ? '' : String(value); }
function visibleStreamingText(value: unknown) { return text(value); }
function array(value: unknown) { return Array.isArray(value) ? value as Array<Record<string, unknown>> : []; }
function profileSummary(value: unknown) { if (!value || typeof value !== 'object') return ''; const item = value as Record<string, unknown>; return [item.name, item.model, item.reasoning && `${item.reasoning} reasoning`].filter(Boolean).join(' · '); }
function approvalSummary(data: Record<string, unknown>) { return [data.approval_type, data.command, data.path, data.host, data.tool].filter(Boolean).map(String).join(' · ') || 'Codex 请求继续执行的权限。'; }
function completionSummary(data: Record<string, unknown>) { const actions = Number(data.page_action_count || 0); if (actions > 0) return `已生成 ${actions} 项页面变更，等待人工应用。`; return text(data.review_status) === 'ready' ? '代码变更已进入 Review。' : '没有待审查代码变更。'; }
function failureMessage(value: unknown) {
  const code = text(value);
  return ({
    assist_workspace_unavailable: 'Assist 工作目录不可用，请重新进入项目后重试。',
    codex_runtime_start_failed: 'Codex Runner 启动失败，请检查运行时状态后重试。',
    codex_turn_failed: 'Codex 请求执行失败，请重试并检查 Endpoint 状态。',
    codex_auth_failed: 'Codex 凭据不可用，请重新验证当前 Profile。',
    codex_timeout: 'Codex 请求超时，请重试或调整 Profile 超时时间。',
    codex_native_plan_unavailable: '当前 Codex Runner 不支持原生 Plan；请检查版本与 app-server 能力。',
    active_codex_profile_required: '没有可用的 Codex Profile。',
    codex_app_server_required: '当前 Codex 不提供 app-server；请更新 Codex 或修复 Profile。',
    assist_profile_affinity_conflict: '该线程已绑定另一个 Endpoint/凭据，请 Fork 后切换。'
  } as Record<string, string>)[code] || code || 'Assist Turn 执行失败。';
}
