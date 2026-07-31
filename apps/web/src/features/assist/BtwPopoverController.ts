import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api, apiUrl, json } from '../../api/client';
import type { AssistScopeBreadcrumbItem, AssistScopeType } from '../../api/types';
import {
  subscribeSelectionAsk,
  type SelectionAskDetail,
  type SelectionAskScope
} from '../../components/common/selection-ask';
import { assistScopeLabel } from './scope-display';

export type BtwEvent = { sequence: number; turn_id: string | null; type: string; data: Record<string, unknown> };
type BtwSession = { id: string; access_token: string; browser_id: string };
type BtwControllerOptions = {
  projectId?: string;
  scopeType?: AssistScopeType;
  scopeId?: string;
  scopeBreadcrumb?: AssistScopeBreadcrumbItem[];
  sessionId?: string;
  profileId?: string;
};

export function useBtwPopoverController(options: BtwControllerOptions) {
  const state = useBtwPopoverState(),
    inheritedScope =
      state.detail?.semanticScope || pageScope(options.scopeType, options.scopeId, options.scopeBreadcrumb);
  const close = useCallback(async () => {
    const current = state.sessionRef.current;
    state.stream.current?.close();
    state.stream.current = null;
    state.sessionRef.current = null;
    state.setDetail(null);
    state.setSession(null);
    state.setEvents([]);
    state.setError('');
    if (current) await destroyBtw(current);
  }, [state.sessionRef, state.setDetail, state.setError, state.setEvents, state.setSession, state.stream]);
  useBtwDialogFocus(state.detail, state.input, state.popover, close);

  async function submit() {
    const content = state.question.trim();
    if (!content || state.busy) return;
    state.setBusy(true);
    state.setError('');
    try {
      if (!options.projectId || !inheritedScope) throw new Error('当前页面没有可用的智能助手上下文');
      const current = state.session || (await createBtwSession(options, inheritedScope, state.detail));
      if (!state.session) {
        state.sessionRef.current = current;
        state.setSession(current);
        connectBtwSession(current, state);
      }
      await api(
        `/assist/v3/btw/${current.id}/turns`,
        json('POST', { access_token: current.access_token, content }, '发送临时问题')
      );
      state.setQuestion('');
    } catch (reason) {
      state.setError((reason as Error).message);
    } finally {
      state.setBusy(false);
    }
  }
  return { ...state, inheritedScope, submit, close };
}

function useBtwPopoverState() {
  const [detail, setDetail] = useState<SelectionAskDetail | null>(null),
    [question, setQuestion] = useState(''),
    [session, setSession] = useState<BtwSession | null>(null),
    [events, setEvents] = useState<BtwEvent[]>([]),
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
  return {
    detail,
    setDetail,
    question,
    setQuestion,
    session,
    setSession,
    events,
    setEvents,
    busy,
    setBusy,
    error,
    setError,
    stream,
    input,
    popover,
    sessionRef
  };
}

function useBtwDialogFocus(
  detail: SelectionAskDetail | null,
  input: RefObject<HTMLInputElement | null>,
  popover: RefObject<HTMLElement | null>,
  close: () => Promise<void>
) {
  useEffect(() => {
    if (!detail) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void close();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = [
          ...(popover.current?.querySelectorAll<HTMLElement>(
            'input,button:not(:disabled),[tabindex]:not([tabindex="-1"])'
          ) || [])
        ],
        first = items[0],
        last = items.at(-1);
      if (!first || !last) return;
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
  }, [close, detail, input, popover]);
}

async function createBtwSession(
  options: BtwControllerOptions,
  scope: SelectionAskScope,
  detail: SelectionAskDetail | null
) {
  return api<BtwSession>(
    '/assist/v3/btw',
    json(
      'POST',
      {
        project_id: options.projectId,
        scope_type: scope.type,
        scope_id: scope.id,
        session_id: options.sessionId,
        profile_id: options.profileId || undefined,
        browser_id: browserId(),
        selection: detail?.selection,
        page_url: detail?.pageUrl
      },
      '创建临时问答'
    )
  );
}

function connectBtwSession(current: BtwSession, state: ReturnType<typeof useBtwPopoverState>) {
  state.stream.current?.close();
  const source = new EventSource(
    apiUrl(`/assist/v3/btw/${current.id}/events?token=${encodeURIComponent(current.access_token)}`)
  );
  state.stream.current = source;
  const consume = (raw: Event) => {
    const item = JSON.parse((raw as MessageEvent).data) as BtwEvent;
    state.setEvents((rows) => (rows.some((row) => row.sequence === item.sequence) ? rows : [...rows, item]));
    if (item.type === 'closed' && state.sessionRef.current?.id === current.id) {
      source.close();
      state.sessionRef.current = null;
      state.setSession(null);
      state.setError('临时问答已关闭');
    }
  };
  for (const type of ['ready', 'user', 'text', 'reasoning_summary', 'completed', 'failed', 'closed'])
    source.addEventListener(type, consume);
  source.onopen = () => state.setError('');
  source.onerror = () => state.setError((value) => value || '临时问答连接已断开');
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
