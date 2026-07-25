import fs from 'node:fs';
import path from 'node:path';

export const SOURCE_ROOTS = Object.freeze(['apps', 'packages', 'scripts', 'tests', 'docker', 'bridge']);
export const SOURCE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.ts', '.tsx', '.css', '.go']);
export const ESLINT_EXTENSIONS = Object.freeze(['.js', '.mjs', '.ts', '.tsx']);
export const QUALITY_THRESHOLDS = Object.freeze({
  file: Object.freeze({ warning: 600, blocking: 1000 }),
  function: Object.freeze({ warning: 100, blocking: 200 }),
  complexity: Object.freeze({ warning: 15, blocking: 40 })
});

const ignoredDirectoryNames = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.ai-workspace',
  '.ai-workspace-test-integration',
  'temp',
  'vendor',
  'generated'
]);

export function classifyMeasurement(kind, value, options = {}) {
  const threshold = QUALITY_THRESHOLDS[kind];
  if (!threshold) throw new TypeError(`Unknown quality measurement: ${kind}`);
  if (options.declaration && (kind === 'file' || kind === 'function')) return 'ok';
  if (value > threshold.blocking) return 'blocking';
  if (value > threshold.warning) return 'warning';
  return 'ok';
}

export function isDeclarationFile(filePath) {
  return /\.d\.(?:ts|mts|cts)$/i.test(normalizePath(filePath));
}

export function shouldIgnorePath(filePath) {
  const normalized = normalizePath(filePath);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => ignoredDirectoryNames.has(segment) || segment.startsWith('.tmp-'))) return true;
  const basename = segments.at(-1) || '';
  return /(?:^|\.)(?:generated|min)\.[^.]+$/i.test(basename);
}

export function collectSourceFiles(cwd = process.cwd(), extensions = SOURCE_EXTENSIONS) {
  const allowedExtensions = new Set(extensions);
  return SOURCE_ROOTS.flatMap((root) => walk(path.join(cwd, root), cwd, allowedExtensions)).sort();
}

export function countPhysicalLines(source) {
  if (!source) return 0;
  const lines = source.split(/\r\n|\r|\n/);
  return /(?:\r\n|\r|\n)$/.test(source) ? lines.length - 1 : lines.length;
}

export function evaluateFileLength(filePath, source) {
  const lineCount = countPhysicalLines(source);
  return {
    filePath: normalizePath(filePath),
    kind: 'file',
    value: lineCount,
    level: classifyMeasurement('file', lineCount, { declaration: isDeclarationFile(filePath) })
  };
}

export function normalizePath(filePath) {
  return String(filePath).replaceAll('\\', '/');
}

function walk(directory, cwd, allowedExtensions) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(cwd, absolutePath);
    if (shouldIgnorePath(relativePath)) return [];
    if (entry.isDirectory()) return walk(absolutePath, cwd, allowedExtensions);
    return entry.isFile() && allowedExtensions.has(path.extname(entry.name).toLowerCase()) ? [relativePath] : [];
  });
}
