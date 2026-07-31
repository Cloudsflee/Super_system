import fs from 'node:fs';
import path from 'node:path';

export const QUALITY_POLICY_VERSION = '2';
export const SOURCE_ROOTS = Object.freeze(['apps', 'packages', 'scripts', 'tests', 'docker', 'bridge']);
export const SOURCE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.ts', '.tsx', '.css', '.go']);
export const ESLINT_EXTENSIONS = Object.freeze(['.js', '.mjs', '.ts', '.tsx']);
export const ABSOLUTE_FILE_LIMIT = 1000;

export const QUALITY_PROFILES = deepFreeze({
  production: {
    file: { warning: 400, blocking: 800 },
    function: { warning: 80, blocking: 150 },
    complexity: { warning: 15, blocking: 30 },
    lineLength: { warning: 120, blocking: null }
  },
  test: {
    file: { warning: 800, blocking: 1000 },
    function: { warning: 150, blocking: 250 },
    complexity: { warning: 25, blocking: 50 },
    lineLength: { warning: 120, blocking: null }
  },
  migration: {
    file: { warning: 800, blocking: 1000 },
    function: { warning: 120, blocking: 200 },
    complexity: { warning: 20, blocking: 40 },
    lineLength: { warning: 120, blocking: null }
  },
  tooling: {
    file: { warning: 600, blocking: 1000 },
    function: { warning: 100, blocking: 200 },
    complexity: { warning: 20, blocking: 40 },
    lineLength: { warning: 120, blocking: null }
  },
  stylesheet: {
    file: { warning: 800, blocking: 1000 }
  },
  static: {
    file: { warning: 800, blocking: 1000 },
    function: { warning: 100, blocking: 200 },
    complexity: { warning: 20, blocking: 40 },
    lineLength: { warning: 120, blocking: null }
  }
});

// Kept as the production-profile alias for callers that consumed the V1 policy directly.
export const QUALITY_THRESHOLDS = QUALITY_PROFILES.production;

export const ESLINT_PROFILE_PATTERNS = deepFreeze({
  tooling: ['scripts/**/*.{js,mjs,ts,tsx}'],
  migration: ['docker/**/*.{js,mjs,ts,tsx}', 'apps/api/src/state-migration-*.mjs'],
  static: ['apps/web/src/api/types.ts'],
  test: [
    'tests/**/*.{js,mjs,ts,tsx}',
    'apps/*/src/test/**/*.{js,mjs,ts,tsx}',
    '**/*.test.{js,mjs,ts,tsx}',
    '**/*.spec.{js,mjs,ts,tsx}'
  ]
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
const staticSourcePaths = new Set(['apps/web/src/api/types.ts']);

export function qualityProfileForPath(filePath) {
  const normalized = normalizePath(filePath).replace(/^\.\//, '');
  if (path.posix.extname(normalized).toLowerCase() === '.css') return 'stylesheet';
  if (isTestPath(normalized)) return 'test';
  if (/^docker\//.test(normalized) || /^apps\/api\/src\/state-migration-[^/]+\.mjs$/.test(normalized))
    return 'migration';
  if (/^scripts\//.test(normalized)) return 'tooling';
  if (staticSourcePaths.has(normalized)) return 'static';
  return 'production';
}

export function thresholdsForPath(filePath) {
  return QUALITY_PROFILES[qualityProfileForPath(filePath)];
}

export function classifyMeasurement(kind, value, options = {}) {
  if (options.declaration && (kind === 'file' || kind === 'function')) return 'ok';
  if (kind === 'file' && value > ABSOLUTE_FILE_LIMIT) return 'blocking';
  const profile = options.profile || (options.filePath ? qualityProfileForPath(options.filePath) : 'production');
  const threshold = QUALITY_PROFILES[profile]?.[kind];
  if (!threshold) throw new TypeError(`Unknown quality measurement/profile: ${kind}/${profile}`);
  if (threshold.blocking !== null && value > threshold.blocking) return 'blocking';
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
  const lineCount = countPhysicalLines(source),
    profile = qualityProfileForPath(filePath);
  return {
    filePath: normalizePath(filePath),
    ruleId: 'max-lines',
    kind: 'file',
    value: lineCount,
    profile,
    level: classifyMeasurement('file', lineCount, {
      filePath,
      profile,
      declaration: isDeclarationFile(filePath)
    })
  };
}

export function normalizePath(filePath) {
  return String(filePath).replaceAll('\\', '/');
}

function isTestPath(filePath) {
  return (
    /^tests\//.test(filePath) ||
    /^apps\/[^/]+\/src\/test\//.test(filePath) ||
    /(?:^|\/)fixtures\//.test(filePath) ||
    /\.(?:test|spec)\.(?:js|mjs|ts|tsx)$/.test(filePath)
  );
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

function deepFreeze(value) {
  for (const nested of Object.values(value)) if (nested && typeof nested === 'object') deepFreeze(nested);
  return Object.freeze(value);
}
