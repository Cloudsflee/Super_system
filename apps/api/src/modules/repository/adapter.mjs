import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { AppError, assert } from '../../errors.mjs';
import { hashJson, sha256 } from '../../crypto.mjs';
import { normalizeRelativePath } from '../../path-policy.mjs';
import { FIXTURES, initializeFixture, gitHead } from '../../git-fixture.mjs';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const MAX_SOURCE_LABEL = 240;

/** Validate and normalize the public source discriminator. */
export function normalizeRepositorySource(source, config = {}) {
  assert(source && typeof source === 'object' && !Array.isArray(source), 'repository_source_invalid', 'repository source must be an object', { status: 422 });
  const kind = String(source.kind || '').trim().toLowerCase();
  if (kind === 'fixture') {
    const fixtureId = String(source.id || '').trim();
    assert(FIXTURES[fixtureId], 'repository_source_invalid', 'repository fixture is unknown', { status: 422, details: { source_kind: 'fixture' } });
    return Object.freeze({ kind: 'fixture', id: fixtureId, label: `fixture:${fixtureId}` });
  }
  if (kind === 'local' || kind === 'path') {
    const locator = String(source.path || source.locator || '').trim();
    assert(locator.length > 0 && locator.length <= 4096, 'repository_source_invalid', 'local repository path is required', { status: 422, details: { source_kind: 'local' } });
    const canonical = canonicalImportPath(locator, config.projectImportRoots || config.importRoots || []);
    return Object.freeze({ kind: 'local', path: canonical, locator: canonical, label: path.basename(canonical).slice(0, MAX_SOURCE_LABEL) });
  }
  if (kind === 'git' || kind === 'https' || kind === 'https_git') {
    const raw = String(source.url || source.remote_url || source.locator || '').trim();
    const url = validateGitUrl(raw, config.projectGitHosts || config.gitHosts || []);
    return Object.freeze({ kind: 'git', url, locator: url, label: displayUrl(url) });
  }
  if (kind === 'upload' || kind === 'archive') {
    const locator = String(source.locator || source.path || '').trim();
    assert(locator.length <= 4096, 'repository_source_invalid', 'source locator is too long', { status: 422 });
    return Object.freeze({ kind, locator, label: `${kind}:${path.basename(locator || 'pending')}`.slice(0, MAX_SOURCE_LABEL) });
  }
  throw new AppError('repository_source_invalid', 'repository source kind is not supported', { status: 422, details: { source_kind: kind || null } });
}

