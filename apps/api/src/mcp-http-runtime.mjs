import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { HttpError } from './http.mjs';
import { authenticateMcpRequest } from './mcp-client-service.mjs';
import { createAiwsMcpServer } from './mcp-server-factory.mjs';
import { runAsActor } from './actor-context.mjs';

const sessions = new Map();
let registry = null;

export function configureMcpHttpRuntime(value) {
  registry = value;
}

export async function handleMcpHttpRequest(req, res, body = undefined) {
  if (!registry) throw new Error('mcp_runtime_not_configured');
  const { client, release } = await authenticateMcpRequest(req);
  try {
    const sessionId = header(req, 'mcp-session-id');
    let record = sessionId ? sessions.get(sessionId) : null;
    if (record && record.client_id !== client.id) throw new HttpError(403, { error: 'mcp_session_client_mismatch' });
    if (!record && sessionId) throw new HttpError(404, { error: 'mcp_session_not_found' });
    if (!record) {
      if (req.method !== 'POST' || !isInitializeRequest(body))
        throw new HttpError(400, { error: 'mcp_initialize_required' });
      if ([...sessions.values()].filter((item) => item.client_id === client.id).length >= 20)
        throw new HttpError(429, { error: 'mcp_session_limit_exceeded' });
      record = await createSession(client);
    }
    record.last_seen_at = Date.now();
    await runAsActor(client.subject_user_id, () => record.transport.handleRequest(req, res, body));
  } finally {
    release();
  }
}

export async function closeMcpHttpRuntime() {
  const records = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(records.map((record) => record.dispose()));
}

export function mcpSessionSnapshot() {
  return [...sessions.entries()].map(([id, item]) => ({
    id,
    client_id: item.client_id,
    created_at: item.created_at,
    last_seen_at: item.last_seen_at
  }));
}

async function createSession(client) {
  let record;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => `mcp_${randomUUID().replaceAll('-', '')}`,
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      record.id = sessionId;
      sessions.set(sessionId, record);
    },
    onsessionclosed: (sessionId) => {
      void disposeSession(sessionId);
    }
  });
  const built = createAiwsMcpServer({ registry, client });
  record = {
    id: null,
    client_id: client.id,
    transport,
    server: built.server,
    created_at: Date.now(),
    last_seen_at: Date.now(),
    disposed: false,
    dispose: async () => {
      if (record.disposed) return;
      record.disposed = true;
      if (record.id) sessions.delete(record.id);
      await transport.close().catch(() => undefined);
      await built.dispose();
    }
  };
  transport.onclose = () => {
    if (record.id) sessions.delete(record.id);
  };
  await built.server.connect(transport);
  return record;
}

async function disposeSession(sessionId) {
  const record = sessions.get(sessionId);
  if (record) await record.dispose();
}
function header(req, name) {
  const value = req.headers[String(name).toLowerCase()];
  return Array.isArray(value) ? value[0] : value ? String(value) : null;
}

const sweeper = setInterval(() => {
  const cutoff = Date.now() - Number(process.env.AIWS_MCP_SESSION_IDLE_MS || 30 * 60 * 1000);
  for (const [sessionId, record] of sessions) if (record.last_seen_at < cutoff) void disposeSession(sessionId);
}, 60_000);
sweeper.unref?.();
