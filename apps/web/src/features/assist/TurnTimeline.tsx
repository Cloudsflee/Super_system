import { Bot, GitCompare, Paperclip, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { AssistOperation, AssistV3Event, AssistV3Turn } from '../../api/types';
import { AssistMarkdown } from './AssistMarkdown';
import { OperationReceipt } from './OperationReceipt';
import { TypedEvent } from './TypedEvent';
import { UserInputCard } from './UserInputCard';
import { TurnUsage } from './TurnUsage';

type Props = {
  turns: AssistV3Turn[]; events: AssistV3Event[]; connected: boolean; busy: boolean;
  onRetry: (turn: AssistV3Turn) => void; onReview: (turn: AssistV3Turn) => void;
  onRespondUserInput: (turnId: string, itemId: string, answers: Record<string, { answers: string[] }>) => void;
  onConfirmOperation: (item: AssistOperation, approved: boolean) => void; onUndoOperation: (item: AssistOperation, force?: boolean) => void;
};

export function TurnTimeline({ turns, events, connected, busy, onRetry, onReview, onRespondUserInput, onConfirmOperation, onUndoOperation }: Props) {
  const root = useRef<HTMLDivElement>(null), end = useRef<HTMLDivElement>(null), follow = useRef(true);
  const sessionEvents = events.filter((event) => !event.turn_id);
  useEffect(() => { if (follow.current) end.current?.scrollIntoView?.({ block: 'end' }); }, [events.length, turns.length]);
  return <div className="turn-timeline" ref={root} onScroll={() => { const node = root.current; if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; }}>
    <div className={`stream-health ${connected ? 'connected' : ''}`}><i />{connected ? '实时事件已连接' : '正在重连事件流'}</div>
    {!turns.length && <div className="quiet-empty"><Bot size={24} /><p>发送消息，或为下一次 Turn 开启原生 Plan</p></div>}
    {sessionEvents.length > 0 && <div className="turn-events session-events">{sessionEvents.map((event) => <TypedEvent event={event} key={`${event.sequence}:${event.type}`} />)}</div>}
    {turns.map((turn) => {
      const allTurnEvents = events.filter((event) => event.turn_id === turn.id), usage = [...allTurnEvents].reverse().find((event) => event.type === 'usage')?.data || turn.usage || null;
      const turnEvents = coalesceAssistEvents(allTurnEvents.filter((event) => !(turn.output_text && event.type === 'text') && !['request_user_input', 'request_user_input_resolved', 'operation', 'usage'].includes(event.type)));
      const retryable = ['failed', 'stopped', 'interrupted'].includes(turn.status), reviewable = Boolean(turn.change_batch_id && ['ready', 'changes_requested', 'applied'].includes(turn.review_status));
      const nativePlan = [...turnEvents].reverse().find((event) => event.type === 'plan' && event.data.source === 'codex-native'), nativePlanIsOutput = Boolean(nativePlan && String(nativePlan.data.text || '').trim() === String(turn.output_text || '').trim());
      return <section className="assist-turn" key={turn.id}>
        <article className="turn-prompt"><span className="sr-only">用户消息</span><div className="turn-prompt-meta">{turn.collaboration_mode === 'plan' && <span className="native-plan-label">Plan</span>}<span className={`status ${turn.status}`}>{turn.status}</span></div><details className="turn-configuration"><summary><SlidersHorizontal size={11} />{turn.model} · {turn.reasoning}</summary><div><span>{turn.code_access === 'workspace_write' ? 'workspaceWrite' : `readOnly · ${turn.code_read_only_reason || ''}`}</span></div></details><p>{turn.prompt}</p>{turn.attachments?.length ? <footer><Paperclip size={12} />{turn.attachments.map((item) => <span key={item.id}>{item.title}</span>)}</footer> : null}</article>
        <div className="turn-events">{turnEvents.map((event) => <TypedEvent event={event} key={`${event.sequence}:${event.type}`} />)}</div>
        {(turn.user_inputs || []).map((item) => <UserInputCard key={item.id} item={item} busy={busy} onRespond={(answers) => onRespondUserInput(turn.id, item.item_id, answers)} />)}
        {(turn.operations || []).map((item) => <OperationReceipt key={item.id} operation={item} busy={busy} onConfirm={(approved) => onConfirmOperation(item, approved)} onUndo={(force) => onUndoOperation(item, force)} />)}
        {turn.output_text && !nativePlanIsOutput && <article className="turn-output"><span className="sr-only">助手回复</span><AssistMarkdown>{turn.output_text}</AssistMarkdown>{usage && <TurnUsage usage={usage} />}</article>}
        {(retryable || reviewable) && <footer className="turn-actions">{retryable && <button className="button secondary" onClick={() => onRetry(turn)}><RotateCcw size={14} />Retry</button>}{reviewable && <button className="button primary" onClick={() => onReview(turn)}><GitCompare size={14} />Review batch</button>}</footer>}
      </section>;
    })}<div ref={end} />
  </div>;
}

export function coalesceAssistEvents(events: AssistV3Event[]) {
  const result: AssistV3Event[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    if (event.type === 'text' && previous?.type === 'text') result[result.length - 1] = { ...event, data: { ...event.data, text: `${String(previous.data.text || '')}${String(event.data.text || '')}` } };
    else if (event.type === 'plan' && previous?.type === 'plan' && event.data.source === previous.data.source) { const streaming = event.data.status === 'streaming' && previous.data.status === 'streaming'; result[result.length - 1] = { ...event, data: { ...event.data, text: streaming ? `${String(previous.data.text || '')}${String(event.data.text || '')}` : String(event.data.text || previous.data.text || '') } }; }
    else if (event.type === 'command' && previous?.type === 'command' && event.data.item_id && event.data.item_id === previous.data.item_id) result[result.length - 1] = { ...event, data: { ...event.data, output: `${String(previous.data.output || '')}${String(event.data.output || '')}` } };
    else result.push(event);
  }
  return result;
}