export function canonicalImportPath(input, roots = []) {
  const candidate = path.resolve(String(input));
  const configuredRoots = (Array.isArray(roots) ? roots : []).map((root) => path.resolve(String(root))).filter(Boolean);
  assert(configuredRoots.length > 0, 'repository_source_invalid', 'local repository imports are disabled until an allowlist root is configured', { status: 422, details: { source_kind: 'local' } });
  let realCandidate;
  try { realCandidate = fs.realpathSync(candidate); }
  catch { throw new AppError('repository_source_invalid', 'local repository path does not exist', { status: 422, details: { source_kind: 'local' } }); }
  const matchedRoot = configuredRoots.find((root) => {
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch { return false; }
    return realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${path.sep}`);
  });
  assert(matchedRoot, 'repository_source_invalid', 'local repository path is outside the configured allowlist', { status: 422, details: { source_kind: 'local' } });
  const stat = fs.lstatSync(realCandidate);
  assert(stat.isDirectory(), 'repository_source_invalid', 'local repository source must be a directory', { status: 422, details: { source_kind: 'local' } });
  assert(!stat.isSymbolicLink(), 'repository_source_invalid', 'local repository source may not be a symlink', { status: 422, details: { source_kind: 'local' } });
  return realCandidate;
}

export function validateGitUrl(raw, hosts = []) {
  let parsed;
  try { parsed = new URL(String(raw)); } catch { throw new AppError('repository_source_invalid', 'repository URL is invalid', { status: 422, details: { source_kind: 'git' } }); }
  assert(parsed.protocol === 'https:', 'repository_source_invalid', 'repository URL must use HTTPS', { status: 422, details: { source_kind: 'git' } });
  assert(!parsed.username && !parsed.password, 'repository_source_invalid', 'repository URL userinfo is not allowed', { status: 422, details: { source_kind: 'git' } });
  const allowlist = (Array.isArray(hosts) ? hosts : []).map((host) => String(host).toLowerCase()).filter(Boolean);
  assert(allowlist.includes(parsed.hostname.toLowerCase()), 'repository_source_invalid', 'repository URL host is not allowlisted', { status: 422, details: { source_kind: 'git', host: parsed.hostname.toLowerCase() } });
  assert(parsed.pathname.length > 1 && !parsed.pathname.includes('\\'), 'repository_source_invalid', 'repository URL path is invalid', { status: 422, details: { source_kind: 'git' } });
  parsed.hash = '';
  return parsed.toString();
}

export async function runGit(directory, args, { signal, timeout = GIT_TIMEOUT_MS } = {}) {
  const resolved = path.resolve(directory);
  const fixedArgs = ['-c', `safe.directory=${resolved}`, '-C', resolved, ...args.map(String)];
  try {
    const result = await execFileAsync('git', fixedArgs, {
      encoding: 'utf8', windowsHide: true, timeout, signal,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    });
    return { stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
  } catch (error) {
    const code = error?.killed && error?.signal === 'SIGTERM' ? 'repository_probe_timeout' : 'repository_probe_failed';
    throw new AppError(code, 'repository Git operation failed', { status: 422, retryable: code === 'repository_probe_timeout', details: { source_kind: 'git' } });
  }
}

export async function probeRepositorySource(source, config = {}, { signal } = {}) {
  const normalized = normalizeRepositorySource(source, config);
  if (normalized.kind === 'fixture') {
    const files = Object.keys(FIXTURES[normalized.id].files).sort();
    const manifest = await manifestDirectoryFromFixture(normalized.id);
    return { ...publicSource(normalized), revision: manifest.revision, hash: manifest.hash, file_count: files.length, read_only: true, manifest };
  }
  if (normalized.kind === 'local') {
    const manifest = manifestDirectory(normalized.path);
    const revision = await detectGitRevision(normalized.path, signal).catch(() => manifest.hash);
    return { ...publicSource(normalized), revision, hash: manifest.hash, file_count: manifest.entries.length, read_only: true, manifest };
  }
  if (normalized.kind === 'git') {
    const revision = await remoteGitRevision(normalized.url, signal);
    return { ...publicSource(normalized), revision, hash: revision, file_count: null, read_only: true };
  }
  return { ...publicSource(normalized), revision: '', hash: '', file_count: null, read_only: true };
}

export async function stageRepositorySource(source, stagingDirectory, config = {}, { signal } = {}) {
  const normalized = normalizeRepositorySource(source, config);
  const target = path.resolve(stagingDirectory);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  if (normalized.kind === 'fixture') {
    const revision = await initializeFixture(target, normalized.id);
    const manifest = manifestDirectory(target);
    return { source: publicSource(normalized), revision, hash: manifest.hash, manifest, path: target };
  }
  if (normalized.kind === 'local') {
    const before = manifestDirectory(normalized.path);
    copyDirectorySafe(normalized.path, target);
    const after = manifestDirectory(normalized.path);
    if (before.hash !== after.hash) throw new AppError('repository_source_changed', 'read-only source changed during import', { status: 409, details: { source_kind: 'local' } });
    const staged = manifestDirectory(target);
    return { source: publicSource(normalized), revision: await detectGitRevision(normalized.path, signal).catch(() => before.hash), hash: before.hash, manifest: staged, path: target };
  }
  if (normalized.kind === 'git') {
    await runGit(path.dirname(target), ['clone', '--no-hardlinks', '--no-checkout', '--', normalized.url, target], { signal });
    await runGit(target, ['checkout', '--detach', 'HEAD'], { signal });
    await runGit(target, ['remote', 'remove', 'origin'], { signal }).catch(() => undefined);
    const revision = (await runGit(target, ['rev-parse', 'HEAD'], { signal })).stdout;
    const manifest = manifestDirectory(target);
    return { source: publicSource(normalized), revision, hash: manifest.hash, manifest, path: target };
  }
  throw new AppError('repository_source_invalid', 'source cannot be staged without an upload artifact', { status: 422 });
}

export function atomicRename(source, destination) {
  const from = path.resolve(source), to = path.resolve(destination);
  assert(from !== to, 'repository_line_fault', 'staging and checkout paths must differ', { status: 409 });
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
  return to;
}

export function manifestDirectory(directory) {
  const root = path.resolve(directory);
  const entries = [];
  walkDirectory(root, root, entries);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const hash = hashJson(entries.map(({ path: relative, sha256: digest, byte_size: byteSize, mode }) => ({ path: relative, sha256: digest, byte_size: byteSize, mode })));
  return { revision: hash, hash, entries };
}

export function manifestBytes(entries = []) {
  const normalized = [...entries].map((entry) => ({ path: normalizeRelativePath(String(entry.path)), sha256: String(entry.sha256), byte_size: Number(entry.byte_size), mode: String(entry.mode || 'file') })).sort((a, b) => a.path.localeCompare(b.path));
  return { hash: hashJson(normalized), entries: normalized };
}

export function createDeterministicArchive(directory) {
  const manifest = manifestDirectory(directory);
  const chunks = ['AIWS-ARCHIVE-V1\n'];
  for (const entry of manifest.entries) {
    const bytes = fs.readFileSync(path.join(path.resolve(directory), ...entry.path.split('/')));
    chunks.push(`${entry.path}\t${entry.sha256}\t${entry.byte_size}\n`);
    chunks.push(bytes.toString('base64'), '\n');
  }
  const bytes = Buffer.from(chunks.join(''), 'utf8');
  return { bytes, sha256: sha256(bytes), manifest };
}

export function copyDirectorySafe(source, target) {
  const root = path.resolve(source);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (item.name === '.git' || item.name === '.aiws') continue;
    const from = path.join(root, item.name), to = path.join(target, item.name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new AppError('repository_source_invalid', 'repository source contains a symlink', { status: 422, details: { path: item.name } });
    if (stat.isDirectory()) copyDirectorySafe(from, to);
    else if (stat.isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.copyFileSync(from, to); }
    else throw new AppError('repository_source_invalid', 'repository source contains a special file', { status: 422 });
  }
}

export function publicSource(source) {
  const { path: _path, locator, url, id: fixtureId, ...rest } = source || {};
  return {
    kind: rest.kind,
    display_label: String(rest.label || (fixtureId ? `fixture:${fixtureId}` : locator || url || '')).slice(0, MAX_SOURCE_LABEL),
    ...(rest.kind === 'fixture' ? { fixture_id: fixtureId } : {}),
    ...(rest.kind === 'git' ? { host: new URL(url).hostname.toLowerCase() } : {})
  };
}

function displayUrl(url) {
  const parsed = new URL(url);
  return `${parsed.hostname}${parsed.pathname}`.slice(0, MAX_SOURCE_LABEL);
}

async function remoteGitRevision(url, signal) {
  const result = await runGit(process.cwd(), ['ls-remote', '--heads', '--', url], { signal });
  const first = result.stdout.split(/\r?\n/).find(Boolean) || '';
  const revision = first.split(/\s+/)[0] || '';
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new AppError('repository_probe_failed', 'remote repository has no readable head', { status: 422 });
  return revision;
}

async function detectGitRevision(directory, signal) {
  const result = await runGit(directory, ['rev-parse', 'HEAD'], { signal });
  return result.stdout;
}

async function manifestDirectoryFromFixture(fixtureId) {
  const fixture = FIXTURES[fixtureId];
  const entries = Object.entries(fixture.files).map(([relative, content]) => ({ path: relative, sha256: sha256(content), byte_size: Buffer.byteLength(content), mode: 'file' }));
  return { ...manifestBytes(entries), revision: hashJson(entries) };
}

function walkDirectory(root, current, entries) {
  const list = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const item of list) {
    if (item.name === '.git' || item.name === '.aiws') continue;
    const absolute = path.join(current, item.name);
    const relative = normalizeRelativePath(path.relative(root, absolute).replaceAll('\\', '/'));
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new AppError('repository_source_invalid', 'repository source contains a symlink', { status: 422, details: { path: relative } });
    if (stat.isDirectory()) walkDirectory(root, absolute, entries);
    else if (stat.isFile()) {
      const bytes = fs.readFileSync(absolute);
      entries.push({ path: relative, sha256: sha256(bytes), byte_size: bytes.byteLength, mode: 'file' });
    } else throw new AppError('repository_source_invalid', 'repository source contains a special file', { status: 422, details: { path: relative } });
  }
}
