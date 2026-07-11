import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { STAGING_DIR, WORKSPACE_DIR } from './config.mjs';
import { command, HttpError } from './http.mjs';
import { isGitRepo } from './git-utils.mjs';
import { assertWithin, managedProjectRoot, managedRepoPath, safeSegment } from './managed-workspace.mjs';
import { now } from '../../../packages/shared/index.mjs';
import { id } from '../../../packages/shared/index.mjs';

export const PROJECT_IMPORT_LIMITS = Object.freeze({ files: 10000, totalBytes: 512 * 1024 * 1024, fileBytes: 64 * 1024 * 1024 });
const LIMITS = PROJECT_IMPORT_LIMITS;

export async function materializeCodeSource(project, source, operationKey = 'default') {
  const normalized = normalizeCodeSource(source);
  if (!normalized) return ensureManagedRepository(project.id);
  const projectRoot = managedProjectRoot(project.id), target = managedRepoPath(project.id);
  const stage = path.join(STAGING_DIR, safeSegment(project.id), safeSegment(operationKey)), stagedRepo = path.join(stage, 'repo');
  assertWithin(STAGING_DIR, stage); assertWithin(WORKSPACE_DIR, target);
  await fsp.rm(stage, { recursive: true, force: true }); await fsp.mkdir(stage, { recursive: true });
  let sourceHash = null;
  try {
    if (normalized.type === 'local_directory' || normalized.type === 'local_git') {
      const sourcePath = path.resolve(normalized.path); await assertSafeSourceRoot(sourcePath);
      sourceHash = (await scanTree(sourcePath)).sha256;
      if (normalized.type === 'local_git' || isGitRepo(sourcePath)) {
        const result = command('git', ['clone', '--local', '--no-hardlinks', sourcePath, stagedRepo], stage, 120000, { GIT_TERMINAL_PROMPT: '0' });
        if (!result.ok) throw new HttpError(409, { error: 'local_clone_failed', detail: result.stderr || result.error });
      } else await copyTree(sourcePath, stagedRepo);
    } else if (normalized.type === 'git' || normalized.type === 'github') {
      const url = validateGitUrl(normalized.url), result = command('git', ['clone', '--origin', 'origin', url, stagedRepo], stage, 120000, { GIT_TERMINAL_PROMPT: '0' });
      if (!result.ok) throw new HttpError(409, { error: 'repository_clone_failed', detail: result.stderr || result.error });
      sourceHash = crypto.createHash('sha256').update(url).digest('hex');
    } else if (normalized.type === 'archive') {
      const archive = path.resolve(normalized.path); await assertSafeFile(archive); validateArchiveListing(archive);
      await fsp.mkdir(stagedRepo, { recursive: true }); const result = command('tar', ['-xf', archive, '-C', stagedRepo], stage, 120000);
      if (!result.ok) throw new HttpError(400, { error: 'archive_extract_failed', detail: result.stderr || result.error });
      await scanTree(stagedRepo); sourceHash = await hashFile(archive);
    } else throw new HttpError(400, { error: 'unsupported_code_source' });
    await scanTree(stagedRepo); await fsp.mkdir(projectRoot, { recursive: true });
    if (fs.existsSync(target)) { if ((await fsp.readdir(target)).length) throw new HttpError(409, { error: 'managed_repository_not_empty' }); await fsp.rm(target, { recursive: true, force: true }); }
    await fsp.rename(stagedRepo, target);
    return { repo_path: target, source: publicSource(normalized), source_hash: sourceHash, imported_at: now() };
  } finally { await fsp.rm(stage, { recursive: true, force: true }); }
}

export async function ensureManagedRepository(projectId) {
  const target = managedRepoPath(projectId); assertWithin(WORKSPACE_DIR, target); await fsp.mkdir(target, { recursive: true });
  if (!isGitRepo(target)) { const result = command('git', ['init'], target, 30000, { GIT_TERMINAL_PROMPT: '0' }); if (!result.ok) throw new HttpError(409, { error: 'managed_repository_init_failed', detail: result.stderr || result.error }); }
  return { repo_path: target, source: null, source_hash: null, imported_at: now() };
}

