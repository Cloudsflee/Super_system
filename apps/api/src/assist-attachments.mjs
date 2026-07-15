import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { ATTACHMENT_DIR, ATTACHMENT_TEMP_DIR } from './config.mjs';
import { HttpError } from './http.mjs';
import { mutate, owner, readState } from './state.mjs';
import { cleanText, modelPolicy, publicAttachment, readableProjectCwd, requireProject, requireSession } from './assist-v3-domain.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { previewKind, sniffMime } from './attachment-mime.mjs';
import { inspectOfficeArchive } from './office-archive.mjs';
import { assertProjectLifecycleIdle, withProjectLifecycleLock } from './project-lifecycle-operations.mjs';
export { previewKind, sniffMime } from './attachment-mime.mjs';
export const NORMAL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const MEDIA_ATTACHMENT_MAX_BYTES = 250 * 1024 * 1024;
export const DEFAULT_PROJECT_ATTACHMENT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const HEAD_BYTES = 8192;
const activeReservations = new Map();
const attachmentLocks = new Map();
export async function uploadV3Attachment(sessionId, req) { const snapshot = await readState(), session = requireSession(snapshot, sessionId), project = requireProject(snapshot, session.project_id); return withProjectLifecycleLock(project.id, () => uploadV3AttachmentLocked(sessionId, req)); }
async function uploadV3AttachmentLocked(sessionId, req) {
  const snapshot = await readState(), session = requireSession(snapshot, sessionId), project = assertProjectLifecycleIdle(requireProject(snapshot, session.project_id));
  const quota = projectAttachmentQuota(project), usedAtStart = projectAttachmentUsage(snapshot, project.id);
  if (usedAtStart >= quota) throw new HttpError(413, { error: 'attachment_quota_exceeded', quota_bytes: quota, used_bytes: usedAtStart });
  const attachmentId = id('att'), tempPath = path.join(ATTACHMENT_TEMP_DIR, `${attachmentId}-${Date.now()}.upload`);
  await fsp.mkdir(ATTACHMENT_TEMP_DIR, { recursive: true, mode: 0o700 });
  let reserved = 0, parsed, finalPath = null;
  try {
    parsed = await streamMultipartFile(req, tempPath, (delta) => {
      const current = activeReservations.get(project.id) || 0;
      if (usedAtStart + current + delta > quota) throw new HttpError(413, { error: 'attachment_quota_exceeded', quota_bytes: quota, used_bytes: usedAtStart + current });
      reserved += delta; activeReservations.set(project.id, current + delta);
    });
    const filename = safeOriginalFilename(parsed.filename), detectedMime = sniffMime(parsed.head, filename, parsed.clientMime);
    const isMedia = /^(?:audio|video)\//.test(detectedMime), confirmedMedia = parseBoolean(parsed.fields.media_confirmed || parsed.fields.confirm_media);
    const maxBytes = isMedia && confirmedMedia ? MEDIA_ATTACHMENT_MAX_BYTES : NORMAL_ATTACHMENT_MAX_BYTES;
    if (parsed.size > maxBytes) throw new HttpError(413, { error: isMedia ? 'attachment_media_confirmation_required' : 'attachment_too_large', max_bytes: maxBytes, detected_mime_type: detectedMime });
    if (detectedMime.includes('openxmlformats-officedocument')) await inspectOfficeArchive(tempPath, detectedMime);
    const finalDir = path.join(ATTACHMENT_DIR, safeStorageToken(project.id), attachmentId);
    finalPath = path.join(finalDir, parsed.sha256);
    await fsp.mkdir(finalDir, { recursive: true, mode: 0o700 });
    await syncFile(tempPath);
    await fsp.rename(tempPath, finalPath);
    await syncDirectory(finalDir);
    const created = await mutate((state) => {
      const actor = owner(state), currentSession = requireSession(state, session.id), currentProject = assertProjectLifecycleIdle(requireProject(state, project.id));
      const currentUsage = projectAttachmentUsage(state, currentProject.id), currentQuota = projectAttachmentQuota(currentProject);
      if (currentUsage + parsed.size > currentQuota) throw new HttpError(413, { error: 'attachment_quota_exceeded', quota_bytes: currentQuota, used_bytes: currentUsage });
      const preview = previewKind(detectedMime, filename);
      const attachment = {
        id: attachmentId, project_id: currentProject.id, session_id: currentSession.id, turn_id: null,
        kind: detectedMime.startsWith('image/') ? 'image' : 'project_attachment', title: cleanText(parsed.fields.title || filename, 200) || filename,
        original_filename: filename, file_ref_id: null, relative_path: null, managed_path: finalPath, url: null,
        content_type: detectedMime, client_mime_type: parsed.clientMime, detected_mime_type: detectedMime,
        preview_kind: preview, storage_status: 'ready', storage_error: null, content_deleted_at: null, deleted_at: null,
        size_bytes: parsed.size, sha256: parsed.sha256, text: null, selection: null,
        model_policy: modelPolicy(detectedMime.startsWith('image/') ? 'image' : 'project_attachment', detectedMime), status: 'ready',
        created_by_user_id: actor.id, created_at: now(), updated_at: now()
      };
      state.attachments.push(attachment); return publicAttachment(attachment);
    });
    return created;
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    if (finalPath) await fsp.rm(path.dirname(finalPath), { recursive: true, force: true }).catch(() => undefined);
    throw normalizeUploadError(error);
  } finally {
    const current = activeReservations.get(project.id) || 0, next = Math.max(0, current - reserved);
    if (next) activeReservations.set(project.id, next); else activeReservations.delete(project.id);
  }
}
export async function serveAttachmentContent(req, res, attachmentId, { download = false } = {}) {
  const state = await readState(), attachment = requireAttachment(state, attachmentId);
  if (attachment.content_deleted_at || attachment.storage_status === 'deleted') throw new HttpError(410, { error: 'attachment_content_deleted', attachment: publicAttachment(attachment) });
  const file = await verifiedManagedFile(attachment), stat = await fsp.stat(file), size = stat.size;
  if (size !== Number(attachment.size_bytes)) throw new HttpError(409, { error: 'attachment_storage_size_mismatch' });
  const etag = `"sha256-${attachment.sha256}"`;
  if (!req.headers.range && req.headers['if-none-match'] === etag) { res.writeHead(304, attachmentHeaders(attachment, { etag, download, length: 0 })); res.end(); return true; }
  let range;
  try { range = parseSingleRange(req.headers.range, size); }
  catch (error) {
    if (!(error instanceof HttpError) || error.status !== 416) throw error;
    res.writeHead(416, { 'content-type': 'application/json; charset=utf-8', 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(error.payload)); return true;
  }
  const status = range ? 206 : 200, start = range?.start ?? 0, end = range?.end ?? Math.max(0, size - 1), length = size ? end - start + 1 : 0;
  const headers = attachmentHeaders(attachment, { etag, download, length });
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (!size || req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file, { start, end }).pipe(res); return true;
}
export async function deleteV3Attachment(attachmentId, { confirmReferenced = false } = {}) { const snapshot = await readState(), attachment = requireAttachment(snapshot, attachmentId); return withProjectLifecycleLock(attachment.project_id, () => deleteV3AttachmentLocked(attachmentId, confirmReferenced)); }
async function deleteV3AttachmentLocked(attachmentId, confirmReferenced) {
  return withAttachmentLock(attachmentId, async () => {
    const snapshot = await readState(), attachment = requireAttachment(snapshot, attachmentId);
    assertProjectLifecycleIdle(requireProject(snapshot, attachment.project_id));
    const references = referencedTurns(snapshot, attachment);
    if (references.some((turn) => ['queued', 'preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping'].includes(turn.status))) throw new HttpError(423, { error: 'attachment_in_use' });
    if (references.length && !confirmReferenced) throw new HttpError(409, { error: 'attachment_delete_confirmation_required', referenced_turn_count: references.length });
    if (attachment.content_deleted_at || attachment.storage_status === 'deleted') return { attachment: publicAttachment(attachment), deleted: true, tombstone: true };
    const file = attachment.managed_path ? await verifiedManagedFile(attachment) : null;
    const staged = file ? `${file}.deleting-${process.pid}-${Date.now()}` : null;
    if (file) await fsp.rename(file, staged);
    let stateCommitted = false;
    try {
      const result = await mutate((state) => {
        const current = requireAttachment(state, attachment.id), currentReferences = referencedTurns(state, current);
        assertProjectLifecycleIdle(requireProject(state, current.project_id));
        if (currentReferences.some((turn) => ['queued', 'preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping'].includes(turn.status))) throw new HttpError(423, { error: 'attachment_in_use' });
        if (currentReferences.length && !confirmReferenced) throw new HttpError(409, { error: 'attachment_delete_confirmation_required', referenced_turn_count: currentReferences.length });
        if (!currentReferences.length) {
          state.attachments = state.attachments.filter((item) => item.id !== current.id);
          return { attachment: publicAttachment(current), deleted: true, tombstone: false };
        }
        Object.assign(current, { managed_path: null, text: null, storage_status: 'deleted', status: 'content_deleted', content_deleted_at: now(), updated_at: now() });
        return { attachment: publicAttachment(current), deleted: true, tombstone: true };
      });
      stateCommitted = true;
      if (staged) { await removeStagedFile(staged); await fsp.rm(path.dirname(staged), { recursive: true, force: true }).catch(() => undefined); }
      return result;
    } catch (error) {
      if (staged && file) { if (stateCommitted) await compensateAttachmentDelete(attachment, staged, file); else await fsp.rename(staged, file).catch(() => undefined); }
      throw error;
    }
  });
}
export async function verifyTurnAttachmentManifest(turn, attachments, cwd) {
  const manifest = new Map((turn.attachment_manifest || []).map((item) => [item.id, item]));
  if (manifest.size !== (turn.attachment_ids || []).length || attachments.length !== manifest.size) throw new HttpError(409, { error: 'attachment_manifest_mismatch' });
  const verifiedPaths = new Map();
  for (const attachment of attachments) {
    const frozen = manifest.get(attachment.id);
    if (!frozen || Number(frozen.size_bytes) !== Number(attachment.size_bytes) || frozen.sha256 !== (attachment.sha256 || null)) throw new HttpError(409, { error: 'attachment_manifest_changed', attachment_id: attachment.id });
    if (attachment.content_deleted_at || attachment.storage_status === 'deleted') throw new HttpError(410, { error: 'attachment_content_deleted', attachment_id: attachment.id });
    let file = null;
    if (attachment.managed_path) file = await verifiedManagedFile(attachment);
    else if (attachment.storage_status === 'external' && attachment.relative_path && attachment.sha256) file = await verifiedProjectAttachmentPath(cwd, attachment.relative_path);
    if (!file || !attachment.sha256) continue;
    const stat = await fsp.stat(file);
    if (stat.size !== Number(attachment.size_bytes)) throw new HttpError(409, { error: 'attachment_manifest_changed', attachment_id: attachment.id });
    const digest = await hashFile(file);
    if (digest !== attachment.sha256) throw new HttpError(409, { error: 'attachment_manifest_changed', attachment_id: attachment.id });
    verifiedPaths.set(attachment.id, file);
  }
  return verifiedPaths;
}
export function nativeAttachmentBindings(attachments, profile, verifiedPaths = new Map()) {
  const stored = attachments.filter((item) => item.managed_path && item.storage_status === 'ready');
  const offset = Array.isArray(profile.mounts) ? profile.mounts.length : 0, nativePaths = new Map();
  const mounts = stored.map((item, index) => {
    const file = verifiedPaths.get(item.id) || item.managed_path, directory = path.dirname(file);
    nativePaths.set(item.id, profile.kind === 'docker' ? `/aiws-mounts/${offset + index}/${path.basename(file)}` : file);
    return directory;
  });
  return { mounts, nativePaths };
}
async function streamMultipartFile(req, tempPath, reserve) {
  const contentType = String(req.headers['content-type'] || '');
  if (!/^multipart\/form-data\b/i.test(contentType)) throw new HttpError(415, { error: 'attachment_multipart_required' });
  let parser;
  try { parser = Busboy({ headers: req.headers, limits: { files: 1, fields: 20, parts: 21, fileSize: MEDIA_ATTACHMENT_MAX_BYTES + 1, fieldSize: 64 * 1024 } }); }
  catch { throw new HttpError(400, { error: 'multipart_boundary_invalid' }); }
  const fields = {}, headChunks = [], hash = createHash('sha256');
  let filename = '', clientMime = 'application/octet-stream', size = 0, fileTask = null, parserError = null, seenFile = false;
  const abort = () => { parserError ||= new HttpError(400, { error: 'attachment_upload_aborted' }); parser.destroy(parserError); };
  const completion = new Promise((resolve, reject) => {
    parser.on('field', (name, value) => { fields[String(name).slice(0, 100)] = String(value).slice(0, 64 * 1024); });
    parser.on('file', (_name, stream, info) => {
      if (seenFile) { stream.resume(); parserError ||= new HttpError(400, { error: 'attachment_single_file_required' }); return; }
      seenFile = true; filename = info.filename; clientMime = normalizeMime(info.mimeType);
      stream.once('limit', () => { parserError ||= new HttpError(413, { error: 'attachment_too_large', max_bytes: MEDIA_ATTACHMENT_MAX_BYTES }); });
      const inspect = new Transform({ transform(chunk, _encoding, callback) {
        try {
          if (size + chunk.length > MEDIA_ATTACHMENT_MAX_BYTES) throw new HttpError(413, { error: 'attachment_too_large', max_bytes: MEDIA_ATTACHMENT_MAX_BYTES });
          reserve(chunk.length); size += chunk.length; hash.update(chunk);
          let remaining = HEAD_BYTES - headChunks.reduce((total, item) => total + item.length, 0);
          if (remaining > 0) headChunks.push(Buffer.from(chunk.subarray(0, remaining)));
          callback(null, chunk);
        } catch (error) { callback(error); }
      } });
      fileTask = pipeline(stream, inspect, fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 })).catch((error) => { parserError ||= error; parser.destroy(error); });
    });
    parser.once('filesLimit', () => { parserError ||= new HttpError(400, { error: 'attachment_single_file_required' }); });
    parser.once('partsLimit', () => { parserError ||= new HttpError(400, { error: 'multipart_part_count_exceeded' }); });
    parser.once('error', (error) => { parserError ||= error; });
    parser.once('close', async () => {
      req.off('aborted', abort); req.off('error', abort);
      await fileTask;
      if (parserError) reject(parserError);
      else if (!seenFile) reject(new HttpError(400, { error: 'attachment_file_required' }));
      else resolve({ fields, filename, clientMime, size, head: Buffer.concat(headChunks), sha256: hash.digest('hex') });
    });
  });
  req.once('aborted', abort); req.once('error', abort);
  req.pipe(parser);
  return completion;
}

