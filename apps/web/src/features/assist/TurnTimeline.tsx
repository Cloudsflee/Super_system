import { useMemo } from 'react';
import { TypedEvent } from './TypedEvent';

export function coalesceAssistEvents(events: Array<{ sequence?: number; type?: string; method?: string; data?: unknown }>) {
  const seen = new Set<string>();
  return [...events].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0)).filter((event) => { const key = `${event.sequence || 0}:${event.type || event.method || ''}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

export function TurnTimeline({ events = [] }: { events?: Array<{ sequence?: number; type?: string; method?: string; data?: unknown }> }) {
  const rows = useMemo(() => coalesceAssistEvents(events), [events]);
  return <div className="assist-turn-timeline" role="log" aria-label="Assist timeline">{rows.map((event, index) => <TypedEvent key={`${event.sequence || index}-${index}`} event={event} />)}{!rows.length && <div className="list-empty">No events</div>}</div>;
}
export default TurnTimeline;