export async function ensureManagedBaseline(projectId) {
  const target = managedRepoPath(projectId); await ensureManagedRepository(projectId);
  const status = command('git', ['status', '--porcelain=v1', '--untracked-files=all'], target, 10000, { GIT_TERMINAL_PROMPT: '0' });
  const head = command('git', ['rev-parse', '--verify', 'HEAD'], target, 5000, { GIT_TERMINAL_PROMPT: '0' });
  if (head.ok && !status.stdout.trim()) return { head: head.stdout.trim(), created: false };
  const staged = command('git', ['add', '-A'], target, 30000, { GIT_TERMINAL_PROMPT: '0' });
  if (!staged.ok) throw new HttpError(409, { error: 'managed_baseline_stage_failed', detail: staged.stderr || staged.error });
  const committed = command('git', ['-c', 'user.name=AI Workspace', '-c', 'user.email=aiws@local.invalid', 'commit', '--allow-empty', '-m', 'chore(aiws): establish managed baseline'], target, 30000, { GIT_TERMINAL_PROMPT: '0' });
  if (!committed.ok) throw new HttpError(409, { error: 'managed_baseline_commit_failed', detail: committed.stderr || committed.error });
  return { head: command('git', ['rev-parse', 'HEAD'], target, 5000).stdout.trim(), created: true };
}

export async function materializeContextSources(project, sources = []) {
  const root = path.join(managedProjectRoot(project.id), 'contexts'); assertWithin(WORKSPACE_DIR, root); await fsp.mkdir(root, { recursive: true });
  const attachments = [];
  for (const source of sources.slice(0, 50)) {
    const attachmentId = id('att'), created = now();
    if (source.type === 'url') { attachments.push({ id: attachmentId, project_id: project.id, kind: 'url', label: source.label || source.url, url: source.url, model_injectable: true, status: 'ready', created_at: created, updated_at: created }); continue; }
    if (source.type === 'text') { const target = path.join(root, `${attachmentId}.txt`); await fsp.writeFile(target, String(source.text || ''), { encoding: 'utf8', mode: 0o600 }); attachments.push(attachmentRecord(project.id, attachmentId, source.label || '文本材料', target, 'text/plain', true, created)); continue; }
    const input = path.resolve(source.path || ''), stat = await fsp.lstat(input).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new HttpError(400, { error: 'context_source_file_invalid' });
    if (stat.size > LIMITS.fileBytes) throw new HttpError(413, { error: 'context_source_file_too_large' });
    const target = path.join(root, `${attachmentId}-${safeSegment(path.basename(input))}`); await fsp.copyFile(input, target);
    const contentType = contentTypeFor(target), injectable = /^(text\/|image\/)|application\/(pdf|vnd\.openxmlformats-officedocument)/.test(contentType);
    attachments.push(attachmentRecord(project.id, attachmentId, source.label || path.basename(input), target, contentType, injectable, created));
  }
  return attachments;
}

