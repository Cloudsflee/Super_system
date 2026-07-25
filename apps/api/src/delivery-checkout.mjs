import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WORKTREE_DIR } from './config.mjs';
import { git, isGitRepo } from './git-utils.mjs';
import { safeSegment } from './assist-v3-git.mjs';

export async function ensureDeliveryCheckout(context, delivery, baseSha) {
  const root = path.join(WORKTREE_DIR, safeSegment(context.project.id), 'deliveries');
  const target = path.join(root, safeSegment(context.task.id));
  await fsp.mkdir(root, { recursive: true });
  if (fs.existsSync(target) && isGitRepo(target)) {
    const marker = await fsp.lstat(path.join(target, '.git')).catch(() => null);
    if (marker?.isDirectory() && !marker.isSymbolicLink()) return target;
    if (marker?.isFile() && !marker.isSymbolicLink()) await migrateLinkedWorktree(context.repo_path, target);
    else throw checkoutError('delivery_checkout_git_metadata_invalid');
  }
  if (fs.existsSync(target)) throw checkoutError('delivery_worktree_path_occupied');

  const cloned = git(root, ['clone', '--no-hardlinks', '--no-checkout', '--', context.repo_path, target], 120_000);
  if (!cloned.ok) {
    await fsp.rm(target, { recursive: true, force: true });
    throw checkoutError('delivery_worktree_create_failed', { detail: cloned.stderr || cloned.error });
  }
  try {
    await configureRemote(context, target);
    const branchExists = git(target, ['show-ref', '--verify', '--quiet', `refs/heads/${delivery.branch}`], 5_000).ok;
    const checkedOut = git(
      target,
      branchExists ? ['checkout', delivery.branch] : ['checkout', '-b', delivery.branch, baseSha],
      60_000
    );
    if (!checkedOut.ok)
      throw checkoutError('delivery_worktree_create_failed', { detail: checkedOut.stderr || checkedOut.error });
    const head = git(target, ['rev-parse', 'HEAD'], 5_000).stdout.trim();
    if (head !== baseSha) throw checkoutError('delivery_base_sha_mismatch', { expected: baseSha, actual: head });
    return target;
  } catch (error) {
    await fsp.rm(target, { recursive: true, force: true });
    throw error;
  }
}

async function migrateLinkedWorktree(repository, target) {
  const status = git(target, ['status', '--porcelain', '--untracked-files=all'], 10_000);
  if (!status.ok)
    throw checkoutError('delivery_linked_worktree_migration_failed', { detail: status.stderr || status.error });
  if (status.stdout.trim()) throw checkoutError('delivery_linked_worktree_migration_dirty');
  const removed = git(repository, ['worktree', 'remove', '--force', target], 60_000);
  if (!removed.ok)
    throw checkoutError('delivery_linked_worktree_migration_failed', { detail: removed.stderr || removed.error });
  git(repository, ['worktree', 'prune'], 10_000);
}

async function configureRemote(context, target) {
  const remoteName = context.connection.remote_name || 'origin';
  const sourceRemote = git(context.repo_path, ['remote', 'get-url', remoteName], 5_000);
  if (!sourceRemote.ok) return;
  const current = git(target, ['remote', 'get-url', remoteName], 5_000);
  const configured = git(
    target,
    current.ok
      ? ['remote', 'set-url', remoteName, sourceRemote.stdout.trim()]
      : ['remote', 'add', remoteName, sourceRemote.stdout.trim()],
    5_000
  );
  if (!configured.ok)
    throw checkoutError('delivery_remote_configuration_failed', { detail: configured.stderr || configured.error });
}

function checkoutError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
