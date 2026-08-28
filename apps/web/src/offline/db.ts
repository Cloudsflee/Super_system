import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';

export const OFFLINE_DB_NAME = 'aiws-v3-clean-offline';
export const OFFLINE_DB_VERSION = 1;

export interface CursorRecord {
  key: string;
  actor_id: string;
  project_id: string;
  signed_cursor: string;
  last_global_sequence: number;
  last_project_sequence: number;
  updated_at: string;
}

export type OutboxState = 'queued' | 'sending' | 'succeeded' | 'blocked' | 'failed' | 'superseded' | 'discarded';

export interface OutboxRecord {
  key: string;
  id: string;
  actor_id: string;
  team_id: string;
  project_id: string;
  command: string;
  method: string;
  path: string;
  expected_revision: number | null;
  idempotency_key: string;
  canonical_body: string;
  canonical_hash: string;
  aggregate_key: string;
  fifo_sequence: number;
  state: OutboxState;
  lineage_id: string;
  successor_key?: string;
  error_code?: string;
  server_revision?: number;
  created_at: string;
  updated_at: string;
}

export interface OfflineSchema extends DBSchema {
  cursors: { key: string; value: CursorRecord; indexes: { 'by-scope': [string, string] } };
  outbox: { key: string; value: OutboxRecord; indexes: { 'by-state': OutboxState; 'by-aggregate': string; 'by-created': string } };
}

export async function openOfflineDb(name = OFFLINE_DB_NAME): Promise<IDBPDatabase<OfflineSchema>> {
  if (!('indexedDB' in globalThis)) throw new Error('indexeddb_unavailable');
  return openDB<OfflineSchema>(name, OFFLINE_DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('cursors')) {
        const store = db.createObjectStore('cursors', { keyPath: 'key' });
        store.createIndex('by-scope', ['actor_id', 'project_id']);
      }
      if (!db.objectStoreNames.contains('outbox')) {
        const store = db.createObjectStore('outbox', { keyPath: 'key' });
        store.createIndex('by-state', 'state');
        store.createIndex('by-aggregate', 'aggregate_key');
        store.createIndex('by-created', 'created_at');
      }
    }
  });
}

export async function deleteOfflineDb(name = OFFLINE_DB_NAME): Promise<void> {
  await deleteDB(name);
}