export function parseSingleRange(value, size) {
  if (!value) return null;
  const text = String(value).trim();
  if (text.includes(',')) throw rangeError(size);
  const match = text.match(/^bytes=(\d*)-(\d*)$/); if (!match || (!match[1] && !match[2]) || size <= 0) throw rangeError(size);
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) throw rangeError(size); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw rangeError(size); end = Math.min(end, size - 1); }
  return { start, end };
}
function attachmentHeaders(item, { etag, download, length }) {
  const original = safeOriginalFilename(item.original_filename || item.title || 'attachment'), mime = normalizeMime(item.detected_mime_type || item.content_type), active = /^(?:text\/html|image\/svg\+xml)$/.test(mime);
  const fallback = original.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'attachment';
  return {
    'content-type': active && !download ? 'text/plain; charset=utf-8' : mime,
    'content-length': String(length), 'accept-ranges': 'bytes', etag,
    'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin', 'content-security-policy': "sandbox; default-src 'none'",
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(original)}`
  };
}
function requireAttachment(state, attachmentId) { const item = state.attachments.find((entry) => entry.id === attachmentId && !entry.deleted_at); if (!item) throw new HttpError(404, { error: 'attachment_not_found' }); return item; }
async function verifiedManagedFile(item) {
  if (!item.managed_path || item.storage_status !== 'ready') throw new HttpError(410, { error: 'attachment_content_deleted', attachment: publicAttachment(item) });
  const root = await fsp.realpath(ATTACHMENT_DIR), stat = await fsp.lstat(item.managed_path).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new HttpError(409, { error: 'attachment_storage_invalid' });
  const file = await fsp.realpath(item.managed_path), relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new HttpError(409, { error: 'attachment_storage_invalid' });
  return file;
}
function referencedTurns(state, item) { return state.assist_turns.filter((turn) => turn.id === item.turn_id || (turn.attachment_ids || []).includes(item.id)); }
function projectAttachmentUsage(state, projectId) { return state.attachments.filter((item) => item.project_id === projectId && item.storage_status === 'ready' && !item.content_deleted_at && !item.deleted_at && item.managed_path).reduce((total, item) => total + Number(item.size_bytes || 0), 0); }
function projectAttachmentQuota(project) { const configured = Number(project.settings?.attachment_quota_bytes ?? process.env.AIWS_PROJECT_ATTACHMENT_QUOTA_BYTES); return Number.isSafeInteger(configured) && configured >= NORMAL_ATTACHMENT_MAX_BYTES ? configured : DEFAULT_PROJECT_ATTACHMENT_QUOTA_BYTES; }
function safeOriginalFilename(value) { const name = String(value || 'attachment').replace(/[\0\r\n]/g, '').replaceAll('\\', '/').split('/').at(-1).trim().slice(0, 255); return name && name !== '.' && name !== '..' ? name : 'attachment'; }
function normalizeMime(value) { const mime = String(value || '').toLowerCase().split(';')[0].trim(); return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : 'application/octet-stream'; }
function parseBoolean(value) { return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase()); }
function safeStorageToken(value) { const token = String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128); if (!token) throw new HttpError(409, { error: 'attachment_storage_project_invalid' }); return token; }
async function syncFile(file) { const handle = await fsp.open(file, 'r+'); try { await handle.sync(); } finally { await handle.close(); } }
async function syncDirectory(directory) { if (process.platform === 'win32') return; const handle = await fsp.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function removeStagedFile(file) { try { await fsp.rm(file, { force: true }); } catch (error) { if (await fsp.stat(file).then(() => true, () => false)) throw error; } }
async function compensateAttachmentDelete(snapshot, staged, original) { let managedPath = original; try { await fsp.rename(staged, original); } catch { managedPath = staged; } await mutate((state) => { const restored = { ...snapshot, managed_path: managedPath }, current = state.attachments.find((item) => item.id === snapshot.id); if (current) Object.assign(current, restored); else state.attachments.push(restored); }); }
function normalizeUploadError(error) { if (error instanceof HttpError) return error; if (error?.code === 'ENOSPC') return new HttpError(507, { error: 'attachment_storage_full' }); return new HttpError(400, { error: 'attachment_upload_failed', reason: /^[a-z0-9_.-]{1,120}$/i.test(String(error?.code || '')) ? error.code : 'stream_failed' }); }
function rangeError(size) { return new HttpError(416, { error: 'attachment_range_not_satisfiable', size_bytes: size }); }
function withAttachmentLock(idValue, operation) { const key = String(idValue), previous = attachmentLocks.get(key) || Promise.resolve(), current = previous.catch(() => undefined).then(operation); attachmentLocks.set(key, current); return current.finally(() => { if (attachmentLocks.get(key) === current) attachmentLocks.delete(key); }); }
async function verifiedProjectAttachmentPath(cwd, relativeValue) {
  const relative = String(relativeValue).replaceAll('\\', '/'); if (!relative || relative.startsWith('/') || relative.split('/').includes('..')) throw new HttpError(409, { error: 'attachment_path_invalid' });
  const root = await fsp.realpath(path.resolve(cwd)).catch(() => { throw new HttpError(409, { error: 'attachment_path_invalid' }); });
  const lexical = path.resolve(root, ...relative.split('/')), lexicalRelative = path.relative(root, lexical);
  if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) throw new HttpError(409, { error: 'attachment_path_invalid' });
  const stat = await fsp.lstat(lexical).catch(() => null); if (!stat?.isFile() || stat.isSymbolicLink()) throw new HttpError(409, { error: 'attachment_path_invalid' });
  const file = await fsp.realpath(lexical), realRelative = path.relative(root, file);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new HttpError(409, { error: 'attachment_path_invalid' });
  return file;
}
async function hashFile(file) { const hash = createHash('sha256'); await pipeline(fs.createReadStream(file), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(); } })); return hash.digest('hex'); }
