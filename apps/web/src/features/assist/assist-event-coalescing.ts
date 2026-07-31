import type { AssistV3Event } from '../../api/types';

type EventMerger = (previous: AssistV3Event, current: AssistV3Event) => AssistV3Event | null;

const eventMergers: Record<string, EventMerger> = {
  text: mergeText,
  plan: mergePlan,
  command: mergeCommand,
  file_change: mergeFileChange,
  reasoning_summary: mergeReasoning,
  diff: mergeDiff
};

export function coalesceAssistEvents(events: AssistV3Event[]) {
  const result: AssistV3Event[] = [];
  for (const event of events) {
    const previous = result.at(-1),
      merged = previous ? eventMergers[event.type]?.(previous, event) : null;
    if (merged) result[result.length - 1] = merged;
    else result.push(event);
  }
  return result;
}

function mergeText(previous: AssistV3Event, current: AssistV3Event) {
  if (previous.type !== 'text') return null;
  return {
    ...current,
    data: { ...current.data, text: `${String(previous.data.text || '')}${String(current.data.text || '')}` }
  };
}

function mergePlan(previous: AssistV3Event, current: AssistV3Event) {
  if (previous.type !== 'plan' || current.data.source !== previous.data.source) return null;
  const streaming = current.data.status === 'streaming' && previous.data.status === 'streaming';
  return {
    ...current,
    data: {
      ...current.data,
      text: streaming
        ? `${String(previous.data.text || '')}${String(current.data.text || '')}`
        : String(current.data.text || previous.data.text || '')
    }
  };
}

function mergeCommand(previous: AssistV3Event, current: AssistV3Event) {
  if (previous.type !== 'command' || !compatibleItems(previous, current)) return null;
  return {
    ...current,
    data: {
      ...previous.data,
      ...current.data,
      command: current.data.command || previous.data.command,
      output: mergedStreamValue(previous.data.output, current.data.output, current.data.item_id == null)
    }
  };
}

function mergeFileChange(previous: AssistV3Event, current: AssistV3Event) {
  if (previous.type !== 'file_change' || !compatibleItems(previous, current)) return null;
  return {
    ...current,
    data: {
      ...previous.data,
      ...current.data,
      patch: mergedStreamValue(previous.data.patch, current.data.patch, Array.isArray(current.data.changes))
    }
  };
}

function mergeReasoning(previous: AssistV3Event, current: AssistV3Event) {
  if (previous.type !== 'reasoning_summary') return null;
  return {
    ...current,
    data: {
      ...current.data,
      summary: mergedStreamValue(
        previous.data.summary,
        current.data.summary,
        String(current.data.summary || '').startsWith(String(previous.data.summary || ''))
      )
    }
  };
}

function mergeDiff(previous: AssistV3Event, current: AssistV3Event) {
  return previous.type === 'diff' ? current : null;
}

function compatibleItems(previous: AssistV3Event, current: AssistV3Event) {
  if (previous.data.item_id && current.data.item_id) return previous.data.item_id === current.data.item_id;
  if (previous.data.item_id && !current.data.item_id) {
    if (previous.type === 'command' && previous.data.command && current.data.command)
      return previous.data.command === current.data.command;
    if (previous.type === 'file_change' && Array.isArray(previous.data.changes) && Array.isArray(current.data.changes))
      return false;
    return true;
  }
  if (!previous.data.item_id && current.data.item_id) return false;
  return (
    previous.type === 'command' && Boolean(previous.data.command) && previous.data.command === current.data.command
  );
}

function mergedStreamValue(previous: unknown, current: unknown, authoritative: boolean) {
  const before = String(previous || ''),
    next = String(current || '');
  if (!next) return before;
  if (authoritative || next.startsWith(before)) return next;
  return `${before}${next}`;
}
