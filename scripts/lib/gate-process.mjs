import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const GATE_ERROR_CODES = Object.freeze({
  notFound: 'gate_command_not_found',
  timeout: 'gate_command_timeout',
  failed: 'gate_command_failed'
});

const DEFAULT_MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function nodeInvocation(script, args = []) {
  return { command: process.execPath, args: [String(script), ...args.map(String)], command_role: 'node' };
}

export function executableInvocation(command, args = [], commandRole = 'executable') {
  return { command: String(command), args: args.map(String), command_role: commandRole };
}

export function pnpmInvocation(args = [], options = {}) {
  const execPath = path.resolve(options.execPath || process.execPath);
  const nodeDirectory = path.dirname(execPath);
  const candidates = [
    path.join(nodeDirectory, 'node_modules', 'corepack', 'dist', 'corepack.js'),
    path.resolve(nodeDirectory, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js')
  ];
  const corepackScript = candidates.find((candidate) => fs.existsSync(candidate));
  if (corepackScript) {
    return { command: execPath, args: [corepackScript, 'pnpm', ...args.map(String)], command_role: 'pnpm' };
  }
  return { command: 'corepack', args: ['pnpm', ...args.map(String)], command_role: 'pnpm' };
}

export async function runGateCommand(invocation, options = {}) {
  const root = path.resolve(options.workspaceRoot || options.cwd || process.cwd());
  const cwd = path.resolve(options.cwd || root);
  const cwdRole = String(options.cwdRole || 'workspace');
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxCaptureBytes = positiveInteger(options.maxCaptureBytes, DEFAULT_MAX_CAPTURE_BYTES);
  const startedAt = new Date();
  const started = Date.now();
  const stdoutCapture = boundedCapture(maxCaptureBytes);
  const stderrCapture = boundedCapture(maxCaptureBytes);
  const stdoutForwarder = lineForwarder(options.stdout === false ? null : (options.stdout || process.stdout), root, options.stdoutPrefix || '');
  const stderrForwarder = lineForwarder(options.stderr === false ? null : (options.stderr || process.stderr), root, options.stderrPrefix || '');
  const child = spawn(String(invocation.command), (invocation.args || []).map(String), {
    cwd,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    detached: process.platform !== 'win32'
  });

  child.stdout.on('data', (chunk) => {
    stdoutCapture.add(chunk);
    stdoutForwarder.add(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrCapture.add(chunk);
    stderrForwarder.add(chunk);
  });

  let timedOut = false;
  let spawnError = null;
  const completion = new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error; resolve({ exitStatus: null, signal: null }); });
    child.once('close', (exitStatus, signal) => resolve({ exitStatus, signal }));
  });
  const timer = setTimeout(async () => {
    timedOut = true;
    await terminateProcessTree(child);
  }, timeoutMs);
  timer.unref?.();
  const completed = await completion;
  clearTimeout(timer);
  stdoutForwarder.finish();
  stderrForwarder.finish();
  const endedAt = new Date();
  const stdout = redactGateText(stdoutCapture.value(), root);
  const stderr = redactGateText([
    stderrCapture.value(),
    spawnError?.message || ''
  ].filter(Boolean).join('\n'), root);
  const command = publicInvocation(invocation, root);
  const errorCode = timedOut
    ? GATE_ERROR_CODES.timeout
    : spawnError?.code === 'ENOENT'
      ? GATE_ERROR_CODES.notFound
      : completed.exitStatus === 0
        ? null
        : GATE_ERROR_CODES.failed;
  return {
    command: command.command,
    args: command.args,
    command_role: invocation.command_role || 'executable',
    cwd_role: cwdRole,
    started_at: startedAt.toISOString(),
    completed_at: endedAt.toISOString(),
    duration_ms: Date.now() - started,
    exit_status: completed.exitStatus == null ? (errorCode ? 1 : 0) : completed.exitStatus,
    signal: completed.signal || null,
    timed_out: timedOut,
    ok: !errorCode,
    error_code: errorCode,
    output: { stdout: stdout.value, stderr: stderr.value },
    capture: {
      max_bytes_per_stream: maxCaptureBytes,
      stdout_truncated: stdoutCapture.truncated(),
      stderr_truncated: stderrCapture.truncated()
    },
    redaction: {
      passed: !containsSensitiveGateText(command.command)
        && command.args.every((value) => !containsSensitiveGateText(value))
        && !containsSensitiveGateText(stdout.value)
        && !containsSensitiveGateText(stderr.value),
      removed: command.removed + stdout.removed + stderr.removed
    }
  };
}

export function spawnGateProcess(invocation, options = {}) {
  const root = path.resolve(options.workspaceRoot || options.cwd || process.cwd());
  const child = spawn(String(invocation.command), (invocation.args || []).map(String), {
    cwd: path.resolve(options.cwd || root),
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    detached: process.platform !== 'win32'
  });
  if (child.stdout && options.stdout !== false) {
    const forwarder = lineForwarder(options.stdout || process.stdout, root, options.stdoutPrefix || '');
    child.stdout.on('data', (chunk) => forwarder.add(chunk));
    child.stdout.on('end', () => forwarder.finish());
  }
  if (child.stderr && options.stderr !== false) {
    const forwarder = lineForwarder(options.stderr || process.stderr, root, options.stderrPrefix || '');
    child.stderr.on('data', (chunk) => forwarder.add(chunk));
    child.stderr.on('end', () => forwarder.finish());
  }
  return child;
}

