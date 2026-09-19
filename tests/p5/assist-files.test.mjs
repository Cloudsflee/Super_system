import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../../apps/api/src/clean/canonical.mjs';
import { close, closeServer, createAssistPrerequisites, createProject, createWorkspace, listen, open, waitForOperation } from './helpers.mjs';
import { open as openP10 } from '../p10/helpers.mjs';

test('Assist persists opaque provider lineage and enforces completion, interaction and retry invariants', async () => {
  const state = await open();
  try {
    const project = await createProject(state, 'assist');
    const { pack, profile } = await createAssistPrerequisites(state, project, 'assist');
    const createdSession = await state.runtime.assist.createSession({
      project_id: project.id, scope: 'project', scope_id: project.id,
      context_pack_id: pack.id, profile_id: profile.id, idempotency_key: 'p5-assist-session-key'
    }, state.principal);
    const session = createdSession.session;
    assert.equal(createdSession.operation.status, 'succeeded');
    const queued = await state.runtime.assist.createTurn({
      session_id: session.id, expected_revision: session.revision, message: 'complete this turn', defer: true,
      idempotency_key: 'p5-assist-turn-key'
    }, state.principal);
    const first = state.runtime.db.get('SELECT * FROM assist_turns WHERE operation_id=?', [queued.operation_id]);
    const completed = await state.runtime.assist.executeTurn(first.id, state.principal);
    assert.equal(completed.status, 'completed');
    assert.match(completed.provider_turn_id, /^provider_turn_/);
    assert.deepEqual(completed.messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(state.runtime.operations.get(first.operation_id, { actorId: state.principal.actorId }).status, 'succeeded');

    let sessionRevision = state.runtime.db.get('SELECT revision FROM assist_sessions WHERE id=?', [session.id]).revision;
    const waitingOperation = await state.runtime.assist.createTurn({
      session_id: session.id, expected_revision: sessionRevision, message: 'wait for input', defer: true,
      fixture: { pending_input: { prompt_summary: 'Choose', input_schema: { type: 'string' } } },
      idempotency_key: 'p5-assist-waiting-key'
    }, state.principal);
    let waiting = state.runtime.db.get('SELECT * FROM assist_turns WHERE operation_id=?', [waitingOperation.operation_id]);
    await state.runtime.assist.executeTurn(waiting.id, state.principal);
    waiting = state.runtime.db.get('SELECT * FROM assist_turns WHERE id=?', [waiting.id]);
    assert.equal(waiting.status, 'awaiting_input');
    assert.equal(state.runtime.db.get('SELECT status FROM operations WHERE id=?', [waiting.operation_id]).status, 'paused');
    const input = state.runtime.db.get('SELECT * FROM runtime_user_inputs WHERE assist_turn_id=?', [waiting.id]);
    await state.runtime.assist.answerInput(input.id, {
      response: { value: 'continue' }, expected_revision: input.revision, idempotency_key: 'p5-assist-answer-key'
    }, state.principal);
    assert.equal((await waitForOperation(state.runtime, waiting.operation_id, state.principal.actorId)).status, 'succeeded');
    assert.equal(state.runtime.db.get('SELECT status FROM assist_turns WHERE id=?', [waiting.id]).status, 'completed');

    sessionRevision = state.runtime.db.get('SELECT revision FROM assist_sessions WHERE id=?', [session.id]).revision;
    const incompleteOperation = await state.runtime.assist.createTurn({
      session_id: session.id, expected_revision: sessionRevision, message: 'incomplete provider output', defer: true,
      fixture: { missing_terminal: true }, idempotency_key: 'p5-assist-incomplete-key'
    }, state.principal);
    let incomplete = state.runtime.db.get('SELECT * FROM assist_turns WHERE operation_id=?', [incompleteOperation.operation_id]);
    await assert.rejects(() => state.runtime.assist.executeTurn(incomplete.id, state.principal), (error) => error.code === 'assist_output_incomplete');
    incomplete = state.runtime.db.get('SELECT * FROM assist_turns WHERE id=?', [incomplete.id]);
    assert.equal(state.runtime.db.get('SELECT status FROM operations WHERE id=?', [incomplete.operation_id]).status, 'failed');
    const retry = await state.runtime.assist.retryTurn(incomplete.id, {
      expected_revision: incomplete.revision, fixture: { assistant: 'retry complete' }, idempotency_key: 'p5-assist-retry-key'
    }, state.principal);
    assert.equal((await waitForOperation(state.runtime, retry.operation_id, state.principal.actorId)).status, 'succeeded');
    const retried = state.runtime.db.get('SELECT * FROM assist_turns WHERE id=?', [incomplete.id]);
    assert.equal(retried.attempt, 2);
    assert.equal(state.runtime.db.get("SELECT relation FROM operation_links WHERE operation_id=? AND aggregate_type='operation' AND aggregate_id=?", [retry.operation_id, incomplete.operation_id]).relation, 'retry_of');
    assert.equal(state.runtime.db.integrity().semantic.valid, true);
  } finally { await close(state); }
});

test('Attachments enforce bounded previews and file batches apply and undo under Repository fencing', async () => {
  const state = await open();
  try {
    const project = await createProject(state, 'files');
    const { workspace, directory } = await createWorkspace(state, project, 'files');
    fs.writeFileSync(path.join(directory, 'alpha.txt'), 'before');
    const attachment = await state.runtime.files.createAttachment({
      project_id: project.id, filename: 'note.json', media_type: 'application/json',
      content_base64: Buffer.from('{"ok":true}').toString('base64'), idempotency_key: 'p5-attachment-key'
    }, state.principal);
    assert.equal(attachment.attachment.disposition, 'preview');
    assert.equal(Buffer.from(state.runtime.files.attachmentContent(attachment.attachment.id, state.principal, { preview: true }).content_base64, 'base64').toString('utf8'), '{"ok":true}');
    const quarantined = await state.runtime.files.createAttachment({
      project_id: project.id, filename: 'mismatch.png', media_type: 'image/png',
      content_base64: Buffer.from('plain text').toString('base64'), idempotency_key: 'p5-attachment-quarantine-key'
    }, state.principal);
    assert.equal(quarantined.attachment.status, 'quarantined');

    const created = await state.runtime.files.createBatch({
      project_id: project.id, workspace_id: workspace.id,
      changes: [{ path: 'alpha.txt', action: 'replace', content: 'after' }, { path: 'beta.txt', action: 'create', content: 'new' }],
      idempotency_key: 'p5-batch-key'
    }, state.principal);
    const approved = await state.runtime.files.approveBatch(created.batch.id, {
      expected_revision: created.batch.revision, idempotency_key: 'p5-batch-approve-key'
    }, state.principal);
    const applying = await state.runtime.files.applyBatch(created.batch.id, {
      expected_revision: approved.batch.revision, idempotency_key: 'p5-batch-apply-key'
    }, state.principal);
    assert.equal((await waitForOperation(state.runtime, applying.operation_id, state.principal.actorId)).status, 'succeeded');
    const applied = state.runtime.files.reviewBatch(created.batch.id, state.principal);
    assert.equal(applied.batch.status, 'applied');
    assert.deepEqual(applied.items.map((item) => item.status), ['applied', 'applied']);
    assert.equal(fs.readFileSync(path.join(directory, 'alpha.txt'), 'utf8'), 'after');
    const replay = await state.runtime.files.applyBatch(created.batch.id, {
      expected_revision: approved.batch.revision, idempotency_key: 'p5-batch-apply-key'
    }, state.principal);
    assert.equal(replay.replayed, true);
    assert.equal(replay.operation_id, applying.operation_id);
    const undoing = await state.runtime.files.undoBatch(created.batch.id, {
      expected_revision: applied.batch.revision, idempotency_key: 'p5-batch-undo-key'
    }, state.principal);
    assert.equal((await waitForOperation(state.runtime, undoing.operation_id, state.principal.actorId)).status, 'succeeded');
    assert.equal(fs.readFileSync(path.join(directory, 'alpha.txt'), 'utf8'), 'before');
    assert.equal(fs.existsSync(path.join(directory, 'beta.txt')), false);
    assert.equal(state.runtime.db.get("SELECT count(*) AS count FROM file_change_items WHERE status!='pending'").count, 0);
    assert.equal(state.runtime.db.integrity().semantic.valid, true);
  } finally { await close(state); }
});

test('Files index workspaces on first list, skips unsafe entries, and binds Context to file revision/hash', async () => {
  const state = await open();
  try {
    const project = await createProject(state, 'file-index');
    const foreign = await createProject(state, 'file-index-foreign');
    const { workspace, directory } = await createWorkspace(state, project, 'file-index');
    fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'README.md'), '# indexed\n');
    fs.writeFileSync(path.join(directory, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(directory, '.git', 'config'), 'hidden');
    fs.writeFileSync(path.join(directory, 'node_modules', 'hidden.js'), 'hidden');
    try { fs.symlinkSync(path.join(directory, 'README.md'), path.join(directory, 'README-link.md')); } catch { /* symlink privileges vary by runner */ }
    const listed = await state.runtime.files.listFiles(project.id, { workspace_id: workspace.id, limit: 500 }, state.principal);
    const paths = listed.files.map((file) => file.relative_path);
    assert.ok(paths.includes('README.md'));
    assert.equal(paths.includes('.git/config'), false);
    assert.equal(paths.includes('node_modules/hidden.js'), false);
    const binary = listed.files.find((file) => file.relative_path === 'image.bin');
    assert.ok(binary);
    const checked = state.runtime.files.readIndexedFile(project.id, binary.id, binary.revision, binary.content_sha256, state.principal);
    assert.deepEqual(checked.bytes, Buffer.from([0, 1, 2, 3]));
    assert.throws(() => state.runtime.files.readIndexedFile(foreign.id, binary.id, binary.revision, binary.content_sha256, state.principal), (error) => error.code === 'scope_denied');

    const text = listed.files.find((file) => file.relative_path === 'README.md');
    fs.writeFileSync(path.join(directory, 'README.md'), '# drifted\n');
    assert.throws(() => state.runtime.files.readIndexedFile(project.id, text.id, text.revision, text.content_sha256, state.principal), (error) => error.code === 'file_stale');
    await assert.rejects(() => state.runtime.context.createSource(project.id, {
      source_type: 'file', file_ref_id: text.id, expected_file_revision: text.revision,
      expected_file_hash: text.content_sha256, title: 'drifted', canonical_uri: 'file/readme', idempotency_key: 'p5-file-context-drift'
    }, state.principal), (error) => error.code === 'file_stale');
    const priorOwner = state.runtime.context.files;
    state.runtime.context.files = null;
    await assert.rejects(() => state.runtime.context.createSource(project.id, {
      source_type: 'file', file_ref_id: text.id, title: 'owner missing', canonical_uri: 'file/missing-owner', idempotency_key: 'p5-file-owner-missing'
    }, state.principal), (error) => error.code === 'files_owner_unavailable');
    state.runtime.context.files = priorOwner;
  } finally { await close(state); }
});

