import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

export class DatabaseClient {
  constructor(file) {
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.pending = new Map();
    this.worker = new Worker(new URL('./db-worker.mjs', import.meta.url), {
      type: 'module',
      workerData: { file: this.file }
    });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.on('message', (message) => {
      if (message.type === 'ready') {
        this.resolveReady(message);
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(Object.assign(new Error(message.error?.message || 'database operation failed'), message.error));
    });
    this.worker.on('error', (error) => {
      this.rejectReady(error);
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    });
  }

  async request(message) {
    await this.ready;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
    });
  }

  query(sql, params = []) { return this.request({ op: 'query', sql, params }); }
  get(sql, params = []) { return this.request({ op: 'get', sql, params }); }
  run(sql, params = []) { return this.request({ op: 'run', sql, params }); }
  exec(sql) { return this.request({ op: 'exec', sql }); }
  transaction(statements) { return this.request({ op: 'transaction', statements }); }
  integrity() { return this.request({ op: 'integrity' }); }

  async close() {
    if (!this.worker) return;
    try { await this.request({ op: 'close' }); } finally {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

export async function openDatabase(file) {
  const database = new DatabaseClient(file);
  await database.ready;
  return database;
}
