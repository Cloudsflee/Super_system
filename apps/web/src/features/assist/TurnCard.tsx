import { GitCompare, Paperclip, RotateCcw } from 'lucide-react';
import type { AssistOperation, AssistV3Event, AssistV3Turn } from '../../api/types';
import { AssistMarkdown } from './AssistMarkdown';
import { coalesceAssistEvents } from './assist-event-coalescing';
import { OperationReceipt } from './OperationReceipt';
import { isDirectEvent, TypedEvent } from './TypedEvent';
import { TurnRuntimeDetails } from './TurnRuntimeDetails';
import { UserInputCard } from './UserInputCard';

export type TurnCardProps = {
  turn: AssistV3Turn;
  events: AssistV3Event[];
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
  onReviseOperation: (item: AssistOperation) => void;
  onContinueOperation: (item: AssistOperation) => void;
};

export function TurnCard({ turn, events, busy, ...actions }: TurnCardProps) {
  const usage = [...events].reverse().find((event) => event.type === 'usage')?.data || turn.usage || null,
    turnEvents = coalesceAssistEvents(events),
    retryable = ['failed', 'stopped', 'interrupted'].includes(turn.status),
    reviewable = Boolean(
      turn.change_batch_id && ['ready', 'no_changes', 'changes_requested', 'applied'].includes(turn.review_status)
    ),
    phase = turnPhase(turn.status),
    directEvents = turnDirectEvents(turn, turnEvents, retryable),
    reply = assistantReply(turn, turnEvents);
  return (
    <section className="assist-turn">
      <TurnPrompt turn={turn} />
      {phase && (
        <div className={`turn-phase ${phase === '正在处理' ? 'processing' : 'waiting'}`} role="status">
          <i />
          {phase}
        </div>
      )}
      <TurnRuntimeDetails events={turnEvents} usage={usage} active={Boolean(phase)} />
      {directEvents.length > 0 && (
        <div className="turn-direct-events">
          {directEvents.map((event) => (
            <TypedEvent event={event} key={`${event.sequence}:${event.type}`} />
          ))}
        </div>
      )}
      {(turn.user_inputs || []).map((item) => (
        <UserInputCard
          key={item.id}
          item={item}
          busy={busy}
          onRespond={(answers) => actions.onRespondUserInput(turn.id, item.item_id, answers)}
        />
      ))}
      {(turn.operations || []).map((item) => (
        <OperationReceipt
          key={item.id}
          operation={item}
          busy={busy}
          onConfirm={(approved) => actions.onConfirmOperation(item, approved)}
          onUndo={(force) => actions.onUndoOperation(item, force)}
          onRevise={() => actions.onReviseOperation(item)}
          onContinue={() => actions.onContinueOperation(item)}
        />
      ))}
      {reply && (
        <article className="turn-output">
          <span className="sr-only">助手回复</span>
          <AssistMarkdown>{reply}</AssistMarkdown>
        </article>
      )}
      <TurnActions
        turn={turn}
        retryable={retryable}
        reviewable={reviewable}
        onRetry={actions.onRetry}
        onReview={actions.onReview}
      />
    </section>
  );
}

function TurnPrompt({ turn }: { turn: AssistV3Turn }) {
  return (
    <article className="turn-prompt">
      <span className="sr-only">用户消息</span>
      {turn.collaboration_mode === 'plan' && (
        <div className="turn-prompt-meta">
          <span className="native-plan-label">规划</span>
        </div>
      )}
      <p>{turn.prompt}</p>
      {turn.attachments?.length ? (
        <footer>
          <Paperclip size={12} />
          {turn.attachments.map((item) => (
            <span key={item.id}>{item.title}</span>
          ))}
        </footer>
      ) : null}
    </article>
  );
}

function TurnActions({
  turn,
  retryable,
  reviewable,
  onRetry,
  onReview
}: {
  turn: AssistV3Turn;
  retryable: boolean;
  reviewable: boolean;
  onRetry: (turn: AssistV3Turn) => void;
  onReview: (turn: AssistV3Turn) => void;
}) {
  if (!retryable && !reviewable) return null;
  return (
    <footer className="turn-actions">
      {retryable && (
        <button className="button secondary" onClick={() => onRetry(turn)}>
          <RotateCcw size={14} />
          重试
        </button>
      )}
      {reviewable && (
        <button className="button primary" onClick={() => onReview(turn)}>
          <GitCompare size={14} />
          审查变更批次
        </button>
      )}
    </footer>
  );
}

function turnPhase(status: string) {
  if (['queued', 'preparing', 'waiting_user_input', 'waiting_approval'].includes(status)) return '等待处理';
  if (['running', 'stopping'].includes(status)) return '正在处理';
  return null;
}

function assistantReply(turn: AssistV3Turn, events: AssistV3Event[]) {
  const output = String(turn.output_text || '').trim();
  if (output) return output;
  const nativePlan = [...events]
    .reverse()
    .find(
      (event) => event.type === 'plan' && event.data.source === 'codex-native' && String(event.data.text || '').trim()
    );
  if (nativePlan) return String(nativePlan.data.text).trim();
  const streamedText = events
    .filter((event) => event.type === 'text')
    .map((event) => String(event.data.text || ''))
    .join('')
    .trim();
  if (streamedText) return streamedText;
  const plan = [...events].reverse().find((event) => event.type === 'plan' && String(event.data.text || '').trim());
  return plan ? String(plan.data.text).trim() : '';
}

function turnDirectEvents(turn: AssistV3Turn, events: AssistV3Event[], retryable: boolean) {
  const direct = events.filter(isDirectEvent);
  if (direct.length || !retryable) return direct;
  const type = turn.status === 'stopped' ? 'stopped' : turn.status === 'interrupted' ? 'interrupted' : 'failed';
  return [
    {
      id: -1,
      sequence: -1,
      session_id: turn.session_id,
      turn_id: turn.id,
      type,
      data: { error: turn.error_code },
      created_at: turn.updated_at
    } satisfies AssistV3Event
  ];
}
