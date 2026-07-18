import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { api, cleanup, makeFixture, sourceSnapshot, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v13-import-security-');
const archiveSource = path.join(fixture.root, 'archive-source');
const tarFile = path.join(fixture.root, 'source.tar');
const zipFile = path.join(fixture.root, 'source.zip');
const binaryContext = path.join(fixture.root, 'diagram.bin');
fs.mkdirSync(path.join(archiveSource, 'src'), { recursive: true });
fs.writeFileSync(path.join(archiveSource, 'README.md'), '# Safe archive source\n', 'utf8');
fs.writeFileSync(path.join(archiveSource, 'src', 'index.js'), 'export const safe = true;\n', 'utf8');
fs.writeFileSync(binaryContext, Buffer.from([0, 1, 2, 3, 255]));
run('tar', ['-cf', tarFile, '-C', archiveSource, '.']);
run('tar', ['-a', '-cf', zipFile, '-C', archiveSource, '.']);
const archiveBefore = new Map([[tarFile, fileSnapshot(tarFile)], [zipFile, fileSnapshot(zipFile)], [binaryContext, fileSnapshot(binaryContext)]]);

const port = Number(process.env.AIWS_TEST_PORT || 4599);
let server;
try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const tarProject = await importArchive('Safe TAR import', tarFile, [{ type: 'file', path: binaryContext, label: 'unknown binary' }]);
  assert.equal(fs.readFileSync(path.join(tarProject.imported.project.repo_path, 'README.md'), 'utf8'), '# Safe archive source\n');
  const attachments = await api(port, `/assist/v3/sessions/${tarProject.draft.assist_session.id}/attachments`);
  const binary = attachments.find((item) => item.title === 'unknown binary');
  assert.equal(binary.content_type, 'application/octet-stream');
  assert.equal(binary.model_policy, 'artifact_only');
  assert.equal('text' in binary, false);

  const zipProject = await importArchive('Safe ZIP import', zipFile);
  assert.equal(fs.readFileSync(path.join(zipProject.imported.project.repo_path, 'src', 'index.js'), 'utf8'), 'export const safe = true;\n');
  for (const [file, snapshot] of archiveBefore) assert.deepEqual(fileSnapshot(file), snapshot);

  const failedSource = path.join(fixture.root, 'failed-source');
  fs.mkdirSync(failedSource);
  fs.writeFileSync(path.join(failedSource, 'README.md'), '# failure cleanup source\n', 'utf8');
  const failedBefore = sourceSnapshot(failedSource);
  const failed = await api(port, '/projects', 'POST', { title: 'Mid-import cleanup' }, 201);
  await api(port, `/projects/${failed.project.id}/intake`, 'PUT', {
    mode: 'existing', code_source: { type: 'local_directory', path: failedSource },
    context_sources: [{ type: 'file', path: path.join(fixture.root, 'missing-context.txt') }]
  });
  await api(port, `/projects/${failed.project.id}/imports`, 'POST', { operation_key: 'cleanup-retry' }, 400, 'context_source_file_invalid');
  assert.equal(fs.existsSync(path.join(fixture.home, 'workspaces', failed.project.id)), false);
  assert.equal(filesUnder(path.join(fixture.home, 'staging')).length, 0);
  assert.deepEqual(sourceSnapshot(failedSource), failedBefore);
  await api(port, `/projects/${failed.project.id}/intake`, 'PUT', { context_sources: [] });
  const retried = await api(port, `/projects/${failed.project.id}/imports`, 'POST', { operation_key: 'cleanup-retry' }, 201);
  assert.equal(retried.job.status, 'succeeded');
  assert.deepEqual(sourceSnapshot(failedSource), failedBefore);

  const symlinkSource = path.join(fixture.root, 'symlink-source');
  fs.mkdirSync(symlinkSource);
  fs.writeFileSync(path.join(symlinkSource, 'README.md'), '# symlink source\n', 'utf8');
  fs.symlinkSync(binaryContext, path.join(symlinkSource, 'linked.bin'), 'file');
  const linked = await api(port, '/projects', 'POST', { title: 'Reject linked source' }, 201);
  await api(port, `/projects/${linked.project.id}/intake`, 'PUT', { mode: 'existing', code_source: { type: 'local_directory', path: symlinkSource } });
  await api(port, `/projects/${linked.project.id}/imports`, 'POST', { operation_key: 'reject-link' }, 400, 'source_symlink_rejected');
  assert.equal(fs.existsSync(path.join(fixture.home, 'workspaces', linked.project.id)), false);

  const upload = await api(port, '/projects', 'POST', { title: 'Reject upload traversal' }, 201);
  await api(port, `/projects/${upload.project.id}/intake`, 'PUT', { mode: 'existing', code_source: { type: 'local_directory', path: 'browser-upload' } });
  const boundary = 'aiws-v13-boundary';
  const multipart = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="code_file"; filename="../escape.txt"\r\nContent-Type: text/plain\r\n\r\nescape\r\n--${boundary}--\r\n`);
  const traversalResponse = await fetch(`http://127.0.0.1:${port}/projects/${upload.project.id}/imports`, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: multipart });
  const traversal = await traversalResponse.json();
  assert.equal(traversalResponse.status, 400);
  assert.equal(traversal.error, 'upload_path_invalid');
  assert.equal(filesUnder(path.join(fixture.home, 'staging')).length, 0);
  assert.equal(filesUnder(fixture.root).some((item) => item.endsWith(`${path.sep}escape.txt`)), false);

  const trashed = await api(port, `/projects/${tarProject.draft.project.id}/trash`, 'POST', {});
  assert.ok(trashed.project.trash_metadata?.path);
  const retained = await api(port, `/projects/${tarProject.draft.project.id}/purge`, 'POST', { confirm_title: 'Safe TAR import', retain_managed_directory: true });
  assert.equal(retained.storage.retained, true);
  assert.equal(fs.existsSync(retained.storage.path), true);
  assert.ok(path.resolve(retained.storage.path).startsWith(path.resolve(path.join(fixture.home, 'exports'))));
  for (const [file, snapshot] of archiveBefore) assert.deepEqual(fileSnapshot(file), snapshot);
  console.log('V1.3 secure import integration tests passed');
} finally {
  await server?.stop();
  cleanup(fixture.root);
}

