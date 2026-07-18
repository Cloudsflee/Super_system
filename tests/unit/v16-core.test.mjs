import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v16-core-'));
process.env.AIWS_HOME = path.join(root, 'home');
let btw;

try {
  const migration = await import('../../apps/api/src/state-migration-v15.mjs');
  const legacy = legacyState();
  const migrated = migration.migrateState14To15(legacy, { timestamp: '2026-07-14T00:00:00.000Z' });
  assert.equal(migrated.state.schema_version, 15);
  assert.equal(migrated.repaired_shared_forks, 1);
  const repaired = migrated.state.assist_sessions.find((item) => item.id === 'fork-shared');
  assert.equal(repaired.codex_thread_id, null);
  assert.equal(repaired.historical_shared_codex_thread_id, 'shared-thread');
  assert.equal(repaired.native_thread_repair_required, true);
  assert.equal(migrated.state.assist_turns[0].codex_turn_id, null);
  assert.deepEqual(pick(migrated.state.attachments[0], ['original_filename', 'detected_mime_type', 'preview_kind', 'storage_status']), {
    original_filename: 'legacy.md', detected_mime_type: 'text/markdown', preview_kind: 'markdown', storage_status: 'external'
  });
  assert.equal(migration.migrateState14To15(migrated.state).migrated, false);

  const runnerState = legacyState();
  runnerState.codex_profiles = [
    { id: 'official-runner', image: 'aiws-codex-runner:1.5.0-codex-0.144.0', base_url: 'https://official.example/v1', credential_ref: 'vault-official' },
    { id: 'official-config-runner', config: { image: 'aiws-codex-runner:1.0.0-codex-0.99.0' }, base_url: 'https://config.example/v1' },
    { id: 'custom-runner', image: 'registry.example/custom-codex:1.5.0', base_url: 'https://custom.example/v1', credential_ref: 'vault-custom' }
  ];
  runnerState.integration_statuses = [
    { key: 'codex_probe', profile_id: 'official-runner', status: 'ready', updated_at: 'old' },
    { key: 'codex_probe', profile_id: 'official-config-runner', status: 'ready', updated_at: 'old' },
    { key: 'codex_probe', profile_id: 'custom-runner', status: 'ready', updated_at: 'old' }
  ];
  const normalized = migration.migrateState14To15(runnerState, { timestamp: '2026-07-14T00:00:00.000Z' });
  assert.equal(normalized.state.codex_profiles[0].image, 'aiws-codex-runner:1.6.0-codex-0.144.0');
  assert.equal(normalized.state.codex_profiles[1].config.image, 'aiws-codex-runner:1.6.0-codex-0.144.0');
  assert.equal(normalized.state.codex_profiles[2].image, 'registry.example/custom-codex:1.5.0');
  assert.equal(normalized.state.codex_profiles[2].base_url, 'https://custom.example/v1');
  assert.equal(normalized.state.codex_profiles[2].credential_ref, 'vault-custom');
  assert.deepEqual(normalized.normalized_runner_profiles, ['official-config-runner', 'official-runner']);
  assert.equal(normalized.staled_runner_probes, 2);
  assert.deepEqual(normalized.state.integration_statuses.map((item) => item.status), ['stale', 'stale', 'ready']);
  assert.equal(migration.normalizeOfficialRunnerImages(normalized.state).changed, false, 'Runner normalization is idempotent');

  const migrationDir = path.join(root, 'migration'), stateFile = path.join(migrationDir, 'state.json');
  fs.mkdirSync(migrationDir, { recursive: true });
  const original = `${JSON.stringify(legacy, null, 2)}\n`; fs.writeFileSync(stateFile, original);
  await assert.rejects(() => migration.migrateStateFileToV15(stateFile, {
    backupDirectory: path.join(migrationDir, 'backups'), clock: () => new Date('2026-07-14T01:02:03.000Z'),
    afterReplace: () => { const error = new Error('rollback injection'); error.code = 'injected_v16_failure'; throw error; }
  }), /rollback injection/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), original);
  const manifest = JSON.parse(fs.readFileSync(path.join(migrationDir, 'backups', 'state-schema14-2026-07-14T01-02-03-000Z.manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'rolled_back'); assert.equal(manifest.error, 'injected_v16_failure');

  const office = await import('../../apps/api/src/office-archive.mjs'), officeDir = path.join(root, 'office'); fs.mkdirSync(officeDir);
  const validDocx = path.join(officeDir, 'valid.docx'); fs.writeFileSync(validDocx, zipFixture([{ name: '[Content_Types].xml', data: '<Types />' }, { name: 'word/document.xml', data: '<document />' }]));
  assert.equal((await office.inspectOfficeArchive(validDocx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).entries, 2);
  const bombDocx = path.join(officeDir, 'bomb.docx'); fs.writeFileSync(bombDocx, zipFixture([{ name: '[Content_Types].xml', data: 'x' }, { name: 'word/document.xml', data: 'x', uncompressedSize: 201 * 1024 * 1024 }]));
  await assert.rejects(() => office.inspectOfficeArchive(bombDocx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), (error) => error.payload?.error === 'attachment_office_archive_limit');
  const macroDocx = path.join(officeDir, 'macro.docx'); fs.writeFileSync(macroDocx, zipFixture([{ name: '[Content_Types].xml', data: 'x' }, { name: 'word/document.xml', data: 'x' }, { name: 'word/vbaProject.bin', data: 'macro' }]));
  await assert.rejects(() => office.inspectOfficeArchive(macroDocx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), (error) => error.payload?.error === 'attachment_office_active_content');

  const stateApi = await import('../../apps/api/src/state.mjs');
  await stateApi.ensureRuntime();
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true }); fs.writeFileSync(path.join(repo, 'README.md'), '# V1.6\n');
  await stateApi.mutate((state) => {
    state.projects = [{ id: 'project-v16', title: 'V1.6', status: 'active', managed_workspace_state: 'ready', repo_path: repo, settings: {} }];
    state.codex_profiles = [{ id: 'profile-v16', name: 'V1.6 profile', status: 'validated', is_active: true, assist_configuration: false, provider: 'openai', kind: 'host', model: 'gpt-v16', reasoning: 'high' }];
    state.assist_configurations = [];
    state.assist_sessions = [session('root-session', null, 'native-root')];
    state.assist_turns = [{ id: 'root-turn', session_id: 'root-session', project_id: 'project-v16', status: 'completed', codex_turn_id: 'native-turn-root', completed_at: '2026-07-14T00:00:00.000Z', updated_at: '2026-07-14T00:00:00.000Z' }];
    state.assist_change_batches = []; state.terminal_sessions = [];
  });

  const lifecycle = await import('../../apps/api/src/assist-session-lifecycle.mjs');
  const forkCalls = [];
  const forked = await lifecycle.forkV3Session('root-session', { title: 'Independent', from_turn_id: 'root-turn' }, { rpc: async (request) => {
    forkCalls.push(request); return { result: { thread: { id: 'native-fork-a' } } };
  } });
  assert.equal(forked.forked_from_session_id, 'root-session'); assert.equal(forked.codex_thread_id, 'native-fork-a');
  assert.deepEqual(forkCalls[0].params, { turnId: 'native-turn-root', ephemeral: false });
  const countBeforeFailure = (await stateApi.readState()).assist_sessions.length;
  await assert.rejects(() => lifecycle.forkV3Session('root-session', {}, { rpc: async () => { throw new Error('native unavailable'); } }), (error) => error.payload?.error === 'assist_native_fork_failed');
  assert.equal((await stateApi.readState()).assist_sessions.length, countBeforeFailure, 'failed native Fork creates no local branch');
  await assert.rejects(() => lifecycle.forkV3Session('root-session', {}, { rpc: async (request) => {
    if (request.method === 'thread/fork') { await stateApi.mutate((state) => { state.assist_sessions.find((item) => item.id === 'root-session').codex_thread_id = 'source-changed'; }); return { result: { thread: { id: 'orphan-native-thread' } } }; }
    throw new Error('orphan cleanup unavailable');
  } }), (error) => error.payload?.error === 'assist_native_fork_source_changed');
  assert.equal((await stateApi.readState()).traces.some((item) => item.event_type === 'assist.native_thread.orphaned' && item.data.native_thread_id === 'orphan-native-thread'), true);
  await stateApi.mutate((state) => { state.assist_sessions.find((item) => item.id === 'root-session').codex_thread_id = 'native-root'; });
  await assert.rejects(() => lifecycle.deleteV3Session('root-session'), (error) => error.payload?.error === 'assist_root_session_not_deletable');

  await stateApi.mutate((state) => { state.assist_sessions.push({ ...session('fork-child', forked.id, 'native-child'), parent_session_id: forked.id }); });
  const childDelete = await lifecycle.deleteV3Session('fork-child', { clock: () => new Date('2026-07-14T02:00:00.000Z') });
  const parentDelete = await lifecycle.deleteV3Session(forked.id, { clock: () => new Date('2026-07-14T03:00:00.000Z') });
  assert.notEqual(childDelete.delete_batch_id, parentDelete.delete_batch_id);
  const sessionService = await import('../../apps/api/src/assist-v3-sessions.mjs');
  await stateApi.mutate((state) => { state.assist_turns.find((item) => item.id === 'root-turn').status = 'waiting_user_input'; });
  await assert.rejects(() => sessionService.archiveV3Session('root-session'), (error) => error.payload?.error === 'assist_session_running');
  await stateApi.mutate((state) => { state.assist_turns.find((item) => item.id === 'root-turn').status = 'completed'; });
  await sessionService.archiveV3Session('root-session');
  assert.equal((await sessionService.getV3Session('root-session')).archived_at !== null, true, 'archived sessions remain readable');
  assert.equal((await sessionService.updateV3Session('root-session', { title: 'Archived root' })).title, 'Archived root');
  await sessionService.restoreV3Session('root-session');
  assert.equal((await sessionService.listV3Sessions({ project_id: 'project-v16' })).some((item) => item.id === forked.id), false, 'default session list excludes deleted branches');
  assert.equal((await sessionService.listV3Sessions({ project_id: 'project-v16', deleted: 'include' })).some((item) => item.id === forked.id), true, 'deleted branches require an explicit include query');
  assert.equal((await sessionService.listV3Sessions({ project_id: 'project-v16', deleted: 'only' })).every((item) => item.deleted_at), true);
  const parentRestore = await lifecycle.restoreDeletedV3Session(forked.id, { clock: () => new Date('2026-07-15T00:00:00.000Z') });
  assert.deepEqual(parentRestore.restored_session_ids, [forked.id]);
  assert.ok((await stateApi.readState()).assist_sessions.find((item) => item.id === 'fork-child').deleted_at, 'restore is limited to its deletion batch');
  assert.deepEqual((await lifecycle.restoreDeletedV3Session('fork-child', { clock: () => new Date('2026-07-15T00:00:00.000Z') })).restored_session_ids, ['fork-child']);

  const attachments = await import('../../apps/api/src/assist-attachments.mjs');
  const largeBytes = Buffer.alloc(2 * 1024 * 1024 + 1, 0xa5), largePath = path.join(repo, 'large.bin'); fs.writeFileSync(largePath, largeBytes);
  await stateApi.mutate((state) => { state.projects[0].lifecycle_operation = { id: 'plop-attachment', type: 'trash' }; });
  await assert.rejects(() => sessionService.createV3Attachment('root-session', { kind: 'project_file', path: 'large.bin' }), (error) => error.status === 423 && error.payload?.error === 'project_lifecycle_operation_in_progress');
  await stateApi.mutate((state) => { state.projects[0].lifecycle_operation = null; });
  const largeReference = await sessionService.createV3Attachment('root-session', { kind: 'project_file', path: 'large.bin' });
  assert.equal(largeReference.size_bytes, largeBytes.length); assert.equal(largeReference.sha256, cryptoHash(largeBytes));
  const outside = path.join(root, 'outside'), linked = path.join(repo, 'linked'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const escaped = { id: 'escaped', storage_status: 'external', relative_path: 'linked/secret.txt', size_bytes: 7, sha256: cryptoHash(Buffer.from('outside')) };
  await assert.rejects(() => attachments.verifyTurnAttachmentManifest({ attachment_ids: ['escaped'], attachment_manifest: [{ id: 'escaped', size_bytes: 7, sha256: escaped.sha256 }] }, [escaped], repo), (error) => error.payload?.error === 'attachment_path_invalid');
  assert.deepEqual(attachments.parseSingleRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(attachments.parseSingleRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(attachments.parseSingleRange('bytes=8-', 10), { start: 8, end: 9 });
  assert.throws(() => attachments.parseSingleRange('bytes=10-', 10), (error) => error.status === 416);
  assert.equal(attachments.sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), 'spoof.txt', 'text/plain'), 'image/png');
  assert.equal(attachments.sniffMime(Buffer.from('<svg><script>alert(1)</script></svg>'), 'active.svg', 'image/svg+xml'), 'image/svg+xml');
  assert.equal(attachments.previewKind('image/svg+xml', 'active.svg'), 'text');

  await stateApi.mutate((state) => {
    const purgeAt = new Date().toISOString();
    state.assist_turns.push({ id: 'purge-turn', session_id: forked.id, project_id: 'project-v16', status: 'completed', context_pack_id: 'purge-pack', worktree_id: 'purge-turn-worktree', created_at: purgeAt, updated_at: purgeAt });
    state.assist_messages.push({ id: 'purge-message', session_id: forked.id, turn_id: 'purge-turn' });
    state.assist_events.push({ id: 'purge-event', sequence: 1, session_id: forked.id, turn_id: 'purge-turn' });
    state.ui_action_intents.push({ id: 'purge-action', session_id: forked.id, turn_id: 'purge-turn' });
    state.assist_operations.push({ id: 'purge-operation', session_id: forked.id, turn_id: 'purge-turn' });
    state.runtime_user_inputs.push({ id: 'purge-input', session_id: forked.id, turn_id: 'purge-turn' });
    state.context_packs.push({ id: 'purge-pack', sufficiency_check_id: 'purge-check', content_file_ref_id: 'purge-context-ref' });
    state.context_sufficiency_checks.push({ id: 'purge-check', target_type: 'assist_turn', target_id: 'purge-turn' });
    state.worktrees.push({ id: 'purge-turn-worktree', project_id: 'project-v16' }, { id: 'purge-terminal-worktree', project_id: 'project-v16' });
    state.terminal_sessions.push({ id: 'purge-terminal', project_id: 'project-v16', assist_session_id: forked.id, turn_id: 'purge-turn', worktree_id: 'purge-terminal-worktree', artifact_file_ref_id: 'purge-terminal-ref', status: 'exited' });
    state.human_reviews.push({ id: 'purge-turn-review', target_type: 'assist_turn', target_id: 'purge-turn' }, { id: 'purge-terminal-review', target_type: 'terminal_session', target_id: 'purge-terminal' });
    state.file_refs.push({ id: 'purge-context-ref', meta: { context_pack_id: 'purge-pack' } }, { id: 'purge-terminal-ref', meta: { terminal_session_id: 'purge-terminal' } });
  });
  await lifecycle.deleteV3Session(forked.id, { clock: () => new Date('2026-07-16T00:00:00.000Z') });
  const purgeClock = () => new Date('2026-08-16T00:00:00.000Z');
  await stateApi.mutate((state) => { state.projects[0].deleted_at = '2026-08-01T00:00:00.000Z'; });
  assert.deepEqual(await lifecycle.purgeExpiredDeletedSessions({ clock: purgeClock, rpc: async () => ({}) }), [], 'session sweeper defers to a trashed project');
  assert.equal((await stateApi.readState()).assist_sessions.some((item) => item.id === forked.id), true);
  await stateApi.mutate((state) => { state.projects[0].deleted_at = null; });
  const failedPurge = await lifecycle.purgeExpiredDeletedSessions({ clock: purgeClock, rpc: async () => { throw new Error('native cleanup offline'); } });
  assert.equal(failedPurge[0].purged, false);
  const retryState = await stateApi.readState(), retrySession = retryState.assist_sessions.find((item) => item.id === forked.id);
  assert.equal(retrySession.purge_stage, 'retry_pending'); assert.equal(retrySession.purge_retry_at, '2026-08-16T00:05:00.000Z');
  assert.deepEqual(await lifecycle.purgeExpiredDeletedSessions({ clock: () => new Date('2026-08-16T00:04:59.000Z'), rpc: async () => ({}) }), []);
  const purged = await lifecycle.purgeExpiredDeletedSessions({ clock: () => new Date('2026-08-16T00:05:01.000Z'), rpc: async () => { throw new Error('thread not found'); } });
  const purgedState = await stateApi.readState();
  assert.equal(purged[0].purged, true); assert.equal(purgedState.assist_sessions.some((item) => item.id === forked.id || item.id === 'fork-child'), false);
  for (const [collection, recordIds] of Object.entries({ assist_turns: ['purge-turn'], assist_messages: ['purge-message'], assist_events: ['purge-event'], ui_action_intents: ['purge-action'], assist_operations: ['purge-operation'], runtime_user_inputs: ['purge-input'], context_packs: ['purge-pack'], context_sufficiency_checks: ['purge-check'], worktrees: ['purge-turn-worktree', 'purge-terminal-worktree'], terminal_sessions: ['purge-terminal'], human_reviews: ['purge-turn-review', 'purge-terminal-review'], file_refs: ['purge-context-ref', 'purge-terminal-ref'] })) {
    assert.equal(purgedState[collection].some((item) => recordIds.includes(item.id)), false, `${collection} retains deleted Assist resources`);
  }

  btw = await import('../../apps/api/src/assist-btw.mjs');
  const closed = [], conversations = [];
  const createConversation = async () => {
    const current = { busy: false, close: () => closed.push(true), sendTurn: async ({ prompt, onEvent }) => { onEvent({ aiws_type: 'text', data: { text: `reply:${prompt}` } }); return { output_text: `reply:${prompt}`, turn_id: 'btw-native-turn' }; } };
    conversations.push(current); return current;
  };
  const first = await btw.createAssistBtw('root-session', { browser_id: 'browser-one' }, {}, { createConversation });
  const replacement = await btw.createAssistBtw('root-session', { browser_id: 'browser-one' }, {}, { createConversation });
  assert.equal(btw.assistBtwStatus().active, 1); assert.equal(closed.length, 1);
  await assert.rejects(() => btw.createAssistBtwTurn(first.id, { content: 'stale', access_token: first.access_token }), (error) => error.payload?.error === 'assist_btw_expired');
  await btw.createAssistBtwTurn(replacement.id, { content: 'memory-only-prompt', access_token: replacement.access_token });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fs.readFileSync(path.join(process.env.AIWS_HOME, 'data', 'state.json'), 'utf8').includes('memory-only-prompt'), false);
  await btw.closeAllAssistBtw('test-reset');
  const active = [];
  for (let index = 0; index < btw.BTW_GLOBAL_LIMIT; index++) active.push(await btw.createAssistBtw('root-session', { browser_id: `browser-${index}` }, {}, { createConversation }));
  await assert.rejects(() => btw.createAssistBtw('root-session', { browser_id: 'browser-overflow' }, {}, { createConversation }), (error) => error.status === 429);
  assert.equal(await btw.sweepExpiredBtw({ clock: () => Date.now() + btw.BTW_TTL_MS }), btw.BTW_GLOBAL_LIMIT);
  assert.equal(btw.assistBtwStatus().active, 0);
  console.log('V1.6 core unit tests passed');
} finally {
  await btw?.closeAllAssistBtw('test-finished');
  fs.rmSync(root, { recursive: true, force: true });
}

function legacyState() {
  return {
    schema_version: 14,
    assist_sessions: [session('root-shared', null, 'shared-thread'), session('fork-shared', 'root-shared', 'shared-thread')],
    assist_turns: [{ id: 'legacy-turn', session_id: 'root-shared', status: 'completed' }],
    attachments: [{ id: 'legacy-attachment', session_id: 'root-shared', relative_path: 'legacy.md', content_type: 'text/markdown', status: 'ready' }]
  };
}
function session(id, parent, thread) {
  return {
    id, version: 3, project_id: 'project-v16', scope_type: 'project', scope_id: 'project-v16', parent_session_id: parent,
    forked_from_session_id: parent, title: id, status: 'idle', lifecycle: 'active', pinned: false, archived_at: null,
    codex_thread_id: thread, native_thread_generation: 2, native_thread_repair_required: false, runtime_profile_id: 'profile-v16',
    view_context: {}, created_at: '2026-07-14T00:00:00.000Z', updated_at: '2026-07-14T00:00:00.000Z'
  };
}
function pick(value, keys) { return Object.fromEntries(keys.map((key) => [key, value[key]])); }
function cryptoHash(value) { return createHash('sha256').update(value).digest('hex'); }
function zipFixture(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data), local = Buffer.alloc(30), central = Buffer.alloc(46), uncompressed = entry.uncompressedSize ?? data.length;
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(uncompressed, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(uncompressed, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    const localEntry = Buffer.concat([local, name, data]); locals.push(localEntry); centrals.push(Buffer.concat([central, name])); offset += localEntry.length;
  }
  const centralDirectory = Buffer.concat(centrals), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(centralDirectory.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}
