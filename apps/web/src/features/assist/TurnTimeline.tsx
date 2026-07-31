import { Bot } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { AssistOperation, AssistV3Event, AssistV3Turn } from '../../api/types';
import { TurnCard } from './TurnCard';
import { isDirectEvent, TypedEvent } from './TypedEvent';

export { coalesceAssistEvents } from './assist-event-coalescing';

type Props = {
  turns: AssistV3Turn[];
  events: AssistV3Event[];
  reconnecting: boolean;
  busy: boolean;
  onRetry: (turn: AssistV3Turn) => void;
  onReview: (turn: AssistV3Turn) => void;
  onRespondUserInput: (
    turnId: string,
    itemId: string,
    answers: Record<string, { answers: string[]; note?: string }>
  ) => void;
  onConfirmOperation: (item: AssistOperation, approved: boolean) => void;
  onUndoOperation: (item: AssistOperation, force?: boolean) => void;
  onReviseOperation?: (item: AssistOperation) => void;
  onContinueOperation?: (item: AssistOperation) => void;
};

export function TurnTimeline({
  turns,
  events,
  reconnecting,
  busy,
  onRetry,
  onReview,
  onRespondUserInput,
  onConfirmOperation,
  onUndoOperation,
  onReviseOperation = () => undefined,
  onContinueOperation = () => undefined
}: Props) {
  const root = useRef<HTMLDivElement>(null),
    end = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const sessionEvents = events.filter((event) => !event.turn_id && isDirectEvent(event));
  useEffect(() => {
    if (follow.current) end.current?.scrollIntoView?.({ block: 'end' });
  }, [events.length, turns.length]);
  return (
    <div
      className="turn-timeline"
      ref={root}
      onScroll={() => {
        const node = root.current;
        if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
      }}
    >
      {reconnecting && (
        <div className="stream-health" role="status">
          <i />
          正在重新连接
        </div>
      )}
      {!turns.length && (
        <div className="quiet-empty">
          <Bot size={24} />
          <p>发送消息，或为下一轮开启原生规划模式</p>
        </div>
      )}
      {sessionEvents.length > 0 && (
        <div className="turn-direct-events session-events">
          {sessionEvents.map((event) => (
            <TypedEvent event={event} key={`${event.sequence}:${event.type}`} />
          ))}
        </div>
      )}
      {turns.map((turn) => (
        <TurnCard
          key={turn.id}
          turn={turn}
          events={events.filter((event) => event.turn_id === turn.id)}
          busy={busy}
          onRetry={onRetry}
          onReview={onReview}
          onRespondUserInput={onRespondUserInput}
          onConfirmOperation={onConfirmOperation}
          onUndoOperation={onUndoOperation}
          onReviseOperation={onReviseOperation}
          onContinueOperation={onContinueOperation}
        />
      ))}
      <div ref={end} />
    </div>
  );
}
