import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, mutateOfflineV2, normalizeV2Path } from '../api';
import { canonicalJson, canonicalSha256 } from '../offline/canonical';
import { deleteOfflineDb, openOfflineDb } from '../offline/db';
import { OFFLINE_COMMAND_ALLOWLIST, OfflineOutbox, isOfflineCommandAllowed, shouldQueueOffline } from '../offline/outbox';
import { isRetryableQueryError, workspaceQueryKey } from '../query';

const databases: string[] = [];
const scope = (suffix: string) => ({ actorId: `actor-${suffix}`, teamId: 'team-1', projectId: `project-${suffix}`, dbName: `aiws-p9-${suffix}-${crypto.randomUUID()}` });

afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  await Promise.all(databases.splice(0).map((name) => deleteOfflineDb(name)));
});

describe('P9 canonical and scoped storage', () => {
  it('matches the server canonical UTF-8 bytes and SHA-256', async () => {
    const value = { z: -0, a: [3, { b: 2, a: 1 }], skip: undefined };
    expect(canonicalJson(value)).toBe('{"a":[3,{"a":1,"b":2}],"z":0}');
    expect(await canonicalSha256(value)).toBe('1aa4b6524c13a83dc0d9565aaac9bbc30bed70589adf699f4f66f656d9e4328e');
  });

  it('creates only cursor and outbox stores', async () => {
    const name = `aiws-p9-schema-${crypto.randomUUID()}`; databases.push(name);
    const db = await openOfflineDb(name);
    expect([...db.objectStoreNames].sort()).toEqual(['cursors', 'outbox']);
    db.close();
  });

  it('fixes the low-risk command allowlist and scope key shape', () => {
    expect(OFFLINE_COMMAND_ALLOWLIST).toEqual(['project.update', 'brief.create', 'workflow.revise', 'context.selection.create', 'assist.goal.update', 'outcome.requirement.create']);
    expect(isOfflineCommandAllowed('delivery.submit')).toBe(false);
    expect(workspaceQueryKey({ actorId: 'a', teamId: 't', projectId: 'p' }, 'brief', { revision: 2 })).toEqual(['v2', 'a', 't', 'p', 'brief', { revision: 2 }]);
  });
});

describe('P9 outbox scheduling', () => {
  it('restores after a new instance, preserves aggregate FIFO, and caps aggregate concurrency at three', async () => {
    const options = scope('fifo'); databases.push(options.dbName);
    const first = new OfflineOutbox(options);
    for (const aggregate of ['a', 'b', 'c', 'd']) {
      await first.enqueue({ command: 'project.update', method: 'PATCH', path: `/api/v2/projects/${aggregate}`, body: { aggregate, n: 1 }, expectedRevision: 1, aggregateKey: aggregate });
      await first.enqueue({ command: 'project.update', method: 'PATCH', path: `/api/v2/projects/${aggregate}`, body: { aggregate, n: 2 }, expectedRevision: 2, aggregateKey: aggregate });
    }
    const restored = new OfflineOutbox(options);
    expect(await restored.list()).toHaveLength(8);
    let active = 0; let maxActive = 0;
    const calls: string[] = [];
    await restored.flush(async (record) => {
      active += 1; maxActive = Math.max(maxActive, active); calls.push(`${record.aggregate_key}:${record.fifo_sequence}`);
      await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1;
      return { status: 200 };
    });
    expect(maxActive).toBe(3);
    for (const aggregate of ['a', 'b', 'c', 'd']) expect(calls.filter((value) => value.startsWith(`${aggregate}:`))).toEqual([`${aggregate}:1`, `${aggregate}:2`]);
  });

  it('blocks only the conflicted aggregate and creates explicit rebase/discard lineage', async () => {
    const options = scope('conflict'); databases.push(options.dbName);
    const outbox = new OfflineOutbox(options);
    await outbox.enqueue({ command: 'brief.create', method: 'POST', path: '/api/v2/projects/p/briefs', body: { objective: 'one' }, expectedRevision: 1, aggregateKey: 'brief' });
    await outbox.enqueue({ command: 'brief.create', method: 'POST', path: '/api/v2/projects/p/briefs', body: { objective: 'two' }, expectedRevision: 2, aggregateKey: 'brief' });
    await outbox.enqueue({ command: 'workflow.revise', method: 'POST', path: '/api/v2/projects/p/workflow-draft', body: { nodes: [] }, expectedRevision: 1, aggregateKey: 'workflow' });
    await outbox.flush(async (record) => record.aggregate_key === 'brief'
      ? { status: 409, body: { error: { details: { actual_revision: 7 } } } }
      : { status: 200 });
    const rows = await outbox.list();
    const blocked = rows.find((row) => row.state === 'blocked')!;
    expect(blocked.server_revision).toBe(7);
    expect(rows.find((row) => row.aggregate_key === 'brief' && row.fifo_sequence === 2)?.state).toBe('queued');
    expect(rows.find((row) => row.aggregate_key === 'workflow')?.state).toBe('succeeded');
    const successor = await outbox.rebase(blocked.key, { expectedRevision: 7, body: { objective: 'rebased' } });
    expect(successor.idempotency_key).not.toBe(blocked.idempotency_key);
    expect((await outbox.get(blocked.key))?.state).toBe('superseded');
    expect(await outbox.discard('brief')).toBeGreaterThan(0);
    expect((await outbox.list()).filter((row) => row.aggregate_key === 'brief' && ['queued', 'blocked'].includes(row.state))).toHaveLength(0);
  });

  it('isolates actor/project scopes and never queues HTTP responses', async () => {
    const leftOptions = scope('left'); const rightOptions = scope('right'); databases.push(leftOptions.dbName, rightOptions.dbName);
    const left = new OfflineOutbox(leftOptions); const right = new OfflineOutbox(rightOptions);
    await left.enqueue({ command: 'project.update', method: 'PATCH', path: '/api/v2/projects/left', body: {}, aggregateKey: 'left' });
    expect(await left.list()).toHaveLength(1);
    expect(await right.list()).toHaveLength(0);
    expect(shouldQueueOffline(new TypeError('fetch failed'))).toBe(true);
    expect(shouldQueueOffline(new ApiError(500, { error: { code: 'server', message: 'server', retryable: true, request_id: '', details: {} } }))).toBe(false);
    expect(isRetryableQueryError(new ApiError(500, { error: { code: 'server', message: 'server', retryable: true, request_id: '', details: {} } }))).toBe(true);
    expect(isRetryableQueryError(new ApiError(409, { error: { code: 'conflict', message: 'conflict', retryable: false, request_id: '', details: {} } }))).toBe(false);
  });
});

describe('strict v2 mutation boundary', () => {
  it('queues while the browser is offline and rejects retired paths', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const result = await mutateOfflineV2('/projects/p', { name: 'offline' }, 'PATCH', { command: 'project.update', scope: { actorId: 'actor-offline', teamId: 'team', projectId: 'p' }, aggregateKey: 'project:p', expectedRevision: 1 });
    expect('queued' in result).toBe(true);
    expect(normalizeV2Path('/projects/p')).toBe('/api/v2/projects/p');
    expect(() => normalizeV2Path('/api/v1/projects/p')).toThrow('retired_api_route');
  });
});
