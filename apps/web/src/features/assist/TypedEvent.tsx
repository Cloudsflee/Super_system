import { CheckCircle2, CircleDot, FileDiff, Search, ShieldAlert, TerminalSquare, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AssistV3Event } from '../../api/types';
import { useUi } from '../../state/ui';
import { AssistMarkdown } from './AssistMarkdown';

const runtimeEventTypes = new Set<AssistV3Event['type']>([
  'command',
  'file_change',
  'diff',
  'test',
  'mcp',
  'search',
  'reasoning_summary',
  'terminal'
]);
const directEventTypes = new Set<AssistV3Event['type']>(['approval', 'failed', 'stopped', 'interrupted']);

export function isRuntimeEvent(event: AssistV3Event) {
  return runtimeEventTypes.has(event.type);
}
export function isDirectEvent(event: AssistV3Event) {
  if (!directEventTypes.has(event.type)) return false;
  return !(event.type === 'interrupted' && event.data.follow_up_turn_id);
}

export function TypedEvent({ event, detail = false }: { event: AssistV3Event; detail?: boolean }) {
  const showApproval = useUi((state) => state.showProposal);
  const data = event.data;
  if (event.type === 'text' || event.type === 'plan') {
    const content = text(data.text).trim();
    return content ? (
      <article className="turn-output typed-event">
        <span className="sr-only">助手回复</span>
        <AssistMarkdown>{content}</AssistMarkdown>
      </article>
    ) : null;
  }
  if (event.type === 'command')
    return (
      <EventCard detail={detail} icon={TerminalSquare} title={text(data.command) || '命令'} status={data.status}>
        <details>
          <summary>命令输出{data.exit_code != null ? ` · 退出码 ${data.exit_code}` : ''}</summary>
          <pre>{text(data.output) || '暂无输出'}</pre>
        </details>
      </EventCard>
    );
  if (event.type === 'file_change')
    return (
      <EventCard detail={detail} icon={FileDiff} title="文件变更" status={data.status}>
        {array(data.changes).length ? (
          <ul>
            {array(data.changes).map((item, index) => (
              <li key={index}>
                {fileChangeLabel(text(item.kind))} · {text(item.path)}
              </li>
            ))}
          </ul>
        ) : (
          <pre>{text(data.patch) || '变更内容正在汇总'}</pre>
        )}
      </EventCard>
    );
  if (event.type === 'diff')
    return (
      <EventCard detail={detail} icon={FileDiff} title="累计差异" status={data.status}>
        <details>
          <summary>查看差异</summary>
          <pre>{text(data.diff)}</pre>
        </details>
      </EventCard>
    );
  if (event.type === 'test')
    return (
      <EventCard detail={detail} icon={CheckCircle2} title={text(data.name) || '测试'} status={data.status}>
        <p>{text(data.summary)}</p>
      </EventCard>
    );
  if (event.type === 'mcp')
    return (
      <EventCard
        detail={detail}
        icon={Wrench}
        title={text(data.server) ? `工具 · ${text(data.server)}` : '工具'}
        status={data.status}
      >
        <p>{text(data.tool)}</p>
      </EventCard>
    );
  if (event.type === 'search')
    return (
      <EventCard detail={detail} icon={Search} title="搜索" status={data.status}>
        <p>{text(data.query)}</p>
      </EventCard>
    );
  if (event.type === 'usage') return null;
  if (event.type === 'approval')
    return (
      <EventCard icon={ShieldAlert} title="需要确认" status={data.status}>
        <p>{approvalSummary(data)}</p>
        {typeof data.approval_id === 'string' && (
          <button className="button primary" onClick={() => showApproval(String(data.approval_id))}>
            立即审查
          </button>
        )}
      </EventCard>
    );
  if (event.type === 'reasoning_summary')
    return (
      <EventCard detail={detail} icon={CircleDot} title="思考摘要">
        <AssistMarkdown>{text(data.summary)}</AssistMarkdown>
      </EventCard>
    );
  if (event.type === 'terminal')
    return (
      <EventCard detail={detail} icon={TerminalSquare} title="终端" status={data.status}>
        <p>{data.exit_code == null ? '终端会话已启动' : `退出码 ${text(data.exit_code)}`}</p>
      </EventCard>
    );
  if (event.type === 'interrupted' && data.follow_up_turn_id) return null;
  if (['failed', 'stopped', 'interrupted'].includes(event.type))
    return (
      <EventCard icon={ShieldAlert} title={failureTitle(event.type)} status="failed">
        <p>{failureMessage(data.error || data.reason)}</p>
      </EventCard>
    );
  return null;
}

