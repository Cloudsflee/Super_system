import { Layers3, LockKeyhole, Send, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { api, apiUrl, json } from '../../api/client';
import type { AssistScopeBreadcrumbItem, AssistScopeType } from '../../api/types';
import { IconButton } from '../../components/common/IconButton';
import {
  subscribeSelectionAsk,
  type SelectionAskDetail,
  type SelectionAskScope
} from '../../components/common/selection-ask';
import { assistScopeLabel } from './scope-display';

type Anchor = { left: number; top: number; bottom: number; width: number };
type OpenDetail = SelectionAskDetail;
type BtwSession = { id: string; access_token: string; browser_id: string };
type BtwEvent = { sequence: number; turn_id: string | null; type: string; data: Record<string, unknown> };
type BtwPopoverProps = {
  projectId?: string;
  scopeType?: AssistScopeType;
  scopeId?: string;
  scopeBreadcrumb?: AssistScopeBreadcrumbItem[];
  sessionId?: string;
  profileId?: string;
};

export function BtwPopover({ projectId, scopeType, scopeId, scopeBreadcrumb, sessionId, profileId }: BtwPopoverProps) {
  const [detail, setDetail] = useState<OpenDetail | null>(null),
    [question, setQuestion] = useState(''),
    [session, setSession] = useState<BtwSession | null>(null);
  const [events, setEvents] = useState<BtwEvent[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const stream = useRef<EventSource | null>(null),
    input = useRef<HTMLInputElement>(null),
    popover = useRef<HTMLElement>(null),
    sessionRef = useRef<BtwSession | null>(null);
  useEffect(
    () =>
      subscribeSelectionAsk((value) => {
        const current = sessionRef.current;
        stream.current?.close();
        stream.current = null;
        sessionRef.current = null;
        if (current) void destroyBtw(current);
        setSession(null);
        setDetail(value);
        setQuestion('');
        setError('');
        setEvents([]);
      }),
    []
  );
  useEffect(
    () => () => {
      const current = sessionRef.current;
      stream.current?.close();
      if (current) void destroyBtw(current);
    },
    []
  );
  useEffect(() => {
    if (!detail) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [
      ...(popover.current?.querySelectorAll<HTMLElement>(
        'input,button:not(:disabled),[tabindex]:not([tabindex="-1"])'
      ) || [])
    ];
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void close();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0],
        last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', keydown, true);
    requestAnimationFrame(() => input.current?.focus());
    return () => {
      window.removeEventListener('keydown', keydown, true);
      queueMicrotask(() => previous?.focus({ preventScroll: true }));
    };
  }, [detail]);
  if (!detail) return null;
  const inheritedScope = detail.semanticScope || pageScope(scopeType, scopeId, scopeBreadcrumb);

  async function submit() {
    const content = question.trim();
    if (!content || busy) return;
    setBusy(true);
    setError('');
    try {
      if (!projectId || !inheritedScope) throw new Error('当前页面没有可用的智能助手上下文');
      let current = session;
      if (!current) {
        current = await api<BtwSession>(
          '/assist/v3/btw',
          json(
            'POST',
            {
              project_id: projectId,
              scope_type: inheritedScope.type,
              scope_id: inheritedScope.id,
              session_id: sessionId,
              profile_id: profileId || undefined,
              browser_id: browserId(),
              selection: detail?.selection,
              page_url: detail?.pageUrl
            },
            '创建临时问答'
          )
        );
        sessionRef.current = current;
        setSession(current);
        connect(current);
      }
      await api(
        `/assist/v3/btw/${current.id}/turns`,
        json('POST', { access_token: current.access_token, content }, '发送临时问题')
      );
      setQuestion('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    const current = sessionRef.current;
    stream.current?.close();
    stream.current = null;
    sessionRef.current = null;
    setDetail(null);
    setSession(null);
    setEvents([]);
    setError('');
    if (current) await destroyBtw(current);
  }
  function connect(current: BtwSession) {
    stream.current?.close();
    const source = new EventSource(
      apiUrl(`/assist/v3/btw/${current.id}/events?token=${encodeURIComponent(current.access_token)}`)
    );
    stream.current = source;
    const consume = (raw: Event) => {
      const item = JSON.parse((raw as MessageEvent).data) as BtwEvent;
      setEvents((rows) => (rows.some((row) => row.sequence === item.sequence) ? rows : [...rows, item]));
      if (item.type === 'closed' && sessionRef.current?.id === current.id) {
        source.close();
        sessionRef.current = null;
        setSession(null);
        setError('临时问答已关闭');
      }
    };
    for (const type of ['ready', 'user', 'text', 'reasoning_summary', 'completed', 'failed', 'closed'])
      source.addEventListener(type, consume);
    source.onopen = () => setError('');
    source.onerror = () => setError((value) => value || '临时问答连接已断开');
  }
  return (
    <BtwPopoverSurface
      detail={detail}
      inheritedScope={inheritedScope}
      events={events}
      error={error}
      busy={busy}
      question={question}
      input={input}
      popover={popover}
      onQuestion={setQuestion}
      onSubmit={() => void submit()}
      onClose={() => void close()}
    />
  );
}

function BtwPopoverSurface({
  detail,
  inheritedScope,
  events,
  error,
  busy,
  question,
  input,
  popover,
  onQuestion,
  onSubmit,
  onClose
}: {
  detail: SelectionAskDetail;
  inheritedScope?: SelectionAskScope;
  events: BtwEvent[];
  error: string;
  busy: boolean;
  question: string;
  input: RefObject<HTMLInputElement | null>;
  popover: RefObject<HTMLElement | null>;
  onQuestion: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const messages = btwMessages(events),
    position = popoverPosition(detail.rect);
  return (
    <section ref={popover} className="btw-popover" role="dialog" aria-label="临时问答" style={position}>
      <header>
        <strong>临时问答</strong>
        <IconButton label="关闭临时问答" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>
      {inheritedScope ? (
        <InheritedContext scope={inheritedScope} />
      ) : (
        <div className="btw-inherited-context" aria-label="当前上下文不可用">
          <span>
            <Layers3 size={12} />
            当前上下文
          </span>
          <strong>未找到可继承的页面范围</strong>
        </div>
      )}
      {detail.selection && <blockquote>{detail.selection}</blockquote>}
      {messages.length > 0 && (
        <div className="btw-messages" aria-live="polite">
          {messages.map((item, index) => (
            <p className={item.role} key={`${item.turnId}:${index}`}>
              {item.text}
            </p>
          ))}
        </div>
      )}
      {error && (
        <p className="btw-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <input
          ref={input}
          aria-label="临时问题"
          value={question}
          onChange={(event) => onQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <IconButton label="发送临时问题" disabled={busy || !question.trim()} onClick={onSubmit}>
          <Send size={15} />
        </IconButton>
      </footer>
    </section>
  );
}

function InheritedContext({ scope }: { scope: SelectionAskScope }) {
  const path = scope.breadcrumb.join(' / ');
  return (
    <div className="btw-inherited-context" aria-label={`当前上下文：${path}`}>
      <span>
        <Layers3 size={12} />
        当前上下文
      </span>
      <strong>{path}</strong>
      <small>
        {assistScopeLabel(scope.type)}
        {scope.statusLabel && ` · ${scope.statusLabel}`}
      </small>
      {scope.lockReason && (
        <em>
          <LockKeyhole size={11} />
          {scope.lockReason}
        </em>
      )}
    </div>
  );
}

function pageScope(
  type: AssistScopeType | undefined,
  id: string | undefined,
  breadcrumb: AssistScopeBreadcrumbItem[] | undefined
): SelectionAskScope | undefined {
  if (!type || !id) return undefined;
  const labels = (breadcrumb || []).map((item) => item.label).filter(Boolean);
  return {
    type,
    id,
    label: labels.at(-1) || assistScopeLabel(type),
    breadcrumb: labels.length ? labels : [assistScopeLabel(type)]
  };
}

function btwMessages(events: BtwEvent[]) {
  const result: Array<{ role: 'user' | 'assistant'; text: string; turnId: string | null }> = [];
  for (const event of events) {
    if (event.type === 'user')
      result.push({ role: 'user', text: String(event.data.text || ''), turnId: event.turn_id });
    if (event.type === 'text') {
      const previous = result.at(-1);
      if (previous?.role === 'assistant' && previous.turnId === event.turn_id)
        previous.text += String(event.data.text || '');
      else result.push({ role: 'assistant', text: String(event.data.text || ''), turnId: event.turn_id });
    }
    if (event.type === 'failed')
      result.push({
        role: 'assistant',
        text: `请求失败：${String(event.data.error || 'unknown')}`,
        turnId: event.turn_id
      });
  }
  return result;
}
function browserId() {
  const key = 'aiws-browser-instance-v16',
    stored = localStorage.getItem(key);
  if (stored) return stored;
  const random = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    value = `browser-${random}`;
  localStorage.setItem(key, value);
  return value;
}
function destroyBtw(current: BtwSession) {
  return api(`/assist/v3/btw/${current.id}?token=${encodeURIComponent(current.access_token)}`, {
    ...json('DELETE', undefined, '关闭临时问答'),
    keepalive: true
  }).then(
    () => undefined,
    () => undefined
  );
}
function popoverPosition(anchor: Anchor | null) {
  const width = Math.min(420, window.innerWidth - 16),
    left = Math.max(8, Math.min(anchor?.left || window.innerWidth / 2 - width / 2, window.innerWidth - width - 8)),
    top = Math.max(8, Math.min((anchor?.bottom || 80) + 8, window.innerHeight - 360));
  return { left, top, width };
}
