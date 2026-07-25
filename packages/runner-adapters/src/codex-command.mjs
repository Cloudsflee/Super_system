import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function resolveCodexInvocation({
  requested = process.env.AIWS_CODEX_BIN || 'codex',
  commandRunner = locateCommand,
  platform = process.platform,
  exists = fs.existsSync,
  nodeExecutable = process.execPath
} = {}) {
  const value = String(requested || '').trim();
  if (!value) return null;
  const scriptAbsolute = platform === 'win32' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
  if (/\.(?:mjs|js)$/i.test(value) && scriptAbsolute && exists(value))
    return { command: nodeExecutable, args: [value], source: `node:${value}` };
  if (platform !== 'win32') return { command: value, args: [], source: value };
  if (/\.exe$/i.test(value)) return { command: value, args: [], source: value };

  const windowsPath = path.win32;
  const wrappers = [];
  if (windowsPath.isAbsolute(value) && /(?:^|[\\/])codex(?:\.cmd|\.ps1)?$/i.test(value)) wrappers.push(value);
  else if (/^codex(?:\.cmd|\.ps1)?$/i.test(value)) {
    const located = commandRunner('where.exe', ['codex.cmd']);
    if (located.ok)
      wrappers.push(
        ...String(located.stdout || '')
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean)
      );
  } else return { command: value, args: [], source: value };

  for (const wrapper of wrappers) {
    const script = windowsPath.join(
      windowsPath.dirname(windowsPath.normalize(wrapper)),
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js'
    );
    if (exists(script)) return { command: nodeExecutable, args: [script], source: `node:${script}` };
  }
  return null;
}

export function prepareCodexInvocation(command, args = [], options = {}) {
  if (!isCodexCommand(command)) return { command, args };
  const resolved = resolveCodexInvocation({ ...options, requested: command });
  return resolved ? { ...resolved, args: [...resolved.args, ...args] } : { command, args };
}

export function isCodexCommand(command) {
  const value = String(command || '').trim(),
    configured = String(process.env.AIWS_CODEX_BIN || 'codex').trim();
  if (!value) return false;
  return value.toLowerCase() === configured.toLowerCase() || /(?:^|[\\/])codex(?:\.cmd|\.ps1|\.exe)?$/i.test(value);
}

function locateCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || null
  };
}
