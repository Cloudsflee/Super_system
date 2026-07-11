import { Bot, GitCompare, Paperclip, RotateCcw, User } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { AssistV3Event, AssistV3Turn } from '../../api/types';
import { TypedEvent } from './TypedEvent';

type Props = {
  turns: AssistV3Turn[]; events: AssistV3Event[]; connected: boolean;
  onRetry: (turn: AssistV3Turn) => void; onReview: (turn: AssistV3Turn) => void;
};

export function TurnTimeline({ turns, events, connected, onRetry, onReview }: Props) {
  const end = useRef<HTMLDivElement>(null);
  const sessionEvents = events.filter((event) => !event.turn_id);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [events.length, turns.length]);
  return <div className="turn-timeline">
    <div className={`stream-health ${connected ? 'connected' : ''}`}><i />{connected ? '实时事件已连接' : '正在重连事件流'}</div>
    {!turns.length && <div className="quiet-empty"><Bot size={24} /><p>选择 Ask、Plan、Agent 或 CLI 开始协作</p></div>}
    {sessionEvents.length > 0 && <div className="turn-events session-events">{sessionEvents.map((event) => <TypedEvent event={event} key={`${event.sequence}:${event.type}`} />)}</div>}
    {turns.map((turn) => {
      const turnEvents = events.filter((event) => event.turn_id === turn.id);
      const retryable = ['failed', 'stopped', 'interrupted'].includes(turn.status);
      const reviewable = turn.mode === 'agent' && ['ready', 'changes_requested', 'applied'].includes(turn.review_status);
      return <section className="assist-turn" key={turn.id}>
        <article className="turn-prompt"><header><User size={13} /><strong>你 · {turn.mode}</strong><span className={`status ${turn.status}`}>{turn.status}</span></header><p>{turn.prompt}</p>{turn.attachments?.length ? <footer><Paperclip size={12} />{turn.attachments.map((item) => <span key={item.id}>{item.title}</span>)}</footer> : null}</article>
        <div className="turn-events">{turnEvents.map((event) => <TypedEvent event={event} key={`${event.sequence}:${event.type}`} />)}</div>
        {turn.output_text && <article className="turn-output"><header><Bot size={13} /><strong>Codex</strong></header><p>{turn.output_text}</p></article>}
        {(retryable || reviewable) && <footer className="turn-actions">{retryable && <button className="button secondary" onClick={() => onRetry(turn)}><RotateCcw size={14} />Retry</button>}{reviewable && <button className="button primary" onClick={() => onReview(turn)}><GitCompare size={14} />Review changes</button>}</footer>}
      </section>;
    })}
    <div ref={end} />
  </div>;
}
