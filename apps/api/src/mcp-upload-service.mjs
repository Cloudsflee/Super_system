import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ATTACHMENT_TEMP_DIR } from './config.mjs';
import { saveProjectFile } from './file-service.mjs';
import { HttpError } from './http.mjs';
import { assertProjectAccess, assertScopes } from './mcp-client-service.mjs';
import { readState } from './state.mjs';
import { assertProjectWrite } from './project-governance-v19.mjs';

export const MCP_UPLOAD_CHUNK_MAX_BYTES = 512 * 1024;
export const MCP_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const uploads = new Map();

export async function beginMcpUpload(input, client) {
  assertScopes(client, ['files:write']);
  const projectId = String(input.project_id || ''), relative = String(input.path || '').trim().replaceAll('\\', '/');
  assertProjectAccess(client, projectId);
  if (client.subject_user_id) assertProjectWrite(await readState(), projectId, client.subject_user_id);
  if (!projectId || !relative || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new HttpError(400, { error: 'mcp_upload_path_invalid' });
  const size = Number(input.size_bytes);
  if (!Number.isSafeInteger(size) || size < 0 || size > MCP_UPLOAD_MAX_BYTES) throw new HttpError(413, { error: 'mcp_upload_size_invalid', max_bytes: MCP_UPLOAD_MAX_BYTES });
  if (!/^[a-f0-9]{64}$/.test(String(input.sha256 || ''))) throw new HttpError(400, { error: 'mcp_upload_sha256_invalid' });
  await fsp.mkdir(ATTACHMENT_TEMP_DIR, { recursive: true, mode: 0o700 });
  const id = `mup_${randomUUID().replaceAll('-', '')}`, file = path.join(ATTACHMENT_TEMP_DIR, `${id}.part`);
  await fsp.writeFile(file, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
  uploads.set(id, { id, client_id: client.id, project_id: projectId, node_id: input.node_id ? String(input.node_id) : null, path: relative, size_bytes: size, sha256: input.sha256, received_bytes: 0, next_sequence: 0, file, created_at: Date.now() });
  return publicUpload(uploads.get(id));
}

export async function appendMcpUploadChunk(input, client) {
  const upload = ownedUpload(input.upload_id, client), sequence = Number(input.sequence);
  if (!Number.isSafeInteger(sequence) || sequence !== upload.next_sequence) throw new HttpError(409, { error: 'mcp_upload_sequence_invalid', expected_sequence: upload.next_sequence });
  const encoded = String(input.data_base64 || '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new HttpError(400, { error: 'mcp_upload_chunk_base64_invalid' });
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MCP_UPLOAD_CHUNK_MAX_BYTES) throw new HttpError(413, { error: 'mcp_upload_chunk_too_large', max_bytes: MCP_UPLOAD_CHUNK_MAX_BYTES });
  if (upload.received_bytes + bytes.length > upload.size_bytes) throw new HttpError(413, { error: 'mcp_upload_size_exceeded', expected_bytes: upload.size_bytes });
  await fsp.appendFile(upload.file, bytes);
  upload.received_bytes += bytes.length; upload.next_sequence += 1;
  return publicUpload(upload);
}

export async function commitMcpUpload(input, client) {
  const upload = ownedUpload(input.upload_id, client);
  if (client.subject_user_id) assertProjectWrite(await readState(), upload.project_id, client.subject_user_id);
  if (upload.received_bytes !== upload.size_bytes) throw new HttpError(409, { error: 'mcp_upload_incomplete', expected_bytes: upload.size_bytes, received_bytes: upload.received_bytes });
  const bytes = await fsp.readFile(upload.file), digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== upload.sha256) throw new HttpError(409, { error: 'mcp_upload_hash_mismatch', expected_sha256: upload.sha256, actual_sha256: digest });
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new HttpError(415, { error: 'mcp_upload_binary_not_supported' });
  try {
    const change = await saveProjectFile({ projectId: upload.project_id, nodeId: upload.node_id, relative: upload.path, content, source: 'assist_confirmed' });
    uploads.delete(upload.id); await fsp.rm(upload.file, { force: true });
    return { upload: { ...publicUpload(upload), status: 'committed' }, change };
  } catch (error) { throw error; }
}

export async function cancelMcpUpload(input, client) {
  const upload = ownedUpload(input.upload_id, client);
  uploads.delete(upload.id); await fsp.rm(upload.file, { force: true });
  return { ...publicUpload(upload), status: 'cancelled' };
}

export async function cleanupMcpUploads({ maxAgeMs = 60 * 60 * 1000 } = {}) {
  const cutoff = Date.now() - maxAgeMs;
  for (const upload of uploads.values()) if (upload.created_at < cutoff) { uploads.delete(upload.id); await fsp.rm(upload.file, { force: true }).catch(() => undefined); }
}

function ownedUpload(id, client) {
  const upload = uploads.get(String(id || ''));
  if (!upload || upload.client_id !== client.id) throw new HttpError(404, { error: 'mcp_upload_not_found' });
  assertProjectAccess(client, upload.project_id); return upload;
}
function publicUpload(upload) { return { id: upload.id, project_id: upload.project_id, path: upload.path, size_bytes: upload.size_bytes, received_bytes: upload.received_bytes, next_sequence: upload.next_sequence, chunk_max_bytes: MCP_UPLOAD_CHUNK_MAX_BYTES, status: 'uploading' }; }
