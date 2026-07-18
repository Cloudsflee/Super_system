import { createHash, randomUUID } from 'node:crypto';
import { TRACE_EVENTS } from './enums.mjs';

export function id(prefix = 'id') { return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 18)}`; }
export function now() { return new Date().toISOString(); }
export function clone(value) { return JSON.parse(JSON.stringify(value)); }
export function hashString(input) { return createHash('sha256').update(String(input)).digest('hex'); }
export function estimateTokens(text) { return Math.ceil(String(text || '').length / 3.5); }
export function pick(obj, fields) { return Object.fromEntries(fields.map((f) => [f, obj?.[f]])); }
export function unique(list) { return [...new Set((list || []).filter(Boolean))]; }
export function slugify(input, fallback = 'task') {
  const slug = String(input || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || fallback;
}
export function maskSecret(text) {
  if (text === undefined || text === null) return text;
  let out = String(text);
  if (process.env.GITHUB_TOKEN) out = out.split(process.env.GITHUB_TOKEN).join('***MASKED_GITHUB_TOKEN***');
  return out.replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***MASKED_GITHUB_TOKEN***')
    .replace(/\baiws_mcp_[A-Za-z0-9_-]{30,}\b/g, '***MASKED_MCP_TOKEN***')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '***MASKED_PRIVATE_KEY***')
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g, '***MASKED_API_KEY***')
    .replace(/(authorization|bearer|token)\s*[:=]\s*[^'"\s]+/gi, '$1=***MASKED***');
}
export function maskSecretsDeep(value) {
  if (typeof value === 'string') return maskSecret(value);
  if (Array.isArray(value)) return value.map(maskSecretsDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretField(k) ? '***MASKED***' : maskSecretsDeep(v)]));
  }
  return value;
}
function secretField(key) { return /^(authorization|token|password|api_key|private_key|client_secret|webhook_secret|access_token|refresh_token|id_token|session_token_hash)$/i.test(key) || /_(?:password|secret|access_token|refresh_token)$/i.test(key); }
export function makeTrace(event_type, payload = {}, actor = {}) {
  if (!TRACE_EVENTS.includes(event_type)) throw new Error(`未知 TraceEvent 类型: ${event_type}`);
  return {
    id: id('trc'), event_type, actor_type: actor.type || 'system', actor_id: actor.id || null,
    project_id: payload.project_id || null, workspace_id: payload.workspace_id || null, node_id: payload.node_id || null,
    run_id: payload.run_id || null, target_type: payload.target_type || null, target_id: payload.target_id || null,
    summary: maskSecret(payload.summary || event_type), data: maskSecretsDeep(payload.data || {}), raw_file_ref_id: payload.raw_file_ref_id || null,
    occurred_at: now()
  };
}
