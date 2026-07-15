import { maskSecretsDeep } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { cleanText } from './assist-v3-domain.mjs';
import { canonicalJson, sha256 } from './state-migration-v14.mjs';

const MAX_LEDGER_VALUE_BYTES = 64 * 1024;

export function canonicalHash(value) { return sha256(Buffer.from(canonicalJson(value))); }
export function assertLedgerValue(value) { if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_LEDGER_VALUE_BYTES) throw new HttpError(413, { error: 'assist_operation_value_too_large', max_bytes: MAX_LEDGER_VALUE_BYTES }); }
export function sanitizeLedgerValue(value) { const safe = maskSecretsDeep(value); if (JSON.stringify(safe).includes('***MASKED')) throw new HttpError(409, { error: 'assist_operation_secret_value_forbidden' }); return safe; }
export function validateToolValue(tool, value, control) { if (tool === 'select_tab') return control.id; if (value === undefined) throw new HttpError(400, { error: 'assist_dynamic_tool_value_required' }); const safe = sanitizeLedgerValue(value); if (control.allowedValues?.length && !control.allowedValues.some((item) => canonicalJson(item) === canonicalJson(safe))) throw new HttpError(400, { error: 'assist_dynamic_tool_value_not_allowed' }); return safe; }
export function rejectDangerousArguments(value) { if (Array.isArray(value)) { for (const item of value) if (item && typeof item === 'object') rejectDangerousArguments(item); return; } for (const [key, item] of Object.entries(value || {})) { if (/selector|xpath|script|javascript|html|dom|credential|secret|token/i.test(key)) throw new HttpError(400, { error: 'assist_dynamic_tool_unsafe_argument', field: key }); if (item && typeof item === 'object') rejectDangerousArguments(item); } }
export function pageIdentity(viewContext) { return { route: cleanText(viewContext?.route, 2_000), surfaceId: cleanText(viewContext?.surface?.id || viewContext?.surface?.surface_id, 200) || null, revision: cleanText(viewContext?.surface?.revision, 200), browserInstanceId: cleanText(viewContext?.browser_instance_id || viewContext?.surface?.browser_instance_id, 200) || null }; }
export function exposedControls(viewContext) {
  const surface = viewContext?.surface && typeof viewContext.surface === 'object' ? viewContext.surface : {};
  const values = [
    ...normalizeControlList(surface.fields, 'field'), ...normalizeControlList(surface.filters, 'filter'), ...normalizeControlList(surface.tabs, 'tab'),
    ...normalizeControlList(surface.controls, null)
  ];
  const seen = new Set(); return values.filter((item) => { if (seen.has(item.id) || item.sensitivity === 'secret' || item.readable === false || item.reversible === false) return false; seen.add(item.id); return true; });
}
function normalizeControlList(values, fallbackKind) { if (!Array.isArray(values)) return []; return values.slice(0, 200).flatMap((value) => { const controlId = cleanText(value?.id || value?.target_id, 128), kind = fallbackKind || cleanText(value?.kind, 20); if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(controlId) || !['field', 'filter', 'tab'].includes(kind)) return []; return [{ id: controlId, kind, label: cleanText(value.label, 200) || controlId, allowedValues: Array.isArray(value.allowedValues || value.values) ? (value.allowedValues || value.values).slice(0, 200).map(sanitizeLedgerValue) : null, risk: cleanText(value.risk, 30) || 'low', sensitivity: cleanText(value.sensitivity, 30) || 'public', readable: value.readable !== false, reversible: value.reversible !== false }]; }); }
