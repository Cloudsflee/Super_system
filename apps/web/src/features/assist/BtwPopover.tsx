import { Layers3, LockKeyhole, Send, X } from 'lucide-react';
import type { RefObject } from 'react';
import type { AssistScopeBreadcrumbItem, AssistScopeType } from '../../api/types';
import { IconButton } from '../../components/common/IconButton';
import type { SelectionAskDetail, SelectionAskScope } from '../../components/common/selection-ask';
import { useBtwPopoverController, type BtwEvent } from './BtwPopoverController';
import { assistScopeLabel } from './scope-display';

type Anchor = { left: number; top: number; bottom: number; width: number };
type BtwPopoverProps = {
  projectId?: string;
  scopeType?: AssistScopeType;
  scopeId?: string;
  scopeBreadcrumb?: AssistScopeBreadcrumbItem[];
  sessionId?: string;
  profileId?: string;
};

export function BtwPopover({ projectId, scopeType, scopeId, scopeBreadcrumb, sessionId, profileId }: BtwPopoverProps) {
  const controller = useBtwPopoverController({ projectId, scopeType, scopeId, scopeBreadcrumb, sessionId, profileId });
  if (!controller.detail) return null;
  return (
    <BtwPopoverSurface
      detail={controller.detail}
      inheritedScope={controller.inheritedScope}
      events={controller.events}
      error={controller.error}
      busy={controller.busy}
      question={controller.question}
      input={controller.input}
      popover={controller.popover}
      onQuestion={controller.setQuestion}
      onSubmit={() => void controller.submit()}
      onClose={() => void controller.close()}
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
      <BtwMessages messages={messages} />
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

function BtwMessages({ messages }: { messages: ReturnType<typeof btwMessages> }) {
  if (!messages.length) return null;
  return (
    <div className="btw-messages" aria-live="polite">
      {messages.map((item, index) => (
        <p className={item.role} key={`${item.turnId}:${index}`}>
          {item.text}
        </p>
      ))}
    </div>
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
function popoverPosition(anchor: Anchor | null) {
  const width = Math.min(420, window.innerWidth - 16),
    left = Math.max(8, Math.min(anchor?.left || window.innerWidth / 2 - width / 2, window.innerWidth - width - 8)),
    top = Math.max(8, Math.min((anchor?.bottom || 80) + 8, window.innerHeight - 360));
  return { left, top, width };
}
