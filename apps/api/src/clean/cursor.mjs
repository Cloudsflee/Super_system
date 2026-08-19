import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, sha256Hex } from './canonical.mjs';

export class CursorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CursorError';
    this.code = code;
    this.status = code === 'cursor_expired' ? 410 : 400;
    this.retryable = false;
    this.details = details;
  }
}

export function queryHash(value) {
  return sha256Hex(canonicalJson(value));
}

export function encodeCursor({ actorId, projectId = null, stream, sequence = 0, query = {}, expiresAt, secret = 'v3-clean-local-cursor' }) {
  if (!actorId) throw new CursorError('cursor_invalid', 'cursor actor is required');
  if (!Number.isInteger(Number(sequence)) || Number(sequence) < 0) throw new CursorError('cursor_invalid', 'cursor sequence is invalid');
  const expiry = expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  if (!Number.isFinite(Date.parse(expiry))) throw new CursorError('cursor_invalid', 'cursor expiry is invalid');
  const payload = {
    version: 1,
    actor_id: String(actorId),
    project_id: projectId == null ? null : String(projectId),
    stream: String(stream || 'events'),
    sequence: Number(sequence) || 0,
    query_hash: queryHash(query),
    expires_at: expiry
  };
  const body = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
  const signature = sign(body, secret);
  return `c1.${body}.${signature}`;
}

export function decodeCursor(token, { actorId, projectId = null, stream, query = {}, secret = 'v3-clean-local-cursor', now = new Date() } = {}) {
  if (!token || typeof token !== 'string') throw new CursorError('cursor_invalid', 'cursor is required');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'c1') throw new CursorError('cursor_invalid', 'cursor format is invalid');
  const expected = sign(parts[1], secret);
  if (!safeEqual(parts[2], expected)) throw new CursorError('cursor_invalid', 'cursor signature is invalid');
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw new CursorError('cursor_invalid', 'cursor payload is invalid'); }
  if (payload.version !== 1 || !Number.isInteger(payload.sequence) || payload.sequence < 0 || !Number.isFinite(Date.parse(payload.expires_at))) throw new CursorError('cursor_invalid', 'cursor payload is invalid');
  if (String(payload.actor_id) !== String(actorId) || (payload.project_id || null) !== (projectId || null)) {
    throw new CursorError('cursor_scope_mismatch', 'cursor belongs to another scope', { actor_id: payload.actor_id, project_id: payload.project_id });
  }
  if (stream && payload.stream !== String(stream)) throw new CursorError('cursor_scope_mismatch', 'cursor belongs to another stream');
  if (payload.query_hash !== queryHash(query)) throw new CursorError('cursor_scope_mismatch', 'cursor query binding does not match');
  if (Date.parse(payload.expires_at) <= (now instanceof Date ? now.valueOf() : Date.parse(now))) {
    const restart = encodeCursor({ actorId, projectId, stream: payload.stream, sequence: 0, query, expiresAt: restartExpiry(now), secret });
    throw new CursorError('cursor_expired', 'cursor has expired', { restart_cursor: restart });
  }
  return payload;
}

function restartExpiry(now) {
  const base = now instanceof Date ? now.valueOf() : Date.parse(now);
  return new Date((Number.isFinite(base) ? base : Date.now()) + 24 * 60 * 60 * 1000).toISOString();
}

function sign(body, secret) {
  return createHmac('sha256', String(secret)).update(body).digest('base64url');
}

function safeEqual(left, right) {
  try {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}
