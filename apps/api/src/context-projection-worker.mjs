import { parentPort } from 'node:worker_threads';

import {
  buildContextSearchIndex,
  contextHash,
  renderContextMarkdown,
  serializeContextSearchIndex
} from '../../../packages/system-context/src/index.mjs';

if (!parentPort) throw new Error('context_projection_worker_parent_required');

parentPort.on('message', async ({ id, type, payload }) => {
  try {
    const value = type === 'render' ? render(payload) : type === 'index' ? await index(payload) : unknown(type);
    parentPort.postMessage({ id, ok: true, value });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: { code: safeCode(error?.code), message: String(error?.message || error).slice(0, 1000) }
    });
  }
});

function render(payload) {
  const markdown = renderContextMarkdown(payload);
  return { markdown, content_sha256: contextHash(Buffer.from(markdown, 'utf8')) };
}

async function index({ nodes, documentVersions, edges, documents, snapshotHash, rebuiltAt }) {
  const markdownByVersion = new Map(documents.map((item) => [item.id, item.markdown]));
  const built = await buildContextSearchIndex({
    nodes,
    documentVersions,
    edges,
    readDocument: async (version) => markdownByVersion.get(version.id) || ''
  });
  return {
    payload: serializeContextSearchIndex(built.index, { snapshotHash, rebuiltAt }),
    node_count: built.documents.length
  };
}

function unknown(type) {
  const error = new Error('context_projection_worker_message_invalid');
  error.code = 'context_projection_worker_message_invalid';
  error.type = type;
  throw error;
}

function safeCode(value) {
  return /^[a-z0-9_.-]{1,120}$/i.test(String(value || '')) ? String(value) : 'context_projection_worker_failed';
}