function normalizeCodeSource(source) {
  if (!source) return null; const type = String(source.type || '').toLowerCase();
  if (['local_directory', 'local_git', 'archive'].includes(type) && source.path) return { type, path: String(source.path) };
  if (['git', 'github'].includes(type) && (source.url || source.repository_url)) return { type, url: String(source.url || source.repository_url) };
  throw new HttpError(400, { error: 'invalid_code_source' });
}
function publicSource(source) { return source.type.startsWith('local_') || source.type === 'archive' ? { type: source.type, name: path.basename(source.path) } : { type: source.type, url: source.url }; }
async function assertSafeSourceRoot(source) { const stat = await fsp.lstat(source).catch(() => null); if (!stat?.isDirectory()) throw new HttpError(400, { error: 'local_source_not_directory' }); if (stat.isSymbolicLink()) throw new HttpError(400, { error: 'local_source_symlink_rejected' }); }
async function assertSafeFile(source) { const stat = await fsp.lstat(source).catch(() => null); if (!stat?.isFile() || stat.isSymbolicLink()) throw new HttpError(400, { error: 'source_file_invalid' }); if (stat.size > LIMITS.totalBytes) throw new HttpError(413, { error: 'source_too_large' }); }
async function scanTree(root) {
  let files = 0, totalBytes = 0; const hash = crypto.createHash('sha256');
  async function visit(directory, relative = '') {
    const entries = await fsp.readdir(directory, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name), child = path.posix.join(relative.split(path.sep).join('/'), entry.name), stat = await fsp.lstat(full);
      if (stat.isSymbolicLink()) throw new HttpError(400, { error: 'source_symlink_rejected', entry: child });
      if (stat.isDirectory()) await visit(full, child);
      else if (stat.isFile()) {
        files += 1; totalBytes += stat.size;
        if (files > LIMITS.files) throw new HttpError(413, { error: 'source_file_count_exceeded' });
        if (stat.size > LIMITS.fileBytes) throw new HttpError(413, { error: 'source_file_too_large', entry: child });
        if (totalBytes > LIMITS.totalBytes) throw new HttpError(413, { error: 'source_total_size_exceeded' });
        hash.update(child); hash.update(String(stat.size)); hash.update(await fsp.readFile(full));
      } else throw new HttpError(400, { error: 'unsupported_source_entry', entry: child });
    }
  }
  await visit(root); return { files, total_bytes: totalBytes, sha256: hash.digest('hex') };
}
async function copyTree(source, target) { await fsp.mkdir(target, { recursive: true }); for (const entry of await fsp.readdir(source, { withFileTypes: true })) { const from = path.join(source, entry.name), to = path.join(target, entry.name), stat = await fsp.lstat(from); if (stat.isSymbolicLink()) throw new HttpError(400, { error: 'source_symlink_rejected', entry: entry.name }); if (stat.isDirectory()) await copyTree(from, to); else if (stat.isFile()) await fsp.copyFile(from, to); else throw new HttpError(400, { error: 'unsupported_source_entry' }); } }
function validateArchiveListing(archive) {
  const result = command('tar', ['-tf', archive], path.dirname(archive), 30000), verbose = command('tar', ['-tvf', archive], path.dirname(archive), 30000);
  if (!result.ok || !verbose.ok) throw new HttpError(400, { error: 'archive_invalid', detail: result.stderr || verbose.stderr || result.error });
  const entries = result.stdout.split(/\r?\n/).filter(Boolean), detail = verbose.stdout.split(/\r?\n/).filter(Boolean);
  if (detail.length < entries.length) throw new HttpError(400, { error: 'archive_listing_unreadable' });
  validateArchiveRecords(entries.map((entry, index) => ({ path: entry, type: archiveEntryType(detail[index]), size: archiveEntrySize(detail[index]), link: /\s->\s/.test(detail[index]) })));
}
export function validateArchiveRecords(records) {
  if (!Array.isArray(records)) throw new HttpError(400, { error: 'archive_listing_unreadable' });
  if (records.length > LIMITS.files) throw new HttpError(413, { error: 'source_file_count_exceeded' });
  let declaredTotal = 0;
  for (const record of records) {
    const entry = String(record?.path || ''), normalized = entry.replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized) || normalized.split('/').includes('..')) throw new HttpError(400, { error: 'archive_path_traversal', entry });
    if (record?.link || ['link', 'hardlink', 'symlink'].includes(record?.type)) throw new HttpError(400, { error: 'archive_link_rejected' });
    if (record?.type === 'directory') continue;
    const size = Number(record?.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, { error: 'archive_listing_unreadable' });
    if (size > LIMITS.fileBytes) throw new HttpError(413, { error: 'source_file_too_large' });
    declaredTotal += size;
    if (declaredTotal > LIMITS.totalBytes) throw new HttpError(413, { error: 'source_total_size_exceeded' });
  }
  return { entries: records.length, total_bytes: declaredTotal };
}
function archiveEntryType(line) { const prefix = String(line || '').trim()[0]?.toLowerCase(); return prefix === 'd' ? 'directory' : prefix === 'l' ? 'symlink' : prefix === 'h' ? 'hardlink' : 'file'; }
function archiveEntrySize(line) {
  const value = line.trim();
  for (const pattern of [/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s/, /^\S+\s+\S+\/\S+\s+(\d+)\s/, /^\S+\s+\S+\s+\S+\s+(\d+)\s/]) {
    const match = value.match(pattern); if (match) return Number(match[1]);
  }
  return null;
}
function validateGitUrl(value) { const input = String(value || '').trim(); if (/^git@[\w.-]+:[\w./-]+(?:\.git)?$/.test(input)) return input; const url = new URL(input); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new HttpError(400, { error: 'unsafe_git_url' }); return url.toString(); }
async function hashFile(file) { const hash = crypto.createHash('sha256'); hash.update(await fsp.readFile(file)); return hash.digest('hex'); }
function attachmentRecord(projectId, attachmentId, label, target, contentType, injectable, created) { const bytes = fs.readFileSync(target); return { id: attachmentId, project_id: projectId, kind: 'project_attachment', label, managed_path: target, content_type: contentType, size_bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), text: /^text\//.test(contentType) ? bytes.toString('utf8').slice(0, 100_000) : null, model_injectable: injectable, status: 'ready', created_at: created, updated_at: created }; }
function contentTypeFor(file) { return ({ '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })[path.extname(file).toLowerCase()] || 'application/octet-stream'; }
