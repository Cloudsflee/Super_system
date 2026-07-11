import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, cleanup, makeFixture, sourceSnapshot, startApi } from './v13-test-helpers.mjs';

const port = 4595;
const fixture = makeFixture('aiws-v13-project-');
const source = path.join(fixture.root, 'external-source');
fs.mkdirSync(path.join(source, 'src'), { recursive: true });
fs.writeFileSync(path.join(source, 'README.md'), '# External source\n', 'utf8');
fs.writeFileSync(path.join(source, 'src', 'index.js'), 'export const external = true;\n', 'utf8');
const original = sourceSnapshot(source);
let server;

try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const created = await api(port, '/projects', 'POST', { title: 'V1.3 Managed Project', operation_key: 'project-create-1' }, 201);
  const projectId = created.project.id;
  assert.equal(created.project.status, 'draft');
  assert.equal(created.project.onboarding_state, 'intake');
  assert.equal(created.intake.status, 'awaiting_mode');
  assert.equal(created.brief.version, 1);
  assert.equal(created.assist_session.version, 3);
  assert.equal(created.onboarding_route, `/projects/${projectId}/onboarding`);
  const duplicate = await api(port, '/projects', 'POST', { title: 'ignored', operation_key: 'project-create-1' }, 201);
  assert.equal(duplicate.project.id, projectId);
  assert.equal(duplicate.idempotent, true);

  const intake = await api(port, `/projects/${projectId}/intake`, 'PUT', {
    mode: 'existing',
    code_source: { type: 'local_directory', path: source },
    context_sources: [
      { type: 'text', label: '约束', text: '保持外部来源只读' },
      { type: 'url', label: '规范', url: 'https://example.com/spec' }
    ],
    answers: { goal: '验证受管项目生命周期', users: ['Owner'], acceptance_criteria: ['外部目录不变'] }
  });
  assert.equal(intake.brief.version, 2);
  assert.equal(intake.intake.revision, 2);

  await server.stop();
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const restored = await api(port, `/projects/${projectId}/onboarding`);
  assert.equal(restored.intake.mode, 'existing');
  assert.equal(restored.brief.version, 2);
  assert.equal(restored.brief.content.goal, '验证受管项目生命周期');
  assert.equal(restored.briefs.length, 2);
  const revised = await api(port, `/projects/${projectId}/intake`, 'PUT', { answers: { features: ['安全导入', '幂等确认'], open_questions: ['是否保留外部源？'] } });
  assert.equal(revised.brief.version, 3);
  assert.equal(revised.intake.revision, 3);
  assert.deepEqual(revised.brief.content.open_questions, ['是否保留外部源？']);

  const imported = await api(port, `/projects/${projectId}/imports`, 'POST', { operation_key: 'local-import-1' }, 201);
  const managedRepo = path.join(fixture.home, 'workspaces', projectId, 'repo');
  assert.equal(path.resolve(imported.project.repo_path), path.resolve(managedRepo));
  assert.equal(imported.project.managed_workspace_state, 'ready');
  assert.equal(fs.readFileSync(path.join(managedRepo, 'README.md'), 'utf8'), '# External source\n');
  assert.deepEqual(sourceSnapshot(source), original);
  const projectAttachments = await api(port, `/assist/v3/sessions/${created.assist_session.id}/attachments`);
  assert.equal(projectAttachments.length, 2);
  assert.equal(projectAttachments.some((item) => item.model_policy === 'injectable' && item.title === '约束'), true);
  assert.equal(projectAttachments.some((item) => item.url === 'https://example.com/spec'), true);
  const repeatedImport = await api(port, `/projects/${projectId}/imports`, 'POST', { operation_key: 'local-import-1' });
  assert.equal(repeatedImport.job.id, imported.job.id);
  assert.equal(repeatedImport.idempotent, true);

  await api(port, `/projects/${projectId}/files/content`, 'PUT', { path: 'README.md', content: '# blocked\n' }, 409, 'project_onboarding_required');
  assert.equal(fs.readFileSync(path.join(managedRepo, 'README.md'), 'utf8'), '# External source\n');
  const confirmed = await api(port, `/projects/${projectId}/onboarding/confirm`, 'POST', {});
  assert.equal(confirmed.project.status, 'active');
  assert.equal(confirmed.project.onboarding_state, 'confirmed');
  assert.equal(confirmed.idempotent, false);
  assert.equal(confirmed.nodes.length, 3);
  const confirmedAgain = await api(port, `/projects/${projectId}/onboarding/confirm`, 'POST', {});
  assert.equal(confirmedAgain.idempotent, true);
  assert.equal(confirmedAgain.workflow.id, confirmed.workflow.id);
  const confirmedBundle = await api(port, `/projects/${projectId}`);
  assert.equal(confirmedBundle.nodes.length, 3);
  assert.equal(confirmedBundle.contracts.length, 3);

  const saved = await api(port, `/projects/${projectId}/files/content`, 'PUT', { path: 'README.md', content: '# Managed copy\n' });
  assert.equal(saved.path, 'README.md');
  assert.equal(fs.readFileSync(path.join(managedRepo, 'README.md'), 'utf8'), '# Managed copy\n');
  assert.deepEqual(sourceSnapshot(source), original);

  const trashed = await api(port, `/projects/${projectId}/trash`, 'POST', {});
  assert.ok(trashed.project.deleted_at);
  assert.equal(fs.existsSync(path.join(fixture.home, 'workspaces', projectId)), false);
  assert.equal((await api(port, '/projects?deleted=only')).some((item) => item.id === projectId), true);
  const restoredProject = await api(port, `/projects/${projectId}/restore`, 'POST', {});
  assert.equal(restoredProject.project.deleted_at, null);
  assert.equal(fs.existsSync(managedRepo), true);
  await api(port, `/projects/${projectId}/trash`, 'POST', {});
  await api(port, `/projects/${projectId}/purge`, 'POST', { confirm_title: 'wrong title' }, 409, 'project_title_confirmation_mismatch');
  const purged = await api(port, `/projects/${projectId}/purge`, 'POST', { confirm_title: 'V1.3 Managed Project' });
  assert.equal(purged.purged, true);
  await api(port, `/projects/${projectId}/onboarding`, 'GET', undefined, 404, 'project_not_found');
  assert.deepEqual(sourceSnapshot(source), original);

  const missing = await api(port, '/projects', 'POST', { title: 'Existing source required' }, 201);
  await api(port, `/projects/${missing.project.id}/intake`, 'PUT', { mode: 'existing', answers: { goal: '不能创建空已有项目' } });
  await api(port, `/projects/${missing.project.id}/onboarding/confirm`, 'POST', {}, 409, 'project_code_source_required');

  const uploadDraft = await api(port, '/projects', 'POST', { title: 'Browser directory upload' }, 201);
  await api(port, `/projects/${uploadDraft.project.id}/intake`, 'PUT', { mode: 'existing', code_source: { type: 'local_directory', path: 'browser-upload' }, answers: { goal: '验证 multipart 目录上传' } });
  const form = new FormData(); form.set('operation_key', 'browser-directory-1');
  form.append('code_file', new Blob(['# Uploaded directory\n'], { type: 'text/markdown' }), 'uploaded/README.md');
  form.append('code_file', new Blob(['export const uploaded = true;\n'], { type: 'text/javascript' }), 'uploaded/src/index.js');
  form.append('context_file', new Blob(['uploaded context'], { type: 'text/plain' }), 'spec.txt');
  const uploadResponse = await fetch(`http://127.0.0.1:${port}/projects/${uploadDraft.project.id}/imports`, { method: 'POST', body: form });
  const uploaded = await uploadResponse.json(); assert.equal(uploadResponse.status, 201, JSON.stringify(uploaded));
  assert.equal(fs.readFileSync(path.join(uploaded.project.repo_path, 'README.md'), 'utf8'), '# Uploaded directory\n');
  assert.equal(fs.readFileSync(path.join(uploaded.project.repo_path, 'src', 'index.js'), 'utf8'), 'export const uploaded = true;\n');
  const uploadedAttachments = await api(port, `/assist/v3/sessions/${uploadDraft.assist_session.id}/attachments`);
  assert.equal(uploadedAttachments.some((item) => item.title === 'spec.txt'), true);
  const uploadConfirmed = await api(port, `/projects/${uploadDraft.project.id}/onboarding/confirm`, 'POST', {});
  assert.equal(uploadConfirmed.project.status, 'active');
  console.log('V1.3 project lifecycle integration tests passed');
} finally {
  await server?.stop();
  cleanup(fixture.root);
}
