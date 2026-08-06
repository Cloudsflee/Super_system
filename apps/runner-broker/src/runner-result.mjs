import { createHash } from 'node:crypto';

const EVENT_PHASES = Object.freeze({
  'thread.started': 'initializing',
  'turn.started': 'executing',
  'item.completed': 'executing',
  'turn.completed': 'finalizing',
  error: 'failed'
});
const RUNNER_ERROR_CODES = new Set([
  'runner_failed', 'runner_setup_failed', 'runner_spawn_failed', 'runner_deadline_exceeded',
  'runner_output_too_large', 'runner_unavailable', 'runner_digest_mismatch', 'runner_cli_version_mismatch',
  'credential_missing', 'model_mismatch', 'egress_unavailable', 'probe_timeout', 'provider_failed',
  'deterministic_adapter', 'broker_job_unknown', 'cancelled', 'evidence_diff_too_large', 'evidence_capture_failed',
  'evidence_output_missing', 'evidence_output_too_large', 'evidence_output_contains_secret',
  'diff_whitespace_error', 'diff_size_check_failed'
]);

export function normalizeRunnerErrorCode(value, fallback = 'runner_failed') {
  const code = String(value || '').slice(0, 120);
  return RUNNER_ERROR_CODES.has(code) ? code : fallback;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeSummary(value) {
  return String(value || '')
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240);
}

export function normalizeJsonl(value, options = {}) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8');
  const maxBytes = Number(options.maxBytes || 2 * 1024 * 1024);
  if (input.byteLength > maxBytes) throw new Error('runner_output_too_large');
  const events = [];
  let summary = '';
  let usage = {};
  const secrets = (Array.isArray(options.secrets) ? options.secrets : []).filter(Boolean).map(String);
  for (const line of input.toString('utf8').split(/\r?\n/).filter(Boolean).slice(0, 10_000)) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const originalType = String(item.type || 'unknown');
    const phase = EVENT_PHASES[originalType] || 'unknown';
    const eventText = String(item.message || item.summary || item.item?.text || item.error?.message || '');
    const eventSummary = safeSummary(secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), eventText));
    if (eventSummary) summary = eventSummary;
    if (item.usage && typeof item.usage === 'object') usage = Object.fromEntries(Object.entries(item.usage).filter(([, amount]) => Number.isFinite(amount)).slice(0, 16));
    events.push({
      type: Object.hasOwn(EVENT_PHASES, originalType) ? `runner.${originalType}` : 'runner.unknown',
      phase,
      exit_code: Number.isInteger(item.exit_code) ? item.exit_code : null,
      file_count: Array.isArray(item.changed_files) ? item.changed_files.length : null,
      summary: eventSummary,
      summary_sha256: hash(eventSummary)
    });
  }
  return { events, summary, usage };
}