export async function terminateProcessTree(child, graceMs = 1500) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false
      });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already stopped */ } }
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, graceMs))
  ]);
  if (child.exitCode == null && child.signalCode == null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already stopped */ } }
  }
}

export function redactGateText(value, workspaceRoot = process.cwd()) {
  let text = String(value ?? '');
  let removed = 0;
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      removed += 1;
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    });
  };
  const root = path.resolve(workspaceRoot);
  const slashRoot = root.replaceAll('\\', '/');
  const variants = [...new Set([root, slashRoot, root.replaceAll('/', '\\'), encodeURI(slashRoot), encodeURIComponent(slashRoot)])]
    .filter(Boolean).sort((left, right) => right.length - left.length);
  for (const variant of variants) {
    const escaped = escapeRegExp(variant);
    replace(new RegExp(`${escaped}[\\\\/]`, 'gi'), '');
    replace(new RegExp(escaped, 'gi'), '<WORKSPACE>');
  }
  replace(/Bearer\s+[^\s"'`]+/gi, 'Bearer <TOKEN>');
  replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?proof|cookie|secret|password)\s*[:=]\s*)[^,\s"'`]+/gi, '$1<TOKEN>');
  replace(/file:\/\/\/[A-Za-z]:[^\r\n"'`)]+/gi, '<PATH>');
  replace(/(?:^|[\s("'=])((?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'`<>)]*)/g, (match, candidate) => `${match.slice(0, match.indexOf(candidate))}<PATH>`);
  replace(/(?:^|[\s("'=])((?:\/(?:Users|home|tmp|private|var|workspace|mnt)\/)[^\r\n"'`<>\s)]*)/g, (match, candidate) => `${match.slice(0, match.indexOf(candidate))}<PATH>`);
  replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}/g, '<TOKEN>');
  replace(/("(?:token|api_key|access_token|refresh_token|session_proof|cookie|secret|password|private_key)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"<TOKEN>"');
  return { value: text, removed };
}

export function containsSensitiveGateText(value) {
  const text = String(value ?? '');
  return /Bearer\s+[^<\s]+/i.test(text)
    || /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?proof|cookie|secret|password)\s*[:=]\s*(?!<TOKEN>)[A-Za-z0-9+/._-]{8,}/i.test(text)
    || /file:\/\/[A-Za-z]:[\\/]/i.test(text)
    || /(?:^|[\s("'=])[A-Za-z]:[\\/][^\r\n\s"']+/.test(text)
    || /(?:^|\s)\/(?:Users|home|tmp|private|var|workspace|mnt)\//.test(text);
}

function publicInvocation(invocation, root) {
  const commandValue = path.resolve(String(invocation.command)) === path.resolve(process.execPath)
    ? '<NODE>'
    : path.basename(String(invocation.command));
  const command = redactGateText(commandValue, root);
  const args = (invocation.args || []).map((value) => redactGateText(value, root));
  return { command: command.value, args: args.map((entry) => entry.value), removed: command.removed + args.reduce((sum, entry) => sum + entry.removed, 0) };
}

function boundedCapture(maxBytes) {
  const headLimit = Math.floor(maxBytes / 2);
  const tailLimit = maxBytes - headLimit;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let total = 0;
  return {
    add(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      total += chunk.length;
      if (head.length < headLimit) {
        const needed = headLimit - head.length;
        head = Buffer.concat([head, chunk.subarray(0, needed)]);
      }
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > tailLimit) tail = tail.subarray(tail.length - tailLimit);
    },
    truncated: () => total > maxBytes,
    value() {
      if (total <= maxBytes) return Buffer.concat([head, tail.subarray(Math.min(tail.length, Math.max(0, head.length + tail.length - total)))]).toString('utf8');
      return `${head.toString('utf8')}\n<OUTPUT_TRUNCATED:${total - maxBytes}_BYTES>\n${tail.toString('utf8')}`;
    }
  };
}

function lineForwarder(stream, root, prefix) {
  let pending = '';
  const decoder = new StringDecoder('utf8');
  return {
    add(chunk) {
      if (!stream) return;
      pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const lines = pending.split(/(?<=\n)/);
      pending = lines.pop() || '';
      for (const line of lines) stream.write(`${prefix}${redactGateText(line, root).value}`);
      if (pending.length > 64 * 1024) {
        stream.write(`${prefix}${redactGateText(pending, root).value}`);
        pending = '';
      }
    },
    finish() {
      pending += decoder.end();
      if (stream && pending) stream.write(`${prefix}${redactGateText(pending, root).value}`);
      pending = '';
    }
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
