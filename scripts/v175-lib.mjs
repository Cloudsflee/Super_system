import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ROOT = path.resolve(process.cwd());
export const REPORT_ROOT = path.join(ROOT, '.ai-workspace', 'test-reports', 'v1.75');

export function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, relative), 'utf8'));
}

export function normalizePath(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
}

export function walk(relative) {
  const absolute = path.resolve(ROOT, relative);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [normalizePath(path.relative(ROOT, absolute))];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '.git', '.ai-workspace', 'coverage'].includes(entry.name)) return [];
    return walk(path.relative(ROOT, path.join(absolute, entry.name)));
  });
}

export function matchesGlob(value, pattern) {
  const input = normalizePath(value),
    source = normalizePath(pattern);
  let regex = '^';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '*' && source[index + 1] === '*') {
      index++;
      if (source[index + 1] === '/') {
        index++;
        regex += '(?:.*/)?';
      } else regex += '.*';
    } else if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else regex += '\\^$+?.()|{}[]'.includes(char) ? `\\${char}` : char;
  }
  return new RegExp(`${regex}$`).test(input);
}

export function matchesAny(value, patterns = []) {
  return patterns.some((pattern) => matchesGlob(value, pattern));
}
export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
export function utcRunId(prefix = '') {
  return `${prefix}${new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')}-${process.pid}`;
}
export function isMain(metaUrl) {
  return process.argv[1] && metaUrl === pathToFileURL(path.resolve(process.argv[1])).href;
}

export function interpolateArg(value, variables) {
  return String(value).replace(/\$\{([A-Z0-9_]+)\}/g, (match, key) => variables[key] ?? match);
}

export function resolveCommand(argv) {
  const [binary, ...args] = argv;
  if (binary === 'node') return { command: process.execPath, args };
  if (binary !== 'pnpm') return { command: binary, args };
  if (process.platform !== 'win32') return { command: 'corepack', args: ['pnpm', ...args] };
  return {
    command: process.execPath,
    args: [path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js'), ...args]
  };
}

export function runCommand(argv, options = {}) {
  const resolved = resolveCommand(argv),
    started = Date.now(),
    maxCapture = options.maxCapture || 2 * 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      timedOut = false,
      settled = false;
    const child = spawn(resolved.command, resolved.args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const append = (current, chunk) => {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      return next.length > maxCapture ? next.subarray(next.length - maxCapture) : next;
    };
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
      if (options.inherit) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
      if (options.inherit) process.stderr.write(chunk);
    });
    const timeout = options.timeout
      ? setTimeout(() => {
          timedOut = true;
          if (process.platform === 'win32' && child.pid)
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          else child.kill('SIGTERM');
        }, options.timeout)
      : null;
    const finish = (status, signal, error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        status,
        signal,
        error,
        timedOut,
        durationMs: Date.now() - started,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8')
      });
    };
    child.on('error', (error) => finish(null, null, error));
    child.on('close', (status, signal) => finish(status, signal, null));
  });
}

export function runCommandSync(argv, options = {}) {
  const resolved = resolveCommand(argv);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 30000
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null
  };
}

export function redactText(input, env = process.env) {
  let value = String(input || '');
  const secretValues = Object.entries(env)
    .filter(
      ([key, item]) =>
        /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|AUTHORIZATION)/i.test(key) &&
        String(item || '').length >= 4
    )
    .map(([, item]) => String(item));
  for (const secret of [...new Set(secretValues)].sort((a, b) => b.length - a.length))
    value = value.replaceAll(secret, '[REDACTED]');
  value = value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, '[REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|vault|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]'
    )
    .replace(/https?:\/\/[^\s)"']+\?[^\s)"']+/g, (url) => `${url.split('?')[0]}?[REDACTED]`)
    .replace(/\b(?:super-secret|browser-api-key)[A-Za-z0-9_-]*\b/gi, '[REDACTED]');
  return value;
}

export function limitedLog(input, env = process.env) {
  const redacted = redactText(input, env),
    lines = redacted.split(/\r?\n/).slice(-200);
  let value = lines.join('\n'),
    bytes = Buffer.from(value, 'utf8');
  if (bytes.length > 64 * 1024) value = bytes.subarray(bytes.length - 64 * 1024).toString('utf8');
  return value;
}

export function writeFileEnsured(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

export function parseArgs(argv = process.argv.slice(2)) {
  const values = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === '--') continue;
    if (!item.startsWith('--')) {
      values._.push(item);
      continue;
    }
    const key = item.slice(2),
      next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      values[key] = next;
      index++;
    } else values[key] = true;
  }
  return values;
}
