import { ChevronDown, Wrench } from 'lucide-react';
import { useState } from 'react';
import type { AssistV3Event } from '../../api/types';
import { TurnUsage } from './TurnUsage';
import { isRuntimeEvent, TypedEvent } from './TypedEvent';

export function TurnRuntimeDetails({ events, usage }: { events: AssistV3Event[]; usage: Record<string, unknown> | null; active: boolean }) {
  const detailEvents = events.filter(isRuntimeEvent);
  const visibleUsage = usage && Object.values(usage).some((value) => value != null && value !== '' && Number.isFinite(Number(value))) ? usage : null;
  const [open, setOpen] = useState(false);

  if (!detailEvents.length && !visibleUsage) return null;
  const count = detailEvents.length + (visibleUsage ? 1 : 0);
  return <details className="turn-runtime-details" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><Wrench size={13} /><span>运行详情</span><small>{count} 项</small><ChevronDown size={13} /></summary>
    <div className="turn-runtime-content">
      {detailEvents.map((event) => <TypedEvent detail event={event} key={`${event.sequence}:${event.type}`} />)}
      {visibleUsage && <TurnUsage usage={visibleUsage} />}
    </div>
  </details>;
}
