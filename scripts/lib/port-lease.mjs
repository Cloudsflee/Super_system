// Owner: Platform/Testing. Phase: post-P10 D-040 maintenance.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { spawnGateProcess } from './gate-process.mjs';

export const PORT_RETRY_DELAYS_MS = Object.freeze([100, 250, 500, 1000, 2000]);
const LOCK_DIRECTORY = path.join(os.tmpdir(), 'aiws-port-leases-v1');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const watched = new WeakMap();
const errorWithCode = (code, cause) => Object.assign(new Error(code, { cause }), { code });

export function isAddressInUseError(error) {
  return /EADDRINUSE|ERR_ADDRESS_IN_USE|ERR_NO_BUFFER_SPACE|ENOBUFS|address already in use|port \d+ is already in use/i.test(
    `${error?.code || ''} ${error?.message || error || ''} ${error?.cause?.code || ''} ${error?.cause?.message || ''}`
  );
}

/** All consumers use the same lock namespace. The OS listener stays open
 * until handoff to the child; the lock stays held until child readiness. */
export async function acquirePortLease({ port = 0, lockDirectory = LOCK_DIRECTORY } = {}) {
  fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
    });
    const candidate = listener.address().port;
    const lockPath = path.join(lockDirectory, `${candidate}.lock`);
    const token = randomUUID();
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, port: candidate }));
    } catch (error) {
      await new Promise(resolve => listener.close(resolve));
      if (descriptor != null) { fs.closeSync(descriptor); fs.unlinkSync(lockPath); }
      if (error.code === 'EEXIST' && port === 0) continue;
      throw errorWithCode(error.code === 'EEXIST' ? 'EADDRINUSE' : error.code, error);
    }
    let released = false;
    const unlink = () => {
      if (released) return;
      // Only the exclusive creator deletes this lock. Never reclaim another
      // process's file based on a racy PID/liveness observation.
      fs.closeSync(descriptor);
      fs.unlinkSync(lockPath);
      released = true;
      process.removeListener('exit', onExit);
    };
    const onExit = () => { try { unlink(); } catch {} };
    process.once('exit', onExit);
    const handoff = async () => {
      if (listener.listening) await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    };
    return { port: candidate, lock_path: lockPath, handoff, async release() { await handoff(); if (!released) unlink(); } };
  }
  throw errorWithCode('port_lease_exhausted');
}

function observeChild(child) {
  let state = watched.get(child);
  if (state) return state;
  state = { output: '', failure: null, exited: false, closed: false };
  const capture = bytes => { state.output = (state.output + String(bytes)).slice(-65536); };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.once('error', error => { state.failure = error; });
  child.once('exit', () => { state.exited = true; });
  child.once('close', () => { state.closed = true; });
  watched.set(child, state);
  return state;
}

/** Requires a successful health response AND the child's own binding message.
 * A different server returning 200/404 on a stolen port never proves readiness. */
export async function waitForHttpReady(url, { child, readyOutput, timeoutMs = 30000, accept = response => response.ok } = {}) {
  if (!child) throw new TypeError('child_readiness_proof_required');
  const state = observeChild(child);
  const deadline = Date.now() + timeoutMs;
  const assertRunning = () => {
    if (isAddressInUseError(state.output)) throw errorWithCode('EADDRINUSE');
    if (state.failure) throw state.failure;
    if (state.exited || child.exitCode != null || child.signalCode != null) throw errorWithCode('port_process_exited');
  };
  while (Date.now() < deadline) {
    assertRunning();
    const outputConfirmed = !(readyOutput instanceof RegExp) || readyOutput.test(state.output.replace(/\x1b\[[0-9;]*m/g, ''));
    let response;
    let accepted = false;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))) });
      accepted = await accept(response);
    } catch (error) { if (isAddressInUseError(error)) throw error; }
    finally { await response?.body?.cancel().catch(() => undefined); }
    assertRunning();
    // The lease's listener was held until this exact endpoint was reached, so
    // a successful health response is the binding proof even if stdout was
    // emitted before a child capture listener attached. Keep output as an
    // additional diagnostic signal when available.
    if (accepted && outputConfirmed) return;
    await pause(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  const timeout = errorWithCode('port_ready_timeout');
  timeout.details = { url, output_tail: state.output.slice(-512) };
  throw timeout;
}

async function stopTree(child) {
  if (!child?.pid) return;
  const state = observeChild(child);
  if (child.exitCode != null || child.signalCode != null) return;
  // Kill the group even when its leader already exited: descendants may still
  // own sockets and inherited stdout handles.
  if (process.platform === 'win32') {
    try { child.kill(); } catch {}
    const gracefulDeadline = Date.now() + 500;
    while (!state.closed && child.exitCode == null && Date.now() < gracefulDeadline) await pause(20);
    if (!state.closed && child.exitCode == null && child.signalCode == null) await new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', reject);
      killer.once('close', code => (code === 0 || state.closed || child.exitCode != null) ? resolve() : reject(errorWithCode('port_cleanup_process_failed')));
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + 5000;
  while (!state.closed && Date.now() < deadline) await pause(20);
  if (!state.closed) throw errorWithCode('port_cleanup_process_timeout');
}

/** Retry ONLY this startup callback. All journeys and external actions execute
 * after it returns; they are never replayed by an address retry. */
export async function startProbeWithPorts({ prefix, portCount = 2, start, retryDelays = PORT_RETRY_DELAYS_MS, lockDirectory } = {}) {
  if (typeof start !== 'function' || !/^[a-z0-9-]+$/.test(prefix || '')) throw new TypeError('probe_startup_invalid');
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    const leases = [], children = [], browsers = [];
    let disposed = false;
    const scope = {
      directory, leases, attempt: attempt + 1,
      spawn(invocation, options) { const child = spawnGateProcess(invocation, options); observeChild(child); children.push(child); return child; },
      childOutput(index) { const child = children[index]; return child ? (watched.get(child)?.output || '') : ''; },
      browser(browser) { browsers.push(browser); return browser; },
      async ready(index, url, options) { await waitForHttpReady(url, options); await leases[index].release(); },
      async dispose() {
        if (disposed) return;
        const failures = [];
        for (const browser of [...browsers].reverse()) try { await browser.close(); } catch (error) { failures.push(error); }
        for (const child of [...children].reverse()) try { await stopTree(child); } catch (error) { failures.push(error); }
        for (const lease of leases) try { await lease.release(); } catch (error) { failures.push(error); }
        try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { failures.push(error); }
        if (failures.length) throw errorWithCode('port_cleanup_failed', new AggregateError(failures));
        disposed = true;
      }
    };
    try {
      for (let index = 0; index < portCount; index += 1) leases.push(await acquirePortLease({ lockDirectory }));
      const value = await start(scope);
      return { ...value, scope };
    } catch (error) {
      const retryable = isAddressInUseError(error) || children.some(child => isAddressInUseError(watched.get(child)?.output));
      await scope.dispose();
      if (!retryable) throw error;
      if (attempt === retryDelays.length) throw errorWithCode('port_start_retry_exhausted', error);
      await pause(retryDelays[attempt]);
    }
  }
}
