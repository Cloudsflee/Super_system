import { Worker } from 'node:worker_threads';

let worker = null;
let sequence = 0;
let initialized = false;
let closing = false;
let initializationError = null;
const pending = new Map();

export async function initializeStateStore(options) {
  if (initialized) return request('read');
  if (closing) throw stateStoreError('state_store_closing');
  ensureWorker();
  try {
    const result = await request('initialize', options);
    initialized = true;
    initializationError = null;
    return result;
  } catch (error) {
    initializationError = error;
    throw error;
  }
}

export function applyStateChanges(changes) {
  assertInitialized();
  return request('apply', changes);
}

export function replaceStoredState(payload) {
  assertInitialized();
  return request('replace', payload);
}

export function readStoredState() {
  assertInitialized();
  return request('read');
}

export function readStoredStateRevision() {
  assertInitialized();
  return request('revision');
}

export function stateStoreHealth() {
  if (!initialized) {
    return Promise.resolve({
      healthy: false,
      writable: false,
      schema_version: null,
      revision: null,
      integrity: initializationError?.code || (closing ? 'closing' : 'not_initialized')
    });
  }
  return request('health');
}

export function hasRunnableContextProjectionJobs(timestamp = new Date().toISOString()) {
  if (!initialized || closing) return Promise.resolve(false);
  return request('hasRunnableProjectionJobs', { timestamp });
}

export async function checkpointStateStore() {
  if (!initialized || closing) return { checkpointed: false };
  return request('checkpoint');
}

export async function closeStateStore() {
  if (!worker) return;
  if (closing) return closing;
  closing = (async () => {
    try {
      if (initialized) await request('close');
    } finally {
      initialized = false;
      const current = worker;
      worker = null;
      await current?.terminate().catch(() => undefined);
      for (const operation of pending.values()) operation.reject(stateStoreError('state_store_closed'));
      pending.clear();
    }
  })();
  try {
    await closing;
  } finally {
    closing = false;
  }
}

export function stateStoreRuntimeStatus() {
  return {
    initialized,
    closing: Boolean(closing),
    worker_thread_id: worker?.threadId || null,
    error_code: initializationError?.code || null
  };
}

function ensureWorker() {
  if (worker) return worker;
  const instance = new Worker(new URL('./state-store-worker.mjs', import.meta.url));
  instance.unref?.();
  worker = instance;
  instance.on('message', (message) => {
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.ok) operation.resolve(message.value);
    else operation.reject(stateStoreError(message.error?.code, message.error?.details, message.error?.message));
  });
  instance.on('error', failPending);
  instance.on('exit', (code) => {
    if (worker === instance) worker = null;
    if (code !== 0 && !closing) failPending(stateStoreError('state_store_worker_exited', { exit_code: code }));
  });
  return instance;
}

function request(type, payload = {}) {
  if (!worker) throw stateStoreError('state_store_worker_unavailable');
  const id = `${process.pid}:${++sequence}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

function failPending(error) {
  initializationError = error;
  for (const operation of pending.values()) operation.reject(error);
  pending.clear();
}

function assertInitialized() {
  if (!initialized) throw stateStoreError('state_store_not_initialized');
  if (closing) throw stateStoreError('state_store_closing');
}

function stateStoreError(code, details = {}, message = code) {
  const error = new Error(message || code);
  error.code = code || 'state_store_failed';
  error.details = details || {};
  return error;
}
