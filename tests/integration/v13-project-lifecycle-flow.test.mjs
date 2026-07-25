import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, cleanup, makeFixture, sourceSnapshot, startApi } from './v13-test-helpers.mjs';

const port = Number(process.env.AIWS_TEST_PORT || 4595);
const fixture = makeFixture('aiws-v13-project-');
const source = path.join(fixture.root, 'external-source');
fs.mkdirSync(path.join(source, 'src'), { recursive: true });
fs.writeFileSync(path.join(source, 'README.md'), '# External source\n', 'utf8');
fs.writeFileSync(path.join(source, 'src', 'index.js'), 'export const external = true;\n', 'utf8');
const original = sourceSnapshot(source);
let server;

try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const created = await api(
    port,
    '/projects',
    'POST',
    { title: 'V1.3 Managed Project', operation_key: 'project-create-1' },
    201
  );
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
  const revised = await api(port, `/projects/${projectId}/intake`, 'PUT', {
    answers: { features: ['安全导入', '幂等确认'], open_questions: ['是否保留外部源？'] }
  });
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
  assert.equal(
    projectAttachments.some((item) => item.model_policy === 'injectable' && item.title === '约束'),
    true
  );
  assert.equal(
    projectAttachments.some((item) => item.url === 'https://example.com/spec'),
    true
  );
  const repeatedImport = await api(port, `/projects/${projectId}/imports`, 'POST', { operation_key: 'local-import-1' });
  assert.equal(repeatedImport.job.id, imported.job.id);
  assert.equal(repeatedImport.idempotent, true);

  await api(
    port,
    `/projects/${projectId}/files/content`,
    'PUT',
    { path: 'README.md', content: '# blocked\n' },
    409,
    'project_onboarding_required'
  );
  assert.equal(fs.readFileSync(path.join(managedRepo, 'README.md'), 'utf8'), '# External source\n');
  const confirmed = await api(port, `/projects/${projectId}/onboarding/confirm`, 'POST', {
    workflow_nodes: manualWorkflow('lifecycle', '受管项目成果', 'code', 'codex')
  });
  assert.equal(confirmed.project.status, 'active');
  assert.equal(confirmed.project.onboarding_state, 'confirmed');
  assert.equal(confirmed.idempotent, false);
  assert.equal(confirmed.nodes.length, 2);
  assert.equal(confirmed.nodes.find((item) => item.role === 'workstream').title, '受管项目成果');
  assert.equal(confirmed.route, `/projects/${projectId}/workflow`);
  const confirmedAgain = await api(port, `/projects/${projectId}/onboarding/confirm`, 'POST', {});
  assert.equal(confirmedAgain.idempotent, true);
  assert.equal(confirmedAgain.workflow.id, confirmed.workflow.id);
  assert.equal(confirmedAgain.route, confirmed.route);
  const confirmedBundle = await api(port, `/projects/${projectId}`);
  assert.equal(confirmedBundle.nodes.length, 2);
  assert.equal(confirmedBundle.contracts.length, 2);

  const saved = await api(port, `/projects/${projectId}/files/content`, 'PUT', {
    path: 'README.md',
    content: '# Managed copy\n'
  });
  assert.equal(saved.path, 'README.md');
  assert.equal(fs.readFileSync(path.join(managedRepo, 'README.md'), 'utf8'), '# Managed copy\n');
  assert.deepEqual(sourceSnapshot(source), original);
  const attachmentForm = new FormData();
  attachmentForm.set('file', new Blob(['project attachment sentinel'], { type: 'text/plain' }), 'sentinel.txt');
  const attachmentResponse = await fetch(
    `http://127.0.0.1:${port}/assist/v3/sessions/${created.assist_session.id}/attachments/upload`,
    { method: 'POST', body: attachmentForm }
  );
  const managedAttachment = await attachmentResponse.json();
  assert.equal(attachmentResponse.status, 201, JSON.stringify(managedAttachment));
  const managedAttachmentPath = path.join(
    fixture.home,
    'attachments',
    projectId,
    managedAttachment.id,
    managedAttachment.sha256
  );
  assert.equal(fs.existsSync(managedAttachmentPath), true);
  await api(
    port,
    `/projects/${projectId}/purge`,
    'POST',
    { confirm_title: 'V1.3 Managed Project' },
    409,
    'project_not_trashed'
  );
  assert.equal(fs.existsSync(managedRepo), true, 'active project purge must not remove managed files');
  await server.stop();
  const seeded = seedProjectPurgeDependents(path.join(fixture.home, 'data', 'state.json'), {
    projectId,
    workspaceId: confirmed.project.current_workspace_id
  });
  const seededArtifact = seeded.artifact;
  const transientFiles = seedTransientFiles(fixture.home);
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const recoveredState = JSON.parse(fs.readFileSync(path.join(fixture.home, 'data', 'state.json'), 'utf8'));
  assert.equal(recoveredState.node_runs.find((item) => item.id === 'run-purge-late').status, 'failed');
  assert.equal(recoveredState.workflow_nodes.find((item) => item.id === seeded.taskId).status, 'blocked');
  assert.equal(
    recoveredState.import_jobs.find((item) => item.id === 'import-purge-late').error_code,
    'service_restarted'
  );
  for (const file of transientFiles)
    assert.equal(fs.existsSync(file), false, `startup removes stale staging file ${file}`);

  const stateFile = path.join(fixture.home, 'data', 'state.json');
  for (const [collection, record] of [
    ['terminal_sessions', { id: 'terminal-project-in-use', project_id: projectId, status: 'ready' }],
    ['workflow_generations', { id: 'generation-project-in-use', project_id: projectId, status: 'queued' }],
    ['deliveries', { id: 'delivery-project-in-use', project_id: projectId, status: 'running' }],
    ['workflow_migration_jobs', { id: 'migration-project-in-use', project_id: projectId, status: 'generating' }],
    [
      'repository_deletion_intents',
      {
        id: 'deletion-project-in-use',
        canonical_repository_id: 'canonical-project-in-use',
        status: 'executing',
        snapshot: { bindings: [{ project_id: projectId }] }
      }
    ]
  ]) {
    const current = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    current[collection].push(record);
    fs.writeFileSync(stateFile, JSON.stringify(current, null, 2));
    const blocked = await api(port, `/projects/${projectId}/trash`, 'POST', {}, 423, 'project_in_use');
    assert.equal(blocked.resource_id, record.id);
    const cleaned = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    cleaned[collection] = cleaned[collection].filter((item) => item.id !== record.id);
    fs.writeFileSync(stateFile, JSON.stringify(cleaned, null, 2));
  }

  const trashed = await api(port, `/projects/${projectId}/trash`, 'POST', {});
  assert.ok(trashed.project.deleted_at);
  assert.equal(fs.existsSync(path.join(fixture.home, 'workspaces', projectId)), false);
  assert.equal(
    (await api(port, '/projects?deleted=only')).some((item) => item.id === projectId),
    true
  );
  await api(port, `/projects/${projectId}`, 'GET', undefined, 404, 'project_not_found');
  const restoredProject = await api(port, `/projects/${projectId}/restore`, 'POST', {});
  assert.equal(restoredProject.project.deleted_at, null);
  assert.equal(fs.existsSync(managedRepo), true);
  await api(port, `/projects/${projectId}/trash`, 'POST', {});
  await server.stop();
  seedInterruptedPurge(path.join(fixture.home, 'data', 'state.json'), projectId);
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  await api(port, `/projects/${projectId}/restore`, 'POST', {}, 423, 'project_lifecycle_operation_in_progress');
  await api(
    port,
    `/projects/${projectId}/purge`,
    'POST',
    { confirm_title: 'wrong title' },
    409,
    'project_title_confirmation_mismatch'
  );
  const purged = await api(port, `/projects/${projectId}/purge`, 'POST', { confirm_title: 'V1.3 Managed Project' });
  assert.equal(purged.purged, true);
  assert.equal(fs.existsSync(managedAttachmentPath), false, 'project attachment content must be removed');
  assert.equal(fs.existsSync(seededArtifact), false, 'project artifact content must be removed');
  await api(port, `/projects/${projectId}/onboarding`, 'GET', undefined, 404, 'project_not_found');
  assert.deepEqual(sourceSnapshot(source), original);
  assertProjectPurgeComplete(path.join(fixture.home, 'data', 'state.json'), projectId);

  const missing = await api(port, '/projects', 'POST', { title: 'Existing source required' }, 201);
  await api(port, `/projects/${missing.project.id}/intake`, 'PUT', {
    mode: 'existing',
    answers: { goal: '不能创建空已有项目' }
  });
  await api(
    port,
    `/projects/${missing.project.id}/onboarding/confirm`,
    'POST',
    {},
    409,
    'project_code_source_required'
  );

  const uploadDraft = await api(port, '/projects', 'POST', { title: 'Browser directory upload' }, 201);
  await api(port, `/projects/${uploadDraft.project.id}/intake`, 'PUT', {
    mode: 'existing',
    code_source: { type: 'local_directory', path: 'browser-upload' },
    answers: { goal: '验证 multipart 目录上传' }
  });
  const form = new FormData();
  form.set('operation_key', 'browser-directory-1');
  form.append('code_file', new Blob(['# Uploaded directory\n'], { type: 'text/markdown' }), 'uploaded/README.md');
  form.append(
    'code_file',
    new Blob(['export const uploaded = true;\n'], { type: 'text/javascript' }),
    'uploaded/src/index.js'
  );
  form.append('context_file', new Blob(['uploaded context'], { type: 'text/plain' }), 'spec.txt');
  const uploadResponse = await fetch(`http://127.0.0.1:${port}/projects/${uploadDraft.project.id}/imports`, {
    method: 'POST',
    body: form
  });
  const uploaded = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201, JSON.stringify(uploaded));
  assert.equal(fs.readFileSync(path.join(uploaded.project.repo_path, 'README.md'), 'utf8'), '# Uploaded directory\n');
  assert.equal(
    fs.readFileSync(path.join(uploaded.project.repo_path, 'src', 'index.js'), 'utf8'),
    'export const uploaded = true;\n'
  );
  const uploadedAttachments = await api(port, `/assist/v3/sessions/${uploadDraft.assist_session.id}/attachments`);
  assert.equal(
    uploadedAttachments.some((item) => item.title === 'spec.txt'),
    true
  );
  const uploadConfirmed = await api(port, `/projects/${uploadDraft.project.id}/onboarding/confirm`, 'POST', {
    workflow_nodes: manualWorkflow('upload', '上传目录成果', 'code', 'codex')
  });
  assert.equal(uploadConfirmed.project.status, 'active');
  console.log('V1.3 project lifecycle integration tests passed');
} finally {
  await server?.stop();
  cleanup(fixture.root);
}

