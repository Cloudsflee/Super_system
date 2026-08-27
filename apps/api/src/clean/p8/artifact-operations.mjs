import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Hex } from '../canonical.mjs';
import { PlatformError } from '../platform-error.mjs';

export class FilesystemOperationsAdapter {
  constructor({ root, components = {} } = {}) {
    if (!root) throw new TypeError('operations_artifact_root_required');
    this.root = path.resolve(String(root));
    this.components = Object.freeze(Object.fromEntries(Object.entries(components).map(([name, value]) => [name, value ? path.resolve(String(value)) : null])));
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  createBackup({ backupId, createdAt }) {
    const id = safeRef(backupId);
    const finalRoot = path.join(this.root, 'backups', id);
    const temporary = `${finalRoot}.tmp-${process.pid}`;
    if (fs.existsSync(finalRoot) || fs.existsSync(temporary)) throw new PlatformError('backup_exists', 'backup artifact already exists', {}, 409);
    fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
    try {
      const components = {};
      for (const [name, source] of Object.entries(this.components).sort(([left], [right]) => left.localeCompare(right))) {
        const target = path.join(temporary, safeRef(name));
        if (!source || !fs.existsSync(source)) { components[name] = { present: false, files: 0, bytes: 0, sha256: sha256Hex('') }; continue; }
        copyPath(source, target);
        components[name] = { present: true, ...treeDigest(target) };
      }
      const manifest = { schema_version: 'aiws.v3-clean.backup-artifact.v1', backup_id: id, created_at: createdAt, components };
      manifest.manifest_sha256 = sha256Hex(canonicalJson(manifest));
      writeDurable(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      fs.mkdirSync(path.dirname(finalRoot), { recursive: true, mode: 0o700 });
      fs.renameSync(temporary, finalRoot);
      fsyncDirectory(path.dirname(finalRoot));
      return manifest;
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  prepareRestore({ backupId, targetVolumeRef, preparedAt }) {
    const backup = path.join(this.root, 'backups', safeRef(backupId));
    if (!fs.existsSync(backup)) throw new PlatformError('backup_artifact_missing', 'backup artifact is unavailable', {}, 404);
    const sourceManifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
    const target = this.#newStaging(targetVolumeRef);
    copyPath(backup, target);
    const copiedManifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
    if (sha256Hex(canonicalJson({ ...copiedManifest, manifest_sha256: undefined })) !== copiedManifest.manifest_sha256) {
      fs.rmSync(target, { recursive: true, force: true });
      throw new PlatformError('restore_verification_failed', 'restored volume manifest failed verification', {}, 503);
    }
    return { schema_version: 'aiws.v3-clean.restore-prepare.v1', status: 'prepared', backup_id: safeRef(backupId), target_volume_ref: safeRef(targetVolumeRef), source_manifest_sha256: sourceManifest.manifest_sha256, target_manifest_sha256: copiedManifest.manifest_sha256, prepared_at: preparedAt, pointer_switched: false };
  }

  prepareReset({ targetVolumeRef, preserveBackups, preparedAt }) {
    const target = this.#newStaging(targetVolumeRef);
    const manifest = { schema_version: 'aiws.v3-clean.reset-prepare.v1', status: 'prepared', target_volume_ref: safeRef(targetVolumeRef), preserve_backups: preserveBackups !== false, prepared_at: preparedAt, pointer_switched: false };
    manifest.manifest_sha256 = sha256Hex(canonicalJson(manifest));
    writeDurable(path.join(target, 'reset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  #newStaging(reference) {
    const target = path.join(this.root, 'staging', safeRef(reference));
    if (fs.existsSync(target)) throw new PlatformError('target_volume_exists', 'target volume must be new', {}, 409);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return target;
  }
}

function copyPath(source, target) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  else { fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); }
  for (const file of filesOf(target)) { const handle = fs.openSync(file.absolute, 'r+'); try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); } }
  fsyncDirectory(path.dirname(target));
}

function treeDigest(root) {
  const entries = filesOf(root).map((file) => ({ path: file.relative.replaceAll('\\', '/'), bytes: fs.statSync(file.absolute).size, sha256: sha256Hex(fs.readFileSync(file.absolute)) }));
  return { files: entries.length, bytes: entries.reduce((sum, item) => sum + item.bytes, 0), sha256: sha256Hex(canonicalJson(entries)) };
}

function filesOf(root, relative = '') {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [{ absolute: root, relative: relative || path.basename(root) }];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = path.join(relative, entry.name);
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...filesOf(child, childRelative));
    else if (entry.isFile()) output.push({ absolute: child, relative: childRelative });
  }
  return output;
}

function writeDurable(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const handle = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(handle, content); fs.fsyncSync(handle); } finally { fs.closeSync(handle); } }
function fsyncDirectory(directory) { try { const handle = fs.openSync(directory, 'r'); try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); } } catch { /* Windows may reject directory fsync. */ } }
function safeRef(value) { const result = String(value || ''); if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,160}$/.test(result)) throw new PlatformError('artifact_reference_invalid', 'artifact reference is invalid', {}, 422); return result; }
