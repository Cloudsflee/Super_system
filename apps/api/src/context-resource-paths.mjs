import path from 'node:path';
import { sanitizeContextFacts } from '../../../packages/system-context/src/index.mjs';

export function safeRepositoryRelativePath(value) {
  const sanitized = sanitizeContextFacts({ relative_path: value }).facts.relative_path;
  return sanitized === value;
}

export function resolveExistingWithin(root, file) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(String(file || ''));
  const relative = path.relative(resolvedRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw resourceError('context_resource_path_forbidden');
  return candidate;
}

export function resolveWithin(root, relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..'))
    throw resourceError('context_resource_path_forbidden');
  return resolveExistingWithin(root, path.join(root, ...normalized.split('/')));
}

export function mediaTypeFor(file) {
  const extension = path.extname(file).toLowerCase();
  return (
    {
      '.json': 'application/json',
      '.jsonl': 'application/x-ndjson',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.tsv': 'text/tab-separated-values',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.cjs': 'text/javascript',
      '.ts': 'text/typescript',
      '.tsx': 'text/typescript',
      '.jsx': 'text/javascript',
      '.css': 'text/css',
      '.html': 'text/html',
      '.xml': 'application/xml',
      '.yaml': 'application/yaml',
      '.yml': 'application/yaml',
      '.toml': 'application/toml',
      '.sql': 'application/sql',
      '.py': 'text/x-python',
      '.go': 'text/x-go',
      '.rs': 'text/x-rust',
      '.java': 'text/x-java',
      '.c': 'text/x-c',
      '.h': 'text/x-c',
      '.cpp': 'text/x-c++',
      '.sh': 'text/x-shellscript',
      '.ps1': 'text/x-powershell',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip'
    }[extension] || 'text/plain'
  );
}

export function isBinaryMediaType(mediaType) {
  const value = String(mediaType || '').toLowerCase();
  return (
    (value.startsWith('image/') && value !== 'image/svg+xml') ||
    value.startsWith('audio/') ||
    value.startsWith('video/') ||
    ['application/pdf', 'application/zip', 'application/octet-stream'].includes(value)
  );
}

export function boundedEnvironment(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
}

export function resourceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
