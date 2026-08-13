import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { assertIntakeSourceStable } from '../../apps/api/src/modules/project/service.mjs';
import {
  atomicRename,
  canonicalImportPath,
  copyDirectorySafe,
  createDeterministicArchive,
  manifestBytes,
  normalizeRepositorySource,
  publicSource,
  validateGitUrl
} from '../../apps/api/src/modules/repository/adapter.mjs';
import { eventually, fixture, mutate, onboardProject, request } from './helpers.mjs';

const execFileAsync = promisify(execFile);

async function waitOperation(base, operationId, timeout = 10_000) {
  return eventually(
    async () => (await request(base, `/api/v1/operations/${operationId}`)).json,
    (value) => ['completed', 'failed', 'cancelled'].includes(value.status),
    timeout
  );
}

test('repository source normalization and deterministic artifacts enforce adapter boundaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r3-adapter-'));
  const allowed = path.join(root, 'allowed');
  const source = path.join(allowed, 'source');
  const destination = path.join(allowed, 'destination');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'README.md'), '# adapter fixture\n');
  fs.writeFileSync(path.join(source, 'nested', 'entry.txt'), 'entry\n');
  try {
    assert.throws(() => normalizeRepositorySource(null), (error) => error.code === 'repository_source_invalid');
    assert.throws(() => normalizeRepositorySource({ kind: 'fixture', id: 'missing' }), (error) => error.code === 'repository_source_invalid');
    const fixtureSource = normalizeRepositorySource({ kind: 'fixture', id: 'designsignal-v1' });
    assert.equal(Object.isFrozen(fixtureSource), true);
    assert.equal(publicSource(fixtureSource).fixture_id, 'designsignal-v1');

    assert.throws(() => canonicalImportPath(source, []), (error) => error.code === 'repository_source_invalid');
    assert.throws(() => canonicalImportPath(path.join(root, 'missing'), [allowed]), (error) => error.code === 'repository_source_invalid');
    assert.throws(() => canonicalImportPath(path.join(source, 'README.md'), [allowed]), (error) => error.code === 'repository_source_invalid');
    assert.equal(canonicalImportPath(source, [allowed]), fs.realpathSync(source));
    const localSource = normalizeRepositorySource({ kind: 'path', locator: source }, { projectImportRoots: [allowed] });
    assert.equal(localSource.kind, 'local');
    assert.equal(publicSource(localSource).kind, 'local');

    for (const value of ['not-a-url', 'http://github.com/ORG/REPO', 'https://user@github.com/ORG/REPO', 'https://git.example.test/ORG/REPO', 'https://github.com/']) {
      assert.throws(() => validateGitUrl(value, ['github.com']), (error) => error.code === 'repository_source_invalid');
    }
    const gitUrl = validateGitUrl('https://github.com/ORG/REPO#fragment', ['GITHUB.COM']);
    assert.equal(new URL(gitUrl).hash, '');
    const gitSource = normalizeRepositorySource({ kind: 'https_git', remote_url: gitUrl }, { projectGitHosts: ['github.com'] });
    assert.equal(publicSource(gitSource).host, 'github.com');
    assert.equal(normalizeRepositorySource({ kind: 'upload', locator: 'pending' }).kind, 'upload');
    assert.equal(normalizeRepositorySource({ kind: 'archive', path: 'bundle.aiws' }).kind, 'archive');
    assert.throws(() => normalizeRepositorySource({ kind: 'upload', locator: 'x'.repeat(4097) }), (error) => error.code === 'repository_source_invalid');
    assert.throws(() => normalizeRepositorySource({ kind: 'unsupported' }), (error) => error.code === 'repository_source_invalid');

    const normalizedManifest = manifestBytes([
      { path: 'nested/entry.txt', sha256: 'b'.repeat(64), byte_size: 6 },
      { path: 'README.md', sha256: 'a'.repeat(64), byte_size: 18, mode: 'file' }
    ]);
    assert.deepEqual(normalizedManifest.entries.map((entry) => entry.path), ['nested/entry.txt', 'README.md']);
    assert.match(normalizedManifest.hash, /^[a-f0-9]{64}$/);
    const firstArchive = createDeterministicArchive(source);
    const secondArchive = createDeterministicArchive(source);
    assert.equal(firstArchive.sha256, secondArchive.sha256);
    assert.equal(firstArchive.manifest.entries.length, 2);

    const copy = path.join(root, 'copy');
    copyDirectorySafe(source, copy);
    assert.equal(fs.readFileSync(path.join(copy, 'nested', 'entry.txt'), 'utf8'), 'entry\n');
    assert.throws(() => atomicRename(copy, copy), (error) => error.code === 'repository_line_fault');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'stale.txt'), 'stale');
    assert.equal(atomicRename(copy, destination), path.resolve(destination));
    assert.equal(fs.existsSync(path.join(destination, 'stale.txt')), false);
    assert.equal(fs.existsSync(path.join(destination, 'nested', 'entry.txt')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('draft intake resume, stale Brief confirmation, and readiness use explicit revisions', async () => {
  const env = await fixture();
  try {
    const created = await mutate(env.base, '/api/v1/projects', { name: 'R3 draft journey' }, 'r3-draft-project');
    assert.equal(created.response.status, 201);
    assert.equal(created.json.status, 'draft');
    assert.equal(created.json.onboarding_state, 'draft');
    assert.equal(created.json.intake.status, 'draft');
    assert.deepEqual(created.json.brief.content, {});
    assert.equal(created.json.workflow_draft.source_brief_revision, 0);

    const blocked = await mutate(env.base, `/api/v1/projects/${created.json.id}/workflows`, { tasks: [] }, 'r3-draft-blocked');
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.json.error.code, 'project_not_ready');
    assert.deepEqual(blocked.json.error.details.blockers, ['project_not_confirmed', 'intake_not_ready', 'brief_not_confirmed']);
    assert.equal(blocked.json.error.details.project_revision, created.json.revision);
    assert.equal(blocked.json.error.details.intake_revision, created.json.intake.revision);
    assert.equal(blocked.json.error.details.confirmed_brief_revision, null);

    const cancelled = await mutate(env.base, `/api/v1/intakes/${created.json.intake.id}/cancel`, {
      expected_revision: created.json.intake.revision
    }, 'r3-draft-cancel');
    assert.equal(cancelled.response.status, 202);
    assert.equal(cancelled.json.id, created.json.intake.id);
    assert.equal(cancelled.json.status, 'cancelled');

    const resumed = await mutate(env.base, `/api/v1/intakes/${created.json.intake.id}/resume`, {
      expected_revision: cancelled.json.revision
    }, 'r3-draft-resume');
    assert.equal(resumed.response.status, 202);
    assert.equal(resumed.json.intake_id, created.json.intake.id);
    assert.equal((await waitOperation(env.base, resumed.json.operation_id)).status, 'completed');
    const ready = await request(env.base, `/api/v1/projects/${created.json.id}`);
    assert.equal(ready.json.intake.id, created.json.intake.id);
    assert.equal(ready.json.intake.status, 'ready');
    assert.equal(ready.json.intake.attempt, 1);

    const first = await mutate(env.base, `/api/v1/projects/${created.json.id}/briefs`, {
      content: { objective: 'First preview' }
    }, 'r3-brief-first');
    const second = await mutate(env.base, `/api/v1/projects/${created.json.id}/briefs`, {
      content: { objective: 'Confirmed preview', acceptance: ['ready'] }
    }, 'r3-brief-second');
    const beforeConfirm = await request(env.base, `/api/v1/projects/${created.json.id}`);
    const stale = await mutate(env.base, `/api/v1/projects/${created.json.id}/briefs/${first.json.revision}/confirm`, {
      expected_revision: beforeConfirm.json.revision,
      intake_revision: beforeConfirm.json.intake.revision
    }, 'r3-brief-stale-confirm');
    assert.equal(stale.response.status, 409);
    assert.equal(stale.json.error.code, 'revision_conflict');
    assert.equal(stale.json.error.details.current_revision, second.json.revision);

    const confirmed = await mutate(env.base, `/api/v1/projects/${created.json.id}/briefs/${second.json.revision}/confirm`, {
      expected_revision: beforeConfirm.json.revision,
      intake_revision: beforeConfirm.json.intake.revision
    }, 'r3-brief-confirm');
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.json.status, 'active');
    assert.equal(confirmed.json.onboarding_state, 'confirmed');
    assert.equal(confirmed.json.confirmed_brief_revision, second.json.revision);
    assert.equal(confirmed.json.workflow_draft.source_brief_revision, second.json.revision);

    const replay = await mutate(env.base, `/api/v1/projects/${created.json.id}/briefs/${second.json.revision}/confirm`, {
      expected_revision: beforeConfirm.json.revision,
      intake_revision: beforeConfirm.json.intake.revision
    }, 'r3-brief-confirm-replay');
    assert.equal(replay.response.status, 200);
    assert.equal(replay.json.revision, confirmed.json.revision);
    assert.equal(replay.json.confirmed_brief_revision, second.json.revision);

    const workflow = await mutate(env.base, `/api/v1/projects/${created.json.id}/workflows`, {
      name: 'R3 aggregate workflow',
      tasks: [{ id: 'inspect', level: 1, title: 'Inspect', mode: 'read' }]
    }, 'r3-aggregate-workflow');
    assert.equal(workflow.response.status, 201);
    const aggregate = await request(env.base, `/api/v1/projects/${created.json.id}`);
    assert.equal(aggregate.json.workflow.revision, workflow.json.revision);
    assert.equal(aggregate.json.workflow.name, 'R3 aggregate workflow');
    assert.deepEqual(aggregate.json.workflow.tasks, workflow.json.tasks);
    assert.equal('tasks_json' in aggregate.json.workflow, false);
  } finally { await env.close(); }
});

