import { invalidateEventQueries } from './query';
import { type CursorRecord, openOfflineDb } from './offline/db';

export type ProjectEvent = {
  id: string;
  sequence: number;
  previous_project_sequence: number;
  type: string;
  project_id: string | null;
  data?: Record<string, unknown>;
};

export type EventSyncState = 'idle' | 'catching_up' | 'connected' | 'reconnecting' | 'offline' | 'denied';

export class ProjectEventSynchronizer {
  private readonly actorId: string;
  private readonly projectId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onState?: (state: EventSyncState) => void;
  private readonly onEvents?: (events: ProjectEvent[]) => void;
  private readonly cursorKey: string;
  private abortController: AbortController | null = null;
  private stopped = false;
  private lastGlobalSequence = 0;
  private lastProjectSequence = 0;
  private seen = new Set<number>();
  private signedCursor = '';

  constructor(options: { actorId: string; projectId: string; fetchImpl?: typeof fetch; onState?: (state: EventSyncState) => void; onEvents?: (events: ProjectEvent[]) => void }) {
    this.actorId = String(options.actorId);
    this.projectId = String(options.projectId);
    this.fetchImpl = options.fetchImpl || fetch.bind(globalThis);
    this.onState = options.onState;
    this.onEvents = options.onEvents;
    this.cursorKey = `${this.actorId}:${this.projectId}`;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.loadCursor();
    await this.catchUp();
    if (!this.stopped) void this.connectSse();
  }

  stop(): void {
    this.stopped = true;
    this.abortController?.abort();
    this.abortController = null;
  }

  private async catchUp(): Promise<void> {
    this.setState('catching_up');
    let hasMore = true;
    let cursor = this.signedCursor;
    while (hasMore && !this.stopped) {
      const params = new URLSearchParams({ project_id: this.projectId, limit: '200', format: 'json' });
      if (cursor) params.set('cursor', cursor);
      const response = await this.fetchImpl(`/api/v2/events?${params.toString()}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (response.status === 401 || response.status === 403) { this.setState('denied'); throw new Error('event_scope_denied'); }
      if (!response.ok) {
        if (response.status >= 500 || response.status === 0) { this.setState('offline'); throw new Error('event_network_error'); }
        throw new Error(`event_replay_${response.status}`);
      }
      const envelope = await response.json() as { data?: { events?: ProjectEvent[]; next_cursor?: string; cursor_sequence?: number; has_more?: boolean } };
      const data = envelope.data || {};
      const events = this.accept(data.events || []);
      if (events.length) this.onEvents?.(events);
      cursor = String(data.next_cursor || cursor || '');
      hasMore = Boolean(data.has_more);
      this.signedCursor = cursor;
      await this.saveCursor();
    }
  }

  private async connectSse(): Promise<void> {
    if (this.stopped) return;
    this.setState('connected');
    this.abortController = new AbortController();
    const params = new URLSearchParams({ project_id: this.projectId });
    if (this.signedCursor) params.set('cursor', this.signedCursor);
    try {
      const response = await this.fetchImpl(`/api/v2/events?${params.toString()}`, {
        credentials: 'same-origin',
        headers: { accept: 'text/event-stream' },
        signal: this.abortController.signal
      });
      if (response.status === 401 || response.status === 403) { this.setState('denied'); return; }
      if (!response.ok || !response.body) throw new Error('event_sse_unavailable');
      await this.readStream(response.body);
    } catch (error) {
      if (this.stopped || (error as Error)?.name === 'AbortError') return;
      this.setState('reconnecting');
      await this.catchUp().catch(() => undefined);
      if (!this.stopped) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        void this.connectSse();
      }
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!this.stopped) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('event_sse_closed');
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        if (frame.startsWith(':')) continue;
        const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const event = JSON.parse(dataLine.slice(5).trim()) as ProjectEvent;
        const accepted = this.accept([event]);
        if (accepted.length) {
          this.onEvents?.(accepted);
          await this.saveCursor();
        }
      }
    }
  }

  private accept(events: ProjectEvent[]): ProjectEvent[] {
    const accepted: ProjectEvent[] = [];
    for (const event of events.sort((a, b) => a.sequence - b.sequence)) {
      if (event.project_id !== this.projectId || this.seen.has(event.sequence) || event.sequence <= this.lastProjectSequence) continue;
      if (this.lastProjectSequence > 0 && event.previous_project_sequence !== this.lastProjectSequence) {
        this.abortController?.abort();
        this.setState('reconnecting');
        continue;
      }
      this.seen.add(event.sequence);
      this.lastGlobalSequence = Math.max(this.lastGlobalSequence, event.sequence);
      this.lastProjectSequence = event.sequence;
      accepted.push(event);
      invalidateEventQueries(event.type);
    }
    return accepted;
  }

  private async loadCursor(): Promise<void> {
    try {
      const db = await openOfflineDb();
      const cursor = await db.get('cursors', this.cursorKey);
      db.close();
      if (cursor) this.applyCursor(cursor);
    } catch { /* no IndexedDB in private/test contexts */ }
  }

  private async saveCursor(): Promise<void> {
    const record: CursorRecord = {
      key: this.cursorKey,
      actor_id: this.actorId,
      project_id: this.projectId,
      signed_cursor: this.signedCursor,
      last_global_sequence: this.lastGlobalSequence,
      last_project_sequence: this.lastProjectSequence,
      updated_at: new Date().toISOString()
    };
    try {
      const db = await openOfflineDb();
      await db.put('cursors', record);
      db.close();
    } catch { /* memory state remains authoritative for this session */ }
  }

  private applyCursor(cursor: CursorRecord): void {
    this.signedCursor = cursor.signed_cursor;
    this.lastGlobalSequence = Number(cursor.last_global_sequence || 0);
    this.lastProjectSequence = Number(cursor.last_project_sequence || 0);
  }

  private setState(state: EventSyncState): void { this.onState?.(state); }
}

export function createProjectEventSynchronizer(options: ConstructorParameters<typeof ProjectEventSynchronizer>[0]): ProjectEventSynchronizer {
  return new ProjectEventSynchronizer(options);
}
