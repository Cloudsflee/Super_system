import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http.mjs';

export function validateHostImportRelative(value) {
  const input = String(value || '').trim();
  if (!input || input.length > 1024 || /[\0\r\n\\]/.test(input) || path.posix.isAbsolute(input) || /^[a-zA-Z]:/.test(input) || input.startsWith('//')) {
    throw new HttpError(400, { error: 'host_import_relative_path_required' });
  }
  const parts = input.split('/');
  if (parts.some((item) => !item || item === '.' || item === '..')) throw new HttpError(400, { error: 'host_import_path_traversal' });
  return parts.join('/');
}

export async function resolveHostImportPath(value, { root = process.env.AIWS_HOST_PROJECTS_ROOT } = {}) {
  if (!root) throw new HttpError(409, { error: 'host_import_root_unavailable' });
  const relative = validateHostImportRelative(value), resolvedRoot = path.resolve(root);
  const rootStat = await fs.lstat(resolvedRoot).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new HttpError(409, { error: 'host_import_root_unavailable' });
  let cursor = resolvedRoot;
  for (const segment of relative.split('/')) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor).catch(() => null);
    if (!stat) throw new HttpError(400, { error: 'host_import_source_missing' });
    if (stat.isSymbolicLink()) throw new HttpError(400, { error: 'host_import_symlink_rejected' });
  }
  const [realRoot, realTarget] = await Promise.all([fs.realpath(resolvedRoot), fs.realpath(cursor)]);
  const boundary = path.relative(realRoot, realTarget);
  if (boundary.startsWith('..') || path.isAbsolute(boundary)) throw new HttpError(403, { error: 'host_import_path_outside_root' });
  return { absolute: realTarget, relative, name: path.basename(realTarget), path_scope: 'host_import_root' };
}

