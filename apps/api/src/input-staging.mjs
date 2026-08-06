import fs from 'node:fs';
import path from 'node:path';
import { normalizeRelativePath, resolveWorkspacePath } from './path-policy.mjs';

const RUNNER_UID = 10001;
const RUNNER_GID = 10001;

function grantRunnerPath(target, directory = false) {
  try { fs.chownSync(target, RUNNER_UID, RUNNER_GID); } catch { /* Windows/rootless hosts keep native ownership. */ }
  try { fs.chmodSync(target, directory ? 0o770 : 0o660); } catch { /* The container mount remains the enforcement boundary. */ }
}

function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('input_staging_path_escape');
  }
  return resolvedTarget;
}

function assertNoSymlinkComponents(root, target, code) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = assertInside(resolvedRoot, target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  const components = [resolvedRoot];
  let current = resolvedRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    components.push(current);
  }
  for (const component of components) {
    try {
      if (fs.lstatSync(component).isSymbolicLink()) throw new Error(code);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return resolvedTarget;
}

function validateAssets(config, assets) {
  if (!Array.isArray(assets)) throw new Error('input_assets_invalid');
  const casRoot = path.resolve(config.casRoot);
  if (!assets.length) return [];
  if (!fs.existsSync(casRoot) || !fs.lstatSync(casRoot).isDirectory()) throw new Error('input_cas_root_invalid');
  assertNoSymlinkComponents(path.resolve(config.home), casRoot, 'input_asset_symlink_not_allowed');
  const validated = assets.map((asset) => {
    const hash = String(asset?.cas_hash || '');
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('input_asset_hash_invalid');
    const name = normalizeRelativePath(String(asset?.name || ''));
    const source = assertNoSymlinkComponents(
      casRoot,
      path.join(casRoot, hash.slice(0, 2), hash),
      'input_asset_symlink_not_allowed'
    );
    let sourceStat;
    try { sourceStat = fs.lstatSync(source); } catch { throw new Error('input_asset_missing'); }
    if (!sourceStat.isFile()) throw new Error('input_asset_missing');
    if (asset?.byte_size != null && Number(asset.byte_size) !== sourceStat.size) throw new Error('input_asset_size_mismatch');
    return { asset, hash, name, source, sourceStat };
  });
  const names = validated.map((item) => item.name).sort();
  for (let index = 1; index < names.length; index += 1) {
    if (names[index] === names[index - 1] || names[index].startsWith(`${names[index - 1]}/`)) {
      throw new Error('input_asset_path_conflict');
    }
  }
  return validated;
}

/**
 * Stage only the assets declared by an execution. CAS objects are linked into
 * an execution-specific tree so a runner never receives the global CAS root.
 * Hard links preserve bytes without duplicating large assets; copy is used on
 * filesystems that do not support links (for example some Windows volumes).
 */
export function stageExecutionInputs(config, projectId, executionId, assets = []) {
  const root = resolveWorkspacePath(config.home, `inputs/${projectId}/${executionId}`);
  const validated = validateAssets(config, assets);
  assertNoSymlinkComponents(path.resolve(config.home), root, 'input_staging_symlink_not_allowed');
  fs.mkdirSync(root, { recursive: true, mode: 0o770 });
  assertNoSymlinkComponents(path.resolve(config.home), root, 'input_staging_symlink_not_allowed');
  grantRunnerPath(root, true);
  const staged = [];
  for (const { asset, hash, name, source, sourceStat } of validated) {
    const target = assertInside(root, path.join(root, name));
    assertNoSymlinkComponents(root, path.dirname(target), 'input_staging_symlink_not_allowed');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o770 });
    assertNoSymlinkComponents(root, path.dirname(target), 'input_staging_symlink_not_allowed');
    assertNoSymlinkComponents(root, target, 'input_staging_symlink_not_allowed');
    grantRunnerPath(path.dirname(target), true);
    try { fs.rmSync(target, { force: true }); } catch { /* best effort before replacement */ }
    assertNoSymlinkComponents(root, path.dirname(target), 'input_staging_symlink_not_allowed');
    try {
      fs.linkSync(source, target);
    } catch {
      fs.copyFileSync(source, target);
    }
    grantRunnerPath(target);
    staged.push({
      id: String(asset.id || ''),
      name,
      relative_path: name,
      cas_hash: hash,
      byte_size: sourceStat.size,
      media_type: String(asset.media_type || 'application/octet-stream')
    });
  }
  return {
    root,
    subpath: `inputs/${projectId}/${executionId}`,
    assets: staged
  };
}

export function removeExecutionInputs(config, projectId, executionId) {
  const root = resolveWorkspacePath(config.home, `inputs/${projectId}/${executionId}`);
  fs.rmSync(root, { recursive: true, force: true });
}