test('Files HTTP and Context independently bind Unicode bytes, revisions, ACL and disk drift', async () => {
  const state = await open();
  const { server, base } = await listen(state.runtime);
  try {
    const project = await createProject(state, 'file-http');
    const foreign = await createProject(state, 'file-http-other');
    const { workspace, directory } = await createWorkspace(state, project, 'file-http');
    const bytes = Buffer.from('\u4e2d\u6587 context\n');
    fs.writeFileSync(path.join(directory, 'note.txt'), bytes);
    fs.writeFileSync(path.join(directory, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x80]));
    const request = apiClient(base, state.proof);
    const list = await request(`/projects/${project.id}/files?workspace_id=${workspace.id}&limit=500`);
    assert.equal(list.status, 200);
    const text = list.body.data.files.find(file => file.path === 'note.txt');
    const binary = list.body.data.files.find(file => file.path === 'binary.bin');
    assert.equal(text.content_sha256, sha256Hex(bytes));
    const preview = await request(`/projects/${project.id}/files/${text.id}`);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.data.content, bytes.toString('utf8'));
    const metadata = await request(`/projects/${project.id}/files/${binary.id}`);
    assert.equal(metadata.body.data.content, null);
    assert.equal(metadata.body.data.download_only, true);
    assert.equal((await request(`/projects/${foreign.id}/files?workspace_id=${workspace.id}`)).body.error.code, 'scope_denied');
    const source = revision => ({ file_ref_id: text.id, expected_file_revision: revision, expected_file_hash: sha256Hex(bytes), source_type: 'file', canonical_uri: 'file/checked', title: 'Checked', content: 'ignored supplied content', source_revision: 'spoofed' });
    const created = await request(`/projects/${project.id}/context/sources`, source(1));
    assert.equal(created.body.data.source.source_revision, '1');
    assert.equal(created.body.data.source.source_hash, sha256Hex(bytes));
    fs.writeFileSync(path.join(directory, 'note.txt'), 'changed');
    assert.throws(() => state.runtime.files.readIndexedFile(project.id, text.id, 1, text.content_sha256, state.principal), error => error.code === 'file_stale');
    await state.runtime.files.indexWorkspace(workspace.id, project.id, state.principal);
    fs.writeFileSync(path.join(directory, 'note.txt'), bytes);
    await state.runtime.files.indexWorkspace(workspace.id, project.id, state.principal);
    const updated = await request(`/projects/${project.id}/context/sources`, source(3));
    assert.equal(updated.body.data.source.id, created.body.data.source.id);
    assert.equal(updated.body.data.source.source_revision, '3');
    assert.equal(updated.body.data.source.source_hash, sha256Hex(bytes));
    assert.ok(updated.body.data.source.revision > created.body.data.source.revision);
    for (const [revision, hash] of [[1, text.content_sha256], [3, 'f'.repeat(64)]]) assert.throws(() => state.runtime.files.readIndexedFile(project.id, text.id, revision, hash, state.principal), error => error.code === 'file_stale');
    assert.equal((await request(`/projects/${project.id}/context/sources`, { ...source(3), file_ref_id: binary.id, expected_file_revision: 1, expected_file_hash: binary.content_sha256 })).body.error.code, 'file_not_previewable');
    fs.unlinkSync(path.join(directory, 'note.txt'));
    await state.runtime.files.indexWorkspace(workspace.id, project.id, state.principal);
    assert.throws(() => state.runtime.files.readIndexedFile(project.id, text.id, null, null, state.principal), error => error.code === 'file_stale' && error.details.status === 'stale');
    await state.runtime.identity.setAclEntry(project.id, { resource: 'files', action: 'read', effect: 'deny', principal_actor_id: state.principal.actorId, expected_revision: 0, idempotency_key: 'file-http-acl-deny' }, state.principal);
    assert.throws(() => state.runtime.files.readIndexedFile(project.id, binary.id, 1, binary.content_sha256, state.principal), error => error.code === 'permission_denied');
    assert.equal((await request(`/projects/${project.id}/files?workspace_id=${workspace.id}`)).status, 403);
  } finally { await closeServer(server); await close(state); }
});

