// Owner: Platform/Testing. Phase: P10+. Local private storage, never runtime persistence.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const fail = code => { throw Object.assign(new Error(code), { code }); };
export function writeExclusive(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
export function git(root, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) fail('storage_git_failed');
  return result.stdout.trim();
}
export function layout(cwd = process.cwd(), env = process.env) {
  const common = fs.realpathSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const main = path.dirname(common);
  const sibling = suffix => path.join(path.dirname(main), `${path.basename(main)}-${suffix}`);
  const temp = env.AIWS_TEMP_ROOT || sibling('temp');
  const archive = env.AIWS_ARCHIVE_ROOT || sibling('archives');
  if (path.basename(common) !== '.git' && (!env.AIWS_TEMP_ROOT || !env.AIWS_ARCHIVE_ROOT)) fail('storage_explicit_roots_required');
  for (const value of [temp, archive]) {
    if (!path.isAbsolute(value) || !fs.statSync(value).isDirectory()) fail('storage_existing_absolute_root_required');
    assertNoLinks(value);
  }
  if (contains(temp, archive) || contains(archive, temp) || contains(main, temp) || contains(main, archive)) fail('storage_roots_overlap');
  return { main, temp: fs.realpathSync(temp), archive: fs.realpathSync(archive), worktrees: sibling('worktrees'), systemTemp: fs.realpathSync(os.tmpdir()) };
}
export function contains(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function assertNoLinks(target) {
  let current = path.resolve(target);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('storage_link_boundary');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
export function snapshot(root) {
  assertNoLinks(root);
  const rows = [];
  const visit = (relative) => {
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      rows.push({ path: relative, kind: 'link', target: fs.readlinkSync(full) });
      return;
    }
    if (stat.isDirectory()) {
      rows.push({ path: relative, kind: 'directory', mode: stat.mode & 0o777 });
      for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name));
    } else if (stat.isFile()) {
      const bytes = fs.readFileSync(full);
      const after = fs.statSync(full);
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || bytes.length !== stat.size) fail('storage_source_changed');
      rows.push({ path: relative, kind: 'file', size: stat.size, sha256: digest(bytes), mode: stat.mode & 0o777 });
    } else fail('storage_special_file');
  };
  visit('');
  return { sha256: digest(JSON.stringify(rows)), bytes: rows.reduce((sum, row) => sum + (row.size || 0), 0), rows };
}
export function sameSnapshot(root, expected) {
  if (snapshot(root).sha256 !== expected.sha256) fail('storage_source_changed');
}
export function windowsOperation(action, source, destination, aclFile) {
  const script = new URL('./workspace-storage.ps1', import.meta.url);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', decodeURIComponent(script.pathname).replace(/^\/([A-Za-z]:)/, '$1'), '-Action', action, '-Source', source, '-Destination', destination || source, '-AclFile', aclFile], { env, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw Object.assign(new Error(`storage_windows_${action}_failed`), { code: `storage_windows_${action}_failed`, details: { exit_status: result.status, stderr: result.stderr } });
}
export function moveVerified(source, destination, expected, aclFile) {
  assertNoLinks(source); assertNoLinks(path.dirname(destination));
  if (fs.existsSync(destination)) fail('storage_destination_exists');
  sameSnapshot(source, expected);
  if (expected.rows.some(row => row.kind === 'link')) fail('storage_link_requires_review');
  if (process.platform === 'win32') windowsOperation('Check', source, source, aclFile);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    const staging = `${destination}.staging`;
    if (!fs.existsSync(staging)) {
      fs.mkdirSync(staging, { mode: 0o700 });
      if (process.platform === 'win32') windowsOperation('Copy', source, staging, aclFile);
      else fs.cpSync(source, staging, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    }
    sameSnapshot(staging, expected); sameSnapshot(source, expected);
    if (process.platform === 'win32') windowsOperation('Check', staging, staging, aclFile);
    fs.renameSync(staging, destination);
    // A published destination is durable before the source is removed. A failed
    // removal leaves two copies and is never silently resumed or overwritten.
    sameSnapshot(source, expected);
    fs.rmSync(source, { recursive: true });
  }
  sameSnapshot(destination, expected);
  if (process.platform === 'win32') windowsOperation('Check', destination, destination, aclFile);
}