function manualWorkflow(prefix, title, taskKind, executionMode) {
  const workstreamId = `${prefix}-workstream`;
  return [
    {
      id: workstreamId,
      role: 'workstream',
      title,
      outcome: title,
      category: 'deliverable',
      acceptance_criteria: [`验收 ${title}`],
      boundary: { deliverable: title },
      dependency_ids: [],
      tasks: [
        {
          id: `${prefix}-task`,
          role: 'task',
          title: `完成${title}`,
          task_kind: taskKind,
          execution_mode: executionMode,
          dependency_ids: []
        }
      ]
    }
  ];
}

function seedProjectPurgeDependents(stateFile, { projectId, workspaceId }) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    at = new Date().toISOString();
  const workflow = state.workflows.find((item) => item.project_id === projectId);
  const task = state.workflow_nodes.find((item) => item.workflow_id === workflow?.id && item.role === 'task');
  task.status = 'running';
  const artifact = path.join(path.dirname(path.dirname(stateFile)), 'artifacts', 'purge-test', 'project-sentinel.log');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, 'project artifact sentinel');
  state.assist_sessions.push({
    id: 'asst-purge-late',
    version: 3,
    project_id: projectId,
    workspace_id: workspaceId,
    scope_type: 'project',
    scope_id: projectId,
    scope_status: 'active',
    clarification_policy: 'ask',
    status: 'idle',
    created_at: at,
    updated_at: at
  });
  state.assist_turns.push({
    id: 'turn-purge-late',
    session_id: 'asst-purge-late',
    project_id: projectId,
    status: 'completed',
    context_pack_id: 'ctx-purge-late',
    worktree_id: 'worktree-purge-late',
    created_at: at,
    updated_at: at
  });
  state.assist_messages.push({ id: 'message-purge-late', session_id: 'asst-purge-late', turn_id: 'turn-purge-late' });
  state.assist_events.push({
    id: 'event-purge-late',
    sequence: 1,
    session_id: 'asst-purge-late',
    turn_id: 'turn-purge-late'
  });
  state.ui_action_intents.push({
    id: 'action-purge-late',
    session_id: 'asst-purge-late',
    turn_id: 'turn-purge-late',
    project_id: projectId
  });
  state.assist_operations.push({
    id: 'operation-purge-late',
    session_id: 'asst-purge-late',
    turn_id: 'turn-purge-late',
    project_id: projectId
  });
  state.runtime_user_inputs.push({ id: 'input-purge-late', session_id: 'asst-purge-late', turn_id: 'turn-purge-late' });
  state.context_packs.push({
    id: 'ctx-purge-late',
    source_workspace_id: workspaceId,
    sufficiency_check_id: 'check-purge-late',
    content_file_ref_id: 'ref-context-purge'
  });
  state.context_sufficiency_checks.push({
    id: 'check-purge-late',
    project_id: projectId,
    target_type: 'assist_turn',
    target_id: 'turn-purge-late'
  });
  state.worktrees.push({ id: 'worktree-purge-late', project_id: projectId });
  state.assist_change_batches.push({
    id: 'batch-purge-late',
    session_id: 'asst-purge-late',
    project_id: projectId,
    worktree_id: 'worktree-purge-late',
    status: 'closed'
  });
  state.assist_checkpoints.push({
    id: 'checkpoint-purge-late',
    batch_id: 'batch-purge-late',
    session_id: 'asst-purge-late',
    turn_id: 'turn-purge-late'
  });
  state.terminal_sessions.push({
    id: 'terminal-purge-late',
    project_id: projectId,
    assist_session_id: 'asst-purge-late',
    turn_id: 'turn-purge-late',
    worktree_id: 'worktree-purge-late',
    artifact_file_ref_id: 'ref-terminal-purge',
    status: 'exited'
  });
  state.human_reviews.push({
    id: 'review-purge-late',
    target_type: 'terminal_session',
    target_id: 'terminal-purge-late'
  });
  state.node_runs.push({
    id: 'run-purge-late',
    project_id: projectId,
    workspace_id: task.workspace_id || workspaceId,
    node_id: task.id,
    context_pack_id: 'ctx-purge-late',
    status: 'running'
  });
  state.import_jobs.push({
    id: 'import-purge-late',
    project_id: projectId,
    kind: 'code_source',
    operation_key: 'restart-recovery',
    status: 'processing',
    created_at: at,
    updated_at: at
  });
  state.test_results.push({ id: 'test-result-purge-late', run_id: 'run-purge-late' });
  state.assets.push({
    id: 'asset-purge-late',
    project_id: projectId,
    workspace_id: workspaceId,
    run_id: 'run-purge-late'
  });
  state.asset_versions.push({ id: 'asset-version-purge-late', asset_id: 'asset-purge-late' });
  state.asset_relations.push({ id: 'asset-relation-purge-late', source_asset_id: 'asset-purge-late' });
  state.runner_memory_candidates.push({ id: 'memory-purge-late', project_id: projectId, workspace_id: workspaceId });
  state.file_refs.push(
    { id: 'ref-context-purge', absolute_path: artifact, meta: { context_pack_id: 'ctx-purge-late' } },
    { id: 'ref-terminal-purge', meta: { terminal_session_id: 'terminal-purge-late' } }
  );
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return { artifact, taskId: task.id };
}

