import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import {
  CONTEXT_SEARCH_INDEX_SCHEMA,
  contextIndexableNodes,
  contextSearchIndexSnapshotHash,
  loadContextSearchIndex
} from '../../../packages/system-context/src/index.mjs';
import { now } from '../../../packages/shared/index.mjs';
import { readCasBlob } from './asset-cas.mjs';
import { CONTEXT_INDEX_DIR } from './config.mjs';

export const CONTEXT_INDEX_FILE = path.join(CONTEXT_INDEX_DIR, 'minisearch-v2.json');

let cache = null;
let initialized = false;
let initializationPromise = null;
let buildPromise = null;
let status = {
  state: 'empty',
  snapshot_hash: null,
  node_count: 0,
  rebuilt_at: null,
  generation: 0,
  error_code: null
};

export function initializeContextIndexRuntime() {
  if (initialized) return Promise.resolve(contextIndexRuntimeStatus());
  if (initializationPromise) return initializationPromise;
  initializationPromise = recoverContextIndexFiles()
    .then((result) => {
      initialized = true;
      initializationPromise = null;
      return result;
    })
    .catch((error) => {
      initializationPromise = null;
      status = { ...status, state: 'failed', error_code: safeCode(error) };
      throw error;
    });
  return initializationPromise;
}