function EventCard({
  icon: Icon,
  title,
  status,
  detail = false,
  children
}: {
  icon: typeof CircleDot;
  title: string;
  status?: unknown;
  detail?: boolean;
  children?: ReactNode;
}) {
  const state = String(status || '').replace(/[^a-z0-9_-]/gi, '');
  return (
    <article className={`typed-event ${detail ? 'runtime-event-row' : 'event-card'} ${state}`}>
      <header>
        <Icon size={14} />
        <strong>{title}</strong>
      </header>
      <div>{children}</div>
    </article>
  );
}
function text(value: unknown) {
  return value == null ? '' : String(value);
}
function array(value: unknown) {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}
function fileChangeLabel(value: string) {
  return (
    (
      {
        changed: '已修改',
        modified: '已修改',
        added: '已新增',
        deleted: '已删除',
        renamed: '已重命名',
        untracked: '未跟踪'
      } as Record<string, string>
    )[value] || '已变更'
  );
}
function approvalSummary(data: Record<string, unknown>) {
  return (
    [approvalTypeLabel(text(data.approval_type)), data.command, data.path, data.host, data.tool]
      .filter(Boolean)
      .map(String)
      .join(' · ') || 'Codex 请求继续执行的权限。'
  );
}
function approvalTypeLabel(value: string) {
  return (
    (
      { command: '命令执行', runtime: '运行权限', network: '网络访问', file: '文件访问', tool: '工具调用' } as Record<
        string,
        string
      >
    )[value] || '运行权限'
  );
}
function failureTitle(type: AssistV3Event['type']) {
  return type === 'stopped' ? '已停止' : type === 'interrupted' ? '执行中断' : '执行失败';
}
function failureMessage(value: unknown) {
  const code = text(value);
  return (
    (
      {
        assist_workspace_unavailable: '智能助手工作目录不可用，请重新进入项目后重试。',
        codex_runtime_state_incompatible: 'Codex 运行时状态库不兼容，自动备份恢复未成功；请重新验证当前配置后重试。',
        codex_runtime_start_failed: 'Codex 执行器启动失败，请检查运行时状态后重试。',
        codex_turn_failed: 'Codex 请求执行失败，请重试并检查服务地址状态。',
        codex_auth_failed: 'Codex 凭据不可用，请重新验证当前配置。',
        codex_timeout: 'Codex 请求超时，请重试或调整配置的超时时间。',
        codex_native_plan_unavailable: '当前 Codex 执行器不支持原生规划模式；请检查版本与应用服务能力。',
        active_codex_profile_required: '没有可用的 Codex 配置。',
        codex_app_server_required: '当前 Codex 不提供应用服务；请更新 Codex 或修复配置。',
        assist_profile_affinity_conflict: '该线程已绑定另一个服务地址或凭据，请创建线程分支后切换。',
        runtime_approval_rejected: '执行权限未获批准，本次处理已停止。',
        service_restarted: '服务重启中断了本次处理，请重试。',
        turn_interrupted: '本次处理已中断。',
        user_stop: '本次处理已由你停止。'
      } as Record<string, string>
    )[code] || '智能助手执行未完成，请重试。'
  );
}