function seedInterruptedPurge(stateFile, projectId) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    project = state.projects.find((item) => item.id === projectId);
  project.lifecycle_operation = {
    id: 'plop-interrupted-test',
    type: 'purge',
    started_at: new Date().toISOString(),
    trash_path: project.trash_metadata?.path || project.trash_path,
    retain_managed_directory: false
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
function seedTransientFiles(home) {
  const files = [
    path.join(home, 'staging', 'orphan-import', 'source.tmp'),
    path.join(home, 'attachment-staging', 'orphan.upload')
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'stale');
  }
  return files;
}

function assertProjectPurgeComplete(stateFile, projectId) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const direct = Object.entries(state)
    .filter(([, values]) => Array.isArray(values) && values.some((item) => item?.project_id === projectId))
    .map(([key]) => key);
  assert.deepEqual(direct, [], `project-linked records remain: ${direct.join(', ')}`);
  for (const [collection, idValue] of Object.entries({
    context_packs: 'ctx-purge-late',
    context_sufficiency_checks: 'check-purge-late',
    asset_versions: 'asset-version-purge-late',
    asset_relations: 'asset-relation-purge-late',
    assist_messages: 'message-purge-late',
    assist_events: 'event-purge-late',
    runtime_user_inputs: 'input-purge-late',
    assist_checkpoints: 'checkpoint-purge-late',
    human_reviews: 'review-purge-late',
    file_refs: 'ref-context-purge',
    test_results: 'test-result-purge-late'
  })) {
    assert.equal(
      state[collection].some((item) => item.id === idValue),
      false,
      `${collection} retains project data`
    );
  }
}