export function loadManifest(file) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { sha256, ...body } = manifest;
  if (digest(JSON.stringify(body)) !== sha256 || body.schema !== 'aiws.workspace-storage.v1') fail('storage_manifest_invalid');
  const ids = new Set(); const sources = [];
  const allowed = new Set(['archive', 'keep_referenced', 'keep_runtime', 'skip_active', 'skip_unknown', 'other_project']);
  for (const item of body.items) {
    if (ids.has(item.id) || !allowed.has(item.classification) || !item.reason) fail('storage_manifest_item_invalid');
    ids.add(item.id);
    if (item.classification !== 'archive') continue;
    if (!item.proof || !item.snapshot || !body.source_roots.some(root => contains(root, item.source) && root !== item.source)
      || !contains(body.destination_root, item.destination) || item.destination === body.destination_root
      || contains(item.source, item.destination) || contains(item.destination, item.source)
      || sources.some(source => contains(source, item.source) || contains(item.source, source))) fail('storage_manifest_boundary');
    sources.push(item.source);
  }
  return manifest;
}
export function sealManifest(file, body) {
  writeExclusive(file, { ...body, sha256: digest(JSON.stringify(body)) });
}
export function applyManifest(file, action, dryRun = false) {
  const manifest = loadManifest(file);
  if (!['apply', 'verify', 'rollback'].includes(action)) fail('storage_action_invalid');
  const mutexKey = digest(fs.realpathSync(file).toLowerCase());
  if (process.platform === 'win32' && process.env.AIWS_STORAGE_MUTEX_KEY !== mutexKey) {
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./workspace-storage.ps1', import.meta.url)), '-Action', 'Mutex', '-Source', path.resolve(file), '-Destination', action, '-AclFile', process.execPath, '-CliScript', fileURLToPath(new URL('../workspace-storage.mjs', import.meta.url)), '-MutexKey', mutexKey, '-DryRun', String(dryRun)], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (!result.stdout?.trim()) fail(result.stderr?.trim() || 'storage_mutex_operation_failed');
    return JSON.parse(result.stdout);
  }
  const journal = `${file}.journal`;
  if (action === 'apply') fs.mkdirSync(journal, { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const descriptor = process.platform === 'win32' ? null : fs.openSync(lock, 'wx', 0o600);
  const results = [];
  try {
    const items = manifest.items.filter(item => item.classification === 'archive');
    if (action === 'rollback') {
      // Validate ALL targets before the first inverse mutation.
      for (const item of items) {
        const applied = path.join(journal, `${item.id}.applied.json`);
        const rolled = path.join(journal, `${item.id}.rolled-back.json`);
        if (!fs.existsSync(applied)) fail('storage_apply_receipt_missing');
        sameSnapshot(fs.existsSync(rolled) ? item.source : item.destination, item.snapshot);
        if (process.platform === 'win32') windowsOperation('Check', fs.existsSync(rolled) ? item.source : item.destination, null, path.join(journal, `${item.id}.acl.json`));
        if (!fs.existsSync(rolled) && fs.existsSync(item.source)) fail('storage_rollback_source_exists');
        assertNoLinks(path.dirname(item.source));
      }
    }
    for (const item of action === 'rollback' ? items.toReversed() : items) {
      const applied = path.join(journal, `${item.id}.applied.json`);
      const rolled = path.join(journal, `${item.id}.rolled-back.json`);
      const acl = path.join(journal, `${item.id}.acl.json`);
      try {
        for (const receipt of [applied, rolled, path.join(journal, `${item.id}.intent.json`)]) {
          if (!fs.existsSync(receipt)) continue;
          const recorded = JSON.parse(fs.readFileSync(receipt, 'utf8'));
          if (recorded.manifest !== manifest.sha256 || recorded.item !== item.id) fail('storage_journal_identity_mismatch');
        }
        if (fs.existsSync(rolled)) {
          if (action === 'apply') fail('storage_already_rolled_back');
          sameSnapshot(item.source, item.snapshot);
        } else if (action === 'verify') {
          if (!fs.existsSync(applied) || fs.existsSync(item.source)) fail('storage_apply_incomplete');
          sameSnapshot(item.destination, item.snapshot);
          if (process.platform === 'win32') windowsOperation('Check', item.destination, item.destination, acl);
        } else if (action === 'rollback') {
          if (!dryRun) {
            moveVerified(item.destination, item.source, item.snapshot, acl);
            if (process.platform === 'win32') windowsOperation('Restore', item.source, null, acl);
            writeExclusive(rolled, { manifest: manifest.sha256, item: item.id, at: new Date().toISOString() });
          }
        } else if (fs.existsSync(applied)) {
          if (fs.existsSync(item.source)) fail('storage_two_copies_require_review');
          sameSnapshot(item.destination, item.snapshot);
        } else {
          const intent = path.join(journal, `${item.id}.intent.json`);
          if (!fs.existsSync(intent)) {
            sameSnapshot(item.source, item.snapshot);
            if (process.platform === 'win32') windowsOperation('Capture', item.source, item.source, acl);
            writeExclusive(intent, { manifest: manifest.sha256, item: item.id, at: new Date().toISOString() });
          }
          if (!fs.existsSync(item.source) && fs.existsSync(item.destination)) {
            sameSnapshot(item.destination, item.snapshot);
            if (process.platform === 'win32') windowsOperation('Check', item.destination, item.destination, acl);
          } else moveVerified(item.source, item.destination, item.snapshot, acl);
          writeExclusive(applied, { manifest: manifest.sha256, item: item.id, bytes: item.snapshot.bytes, at: new Date().toISOString() });
        }
        results.push({ id: item.id, ok: true, bytes: item.snapshot.bytes });
      } catch (error) {
        results.push({ id: item.id, ok: false, error: error.code || error.message, details: error.details });
        if (!dryRun && action !== 'verify') writeExclusive(path.join(journal, `${item.id}.failed-${randomUUID()}.json`), results.at(-1));
      }
    }
  } finally { if (descriptor != null) { fs.closeSync(descriptor); fs.unlinkSync(lock); } }
  return { action, dry_run: dryRun, results, byte_exact_mismatches: results.filter(row => !row.ok).map(row => row.id), ok: results.every(row => row.ok) };
}
