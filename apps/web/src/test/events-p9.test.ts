import { describe, expect, it } from 'vitest';
import { ProjectEventSynchronizer, type EventSyncState, type ProjectEvent } from '../events';
import { invalidateForEvent } from '../query';

const event = (sequence: number, previous: number, type = 'project.updated'): ProjectEvent => ({
  id: `event-${sequence}`,
  sequence,
  previous_project_sequence: previous,
  type,
  project_id: 'project-sync'
});

describe('P9 project event synchronizer', () => {
  it('ignores global holes from other projects, deduplicates, and reconnects only on a real project gap', () => {
    const states: EventSyncState[] = [];
    const sync = new ProjectEventSynchronizer({ actorId: 'actor-sync', projectId: 'project-sync', onState: (state) => states.push(state) });
    const accept = (sync as unknown as { accept(events: ProjectEvent[]): ProjectEvent[] }).accept.bind(sync);
    expect(accept([event(2, 0), event(7, 2)])).toHaveLength(2);
    expect(accept([event(7, 2)])).toHaveLength(0);
    expect(accept([event(10, 8)])).toHaveLength(0);
    expect(states.at(-1)).toBe('reconnecting');
    sync.stop();
  });

  it('maps domain events to only their owned query resource', () => {
    expect(invalidateForEvent('brief.created')[0][4]).toBe('brief');
    expect(invalidateForEvent('context_selection.created')[0][4]).toBe('context');
    expect(invalidateForEvent('assist_goal.updated')[0][4]).toBe('assist');
    expect(invalidateForEvent('quality_review.completed')[0][4]).toBe('quality');
    expect(invalidateForEvent('delivery.merged')[0][4]).toBe('delivery');
    expect(invalidateForEvent('operation.failed')[0][4]).toBe('operations');
  });
});
