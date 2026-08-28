import { openOfflineDb, type OutboxRecord, type OutboxState } from './db';
import { canonicalJson, canonicalSha256 } from './canonical';

export const OFFLINE_COMMAND_ALLOWLIST = Object.freeze([
  'project.update',
  'brief.create',
  'workflow.revise',
  'context.selection.create',
  'assist.goal.update',
  'outcome.requirement.create'
] as const);

export type OfflineCommand = (typeof OFFLINE_COMMAND_ALLOWLIST)[number];
export type OfflineResponse = { status: number; body?: unknown };
export type OutboxSender = (record: OutboxRecord) => Promise<OfflineResponse>;

const memory = new Map<string, OutboxRecord>();

export function isOfflineCommandAllowed(command: string): command is OfflineCommand {
  return (OFFLINE_COMMAND_ALLOWLIST as readonly string[]).includes(command);
}

export function shouldQueueOffline(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const status = Number((error as { status?: number } | null)?.status || 0);
  return status === 0;
}

export class OfflineOutbox {
  private readonly actorId: string;
  private readonly teamId: string;
  private readonly projectId: string;
  private readonly dbName?: string;

  constructor(scope: { actorId: string; teamId: string; projectId: string; dbName?: string }) {
    this.actorId = String(scope.actorId);
    this.teamId = String(scope.teamId);
    this.projectId = String(scope.projectId);
    this.dbName = scope.dbName;
  }

  async enqueue(input: {
    command: string;
    method: string;
    path: string;
    body?: unknown;
    expectedRevision?: number | null;
    aggregateKey: string;
    idempotencyKey?: string;
  }): Promise<OutboxRecord> {
    if (!isOfflineCommandAllowed(input.command)) throw new Error('offline_command_forbidden');
    const now = new Date().toISOString();
    const body = canonicalJson(input.body ?? {});
    const hash = await canonicalSha256(input.body ?? {});
    const aggregateKey = String(input.aggregateKey);
    const existing = await this.list({ aggregateKey });
    const sequence = existing.reduce((max, row) => Math.max(max, row.fifo_sequence), 0) + 1;
    const id = randomId('outbox');
    const record: OutboxRecord = {
      key: `${this.actorId}:${this.projectId}:${id}`,
      id,
      actor_id: this.actorId,
      team_id: this.teamId,
      project_id: this.projectId,
      command: input.command,
      method: String(input.method).toUpperCase(),
      path: input.path,
      expected_revision: input.expectedRevision ?? null,
      idempotency_key: input.idempotencyKey || randomId('idem'),
      canonical_body: body,
      canonical_hash: hash,
      aggregate_key: aggregateKey,
      fifo_sequence: sequence,
      state: 'queued',
      lineage_id: id,
      created_at: now,
      updated_at: now
    };
    await this.put(record);
    return record;
  }

  async list(filter: { state?: OutboxState; aggregateKey?: string } = {}): Promise<OutboxRecord[]> {
    const rows = [...memory.values()].filter((row) => row.actor_id === this.actorId && row.project_id === this.projectId
      && (!filter.state || row.state === filter.state) && (!filter.aggregateKey || row.aggregate_key === filter.aggregateKey));
    try {
      const db = await openOfflineDb(this.dbName);
      const values = await db.getAll('outbox');
      db.close();
      for (const row of values) {
        if (row.actor_id === this.actorId && row.project_id === this.projectId
          && (!filter.state || row.state === filter.state) && (!filter.aggregateKey || row.aggregate_key === filter.aggregateKey)) rows.push(row);
      }
    } catch { /* memory fallback keeps tests and private browsing deterministic */ }
    const deduped = new Map(rows.map((row) => [row.key, row]));
    return [...deduped.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.fifo_sequence - b.fifo_sequence);
  }

  async get(key: string): Promise<OutboxRecord | undefined> {
    const local = memory.get(key);
    if (local) return local;
    try {
      const db = await openOfflineDb(this.dbName);
      const value = await db.get('outbox', key);
      db.close();
      return value;
    } catch { return undefined; }
  }

  async flush(send: OutboxSender, options: { concurrency?: number } = {}): Promise<OutboxRecord[]> {
    const limit = Math.max(1, Math.min(3, Number(options.concurrency || 3)));
    const allRows = await this.list();
    const blockedAggregates = new Set(allRows.filter((row) => row.state === 'blocked').map((row) => row.aggregate_key));
    const grouped = new Map<string, OutboxRecord[]>();
    for (const row of allRows.filter((item) => item.state === 'queued' && !blockedAggregates.has(item.aggregate_key))) {
      const group = grouped.get(row.aggregate_key) || [];
      group.push(row); grouped.set(row.aggregate_key, group);
    }
    const aggregates = [...grouped.values()].map((rows) => rows.sort((a, b) => a.fifo_sequence - b.fifo_sequence));
    const completed: OutboxRecord[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < aggregates.length) {
        const rows = aggregates[cursor++];
        for (const row of rows) {
          await this.put({ ...row, state: 'sending', updated_at: new Date().toISOString() });
          try {
            const response = await send(row);
            if (response.status === 409) {
              const details = (response.body as { error?: { details?: { actual_revision?: number } } } | undefined)?.error?.details;
              const blocked = { ...row, state: 'blocked' as const, error_code: 'revision_conflict', server_revision: Number(details?.actual_revision ?? row.expected_revision ?? 0), updated_at: new Date().toISOString() };
              await this.put(blocked); completed.push(blocked); break;
            }
            if (response.status >= 400) {
              const failed = { ...row, state: 'failed' as const, error_code: `http_${response.status}`, updated_at: new Date().toISOString() };
              await this.put(failed); completed.push(failed); break;
            }
            const succeeded = { ...row, state: 'succeeded' as const, updated_at: new Date().toISOString() };
            await this.put(succeeded); completed.push(succeeded);
          } catch {
            await this.put({ ...row, state: 'queued', updated_at: new Date().toISOString() });
            break;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, aggregates.length) }, () => worker()));
    return completed.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.fifo_sequence - b.fifo_sequence);
  }

  async rebase(key: string, input: { expectedRevision: number; body: unknown }): Promise<OutboxRecord> {
    const original = await this.get(key);
    if (!original || original.actor_id !== this.actorId || original.project_id !== this.projectId) throw new Error('outbox_record_not_found');
    const successor = await this.enqueue({ command: original.command, method: original.method, path: original.path, body: input.body, expectedRevision: input.expectedRevision, aggregateKey: original.aggregate_key });
    await this.put({ ...original, state: 'superseded', successor_key: successor.key, updated_at: new Date().toISOString() });
    return successor;
  }

  async discard(aggregateKey: string): Promise<number> {
    const rows = await this.list({ aggregateKey });
    for (const row of rows.filter((item) => ['queued', 'blocked'].includes(item.state))) await this.put({ ...row, state: 'discarded', updated_at: new Date().toISOString() });
    return rows.filter((item) => ['queued', 'blocked'].includes(item.state)).length;
  }

  private async put(row: OutboxRecord): Promise<void> {
    memory.set(row.key, row);
    try {
      const db = await openOfflineDb(this.dbName);
      await db.put('outbox', row);
      db.close();
    } catch { /* private browsing fallback */ }
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('aiws:outbox-change'));
  }

}

function randomId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${uuid}`;
}

export async function enqueueOfflineCommand(scope: { actorId: string; teamId: string; projectId: string }, input: Parameters<OfflineOutbox['enqueue']>[0]): Promise<OutboxRecord> {
  return new OfflineOutbox(scope).enqueue(input);
}
