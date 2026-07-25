import { spawn, spawnSync } from 'node:child_process';
import { isContainerized, managedInstance } from './container-runtime-config.mjs';

const active = new Map();

export function spawnContainerProcess(
  invocation,
  { cwd = process.cwd(), env = process.env, spawnProcess = spawn, stopContainer } = {}
) {
  const child = spawnProcess(invocation.command, invocation.args, {
    cwd,
    env: processEnvironment(env),
    shell: false,
    windowsHide: true
  });
  return registerManagedProcessHandle(invocation, child, { stopContainer });
}

export function registerManagedProcessHandle(invocation, child, { stopContainer = stopManagedContainerAsync } = {}) {
  if (!invocation.containerName) return child;
  const record = { child, name: invocation.containerName, stopping: false };
  active.set(record.name, record);
  const originalKill = typeof child.kill === 'function' ? child.kill.bind(child) : () => false;
  child.kill = (signal = 'SIGTERM') => {
    if (!record.stopping) {
      record.stopping = true;
      stopContainer(record.name);
    }
    return originalKill(signal);
  };
  child.once?.('close', () => {
    if (active.get(record.name)?.child === child) active.delete(record.name);
  });
  child.once?.('error', () => {
    if (active.get(record.name)?.child === child) active.delete(record.name);
  });
  return child;
}

export function releaseManagedProcessHandle(name, child) {
  if (active.get(name)?.child === child) active.delete(name);
}

export function runContainerProcess(
  invocation,
  { cwd, timeoutMs = 120000, stdin = '', env, signal, spawnProcess = spawn } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawnContainerProcess(invocation, { cwd, env, spawnProcess });
    let stdout = '',
      stderr = '',
      settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => {
      child.kill('SIGTERM');
      finish(reject, new Error('process cancelled'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`process timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => finish(resolve, { code, stdout, stderr }));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(stdin);
  });
}

export function stopManagedContainer(name, commandRunner = spawnSync) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(String(name || ''))) return false;
  const result = commandRunner('docker', ['container', 'stop', '--time', '5', name], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8000
  });
  return result?.status === 0;
}

export function stopManagedContainerAsync(name, spawnProcess = spawn) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(String(name || ''))) return false;
  try {
    const child = spawnProcess('docker', ['container', 'stop', '--time', '5', name], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore'
    });
    child.once?.('error', () => undefined);
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

export function stopAllManagedContainers(commandRunner = spawnSync) {
  for (const record of [...active.values()]) {
    record.stopping = true;
    stopManagedContainer(record.name, commandRunner);
    record.child.kill?.('SIGTERM');
  }
  active.clear();
}

export function cleanupStaleContainers({ env = process.env, commandRunner = spawnSync } = {}) {
  if (!isContainerized(env)) return [];
  const instance = managedInstance(env);
  const found = commandRunner(
    'docker',
    ['ps', '-aq', '--filter', 'label=aiws.managed=true', '--filter', `label=aiws.instance=${instance}`],
    { encoding: 'utf8', windowsHide: true, timeout: 8000 }
  );
  if (found?.status !== 0) return [];
  const ids = String(found.stdout || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => /^[a-f0-9]{12,64}$/.test(item));
  if (ids.length)
    commandRunner('docker', ['container', 'rm', '-f', ...ids], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return ids;
}

export function attachContainerShutdown(server, { beforeClose = () => undefined } = {}) {
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    beforeClose();
    if (isContainerized()) stopAllManagedContainers();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

export function activeManagedContainers() {
  return [...active.keys()];
}

function processEnvironment(overrides) {
  if (!overrides || overrides === process.env) return process.env;
  const result = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete result[key];
    else result[key] = String(value);
  }
  return result;
}
