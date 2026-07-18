import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { saveArtifact } from './state.mjs';
import { id, now } from '../../../packages/shared/index.mjs';

export const MAX_PREVIEW_CHARS = 30000;

export function publicSession(value) {
  return { id: value.id, project_id: value.project_id, assist_session_id: value.assist_session_id || null, turn_id: value.turn_id, worktree_id: value.worktree_id, change_batch_id: value.change_batch_id || null, profile_id: value.profile_id, model: value.model, reasoning: value.reasoning, runtime: value.runtime, status: value.status, cols: value.cols, rows: value.rows, exit_code: value.exit_code, error_code: value.error_code || null, output_preview: value.output_preview || '', output_truncated: Boolean(value.output_truncated), artifact_file_ref_id: value.artifact_file_ref_id || null, created_at: value.created_at, updated_at: value.updated_at };
}

export function broadcast(runtime, message) {
  const encoded = JSON.stringify(message);
  for (const client of runtime.clients) if (client.readyState === 1) client.send(encoded);
}

export function rejectWebSocket(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

export function safe(value) {
  return String(value || 'item').replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function appendOutput(runtime, safeOutput) {
  if (!safeOutput) return;
  const bytes = Buffer.from(safeOutput);
  runtime.outputHash.update(bytes);
  runtime.outputBytes += bytes.length;
  runtime.outputStream.write(bytes);
  runtime.preview = (runtime.preview + safeOutput).slice(-MAX_PREVIEW_CHARS);
  broadcast(runtime, { type: 'output', data: safeOutput });
}

export async function finishTerminalArtifact(runtime) {
  try {
    if (runtime.outputError) throw runtime.outputError;
    await new Promise((resolve, reject) => { runtime.outputStream.once('error', reject); runtime.outputStream.end(resolve); });
    if (runtime.outputError) throw runtime.outputError;
    return { id: id('fil'), kind: 'terminal', absolute_path: runtime.artifactPath, relative_path: path.relative(path.dirname(DATA_DIR), runtime.artifactPath), sha256: runtime.outputHash.digest('hex'), size_bytes: runtime.outputBytes, content_type: 'text/plain', meta: { terminal_session_id: runtime.sessionId, complete: true }, created_at: now() };
  } catch {
    runtime.outputStream.destroy();
    await fsp.rm(runtime.artifactPath, { force: true }).catch(() => undefined);
    return saveArtifact('terminal', `${runtime.sessionId}.log`, runtime.preview, { terminal_session_id: runtime.sessionId, complete: false });
  }
}
