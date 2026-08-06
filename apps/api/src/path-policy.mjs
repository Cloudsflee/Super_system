import path from 'node:path';
import { AppError, assert } from './errors.mjs';

const REVIEWABLE = new Set([
  '.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.html', '.py', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.yaml',
  '.yml', '.toml', '.diff', '.patch', '.log', '.csv', '.png', '.jpg', '.jpeg', '.webp'
]);

export function normalizeRelativePath(value) {
  assert(typeof value === 'string' && value.length > 0, 'invalid_input', 'path is required');
  const normalized = value.replaceAll('\\', '/');
  assert(!normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized), 'invalid_input', 'absolute paths are not allowed');
  const segments = normalized.split('/');
  assert(!segments.some((segment) => segment.length === 0), 'invalid_input', 'empty path segments are not allowed');
  assert(!segments.some((segment) => segment === '.' || segment === '..'), 'invalid_input', 'path traversal escapes project workspace');
  const resolved = path.posix.normalize(normalized);
  assert(resolved !== '.' && resolved !== '..' && !resolved.startsWith('../'), 'invalid_input', 'path escapes project workspace');
  return resolved;
}

export function isReviewablePath(value) {
  const normalized = normalizeRelativePath(value);
  return REVIEWABLE.has(path.posix.extname(normalized).toLowerCase());
}

export function assertReviewablePath(value) {
  const normalized = normalizeRelativePath(value);
  if (!isReviewablePath(normalized)) {
    throw new AppError('unsupported_attachment', 'file is retained as a downloadable attachment only', {
      status: 415,
      details: { path: normalized }
    });
  }
  return normalized;
}

export function resolveWorkspacePath(root, relative) {
  const normalized = normalizeRelativePath(relative);
  const base = path.resolve(root);
  const target = path.resolve(base, normalized);
  assert(target === base || target.startsWith(`${base}${path.sep}`), 'invalid_input', 'path escapes workspace');
  return target;
}
