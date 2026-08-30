export function TypedEvent({ event, className = '' }: { event: { type?: string; data?: unknown; method?: string }; className?: string }) {
  return <div className={`typed-event ${className}`.trim()}><strong>{event.type || event.method || 'event'}</strong>{event.data != null && <code>{typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}</code>}</div>;
}
export default TypedEvent;