test('Files excludes symlinks, junctions, special paths and enforces actual file and workspace quotas', async t => {
  const state = await open();
  try {
    const project = await createProject(state, 'file-limits');
    const { workspace, directory } = await createWorkspace(state, project, 'file-limits');
    const outside = path.join(state.root, 'outside');
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'private.txt'), 'outside bytes');
    fs.symlinkSync(outside, path.join(directory, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(directory, 'special.txt'), 'never opened');
    const originalStat = fs.lstatSync;
    const mocked = t.mock.method(fs, 'lstatSync', (file, ...args) => {
      const stat = originalStat(file, ...args);
      if (String(file) === path.join(directory, 'special.txt')) return new Proxy(stat, { get(target, property) { return property === 'isSocket' ? () => true : typeof target[property] === 'function' ? target[property].bind(target) : target[property]; } });
      return stat;
    });
    fs.writeFileSync(path.join(directory, 'limit.txt'), Buffer.alloc(1024 * 1024, 65));
    fs.writeFileSync(path.join(directory, 'oversize.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
    const first = await state.runtime.files.listFiles(project.id, { workspace_id: workspace.id }, state.principal);
    assert.deepEqual(first.files.map(file => file.path), ['limit.txt']);
    mocked.mock.restore();
    fs.unlinkSync(path.join(directory, 'special.txt'));
    for (let index = 0; index < 101; index += 1) fs.writeFileSync(path.join(directory, `quota-${String(index).padStart(3, '0')}.txt`), Buffer.alloc(1024 * 1024, 65));
    await state.runtime.files.indexWorkspace(workspace.id, project.id, state.principal);
    const quota = state.runtime.db.get("SELECT count(*) AS n,sum(byte_length) AS bytes FROM file_refs WHERE workspace_id=? AND status='current'", [workspace.id]);
    assert.equal(quota.bytes, 100 * 1024 * 1024);
    assert.equal(quota.n, 100);
    const manyProject = await createProject(state, 'file-count');
    const many = await createWorkspace(state, manyProject, 'file-count');
    for (let index = 0; index < 10001; index += 1) fs.writeFileSync(path.join(many.directory, `${String(index).padStart(5, '0')}.txt`), '');
    const page = await state.runtime.files.listFiles(manyProject.id, { workspace_id: many.workspace.id, limit: 500 }, state.principal);
    assert.equal(page.total, 10000); assert.equal(page.files.length, 500); assert.equal(page.next_cursor, 500);
    const last = await state.runtime.files.listFiles(manyProject.id, { workspace_id: many.workspace.id, limit: 500, offset: 9500 }, state.principal);
    assert.equal(last.files.length, 500); assert.equal(last.next_cursor, null);
  } finally { await close(state); }
});

async function referenceFixture(state, suffix) {
  const project = await createProject(state, suffix);
  const { workspace, directory } = await createWorkspace(state, project, suffix);
  const { pack, profile } = await createAssistPrerequisites(state, project, suffix);
  const brief = await state.runtime.project.createBrief(project.id, { objective: 'Reference fixture', acceptance: ['checked'], expected_revision: project.revision, idempotency_key: `${suffix}-brief-key` }, state.principal);
  const workflow = await state.runtime.project.reviseWorkflow(project.id, { graph: { nodes: [{ id: 'stream', kind: 'workstream', title: 'Stream' }, { id: 'task', kind: 'task', parent_id: 'stream', title: 'Task', contract: { acceptance: ['done'] } }] }, expected_revision: 1, idempotency_key: `${suffix}-workflow-key` }, state.principal);
  const attachment = await state.runtime.files.createAttachment({ project_id: project.id, filename: 'note.txt', content_base64: Buffer.from('attached').toString('base64'), idempotency_key: `${suffix}-attachment-key` }, state.principal);
  fs.writeFileSync(path.join(directory, 'file.txt'), 'indexed');
  const file = (await state.runtime.files.listFiles(project.id, { workspace_id: workspace.id }, state.principal)).files[0];
  const session = (await state.runtime.assist.createSession({ project_id: project.id, scope: 'project', scope_id: project.id, context_pack_id: pack.id, profile_id: profile.id, repository_workspace_id: workspace.id, idempotency_key: `${suffix}-session-key` }, state.principal)).session;
  const connection = state.runtime.project.listRepositoryConnections(project.id, state.principal)[0];
  const operation = state.runtime.operations.get(attachment.operation.operation_id, { actorId: state.principal.actorId });
  const operationSummary = Object.fromEntries(['operation_id', 'command_id', 'status', 'revision', 'resource_type', 'resource_id', 'project_id', 'terminal', 'retryable', 'poll_uri', 'events_uri'].map(key => [key, operation[key]]));
  operationSummary.terminal = true;
  const references = [
    ['brief', brief.brief.id, 1, brief.revision_record.content_sha256],
    ['workflow', workflow.workflow.id, 1, workflow.workflow.current.graph_sha256],
    ['repository', connection.id, connection.revision, connection.source_hash],
    ['context_pack', pack.id, pack.revision, pack.pack_hash],
    ['attachment', attachment.attachment.id, 1, attachment.attachment.content_sha256],
    ['file', file.id, 1, file.content_sha256],
    ['operation', operation.operation_id, operation.revision, sha256Hex(canonicalJson(operationSummary))]
  ];
  return { project, workspace, pack, profile, workflow, session, references };
}

test('Assist API accepts exactly scoped resources and rejects missing, foreign and stale bindings for all seven types', async () => {
  const state = await openP10();
  const { server, base } = await listen(state.runtime);
  try {
    const own = await referenceFixture(state, 'reference-own');
    const foreign = await referenceFixture(state, 'reference-other');
    const request = apiClient(base, state.proof);
    const route = `/assist/sessions/${own.session.id}/references`;
    for (const [index, [type, id, revision, hash]] of own.references.entries()) {
      assert.match(hash, /^[a-f0-9]{64}$/);
      const input = { reference_type: type, reference_id: id, reference_revision: revision, reference_hash: hash };
      const sessionRevision = state.runtime.db.get('SELECT revision FROM assist_sessions WHERE id=?', [own.session.id]).revision;
      for (const [override, code] of [[{ reference_id: 'missing' }, 'scope_denied'], [{ reference_id: foreign.references[index][1] }, 'scope_denied'], [{ reference_revision: revision + 1 }, 'reference_stale'], [{ reference_hash: 'f'.repeat(64) }, 'reference_stale']]) {
        const result = await request(route, { ...input, ...override }, sessionRevision);
        assert.equal(result.body.error?.code, code, `${type}:${JSON.stringify(result.body)}`);
      }
      const result = await request(route, input, sessionRevision);
      assert.equal(result.status, 201, `${type}:${JSON.stringify(result.body)}`);
      assert.ok(result.body.data.references.some(item => item.reference_id === id && item.reference_revision === revision && item.reference_hash === hash));
    }
    const queued = await state.runtime.assist.createTurn({ session_id: own.session.id, expected_revision: state.runtime.db.get('SELECT revision FROM assist_sessions WHERE id=?', [own.session.id]).revision, message: 'pending', defer: true, idempotency_key: 'references-queued-turn' }, state.principal);
    assert.equal((await request(route, { reference_type: 'operation', reference_id: queued.operation_id }, state.runtime.db.get('SELECT revision FROM assist_sessions WHERE id=?', [own.session.id]).revision)).body.error.code, 'scope_denied');
    for (const [scope, scopeId] of [['project', own.project.id], ['workflow', own.workflow.workflow.id], ['workstream', 'stream'], ['task', 'task']]) {
      const input = { project_id: own.project.id, scope, scope_id: scopeId, context_pack_id: own.pack.id, profile_id: own.profile.id };
      assert.equal((await request('/assist/sessions', input)).status, 201);
      assert.equal((await request('/assist/sessions', { ...input, scope_id: foreign.project.id })).body.error.code, 'scope_denied');
      assert.equal((await request('/assist/sessions', { ...input, scope_id: 'missing' })).body.error.code, 'scope_denied');
    }
    for (const [scope, scopeId] of [['task', 'stream'], ['workstream', 'task']]) assert.equal((await request('/assist/sessions', { project_id: own.project.id, scope, scope_id: scopeId, context_pack_id: own.pack.id, profile_id: own.profile.id })).body.error.code, 'scope_denied');
  } finally { await closeServer(server); await close(state); }
});

function apiClient(base, proof) {
  let sequence = 0;
  return async (route, body, revision = 0) => {
    const response = await fetch(`${base}/api/v2${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: `aiws_session=${proof}`, 'content-type': 'application/json', 'Idempotency-Key': `boundary-request-${++sequence}`, 'X-Expected-Revision': String(revision) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
}

test('P4 file-backed Context fails explicitly when the Files owner is absent', async () => {
  const state = await open({ targetVersion: 4 });
  try {
    const project = await createProject(state, 'p4-file-owner');
    assert.equal(state.runtime.files, null);
    await assert.rejects(() => state.runtime.context.createSource(project.id, { source_type: 'file', file_ref_id: 'not-an-implicit-path', idempotency_key: 'p4-no-files-owner' }, state.principal), error => error.code === 'files_owner_unavailable');
  } finally { await close(state); }
});

test('Assist interactions bind project, turn, operation and session then recheck lifecycle for decisions, reviews, forks and resume', async () => {
  const state = await openP10();
  const { server, base } = await listen(state.runtime);
  try {
    const own = await referenceFixture(state, 'links-own');
    const other = await referenceFixture(state, 'links-other');
    const makeTurn = async fixture => {
      const op = await state.runtime.assist.createTurn({ session_id: fixture.session.id, expected_revision: fixture.session.revision, message: 'Review context', defer: true, idempotency_key: `links-turn-${fixture.project.id}` }, state.principal);
      const turn = state.runtime.db.get('SELECT * FROM assist_turns WHERE operation_id=?', [op.operation_id]);
      await state.runtime.assist.executeTurn(turn.id, state.principal);
      return state.runtime.db.get('SELECT * FROM assist_turns WHERE id=?', [turn.id]);
    };
    const turn = await makeTurn(own), foreignTurn = await makeTurn(other);
    const request = apiClient(base, state.proof);
    const shape = { workspace_id: own.workspace.id, runtime: process.platform === 'win32' ? 'windows_native' : 'linux_native', cwd: '', cols: 120, rows: 32, assist_session_id: own.session.id };
    const pending = [];
    for (const kind of ['approval', 'input']) {
      const route = kind === 'approval' ? '/approvals' : '/user-inputs';
      const input = { project_id: own.project.id, assist_turn_id: turn.id, ...(kind === 'approval' ? { action: 'terminal.open', request: shape } : { prompt_summary: 'Choose next step', input_schema: { type: 'string' } }) };
      for (const overrides of [{ project_id: other.project.id }, { assist_turn_id: foreignTurn.id }, { assist_turn_id: 'missing' }, { operation_id: foreignTurn.operation_id }, { operation_id: own.references[6][1] }]) {
        assert.equal((await request(route, { ...input, ...overrides })).body.error.code, 'scope_denied');
      }
      if (kind === 'approval') for (const override of [{ assist_session_id: other.session.id }, { workspace_id: other.workspace.id }, { assist_session_id: null }]) assert.equal((await request(route, { ...input, request: { ...shape, ...override } })).body.error.code, 'scope_denied');
      const created = await request(route, input);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const row = created.body.data[kind];
      assert.equal(row.assist_turn_id, turn.id);
      assert.equal(row.operation_id, turn.operation_id);
      const decided = await request(`${route}/${row.id}/${kind === 'approval' ? 'decide' : 'answer'}`, kind === 'approval' ? { decision: 'approved' } : { response: { value: 'continue' } }, row.revision);
      assert.equal(decided.status, 200, JSON.stringify(decided.body));
      const next = await request(route, input);
      assert.equal(next.status, 201);
      pending.push({ kind, route, row: next.body.data[kind], input });
    }
    const revision = () => state.runtime.db.get('SELECT revision FROM assist_sessions WHERE id=?', [own.session.id]).revision;
    const archive = await state.runtime.p10Service.archiveAssistSession(own.session.id, { expected_revision: revision(), idempotency_key: 'links-archive' }, state.principal);
    for (const { kind, route, row, input } of pending) {
      const result = await request(`${route}/${row.id}/${kind === 'approval' ? 'decide' : 'answer'}`, kind === 'approval' ? { decision: 'approved' } : { response: { value: 'continue' } }, row.revision);
      assert.equal(result.body.error.code, 'assist_session_inactive');
      assert.equal(result.body.error.details.lifecycle_status, 'archived');
      assert.equal((await request(route, input)).body.error.code, 'assist_session_inactive');
      assert.throws(() => state.runtime.assist.resumeForInteraction(kind, row.id, state.principal), error => error.code === 'assist_session_inactive');
    }
    const deleted = await state.runtime.p10Service.deleteAssistSession(own.session.id, { expected_revision: archive.session.revision, idempotency_key: 'links-delete' }, state.principal);
    for (const [route, body, expected] of [
      [`/assist/sessions/${own.session.id}/fork`, { title: 'invalid fork' }, deleted.session.revision],
      [`/assist/sessions/${own.session.id}/references`, { reference_type: 'brief', reference_id: own.references[0][1] }, deleted.session.revision],
      [`/assist/turns/${turn.id}/review-comments`, { content: 'invalid review' }, turn.revision]
    ]) {
      const result = await request(route, body, expected);
      assert.equal(result.body.error.code, 'assist_session_inactive');
      assert.equal(result.body.error.details.lifecycle_status, 'deleted');
    }
    assert.equal((await request(`/assist/turns/${turn.id}/review-comments`)).body.error.code, 'assist_session_inactive');
    await assert.rejects(() => state.runtime.assist.executeTurn(turn.id, state.principal, { resume: true }), error => error.code === 'assist_session_inactive');
    assert.equal(state.runtime.assist.listSessions({ project_id: own.project.id }, state.principal).sessions.length, 0);
    await state.runtime.p10Service.restoreDeletedAssistSession(own.session.id, { expected_revision: deleted.session.revision, idempotency_key: 'links-restore' }, state.principal);
    assert.equal(state.runtime.assist.getSession(own.session.id, state.principal).deleted_at, null);
    assert.equal(state.runtime.db.integrity().semantic.valid, true);
  } finally { await closeServer(server); await close(state); }
});