async function importArchive(title, archive, contextSources = []) {
  const draft = await api(port, '/projects', 'POST', { title }, 201);
  await api(port, `/projects/${draft.project.id}/intake`, 'PUT', { mode: 'existing', code_source: { type: 'archive', path: archive }, context_sources: contextSources, answers: { goal: `Validate ${title}` } });
  const imported = await api(port, `/projects/${draft.project.id}/imports`, 'POST', { operation_key: `import-${draft.project.id}` }, 201);
  const workstreamId = `archive-workstream-${draft.project.id}`;
  const confirmed = await api(port, `/projects/${draft.project.id}/onboarding/confirm`, 'POST', { workflow_nodes: [{
    id: workstreamId, role: 'workstream', title: `${title}成果`, outcome: `完成 ${title}`, category: 'deliverable',
    acceptance_criteria: ['归档内容已安全导入'], boundary: { deliverable: title }, dependency_ids: [],
    tasks: [{ id: `archive-task-${draft.project.id}`, role: 'task', title: '验证归档内容', task_kind: 'review', execution_mode: 'assist', dependency_ids: [] }]
  }] });
  assert.equal(confirmed.project.status, 'active');
  return { draft, imported, confirmed };
}
function filesUnder(root) { if (!fs.existsSync(root)) return []; return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => { const full = path.join(root, entry.name); return entry.isDirectory() ? filesUnder(full) : [full]; }); }
function fileSnapshot(file) { const stat = fs.statSync(file); return { sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), size: stat.size, mtimeMs: stat.mtimeMs }; }
function run(command, args, cwd = fixture.root) { const result = spawnSync(command, args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); }
