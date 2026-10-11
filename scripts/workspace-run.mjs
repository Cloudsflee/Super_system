// Owner: Platform/Testing. Phase: P10+. Invoke directly for individual probes/tests.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { layout, contains, assertNoLinks, writeExclusive, fail } from './lib/workspace-storage.mjs';
import { pnpmInvocation, terminateProcessTree } from './lib/gate-process.mjs';

export function managedInvocation(command, args) {
  if (command === 'node') return { command: process.execPath, args };
  if (command === 'pnpm') return pnpmInvocation(args);
  if (command === 'corepack' && args[0] === 'pnpm') return pnpmInvocation(args.slice(1));
  if (/\.(?:cmd|bat)$/i.test(command)) fail('workspace_run_shell_script_rejected');
  if (process.platform === 'win32' && !path.isAbsolute(command)) {
    const found = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true });
    const executable = found.stdout?.split(/\r?\n/).find(value => /\.exe$/i.test(value));
    if (executable) return { command: executable, args };
  }
  return { command, args };
}
export async function runManaged(argv, options = {}) {
  if (argv[0] === '--') argv = argv.slice(1);
  if (!argv.length) fail('workspace_run_command_required');
  const env = options.env || process.env;
  const roots = layout(options.cwd || process.cwd(), env);
  const inherited = env.AIWS_STORAGE_RUN_ID;
  if (inherited && !/^[a-f0-9-]{36}$/.test(inherited)) fail('workspace_run_identity_invalid');
  const runId = inherited || randomUUID();
  const commandId = randomUUID();
  const runRoot = path.join(roots.temp, 'runs', runId);
  const commandRoot = path.join(runRoot, commandId);
  assertNoLinks(runRoot);
  fs.mkdirSync(commandRoot, { recursive: true, mode: 0o700 });
  const sharedLock = env.AIWS_PORT_LEASE_ROOT || path.join(os.tmpdir(), 'aiws-port-leases-v1');
  if (contains(runRoot, sharedLock)) fail('workspace_run_shared_lock_invalid');
  const metadata = { schema: 'aiws.workspace-run.v1', run_id: runId, command_id: commandId, pid: process.pid, started_at: new Date().toISOString(), directory: commandRoot, parent_command_id: env.AIWS_STORAGE_COMMAND_ID || null };
  writeExclusive(path.join(commandRoot, '.owner.json'), metadata);
  const temporary = path.join(commandRoot, 'temp');
  fs.mkdirSync(temporary, { mode: 0o700 });
  const invocation = managedInvocation(argv[0], argv.slice(1));
  let businessCode = 1; let businessError = null; let signal = null; let cleanupError = null;
  let child; let timer; let cancelled = false;
  const stop = async received => {
    cancelled = true; signal = received;
    await terminateProcessTree(child);
  };
  const onInterrupt = () => { void stop('SIGINT'); };
  const onTerminate = () => { void stop('SIGTERM'); };
  const onAbort = () => { void stop('cancelled'); };
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const childEnvironment = { ...env, AIWS_TEMP_ROOT: roots.temp, AIWS_ARCHIVE_ROOT: roots.archive, AIWS_STORAGE_RUN_ID: runId, AIWS_STORAGE_COMMAND_ID: commandId, AIWS_PORT_LEASE_ROOT: sharedLock, TEMP: temporary, TMP: temporary, TMPDIR: temporary };
    if (process.platform === 'win32') {
      const count = Number(childEnvironment.GIT_CONFIG_COUNT || 0);
      if (!Number.isSafeInteger(count) || count < 0) fail('workspace_run_git_config_invalid');
      childEnvironment.GIT_CONFIG_COUNT = String(count + 1);
      childEnvironment[`GIT_CONFIG_KEY_${count}`] = 'core.longpaths';
      childEnvironment[`GIT_CONFIG_VALUE_${count}`] = 'true';
    }
    for (const key of Object.keys(childEnvironment)) if (key.toLowerCase() === 'psmodulepath') delete childEnvironment[key];
    const nativeReceipt = path.join(commandRoot, '.process-result.json');
    const windows = process.platform === 'win32';
    const executable = windows ? 'pwsh.exe' : invocation.command;
    const arguments_ = windows ? ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./lib/workspace-process.ps1', import.meta.url))] : invocation.args;
    const streams = options.stdio || 'inherit';
    child = spawn(executable, arguments_, {
      cwd: options.cwd || process.cwd(), shell: false, windowsHide: true,
      detached: !windows, stdio: windows ? ['pipe', streams, streams] : streams,
      env: childEnvironment
    });
    if (windows) { child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ ...invocation, cwd: options.cwd || process.cwd(), receipt: nativeReceipt })); }
    if (options.signal?.aborted) void stop('cancelled');
    const timeout = Number(options.timeoutMs || env.AIWS_RUN_TIMEOUT_MS || 0);
    if (!Number.isFinite(timeout) || timeout < 0) fail('workspace_run_timeout_invalid');
    if (timeout) timer = setTimeout(() => { businessError = 'workspace_run_timeout'; void stop('timeout'); }, timeout);
    businessCode = await new Promise(resolve => {
      child.once('error', error => { businessError = error.code || 'workspace_run_spawn_failed'; resolve(1); });
      child.once('close', (code, received) => { signal ||= received; resolve(code ?? (cancelled ? 130 : 1)); });
    });
    if (windows && fs.existsSync(nativeReceipt)) {
      const native = JSON.parse(fs.readFileSync(nativeReceipt, 'utf8'));
      businessCode = native.exit_status;
      businessError ||= native.error || (native.remaining_processes ? 'workspace_run_descendants_alive' : null);
    } else if (windows && !cancelled) businessError ||= 'workspace_run_process_receipt_missing';
    if (cancelled && businessCode === 0) businessCode = 130;
    if (!windows && child.pid) {
      try { process.kill(-child.pid, 0); businessError ||= 'workspace_run_descendants_alive'; process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  } catch (error) { businessError = error.code || error.message; await terminateProcessTree(child); }
  finally {
    clearTimeout(timer); process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
    options.signal?.removeEventListener('abort', onAbort);
  }
  const success = businessCode === 0 && !businessError && !signal;
  let archiveId = null;
  try {
    assertNoLinks(commandRoot);
    const recorded = JSON.parse(fs.readFileSync(path.join(commandRoot, '.owner.json'), 'utf8'));
    if (recorded.command_id !== commandId || recorded.pid !== process.pid) fail('workspace_run_owner_changed');
    if (success) fs.rmSync(commandRoot, { recursive: true });
    else {
      // Authentication owners destroy credentials themselves. Never copy an
      // unexpected authentication home to the diagnostic archive.
      const inspect = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) fail('workspace_run_link_requires_review');
          if (/^(?:auth\.json|credentials|\.codex|\.codex-device-auth|\.codex-host|codex-homes|\.ssh|\.env)$/i.test(entry.name)) fail('workspace_run_auth_owner_cleanup_required');
          if (entry.isDirectory()) inspect(path.join(directory, entry.name));
        }
      };
      inspect(temporary);
      archiveId = `${runId}-${commandId}`;
      const destination = path.join(roots.archive, 'failed-runs', archiveId);
      assertNoLinks(path.dirname(destination));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      if (fs.existsSync(destination)) fail('workspace_run_archive_collision');
      // Roots are deliberately required on one volume for automatic lifecycle
      // moves. Cross-volume legacy migration uses the ACL-verifying tool.
      fs.renameSync(commandRoot, destination);
      writeExclusive(path.join(destination, 'result.json'), { ...metadata, directory: undefined, business_exit_status: businessCode, business_error: businessError, signal });
    }
    try { fs.rmdirSync(runRoot); } catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; }
  } catch (error) { cleanupError = error.code || error.message; }
  const result = { schema: 'aiws.workspace-run-result.v1', run_id: runId, command_id: commandId, business_exit_status: businessCode, business_error: businessError, signal, cleanup_error: cleanupError, archive_id: archiveId, exit_status: businessCode || (businessError || signal || cleanupError ? 1 : 0) };
  if (cleanupError) {
    const receipts = path.join(roots.archive, 'storage-diagnostics');
    fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
    writeExclusive(path.join(receipts, `${commandId}.json`), result);
  }
  return result;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runManaged(process.argv.slice(2));
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exit_status;
  } catch (error) { process.stderr.write(`${error.code || error.message}\n`); process.exitCode = 1; }
}
