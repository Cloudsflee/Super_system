import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CODEX_HOME_DIR } from './config.mjs';

const RUNTIME_DB_PATTERN = /^(?:goals|logs|memories|state)_\d+\.sqlite(?:-(?:journal|shm|wal))?$/;
const RECOVERY_WINDOW_MS = 30_000;
const activeRecoveries = new Map();
const recentRecoveries = new Map();

export function isCodexStateRuntimeFailure(error) {
  return /failed to initialize sqlite state runtime|failed to initialize state runtime at \/codex-home/i.test(
    String(error?.message || error || '')
  );
}

export async function withCodexRuntimeStateRecovery(profile, operation, options = {}) {
  try {
    return await operation();
  } catch (error) {
    if (!(await recoverCodexRuntimeState(profile, error, options))) throw tagRuntimeStateError(error);
    try {
      return await operation();
    } catch (retryError) {
      throw tagRuntimeStateError(retryError);
    }
  }
}

export async function recoverCodexRuntimeState(profile, error, options = {}) {
  if (profile?.kind !== 'docker' || !isCodexStateRuntimeFailure(error)) return false;
  const home = path.resolve(
    String(profile.codex_home || path.join(options.allowedRoot || CODEX_HOME_DIR, String(profile.id || '')))
  );
  const current = activeRecoveries.get(home);
  if (current) return current;
  const clock = options.clock || Date.now,
    recoveredAt = recentRecoveries.get(home);
  if (recoveredAt && clock() - recoveredAt < RECOVERY_WINDOW_MS) return true;
  const recovery = archiveIncompatibleCodexState(home, options)
    .then((result) => {
      if (result) recentRecoveries.set(home, clock());
      return Boolean(result);
    })
    .catch(() => false)
    .finally(() => activeRecoveries.delete(home));
  activeRecoveries.set(home, recovery);
  return recovery;
}

export async function archiveIncompatibleCodexState(home, options = {}) {
  const allowedRoot = path.resolve(options.allowedRoot || CODEX_HOME_DIR);
  const [rootReal, homeReal] = await Promise.all([fsp.realpath(allowedRoot), fsp.realpath(path.resolve(home))]);
  const relative = path.relative(rootReal, homeReal);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const entries = await fsp.readdir(homeReal, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && RUNTIME_DB_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!files.length) return null;
  const stamp = new Date((options.clock || Date.now)())
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);
  const nonce = options.nonce || crypto.randomBytes(4).toString('hex');
  const backupDir = path.join(homeReal, '.aiws-backups', `runtime-state-${stamp}-${nonce}`);
  await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const moved = [];
  try {
    for (const name of files) {
      await fsp.rename(path.join(homeReal, name), path.join(backupDir, name));
      moved.push(name);
    }
  } catch (error) {
    for (const name of moved.reverse())
      await fsp.rename(path.join(backupDir, name), path.join(homeReal, name)).catch(() => undefined);
    throw error;
  }
  return { backup_dir: backupDir, files: files };
}

function tagRuntimeStateError(error) {
  if (isCodexStateRuntimeFailure(error)) {
    try {
      error.code = 'codex_state_runtime_incompatible';
    } catch {
      /* Preserve immutable errors. */
    }
  }
  return error;
}
