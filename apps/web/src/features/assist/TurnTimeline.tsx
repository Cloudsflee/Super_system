import { Bot, GitCompare, Paperclip, RotateCcw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { AssistOperation, AssistV3Event, AssistV3Turn } from '../../api/types';
import { AssistMarkdown } from './AssistMarkdown';
import { OperationReceipt } from './OperationReceipt';
import { isDirectEvent, TypedEvent } from './TypedEvent';
import { TurnRuntimeDetails } from './TurnRuntimeDetails';
import { UserInputCard } from './UserInputCard';

type Props = {
  turns: AssistV3Turn[]; events: AssistV3Event[]; reconnecting: boolean; busy: boolean;
  onRetry: (turn: AssistV3Turn) => void; onReview: (turn: AssistV3Turn) => void;
  onRespondUserInput: (turnId: string, itemId: string, answers: Record<string, { answers: string[]; note?: string }>) => void;
  onConfirmOperation: (item: AssistOperation, approved: boolean) => void; onUndoOperation: (item: AssistOperation, force?: boolean) => void;
  onReviseOperation?: (item: AssistOperation) => void; onContinueOperation?: (item: AssistOperation) => void;
};

export function TurnTimeline({ turns, events, reconnecting, busy, onRetry, onReview, onRespondUserInput, onConfirmOperation, onUndoOperation, onReviseOperation = () => undefined, onContinueOperation = () => undefined }: Props) {
  const root = useRef<HTMLDivElement>(null), end = useRef<HTMLDivElement>(null), follow = useRef(true);
  const sessionEvents = events.filter((event) => !event.turn_id && isDirectEvent(event));
  useEffect(() => { if (follow.current) end.current?.scrollIntoView?.({ block: 'end' }); }, [events.length, turns.length]);
  return <div className="turn-timeline" ref={root} onScroll={() => { const node = root.current; if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; }}>
    {reconnecting && <div className="stream-health" role="status"><i />正在重新连接</div>}
    {!turns.length && <div className="quiet-empty"><Bot size={24} /><p>发送消息，或为下一轮开启原生规划模式</p></div>}
    {sessionEvents.length > 0 && <div className="turn-direct-events session-events">{sessionEvents.map((event) => <TypedEvent event={event} key={`${event.sequence}:${event.type}`} />)}</div>}
    {turns.map((turn) => {
      const allTurnEvents = events.filter((event) => event.turn_id === turn.id), usage = [...allTurnEvents].reverse().find((event) => event.type === 'usage')?.data || turn.usage || null;
      const turnEvents = coalesceAssistEvents(allTurnEvents);
      const retryable = ['failed', 'stopped', 'interrupted'].includes(turn.status), reviewable = Boolean(turn.change_batch_id && ['ready', 'no_changes', 'changes_requested', 'applied'].includes(turn.review_status));
      const phase = turnPhase(turn.status), directEvents = turnDirectEvents(turn, turnEvents, retryable), reply = assistantReply(turn, turnEvents);
      return <section className="assist-turn" key={turn.id}>
        <article className="turn-prompt"><span className="sr-only">用户消息</span>{turn.collaboration_mode === 'plan' && <div className="turn-prompt-meta"><span className="native-plan-label">规划</span></div>}<p>{turn.prompt}</p>{turn.attachments?.length ? <footer><Paperclip size={12} />{turn.attachments.map((item) => <span key={item.id}>{item.title}</span>)}</footer> : null}</article>
        {phase && <div className={`turn-phase ${phase === '正在处理' ? 'processing' : 'waiting'}`} role="status"><i />{phase}</div>}
        <TurnRuntimeDetails events={turnEvents} usage={usage} active={Boolean(phase)} />
        {directEvents.length > 0 && <div className="turn-direct-events">{directEvents.map((event) => <TypedEvent event={event} key={`${event.sequence}:${event.type}`} />)}</div>}
        {(turn.user_inputs || []).map((item) => <UserInputCard key={item.id} item={item} busy={busy} onRespond={(answers) => onRespondUserInput(turn.id, item.item_id, answers)} />)}
        {(turn.operations || []).map((item) => <OperationReceipt key={item.id} operation={item} busy={busy} onConfirm={(approved) => onConfirmOperation(item, approved)} onUndo={(force) => onUndoOperation(item, force)} onRevise={() => onReviseOperation(item)} onContinue={() => onContinueOperation(item)} />)}
        {reply && <article className="turn-output"><span className="sr-only">助手回复</span><AssistMarkdown>{reply}</AssistMarkdown></article>}
        {(retryable || reviewable) && <footer className="turn-actions">{retryable && <button className="button secondary" onClick={() => onRetry(turn)}><RotateCcw size={14} />重试</button>}{reviewable && <button className="button primary" onClick={() => onReview(turn)}><GitCompare size={14} />审查变更批次</button>}</footer>}
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
    else if (event.type === 'command' && previous?.type === 'command' && compatibleItems(previous, event)) result[result.length - 1] = { ...event, data: { ...previous.data, ...event.data, command: event.data.command || previous.data.command, output: mergedStreamValue(previous.data.output, event.data.output, event.data.item_id == null) } };
    else if (event.type === 'file_change' && previous?.type === 'file_change' && compatibleItems(previous, event)) result[result.length - 1] = { ...event, data: { ...previous.data, ...event.data, patch: mergedStreamValue(previous.data.patch, event.data.patch, Array.isArray(event.data.changes)) } };
    else if (event.type === 'reasoning_summary' && previous?.type === 'reasoning_summary') result[result.length - 1] = { ...event, data: { ...event.data, summary: mergedStreamValue(previous.data.summary, event.data.summary, String(event.data.summary || '').startsWith(String(previous.data.summary || ''))) } };
    else if (event.type === 'diff' && previous?.type === 'diff') result[result.length - 1] = event;
    else result.push(event);
  }
  return result;
}

function turnPhase(status: string) {
  if (['queued', 'preparing', 'waiting_user_input', 'waiting_approval'].includes(status)) return '等待处理';
  if (['running', 'stopping'].includes(status)) return '正在处理';
  return null;
}

function assistantReply(turn: AssistV3Turn, events: AssistV3Event[]) {
  const output = String(turn.output_text || '').trim();
  if (output) return output;
  const nativePlan = [...events].reverse().find((event) => event.type === 'plan' && event.data.source === 'codex-native' && String(event.data.text || '').trim());
  if (nativePlan) return String(nativePlan.data.text).trim();
  const streamedText = events.filter((event) => event.type === 'text').map((event) => String(event.data.text || '')).join('').trim();
  if (streamedText) return streamedText;
  const plan = [...events].reverse().find((event) => event.type === 'plan' && String(event.data.text || '').trim());
  return plan ? String(plan.data.text).trim() : '';
}

function turnDirectEvents(turn: AssistV3Turn, events: AssistV3Event[], retryable: boolean) {
  const direct = events.filter(isDirectEvent);
  if (direct.length || !retryable) return direct;
  const type = turn.status === 'stopped' ? 'stopped' : turn.status === 'interrupted' ? 'interrupted' : 'failed';
  return [{ id: -1, sequence: -1, session_id: turn.session_id, turn_id: turn.id, type, data: { error: turn.error_code }, created_at: turn.updated_at } satisfies AssistV3Event];
}

function compatibleItems(previous: AssistV3Event, current: AssistV3Event) {
  if (previous.data.item_id && current.data.item_id) return previous.data.item_id === current.data.item_id;
  if (previous.data.item_id && !current.data.item_id) {
    if (previous.type === 'command' && previous.data.command && current.data.command) return previous.data.command === current.data.command;
    if (previous.type === 'file_change' && Array.isArray(previous.data.changes) && Array.isArray(current.data.changes)) return false;
    return true;
  }
  if (!previous.data.item_id && current.data.item_id) return false;
  return previous.type === 'command' && Boolean(previous.data.command) && previous.data.command === current.data.command;
}
function mergedStreamValue(previous: unknown, current: unknown, authoritative: boolean) {
  const before = String(previous || ''), next = String(current || '');
  if (!next) return before;
  if (authoritative || next.startsWith(before)) return next;
  return `${before}${next}`;
}