export async function ensureContextSearchIndex(state) {
  await initializeContextIndexRuntime();
  const nodes = contextIndexableNodes(state.context_nodes),
    snapshotHash = contextSearchIndexSnapshotHash({
      nodes: state.context_nodes,
      documentVersions: state.context_document_versions,
      edges: state.context_edges
    });
  if (cache?.snapshot_hash === snapshotHash) return reuseCachedIndex(state, nodes, snapshotHash);
  if (buildPromise) {
    await buildPromise;
    if (cache?.snapshot_hash === snapshotHash)
      return { index: cache.index, status: contextIndexRuntimeStatus(), reused: true };
  }
  try {
    const stored = JSON.parse(await fsp.readFile(CONTEXT_INDEX_FILE, 'utf8'));
    if (stored.schema_version === CONTEXT_SEARCH_INDEX_SCHEMA && stored.snapshot_hash === snapshotHash) {
      const index = loadContextSearchIndex(stored);
      cache = { snapshot_hash: snapshotHash, index };
      return reuseCachedIndex(state, nodes, snapshotHash);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') status = { ...status, state: 'rebuilding', error_code: 'context_index_corrupt' };
  }

  buildPromise = buildContextIndex(state, nodes, snapshotHash);
  try {
    return await buildPromise;
  } finally {
    buildPromise = null;
  }
}

export function contextIndexRuntimeStatus() {
  return { ...status };
}

export function invalidateContextIndexRuntime() {
  cache = null;
}

async function buildContextIndex(state, nodes, snapshotHash) {
  let temporary = null;
  status = { ...status, state: 'rebuilding', snapshot_hash: snapshotHash, error_code: null };
  try {
    const currentVersionIds = new Set(nodes.map((node) => node.current_version_id)),
      documentVersions = state.context_document_versions.filter((version) => currentVersionIds.has(version.id)),
      documents = await Promise.all(
        documentVersions.map(async (version) => ({
          id: version.id,
          markdown: (await readCasBlob(version.cas_ref)).toString('utf8')
        }))
      ),
      built = await requestIndexBuild({
        nodes: state.context_nodes,
        documentVersions,
        edges: state.context_edges,
        documents,
        snapshotHash
      });
    await fsp.mkdir(CONTEXT_INDEX_DIR, { recursive: true, mode: 0o700 });
    temporary = `${CONTEXT_INDEX_FILE}.${process.pid}.${randomUUID()}.tmp`;
    await writeFileAndSync(temporary, JSON.stringify(built.payload));
    await replaceFile(temporary, CONTEXT_INDEX_FILE);
    temporary = null;
    await syncDirectory(CONTEXT_INDEX_DIR);
    const index = loadContextSearchIndex(built.payload),
      rebuiltAt = now();
    cache = { snapshot_hash: snapshotHash, index };
    status = {
      state: 'ready',
      snapshot_hash: snapshotHash,
      node_count: built.node_count,
      rebuilt_at: rebuiltAt,
      generation: Number(status.generation || 0) + 1,
      error_code: null
    };
    return { index, status: contextIndexRuntimeStatus(), reused: false };
  } catch (error) {
    if (temporary) await fsp.rm(temporary, { force: true }).catch(() => undefined);
    status = {
      ...status,
      state: 'failed',
      snapshot_hash: snapshotHash,
      node_count: nodes.length,
      rebuilt_at: null,
      error_code: safeCode(error)
    };
    throw error;
  }
}

async function recoverContextIndexFiles() {
  await fsp.mkdir(CONTEXT_INDEX_DIR, { recursive: true, mode: 0o700 });
  const prefix = `${path.basename(CONTEXT_INDEX_FILE)}.`,
    temporaryFiles = (await fsp.readdir(CONTEXT_INDEX_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.tmp'))
      .map((entry) => path.join(CONTEXT_INDEX_DIR, entry.name));
  if (await exists(CONTEXT_INDEX_FILE)) {
    await Promise.all(temporaryFiles.map((file) => fsp.rm(file, { force: true })));
    try {
      const payload = JSON.parse(await fsp.readFile(CONTEXT_INDEX_FILE, 'utf8'));
      if (payload.schema_version !== CONTEXT_SEARCH_INDEX_SCHEMA) throw indexError('context_index_schema_invalid');
      const index = loadContextSearchIndex(payload);
      cache = { snapshot_hash: payload.snapshot_hash, index };
      status = {
        ...status,
        state: 'stale',
        snapshot_hash: payload.snapshot_hash || null,
        error_code: null
      };
    } catch (error) {
      status = { ...status, state: 'failed', error_code: safeCode(error) };
    }
    return contextIndexRuntimeStatus();
  }

  const recoverable = [];
  for (const file of temporaryFiles) {
    try {
      const payload = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (payload.schema_version !== CONTEXT_SEARCH_INDEX_SCHEMA) throw indexError('context_index_schema_invalid');
      loadContextSearchIndex(payload);
      recoverable.push({ file, payload });
    } catch {
      await fsp.rm(file, { force: true });
    }
  }
  if (recoverable.length > 1)
    throw indexError('context_index_recovery_ambiguous', {
      files: recoverable.map((item) => path.basename(item.file))
    });
  if (recoverable.length === 1) {
    await fsp.rename(recoverable[0].file, CONTEXT_INDEX_FILE);
    await syncDirectory(CONTEXT_INDEX_DIR);
    status = {
      ...status,
      state: 'stale',
      snapshot_hash: recoverable[0].payload.snapshot_hash || null,
      error_code: null
    };
    cache = {
      snapshot_hash: recoverable[0].payload.snapshot_hash,
      index: loadContextSearchIndex(recoverable[0].payload)
    };
  }
  return contextIndexRuntimeStatus();
}

function reuseCachedIndex(state, nodes, snapshotHash) {
  const runtimeIndex = state.context_projector_status?.index;
  status = {
    ...status,
    state: 'ready',
    snapshot_hash: snapshotHash,
    node_count: nodes.length,
    rebuilt_at:
      runtimeIndex?.snapshot_hash === snapshotHash ? runtimeIndex.rebuilt_at || status.rebuilt_at || null : null,
    error_code: null
  };
  return { index: cache.index, status: contextIndexRuntimeStatus(), reused: true };
}

function requestIndexBuild(payload) {
  const worker = new Worker(new URL('./context-projection-worker.mjs', import.meta.url));
  worker.unref?.();
  const id = `${process.pid}:${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const finish = async (error, value) => {
      worker.removeAllListeners();
      await worker.terminate().catch(() => undefined);
      if (error) reject(error);
      else resolve(value);
    };
    worker.once('message', (message) => {
      if (message.id !== id) return;
      if (message.ok) void finish(null, message.value);
      else void finish(indexError(message.error?.code || 'context_index_worker_failed'));
    });
    worker.once('error', (error) => void finish(error));
    worker.once('exit', (code) => {
      if (code !== 0) void finish(indexError('context_index_worker_exited', { exit_code: code }));
    });
    worker.postMessage({ id, type: 'index', payload });
  });
}

async function writeFileAndSync(file, content) {
  const handle = await fsp.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceFile(source, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1))));
    }
  }
}

async function syncDirectory(directory) {
  const handle = await fsp.open(directory, 'r').catch(() => null);
  if (!handle) return;
  try {
    await handle.sync();
  } catch {
  } finally {
    await handle.close();
  }
}

async function exists(file) {
  return fsp.stat(file).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
}

function indexError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function safeCode(error) {
  return /^[a-z0-9_.-]{1,120}$/i.test(String(error?.code || '')) ? String(error.code) : 'context_index_rebuild_failed';
}