test('allowlisted local intake preserves source, records three Lines, recovers faults, and completes lifecycle', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r3-local-source-'));
  fs.writeFileSync(path.join(sourceRoot, 'README.md'), '# external source\n', 'utf8');
  await execFileAsync('git', ['init', sourceRoot], { windowsHide: true });
  await execFileAsync('git', ['-C', sourceRoot, 'config', 'user.email', 'aiws-r3@example.invalid'], { windowsHide: true });
  await execFileAsync('git', ['-C', sourceRoot, 'config', 'user.name', 'AIWS R3'], { windowsHide: true });
  await execFileAsync('git', ['-C', sourceRoot, 'add', 'README.md'], { windowsHide: true });
  await execFileAsync('git', ['-C', sourceRoot, 'commit', '-m', 'external baseline', '--no-gpg-sign'], { windowsHide: true });
  const sourceHead = (await execFileAsync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true })).stdout.trim();
  const sourceFileHash = createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, 'README.md'))).digest('hex');
  const env = await fixture({ config: { projectImportRoots: [sourceRoot] } });
  try {
    const draft = await mutate(env.base, '/api/v1/projects', {
      name: 'R3 local repository',
      repository: { source: { kind: 'local', path: sourceRoot } }
    }, 'r3-local-project');
    const { project } = await onboardProject(env.base, draft, {
      content: { objective: 'Verify repository lifecycle' },
      keyPrefix: 'r3-local-onboarding'
    });
    assert.match(project.repository.baseline_sha, /^[a-f0-9]{40}$/);
    assert.equal(project.repository.source.kind, 'local');
    assert.equal(project.repository.source.read_only, true);
    assert.doesNotMatch(JSON.stringify(project), /source_locator|managed_relative_path|local_path/);

    const connections = await request(env.base, `/api/v1/projects/${project.id}/repository-connections`);
    const linesResponse = await request(env.base, `/api/v1/projects/${project.id}/repository-lines`);
    assert.equal(connections.json.length, 1);
    assert.equal(connections.json[0].source_kind, 'local');
    assert.equal(connections.json[0].read_only, true);
    assert.deepEqual(linesResponse.json.map((line) => line.line_kind).toSorted(), ['external_readonly', 'managed_checkout', 'managed_staging']);
    assert.equal(linesResponse.json.find((line) => line.line_kind === 'managed_staging').status, 'blocked');
    const externalLine = linesResponse.json.find((line) => line.line_kind === 'external_readonly');
    const externalProbe = await mutate(env.base, `/api/v1/repository-lines/${externalLine.id}/probe`, {
      expected_revision: externalLine.revision
    }, 'r3-external-line-probe');
    assert.equal((await waitOperation(env.base, externalProbe.json.operation_id)).status, 'completed');
    assert.equal((await execFileAsync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true })).stdout.trim(), sourceHead);
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, 'README.md'))).digest('hex'), sourceFileHash);

    let checkoutLine = linesResponse.json.find((line) => line.line_kind === 'managed_checkout');
    const checkout = path.join(env.home, 'projects', project.id);
    const displaced = path.join(env.home, '.fault-fixture-checkout');
    fs.renameSync(checkout, displaced);
    const probe = await mutate(env.base, `/api/v1/repository-lines/${checkoutLine.id}/probe`, {
      expected_revision: checkoutLine.revision
    }, 'r3-line-probe-fault');
    assert.equal(probe.response.status, 202);
    const failedProbe = await waitOperation(env.base, probe.json.operation_id);
    assert.equal(failedProbe.status, 'failed');
    assert.equal(failedProbe.error_code, 'repository_line_fault');
    checkoutLine = (await request(env.base, `/api/v1/repository-lines/${checkoutLine.id}`)).json;
    assert.equal(checkoutLine.status, 'fault');
    assert.equal(checkoutLine.fault_code, 'repository_line_fault');

    fs.renameSync(displaced, checkout);
    const recovered = await mutate(env.base, `/api/v1/repository-lines/${checkoutLine.id}/recover`, {
      expected_revision: checkoutLine.revision
    }, 'r3-line-recover');
    assert.equal((await waitOperation(env.base, recovered.json.operation_id)).status, 'completed');
    checkoutLine = (await request(env.base, `/api/v1/repository-lines/${checkoutLine.id}`)).json;
    assert.equal(checkoutLine.status, 'ready');
    assert.equal(checkoutLine.fault_code, '');

    const interrupted = await env.app.domain.operationService.create({
      kind: 'repository.probe', resourceType: 'repository_line', resourceId: checkoutLine.id
    });
    await env.app.database.run("UPDATE repository_lines SET locked_by_operation_id=?,operation_id=?,status='busy',revision=revision+1 WHERE id=?", [interrupted.operation_id, interrupted.operation_id, checkoutLine.id]);
    await env.app.domain.recover();
    assert.equal((await request(env.base, `/api/v1/operations/${interrupted.operation_id}`)).json.error_code, 'operation_interrupted');
    checkoutLine = (await request(env.base, `/api/v1/repository-lines/${checkoutLine.id}`)).json;
    assert.equal(checkoutLine.status, 'fault');
    assert.equal(checkoutLine.fault_code, 'repository_line_interrupted');
    const restartRecovery = await mutate(env.base, `/api/v1/repository-lines/${checkoutLine.id}/recover`, {
      expected_revision: checkoutLine.revision
    }, 'r3-line-restart-recover');
    assert.equal((await waitOperation(env.base, restartRecovery.json.operation_id)).status, 'completed');

    let current = (await request(env.base, `/api/v1/projects/${project.id}`)).json;
    const archived = await mutate(env.base, `/api/v1/projects/${project.id}/archive`, { expected_revision: current.revision }, 'r3-project-archive');
    assert.equal((await waitOperation(env.base, archived.json.operation_id)).status, 'completed');
    current = (await request(env.base, `/api/v1/projects/${project.id}`)).json;
    assert.equal(current.status, 'archived');
    const archiveArtifact = await env.app.database.get("SELECT relative_path,manifest_hash FROM repository_line_artifacts WHERE project_id=? AND kind='archive' ORDER BY created_at DESC LIMIT 1", [project.id]);
    assert.match(archiveArtifact.manifest_hash, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(path.join(env.home, archiveArtifact.relative_path)), true);

    const trashed = await mutate(env.base, `/api/v1/projects/${project.id}/trash`, { expected_revision: current.revision }, 'r3-project-trash');
    assert.equal((await waitOperation(env.base, trashed.json.operation_id)).status, 'completed');
    current = (await request(env.base, `/api/v1/projects/${project.id}`)).json;
    assert.equal(current.status, 'trashed');
    assert.equal(fs.existsSync(checkout), false);
    assert.equal((await execFileAsync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true })).stdout.trim(), sourceHead);

    const restored = await mutate(env.base, `/api/v1/projects/${project.id}/restore`, { expected_revision: current.revision }, 'r3-project-restore');
    assert.equal((await waitOperation(env.base, restored.json.operation_id)).status, 'completed');
    current = (await request(env.base, `/api/v1/projects/${project.id}`)).json;
    assert.equal(current.status, 'active');
    assert.equal(fs.existsSync(checkout), true);

    const reTrashed = await mutate(env.base, `/api/v1/projects/${project.id}/trash`, { expected_revision: current.revision }, 'r3-project-retrash');
    assert.equal((await waitOperation(env.base, reTrashed.json.operation_id)).status, 'completed');
    current = (await request(env.base, `/api/v1/projects/${project.id}`)).json;
    const mismatch = await mutate(env.base, `/api/v1/projects/${project.id}/purge`, {
      expected_revision: current.revision, confirm_name: 'wrong name'
    }, 'r3-project-purge-mismatch');
    assert.equal(mismatch.response.status, 409);
    assert.equal(mismatch.json.error.code, 'project_purge_confirmation_mismatch');
    const purged = await mutate(env.base, `/api/v1/projects/${project.id}/purge`, {
      expected_revision: current.revision, confirm_name: current.name
    }, 'r3-project-purge');
    assert.equal((await waitOperation(env.base, purged.json.operation_id)).status, 'completed');
    assert.equal((await request(env.base, `/api/v1/projects/${project.id}`)).response.status, 404);
    assert.equal((await env.app.database.get('SELECT status FROM projects WHERE id=?', [project.id])).status, 'purged');
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, 'README.md'))).digest('hex'), sourceFileHash);
  } finally {
    await env.close();
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('multipart upload streams into a managed checkout and replays by content identity', async () => {
  const env = await fixture();
  try {
    const draft = await mutate(env.base, '/api/v1/projects', { name: 'R3 streamed upload' }, 'r3-upload-project');
    const uploadForm = () => {
      const form = new FormData();
      form.append('files', new Blob(['export const ready = true;\n'], { type: 'text/javascript' }), 'src/main.mjs');
      form.append('files', new Blob(['# streamed upload\n'], { type: 'text/markdown' }), 'README.md');
      form.append('mode', 'existing');
      return form;
    };
    const upload = await fetch(`${env.base}/api/v1/intakes/${draft.json.intake.id}/upload`, {
      method: 'POST', headers: { accept: 'application/json', 'Idempotency-Key': 'r3-streamed-upload' }, body: uploadForm()
    });
    const receipt = await upload.json();
    assert.equal(upload.status, 202);
    assert.equal(receipt.upload_file_count, 2);
    assert.equal((await waitOperation(env.base, receipt.operation_id)).status, 'completed');

    const project = (await request(env.base, `/api/v1/projects/${draft.json.id}`)).json;
    assert.equal(project.intake.status, 'ready');
    assert.equal(project.intake.source.kind, 'upload');
    assert.match(project.repository.baseline_sha, /^[a-f0-9]{40}$/);
    assert.equal(fs.readFileSync(path.join(env.home, 'projects', draft.json.id, 'src', 'main.mjs'), 'utf8'), 'export const ready = true;\n');
    const uploadRoot = path.join(env.home, '.staging', 'uploads');
    assert.deepEqual(fs.readdirSync(uploadRoot), []);

    const replay = await fetch(`${env.base}/api/v1/intakes/${draft.json.intake.id}/upload`, {
      method: 'POST', headers: { accept: 'application/json', 'Idempotency-Key': 'r3-streamed-upload' }, body: uploadForm()
    });
    const replayReceipt = await replay.json();
    assert.equal(replay.status, 202);
    assert.equal(replayReceipt.operation_id, receipt.operation_id);
    assert.deepEqual(fs.readdirSync(uploadRoot), []);
    assert.doesNotMatch(JSON.stringify(replayReceipt), new RegExp(env.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    const idempotency = await env.app.database.get("SELECT request_hash,response_json FROM idempotency_keys WHERE key='r3-streamed-upload'");
    assert.match(idempotency.request_hash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(idempotency.response_json, /staging|managed_relative_path|local_path/i);
  } finally { await env.close(); }
});

test('Repository Connection, Target, and Line commands preserve revision and ownership boundaries', async () => {
  const env = await fixture();
  try {
    const project = await mutate(env.base, '/api/v1/projects', { name: 'R3 repository commands' }, 'r3-repository-command-project');
    assert.equal(project.response.status, 201);

    let connection = await mutate(env.base, `/api/v1/projects/${project.json.id}/repository-connections`, {
      source: { kind: 'fixture', id: 'designsignal-v1' }
    }, 'r3-connection-create');
    assert.equal(connection.response.status, 201);
    assert.equal(connection.json.source_kind, 'fixture');
    const duplicateConnection = await mutate(env.base, `/api/v1/projects/${project.json.id}/repository-connections`, {
      source: { kind: 'fixture', id: 'designsignal-v1' }
    }, 'r3-connection-duplicate');
    assert.equal(duplicateConnection.response.status, 409);
    assert.equal(duplicateConnection.json.error.code, 'already_exists');
    assert.equal((await request(env.base, `/api/v1/projects/${project.json.id}/repository-connections`)).json.length, 1);
    assert.equal((await request(env.base, `/api/v1/repository-connections/${connection.json.id}`)).json.id, connection.json.id);
    connection = await mutate(env.base, `/api/v1/repository-connections/${connection.json.id}`, {
      expected_revision: connection.json.revision,
      source: { kind: 'fixture', id: 'designsignal-v1' }
    }, 'r3-connection-update', 'PATCH');
    assert.equal(connection.response.status, 200);
    assert.equal(connection.json.revision, 2);
    const staleConnection = await mutate(env.base, `/api/v1/repository-connections/${connection.json.id}`, {
      expected_revision: 1
    }, 'r3-connection-stale', 'PATCH');
    assert.equal(staleConnection.response.status, 409);
    assert.equal(staleConnection.json.error.code, 'revision_conflict');

    const invalidTarget = await mutate(env.base, `/api/v1/repository-connections/${connection.json.id}/targets`, {
      repository: 'fixture/repository', default_branch: '../invalid'
    }, 'r3-target-invalid');
    assert.equal(invalidTarget.response.status, 422);
    assert.equal(invalidTarget.json.error.code, 'invalid_input');

    let target = await mutate(env.base, `/api/v1/repository-connections/${connection.json.id}/targets`, {
      repository: 'fixture/repository', default_branch: 'main'
    }, 'r3-target-create');
    assert.equal(target.response.status, 201);
    const duplicateTarget = await mutate(env.base, `/api/v1/repository-connections/${connection.json.id}/targets`, {
      repository: 'fixture/duplicate', default_branch: 'main'
    }, 'r3-target-duplicate');
    assert.equal(duplicateTarget.response.status, 409);
    assert.equal(duplicateTarget.json.error.code, 'already_exists');
    assert.equal((await request(env.base, `/api/v1/repository-connections/${connection.json.id}/targets`)).json.length, 1);
    assert.equal((await request(env.base, `/api/v1/repository-targets/${target.json.id}`)).json.id, target.json.id);
    target = await mutate(env.base, `/api/v1/repository-targets/${target.json.id}`, {
      expected_revision: target.json.revision, default_branch: 'release/r3'
    }, 'r3-target-update', 'PATCH');
    assert.equal(target.response.status, 200);
    assert.equal(target.json.default_branch, 'release/r3');
    const invalidTargetUpdate = await mutate(env.base, `/api/v1/repository-targets/${target.json.id}`, {
      expected_revision: target.json.revision, default_branch: '../invalid'
    }, 'r3-target-update-invalid', 'PATCH');
    assert.equal(invalidTargetUpdate.response.status, 422);
    assert.equal(invalidTargetUpdate.json.error.code, 'invalid_input');

    const relative = `projects/${project.json.id}/manual-staging`;
    const invalidLine = await mutate(env.base, `/api/v1/projects/${project.json.id}/repository-lines`, {
      target_id: target.json.id, line_kind: 'unsupported_line'
    }, 'r3-line-invalid');
    assert.equal(invalidLine.response.status, 422);
    assert.equal(invalidLine.json.error.code, 'invalid_input');
    let line = await mutate(env.base, `/api/v1/projects/${project.json.id}/repository-lines`, {
      target_id: target.json.id, line_kind: 'managed_staging', managed_relative_path: relative
    }, 'r3-line-create');
    assert.equal(line.response.status, 201);
    const duplicateLine = await mutate(env.base, `/api/v1/projects/${project.json.id}/repository-lines`, {
      target_id: target.json.id, line_kind: 'managed_staging', managed_relative_path: `${relative}-duplicate`
    }, 'r3-line-duplicate');
    assert.equal(duplicateLine.response.status, 409);
    assert.equal(duplicateLine.json.error.code, 'already_exists');
    assert.equal((await request(env.base, `/api/v1/projects/${project.json.id}/repository-lines`)).json.length, 1);
    assert.equal((await request(env.base, `/api/v1/repository-lines/${line.json.id}`)).json.id, line.json.id);
    line = await mutate(env.base, `/api/v1/repository-lines/${line.json.id}`, {
      expected_revision: line.json.revision, branch: 'release/r3', status: 'blocked'
    }, 'r3-line-update', 'PATCH');
    assert.equal(line.response.status, 200);
    assert.equal(line.json.status, 'blocked');
    const staleLine = await mutate(env.base, `/api/v1/repository-lines/${line.json.id}`, {
      expected_revision: 1, branch: 'stale/r3'
    }, 'r3-line-stale', 'PATCH');
    assert.equal(staleLine.response.status, 409);
    assert.equal(staleLine.json.error.code, 'revision_conflict');

    const connectionInUse = await mutate(env.base, `/api/v1/repository-connections/${connection.json.id}`, {
      expected_revision: connection.json.revision
    }, 'r3-connection-in-use', 'DELETE');
    assert.equal(connectionInUse.response.status, 409);
    assert.equal(connectionInUse.json.error.code, 'project_in_use');
    const targetInUse = await mutate(env.base, `/api/v1/repository-targets/${target.json.id}`, {
      expected_revision: target.json.revision
    }, 'r3-target-in-use', 'DELETE');
    assert.equal(targetInUse.response.status, 409);
    assert.equal(targetInUse.json.error.code, 'project_in_use');

    const materialized = path.join(env.home, ...relative.split('/'));
    fs.mkdirSync(materialized, { recursive: true });
    fs.writeFileSync(path.join(materialized, 'README.md'), '# managed staging\n', 'utf8');
    const staleSync = await mutate(env.base, `/api/v1/repository-lines/${line.json.id}/sync`, {
      expected_revision: 1
    }, 'r3-line-sync-stale');
    assert.equal(staleSync.response.status, 409);
    assert.equal(staleSync.json.error.code, 'revision_conflict');
    const synced = await mutate(env.base, `/api/v1/repository-lines/${line.json.id}/sync`, {
      expected_revision: line.json.revision
    }, 'r3-line-sync');
    assert.equal(synced.response.status, 202);
    assert.equal((await waitOperation(env.base, synced.json.operation_id)).status, 'completed');
    line = (await request(env.base, `/api/v1/repository-lines/${line.json.id}`)).json;
    assert.equal(line.probe_status, 'available');

    const deletedLine = await mutate(env.base, `/api/v1/repository-lines/${line.id}`, {
      expected_revision: line.revision
    }, 'r3-line-delete', 'DELETE');
    assert.equal(deletedLine.json.deleted, true);
    const deletedTarget = await mutate(env.base, `/api/v1/repository-targets/${target.json.id}`, {
      expected_revision: target.json.revision
    }, 'r3-target-delete', 'DELETE');
    assert.equal(deletedTarget.json.deleted, true);
    const deletedConnection = await mutate(env.base, `/api/v1/repository-connections/${connection.json.id}`, {
      expected_revision: connection.json.revision
    }, 'r3-connection-delete', 'DELETE');
    assert.equal(deletedConnection.json.deleted, true);

    const missingCheckoutArchive = await mutate(env.base, `/api/v1/projects/${project.json.id}/repository/archive`, {
      expected_revision: project.json.revision
    }, 'r3-repository-archive-missing');
    assert.equal(missingCheckoutArchive.response.status, 404);
    assert.equal(missingCheckoutArchive.json.error.code, 'not_found');

    const onboarded = await onboardProject(env.base, project, {
      content: { objective: 'Archive from Repository API' }, keyPrefix: 'r3-repository-command-onboarding'
    });
    const archive = await mutate(env.base, `/api/v1/projects/${project.json.id}/repository/archive`, {
      expected_revision: onboarded.project.revision
    }, 'r3-repository-archive');
    assert.equal(archive.response.status, 202);
    assert.equal((await waitOperation(env.base, archive.json.operation_id)).status, 'completed');
    const archiveArtifact = await env.app.database.get("SELECT manifest_hash FROM repository_line_artifacts WHERE project_id=? AND kind='archive' ORDER BY created_at DESC LIMIT 1", [project.json.id]);
    assert.match(archiveArtifact.manifest_hash, /^[a-f0-9]{64}$/);
  } finally { await env.close(); }
});

test('failed Intake retry reuses its identity and source drift returns the stable conflict', async () => {
  const env = await fixture();
  try {
    const draft = await mutate(env.base, '/api/v1/projects', { name: 'R3 retry contract' }, 'r3-retry-project');
    await env.app.database.run("UPDATE project_intakes SET status='failed',attempt=1,revision=revision+1,error_code='repository_probe_failed' WHERE id=?", [draft.json.intake.id]);
    await env.app.database.run("UPDATE projects SET onboarding_state='failed',revision=revision+1 WHERE id=?", [draft.json.id]);
    const failed = (await request(env.base, `/api/v1/projects/${draft.json.id}`)).json;
    assert.equal(failed.intake.status, 'failed');
    assert.equal((await request(env.base, `/api/v1/projects/${draft.json.id}/intakes`)).json.length, 1);
    assert.equal((await request(env.base, `/api/v1/intakes/${failed.intake.id}`)).json.error_code, 'repository_probe_failed');

    const retried = await mutate(env.base, `/api/v1/intakes/${failed.intake.id}/retry`, {
      expected_revision: failed.intake.revision
    }, 'r3-intake-retry');
    assert.equal(retried.response.status, 202);
    assert.equal((await waitOperation(env.base, retried.json.operation_id)).status, 'completed');
    const ready = (await request(env.base, `/api/v1/projects/${draft.json.id}`)).json;
    assert.equal(ready.intake.id, failed.intake.id);
    assert.equal(ready.intake.attempt, 2);
    assert.equal(ready.intake.status, 'ready');

    const before = { kind: 'local', revision: 'source-r1', hash: 'a'.repeat(64) };
    const after = { kind: 'local', revision: 'source-r2', hash: 'b'.repeat(64) };
    assert.equal(assertIntakeSourceStable(before, before), before);
    assert.throws(() => assertIntakeSourceStable(before, after), (error) => {
      assert.equal(error.code, 'intake_source_changed');
      assert.equal(error.status, 409);
      assert.equal(error.details.source_kind, 'local');
      return true;
    });
  } finally { await env.close(); }
});
