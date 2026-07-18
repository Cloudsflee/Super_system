import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { signMcpGatewayRequest } from '../../../packages/mcp-bridge/src/index.mjs';
import { createForwardingServer } from './forwarder.mjs';

export class McpGatewayRuntime {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.windows = new Map();
    this.active = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  async handle(req, res, body) {
    const authorization = bearerAuthorization(req);
    const fingerprint = tokenFingerprint(authorization);
    const release = this.acquire(fingerprint);
    try {
      const sessionId = header(req, 'mcp-session-id');
      let record = sessionId ? this.sessions.get(sessionId) : null;
      if (record && record.fingerprint !== fingerprint) throw new GatewayError(403, 'mcp_gateway_session_client_mismatch');
      if (!record && sessionId) throw new GatewayError(404, 'mcp_gateway_session_not_found');
      if (!record) {
        if (req.method !== 'POST' || !isInitializeRequest(body)) throw new GatewayError(400, 'mcp_gateway_initialize_required');
        const count = [...this.sessions.values()].filter((item) => item.fingerprint === fingerprint).length;
        if (count >= this.config.maxSessionsPerClient) throw new GatewayError(429, 'mcp_gateway_session_limit_exceeded');
        record = await this.createSession({ authorization, fingerprint });
      }
      record.lastSeenAt = Date.now();
      try { await record.downstream.handleRequest(req, res, body); }
      catch (error) { if (!record.id) await record.dispose(); throw error; }
    } finally { release(); }
  }

  snapshot() {
    return { active_sessions: this.sessions.size, clients: new Set([...this.sessions.values()].map((item) => item.fingerprint)).size };
  }

  async close() {
    clearInterval(this.sweeper);
    const records = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(records.map((record) => record.dispose()));
  }

  async createSession({ authorization, fingerprint }) {
    const upstream = new Client({ name: 'aiws-mcp-gateway', version: '1.8.0' }, { capabilities: { resources: { subscribe: true } } });
    const upstreamTransport = new StreamableHTTPClientTransport(this.config.coreUrl, {
      requestInit: { headers: { authorization } },
      fetch: signedFetch(this.config.secret)
    });
    try { await upstream.connect(upstreamTransport); }
    catch (error) {
      await upstream.close().catch(() => undefined);
      throw upstreamError(error);
    }

    const local = createForwardingServer(upstream);
    let record;
    const downstream = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `mcpg_${randomUUID().replaceAll('-', '')}`,
      enableJsonResponse: true,
      onsessioninitialized: (id) => { record.id = id; this.sessions.set(id, record); },
      onsessionclosed: (id) => { void this.disposeSession(id); }
    });
    record = {
      id: null, fingerprint, upstream, upstreamTransport, local, downstream,
      createdAt: Date.now(), lastSeenAt: Date.now(), disposed: false,
      dispose: async () => {
        if (record.disposed) return;
        record.disposed = true;
        if (record.id) this.sessions.delete(record.id);
        await Promise.allSettled([upstreamTransport.terminateSession(), downstream.close()]);
        await Promise.allSettled([local.close(), upstream.close()]);
      }
    };
    downstream.onclose = () => { if (record.id) void this.disposeSession(record.id); };
    await local.connect(downstream);
    return record;
  }

  async disposeSession(id) {
    const record = this.sessions.get(id);
    if (record) await record.dispose();
  }

  acquire(fingerprint) {
    const now = Date.now(), cutoff = now - 60_000;
    const recent = (this.windows.get(fingerprint) || []).filter((item) => item > cutoff);
    if (recent.length >= this.config.rateLimitPerMinute) throw new GatewayError(429, 'mcp_gateway_rate_limit_exceeded');
    const active = Number(this.active.get(fingerprint) || 0);
    if (active >= this.config.concurrentLimit) throw new GatewayError(429, 'mcp_gateway_concurrency_limit_exceeded');
    recent.push(now); this.windows.set(fingerprint, recent); this.active.set(fingerprint, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = Math.max(0, Number(this.active.get(fingerprint) || 1) - 1);
      if (next) this.active.set(fingerprint, next); else this.active.delete(fingerprint);
    };
  }

  sweep() {
    const cutoff = Date.now() - this.config.idleMs;
    for (const [id, record] of this.sessions) if (record.lastSeenAt < cutoff) void this.disposeSession(id);
    for (const [key, values] of this.windows) {
      const recent = values.filter((item) => item > Date.now() - 60_000);
      if (recent.length) this.windows.set(key, recent); else this.windows.delete(key);
    }
  }
}

export class GatewayError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function bearerAuthorization(req) {
  const value = header(req, 'authorization');
  if (!/^Bearer\s+aiws_mcp_[A-Za-z0-9_-]{40,240}$/i.test(value)) throw new GatewayError(401, 'mcp_gateway_bearer_required');
  return value;
}

function tokenFingerprint(value) { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
function header(req, name) { const value = req.headers?.[name.toLowerCase()]; return Array.isArray(value) ? String(value[0] || '') : String(value || ''); }
function upstreamError(error) { return error instanceof StreamableHTTPError && error.code === 401 ? new GatewayError(401, 'mcp_gateway_upstream_unauthorized') : new GatewayError(502, 'mcp_gateway_upstream_unavailable'); }

function signedFetch(secret) {
  return async (input, init = {}) => {
    const source = input instanceof Request ? input : null;
    const url = new URL(source?.url || String(input));
    const method = String(init.method || source?.method || 'GET').toUpperCase();
    const headers = new Headers(source?.headers || {});
    new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
    const signed = signMcpGatewayRequest({ secret, method, url, authorization: headers.get('authorization') || '' });
    for (const [key, value] of Object.entries(signed)) headers.set(key, value);
    return globalThis.fetch(input, { ...init, method, headers });
  };
}
