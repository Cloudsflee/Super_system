import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { command, HttpError } from './http.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { hashString, id, now } from '../../../packages/shared/index.mjs';
import { assertManagedProjectWritable } from './project-lifecycle.mjs';
import { withProjectLifecycleLock } from './project-lifecycle-operations.mjs';

const maxFileBytes = 2 * 1024 * 1024;
const maxReferenceFileBytes = 25 * 1024 * 1024;
const presets = new Set(['test', 'typecheck', 'lint', 'build']);

export async function listProjectFiles(projectId, relative = '') {
  const { root, target } = await resolveProjectPath(projectId, relative, true);
  const stat = await fsp.stat(target);
  if (!stat.isDirectory()) throw new HttpError(400, { error: 'path_not_directory' });
  const entries = await fsp.readdir(target, { withFileTypes: true });
  return { root, path: normalize(path.relative(root, target)), entries: entries.filter((item) => !ignored(item.name)).map((item) => ({ name: item.name, path: normalize(path.relative(root, path.join(target, item.name))), type: item.isDirectory() ? 'directory' : 'file', size: item.isFile() ? fs.statSync(path.join(target, item.name)).size : undefined })).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1) };
}

export async function readProjectFile(projectId, relative) {
  const { root, target } = await resolveProjectPath(projectId, relative, true);
  const stat = await fsp.stat(target);
  if (!stat.isFile()) throw new HttpError(400, { error: 'path_not_file' });
  if (stat.size > maxFileBytes) throw new HttpError(413, { error: 'file_too_large', max_bytes: maxFileBytes });
  const bytes = await fsp.readFile(target), content = bytes.toString('utf8');
  return { path: normalize(path.relative(root, target)), content, language: languageFor(target), size: stat.size, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function inspectProjectFile(projectId, relative, maxBytes = maxReferenceFileBytes) {
  const { root, target } = await resolveProjectPath(projectId, relative, true);
  const stat = await fsp.stat(target);
  if (!stat.isFile()) throw new HttpError(400, { error: 'path_not_file' });
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || stat.size > maxBytes) throw new HttpError(413, { error: 'file_too_large', max_bytes: maxBytes });
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  return { path: normalize(path.relative(root, target)), size: stat.size, sha256: hash.digest('hex') };
}

export function saveProjectFile(input) { return withProjectLifecycleLock(input.projectId, () => saveProjectFileLocked(input)); }
async function saveProjectFileLocked({ projectId, nodeId, relative, content, source = 'owner_editor' }) {
  if (typeof relative !== 'string' || !relative.trim()) throw new HttpError(400, { error: 'file_path_required' });
  if (typeof content !== 'string') throw new HttpError(400, { error: 'file_content_required' });
  if (Buffer.byteLength(String(content), 'utf8') > maxFileBytes) throw new HttpError(413, { error: 'file_too_large', max_bytes: maxFileBytes });
  const { state: snapshot, root, target, project } = await resolveProjectPath(projectId, relative, false);
  assertManagedProjectWritable(project);
  const sourceNode = nodeId ? snapshot.workflow_nodes.find((item) => item.id === nodeId) : null;
  if (nodeId && (!sourceNode || !snapshot.workflows.some((item) => item.id === sourceNode.workflow_id && item.project_id === project.id))) throw new HttpError(404, { error: 'node_not_found' });
  const before = fs.existsSync(target) ? await fsp.readFile(target, 'utf8') : '';
  await fsp.writeFile(target, String(content), 'utf8');
  const afterHash = hashString(String(content)), beforeHash = hashString(before);
  const diff = diffSummary(normalize(path.relative(root, target)), before, String(content));
  return mutate((state) => {
    const actor = owner(state), currentProject = state.projects.find((item) => item.id === project.id), node = state.workflow_nodes.find((item) => item.id === nodeId);
    assertManagedProjectWritable(currentProject);
    if (nodeId && !node) throw new HttpError(404, { error: 'node_not_found' });
    const change = { id: id('fch'), project_id: project.id, workspace_id: node?.workspace_id || project.current_workspace_id, node_id: node?.id || null, path: normalize(path.relative(root, target)), before_sha256: beforeHash, after_sha256: afterHash, bytes: Buffer.byteLength(String(content)), diff, source: normalizeSource(source), created_by_user_id: actor.id, created_at: now() };
    state.file_changes.push(change);
    const summary = change.source === 'assist_confirmed' ? `确认 Assist 后保存文件：${change.path}` : `人工保存文件：${change.path}`;
    addTrace(state, 'file.saved', { project_id: project.id, workspace_id: change.workspace_id, node_id: change.node_id, target_type: 'file_change', target_id: change.id, summary, data: { path: change.path, before_sha256: beforeHash, after_sha256: afterHash, diff: change.diff, source: change.source } }, actor.id);
    return change;
  });
}

export async function projectDiff(projectId, relative = '') {
  const { root, target } = await resolveProjectPath(projectId, relative, true);
  const args = ['diff', '--no-ext-diff', '--'];
  if (relative) args.push(normalize(path.relative(root, target)));
  const result = command('git', args, root, 15000);
  if (!result.ok && !result.stdout) throw new HttpError(409, { error: 'git_diff_failed', detail: result.stderr || result.error });
  return { path: relative || null, diff: result.stdout, stderr: result.stderr };
}

export function runTestPreset(input) { return withProjectLifecycleLock(input.projectId, () => runTestPresetLocked(input)); }
async function runTestPresetLocked({ projectId, nodeId, preset }) {
  if (!presets.has(preset)) throw new HttpError(400, { error: 'unsupported_test_preset', allowed: [...presets] });
  const { state: snapshot, root, project } = await resolveProjectPath(projectId, '', true);
  assertManagedProjectWritable(project);
  const sourceNode = nodeId ? snapshot.workflow_nodes.find((item) => item.id === nodeId) : null;
  if (nodeId && (!sourceNode || !snapshot.workflows.some((item) => item.id === sourceNode.workflow_id && item.project_id === project.id))) throw new HttpError(404, { error: 'node_not_found' });
  const invocation = taskInvocation(root, preset);
  const started = Date.now(), result = command(invocation.command, invocation.args, root, Number(process.env.AIWS_TEST_TASK_TIMEOUT_MS || 120000), {}, { inheritEnv: false });
  return mutate((state) => {
    const actor = owner(state), currentProject = state.projects.find((item) => item.id === project.id), node = state.workflow_nodes.find((item) => item.id === nodeId);
    assertManagedProjectWritable(currentProject);
    const task = { id: id('tsk'), project_id: project.id, workspace_id: node?.workspace_id || project.current_workspace_id, node_id: node?.id || null, preset, command: invocation.label, status: result.ok ? 'succeeded' : 'failed', stdout: result.stdout.slice(-30000), stderr: [result.stderr, result.error].filter(Boolean).join('\n').slice(-30000), duration_ms: Date.now() - started, created_by_user_id: actor.id, created_at: now(), completed_at: now() };
    state.test_tasks.push(task);
    addTrace(state, 'test.completed', { project_id: project.id, workspace_id: task.workspace_id, node_id: task.node_id, target_id: task.id, summary: `${preset}: ${task.status}`, data: { duration_ms: task.duration_ms, command: task.command } }, actor.id);
    return task;
  });
}

async function resolveProjectPath(projectId, relative, mustExist) {
  const state = await readState(), project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new HttpError(404, { error: 'project_not_found' });
  const configured = project.repo_path || project.workspace_root;
  if (!configured) throw new HttpError(409, { error: 'repository_not_bound' });
  const root = await fsp.realpath(path.resolve(configured)).catch(() => { throw new HttpError(409, { error: 'repository_root_unavailable' }); });
  const lexicalTarget = path.resolve(root, String(relative || '').replaceAll('\\', '/'));
  if (!within(root, lexicalTarget)) throw new HttpError(403, { error: 'path_outside_repository' });
  if (mustExist) {
    const real = await fsp.realpath(lexicalTarget).catch(() => { throw new HttpError(404, { error: 'path_not_found' }); });
    if (!within(root, real)) throw new HttpError(403, { error: 'symlink_outside_repository' });
    return { state, project, root, target: real };
  }
  if (fs.existsSync(lexicalTarget)) {
    const real = await fsp.realpath(lexicalTarget).catch(() => { throw new HttpError(404, { error: 'path_not_found' }); });
    if (!within(root, real)) throw new HttpError(403, { error: 'symlink_outside_repository' });
    const stat = await fsp.stat(real);
    if (!stat.isFile()) throw new HttpError(400, { error: 'path_not_file' });
    return { state, project, root, target: real };
  }
  const parent = await fsp.realpath(path.dirname(lexicalTarget)).catch(() => { throw new HttpError(404, { error: 'parent_directory_not_found' }); });
  if (!within(root, parent)) throw new HttpError(403, { error: 'symlink_outside_repository' });
  return { state, project, root, target: path.join(parent, path.basename(lexicalTarget)) };
}

export function taskInvocation(root, preset, options = {}) {
  if (!presets.has(preset)) throw new HttpError(400, { error: 'unsupported_test_preset', allowed: [...presets] });
  const platform = options.platform || process.platform, comspec = options.comspec || process.env.ComSpec || 'cmd.exe';
  if (fs.existsSync(path.join(root, 'package.json'))) return platform === 'win32'
    ? { command: comspec, args: ['/d', '/s', '/c', `corepack pnpm ${preset}`], label: `pnpm ${preset}` }
    : { command: 'corepack', args: ['pnpm', preset], label: `pnpm ${preset}` };
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) return { command: 'cargo', args: [preset === 'test' ? 'test' : preset === 'build' ? 'build' : 'check'], label: `cargo ${preset}` };
  if (fs.existsSync(path.join(root, 'go.mod'))) return { command: 'go', args: [preset === 'test' ? 'test' : 'build', './...'], label: `go ${preset}` };
  throw new HttpError(409, { error: 'no_supported_task_runner' });
}
function languageFor(file) { return ({ '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.json': 'json', '.md': 'markdown', '.css': 'css', '.html': 'html', '.py': 'python', '.go': 'go', '.rs': 'rust' })[path.extname(file).toLowerCase()] || 'plaintext'; }
function within(root, target) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function normalize(value) { return value.replaceAll('\\', '/'); }
function ignored(name) { return ['.git', 'node_modules', '.ai-workspace', 'dist', 'coverage'].includes(name); }
function normalizeSource(value) { return ['owner_editor', 'assist_confirmed', 'runner_confirmed'].includes(value) ? value : 'owner_editor'; }
function diffSummary(file, before, after) {
  const beforeLines = splitLines(before), afterLines = splitLines(after);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) suffix++;
  const deleted = Math.max(0, beforeLines.length - prefix - suffix);
  const added = Math.max(0, afterLines.length - prefix - suffix);
  const fingerprint = hashString(`--- a/${file}\n+++ b/${file}\n@@ -${prefix + 1},${deleted} +${prefix + 1},${added} @@\n${before}\n---AIWS-AFTER---\n${after}`);
  return { format: 'summary-v1', before_lines: beforeLines.length, after_lines: afterLines.length, additions: added, deletions: deleted, sha256: fingerprint };
}
function splitLines(value) { return value === '' ? [] : String(value).replace(/\r\n/g, '\n').split('\n'); }
