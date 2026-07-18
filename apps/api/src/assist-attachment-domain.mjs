import { HttpError } from './http.mjs';

export function publicAttachment(item) {
  return { id: item.id, project_id: item.project_id, session_id: item.session_id || null, turn_id: item.turn_id || null, kind: item.kind, title: item.title || item.label || item.kind, original_filename: item.original_filename || item.title || null, file_ref_id: item.file_ref_id || null, relative_path: item.relative_path || null, url: item.url || null, content_type: item.detected_mime_type || item.content_type || null, client_mime_type: item.client_mime_type || item.content_type || null, detected_mime_type: item.detected_mime_type || item.content_type || null, preview_kind: item.preview_kind || 'metadata', storage_status: item.storage_status || 'metadata_only', content_deleted_at: item.content_deleted_at || null, size_bytes: item.size_bytes || 0, sha256: item.sha256 || null, selection: item.selection || null, model_policy: item.model_policy || 'artifact_only', status: item.status, created_at: item.created_at, updated_at: item.updated_at };
}

export function normalizeAttachmentIds(state, session, values) {
  if (!Array.isArray(values) || values.length > 20) throw new HttpError(400, { error: 'invalid_attachment_ids' });
  const unique = [...new Set(values.map(String))];
  for (const key of unique) if (!state.attachments.some((item) => item.id === key && item.session_id === session.id && item.project_id === session.project_id && !item.deleted_at && !item.content_deleted_at && item.storage_status !== 'deleted')) throw new HttpError(404, { error: 'attachment_not_found', attachment_id: key });
  return unique;
}

export function normalizeAttachmentKind(value) {
  const kind = String(value || 'project_attachment');
  if (!['project_file', 'monaco_file', 'selection', 'image', 'project_attachment', 'artifact', 'text', 'url'].includes(kind)) throw new HttpError(400, { error: 'unsupported_attachment_kind' });
  return kind;
}

export function modelPolicy(kind, type) {
  if (kind === 'artifact') return 'artifact_only';
  if (kind === 'image' || /^image\/(?:png|jpeg|webp|gif)$/i.test(type)) return 'image';
  if (kind === 'selection' || kind === 'text' || kind === 'url' || /^text\//i.test(type) || /(?:json|javascript|typescript|xml|yaml|markdown)$/i.test(type)) return 'injectable';
  return 'artifact_only';
}

export function safeRelativePath(value) {
  const raw = String(value || '').replaceAll('\\', '/').trim();
  if (!raw || raw.length > 2000 || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.split('/').includes('..') || /[\0\r\n]/.test(raw)) throw new HttpError(400, { error: 'invalid_attachment_path' });
  return raw.replace(/^\.\//, '');
}

export function normalizeSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const start = boundedInt(value.start_line, 1, 10_000_000, 1);
  return { start_line: start, start_column: boundedInt(value.start_column, 1, 1_000_000, 1), end_line: boundedInt(value.end_line, 1, 10_000_000, start), end_column: boundedInt(value.end_column, 1, 1_000_000, 1) };
}

function boundedInt(value, min, max, fallback) { const number = Number(value); return Number.isInteger(number) && number >= min && number <= max ? number : fallback; }
