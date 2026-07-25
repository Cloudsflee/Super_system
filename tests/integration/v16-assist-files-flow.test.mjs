import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { api, cleanup, createConfirmedProject, makeFixture, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v16-assist-files-');
const source = path.join(fixture.root, 'source');
fs.mkdirSync(source);
git(source, ['init']);
git(source, ['config', 'user.name', 'V1.6 Files']);
git(source, ['config', 'user.email', 'v16@example.test']);
fs.writeFileSync(path.join(source, 'README.md'), '# V1.6 upload fixture\n');
git(source, ['add', '.']);
git(source, ['commit', '-m', 'baseline']);
const fakeCodex = path.resolve('tests/fixtures/fake-codex-app-server-v15.mjs');
const serverEnv = { AIWS_CODEX_BIN: fakeCodex, AIWS_CODEX_VERSION: '0.144.0' };
const stateFile = path.join(fixture.home, 'data', 'state.json');
const port = Number(process.env.AIWS_TEST_PORT || 4616),
  baseUrl = `http://127.0.0.1:${port}`;
let server;

try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch, env: serverEnv });
  const project = await createConfirmedProject({
    baseUrl,
    title: 'V1.6 files',
    goal: 'Verify native references',
    source
  });
  const sessionId = project.draft.assist_session.id;
  await api(port, '/codex/auth/device/start', 'POST', { adapter: 'test' });
  const profile = await api(
    port,
    '/codex/profiles',
    'POST',
    { name: 'V1.6 fixture', provider: 'openai', model: 'gpt-v15-native', reasoning: 'high', mounts: [] },
    201
  );
  updateState((state) => {
    for (const item of state.codex_profiles) item.is_active = item.id === profile.id;
    Object.assign(
      state.codex_profiles.find((item) => item.id === profile.id),
      { kind: 'host', timeout_ms: 20_000, model_catalog: null, model_catalog_required: true }
    );
    state.integration_statuses = state.integration_statuses.filter((item) => item.key !== 'codex_capabilities');
  });
  const configuration = await api(
    port,
    '/assist/v3/configurations',
    'POST',
    { base_profile_id: profile.id, name: 'V1.6 native', model: 'gpt-v15-native', reasoning: 'high' },
    201
  );
  const seed = await api(
    port,
    `/assist/v3/sessions/${sessionId}/turns`,
    'POST',
    { content: 'V16_NATIVE_SEED', collaboration_mode: 'default', configuration_id: configuration.id },
    202
  );
  const seedDone = await waitForTurn(seed.id, (item) => item.status === 'completed');
  assert.match(seedDone.codex_turn_id, /^fake-turn-/);
  assert.equal(seedDone.codex_thread_id, 'fake-native-thread-v15');

  const textBytes = Buffer.from('hello v16 upload\n', 'utf8');
  const textAttachment = await upload(sessionId, textBytes, '../notes.md', 'text/plain');
  assert.equal(textAttachment.original_filename, 'notes.md');
  assert.equal(textAttachment.sha256, crypto.createHash('sha256').update(textBytes).digest('hex'));
  assert.equal(textAttachment.detected_mime_type, 'text/markdown');
  assert.equal(textAttachment.preview_kind, 'markdown');
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]);
  const imageAttachment = await upload(sessionId, pngBytes, 'pixel.png', 'text/plain');
  assert.equal(imageAttachment.detected_mime_type, 'image/png');
  assert.equal(imageAttachment.preview_kind, 'image');
  const fakeOffice = new FormData();
  fakeOffice.append('file', new Blob([Buffer.from('PK\u0003\u0004not-an-office-archive')]), 'spoof.docx');
  const fakeOfficeResponse = await fetch(`${baseUrl}/assist/v3/sessions/${sessionId}/attachments/upload`, {
    method: 'POST',
    body: fakeOffice
  });
  const fakeOfficeError = await fakeOfficeResponse.json();
  assert.equal(fakeOfficeResponse.status, 422);
  assert.equal(fakeOfficeError.error, 'attachment_office_archive_invalid');
  const oversizedForm = new FormData();
  oversizedForm.append('file', new Blob([Buffer.alloc(25 * 1024 * 1024 + 1)]), 'oversized.bin');
  const oversizedResponse = await fetch(`${baseUrl}/assist/v3/sessions/${sessionId}/attachments/upload`, {
    method: 'POST',
    body: oversizedForm
  });
  const oversizedError = await oversizedResponse.json();
  assert.equal(oversizedResponse.status, 413);
  assert.equal(oversizedError.error, 'attachment_too_large');
  assert.deepEqual(fs.readdirSync(path.join(fixture.home, 'attachment-staging')), []);

  const full = await fetch(`${baseUrl}/assist/v3/attachments/${textAttachment.id}/content`);
  assert.equal(full.status, 200);
  assert.equal(await full.text(), textBytes.toString());
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  assert.match(full.headers.get('content-security-policy'), /sandbox/);
  assert.equal(full.headers.get('access-control-allow-origin'), null);
  const range = await fetch(`${baseUrl}/assist/v3/attachments/${textAttachment.id}/content`, {
    headers: { range: 'bytes=2-6' }
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 2-6/${textBytes.length}`);
  assert.equal(await range.text(), textBytes.subarray(2, 7).toString());
  const suffix = await fetch(`${baseUrl}/assist/v3/attachments/${textAttachment.id}/content`, {
    headers: { range: 'bytes=-4' }
  });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), textBytes.subarray(-4).toString());
  const invalidRange = await fetchJson(
    `/assist/v3/attachments/${textAttachment.id}/content`,
    { headers: { range: 'bytes=999-' } },
    416
  );
  assert.equal(invalidRange.data.error, 'attachment_range_not_satisfiable');
  const download = await fetch(`${baseUrl}/assist/v3/attachments/${textAttachment.id}/download`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  await download.arrayBuffer();

  const references = await api(port, `/assist/v3/sessions/${sessionId}/references?q=${encodeURIComponent('notes')}`);
  assert.equal(
    references.some((item) => item.reference_id === textAttachment.id && item.kind === 'uploaded_file'),
    true
  );
  const projectReferences = await api(port, `/assist/v3/sessions/${sessionId}/references?q=README`);
  assert.equal(
    projectReferences.some((item) => item.kind === 'project_file' && item.path === 'README.md'),
    true
  );

  const referenceTurn = await api(
    port,
    `/assist/v3/sessions/${sessionId}/turns`,
    'POST',
    {
      content: 'READ_ATTACHMENT_REFERENCE',
      collaboration_mode: 'default',
      configuration_id: configuration.id,
      attachment_ids: [textAttachment.id, imageAttachment.id]
    },
    202
  );
  const referenceDone = await waitForTurn(referenceTurn.id, (item) => item.status === 'completed');
  assert.match(referenceDone.codex_turn_id, /^fake-turn-/);
  const starts = protocolMessages()
    .filter((item) => item.direction === 'from_aiws' && item.message.method === 'turn/start')
    .map((item) => item.message.params);
  const attachmentStart = starts.find((item) =>
    item.input?.some((entry) => entry.text === 'READ_ATTACHMENT_REFERENCE')
  );
  assert.equal(
    attachmentStart.input.some((item) => item.type === 'mention' && item.name === 'notes.md'),
    true
  );
  assert.equal(
    attachmentStart.input.some((item) => item.type === 'localImage' && /pixel\.png|[a-f0-9]{64}$/.test(item.path)),
    true
  );

  await fetchJson(
    `/assist/v3/attachments/${textAttachment.id}`,
    { method: 'DELETE' },
    409,
    'attachment_delete_confirmation_required'
  );
  const tombstone = await fetchJson(
    `/assist/v3/attachments/${textAttachment.id}?confirm_referenced=true`,
    { method: 'DELETE' },
    200
  );
  assert.equal(tombstone.data.tombstone, true);
  assert.equal(tombstone.data.attachment.storage_status, 'deleted');
  await fetchJson(`/assist/v3/attachments/${textAttachment.id}/content`, {}, 410, 'attachment_content_deleted');
  const refsAfterDelete = await api(port, `/assist/v3/sessions/${sessionId}/references?q=notes`);
  assert.equal(refsAfterDelete.find((item) => item.reference_id === textAttachment.id)?.available, false);
  await fetchJson(`/assist/v3/attachments/${imageAttachment.id}?confirm_referenced=true`, { method: 'DELETE' }, 200);

  const forked = await api(
    port,
    `/assist/v3/sessions/${sessionId}/fork`,
    'POST',
    { title: 'Native branch', from_turn_id: referenceTurn.id },
    201
  );
  assert.equal(forked.forked_from_session_id, sessionId);
  assert.notEqual(forked.codex_thread_id, 'fake-native-thread-v15');
  const beforeFailedFork = readState().assist_sessions.length;
  updateState((state) => {
    state.assist_turns.find((item) => item.id === referenceTurn.id).codex_turn_id = 'fork-failure-turn';
  });
  await fetchJson(
    `/assist/v3/sessions/${sessionId}/fork`,
    { method: 'POST', body: { from_turn_id: referenceTurn.id } },
    502,
    'assist_native_fork_failed'
  );
  assert.equal(readState().assist_sessions.length, beforeFailedFork);
  updateState((state) => {
    state.assist_turns.find((item) => item.id === referenceTurn.id).codex_turn_id = referenceDone.codex_turn_id;
  });
  const child = await api(port, `/assist/v3/sessions/${forked.id}/fork`, 'POST', { title: 'Nested branch' }, 201);
  await fetchJson(`/assist/v3/sessions/${sessionId}`, { method: 'DELETE' }, 409, 'assist_root_session_not_deletable');
  const deleted = await fetchJson(`/assist/v3/sessions/${forked.id}`, { method: 'DELETE' }, 200);
  assert.deepEqual(new Set(deleted.data.deleted_session_ids), new Set([forked.id, child.id]));
  const restored = await api(port, `/assist/v3/sessions/${forked.id}/restore-deleted`, 'POST', {});
  assert.deepEqual(new Set(restored.restored_session_ids), new Set([forked.id, child.id]));

  const slow = await api(
    port,
    `/assist/v3/sessions/${sessionId}/turns`,
    'POST',
    { content: 'SLOW_TURN main thread', collaboration_mode: 'default', configuration_id: configuration.id },
    202
  );
  const createdBtw = await fetchJson(
    `/assist/v3/sessions/${sessionId}/btw`,
    {
      method: 'POST',
      headers: { 'x-aiws-browser-id': 'browser-v16-integration' },
      body: { selection: 'selected V1.6 text' }
    },
    201
  );
  const btwTurn = await fetchJson(
    `/assist/v3/btw/${createdBtw.data.id}/turns`,
    {
      method: 'POST',
      headers: { 'x-aiws-btw-token': createdBtw.data.access_token },
      body: { content: 'BTW_MEMORY_ONLY_QUESTION' }
    },
    202
  );
  assert.equal(btwTurn.data.status, 'running');
  const events = await readSseUntilCompleted(createdBtw.data.id, createdBtw.data.access_token);
  assert.match(events, /event: completed/);
  assert.match(events, /native turn completed/);
  assert.equal(
    (await waitForTurn(slow.id, (item) => item.status === 'completed')).output_text,
    'native slow turn completed'
  );
  assert.equal(fs.readFileSync(stateFile, 'utf8').includes('BTW_MEMORY_ONLY_QUESTION'), false);
  assert.match(await deleteBtwThroughSse(createdBtw.data.id, createdBtw.data.access_token), /event: closed/);

  const restartBtw = await fetchJson(
    `/assist/v3/sessions/${sessionId}/btw`,
    { method: 'POST', headers: { 'x-aiws-browser-id': 'browser-v16-restart' }, body: {} },
    201
  );
  await server.stop();
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch, env: serverEnv });
  await fetchJson(
    `/assist/v3/btw/${restartBtw.data.id}/turns`,
    {
      method: 'POST',
      headers: { 'x-aiws-btw-token': restartBtw.data.access_token },
      body: { content: 'after restart' }
    },
    404,
    'assist_btw_expired'
  );
  console.log('V1.6 Assist files and native Fork integration tests passed');
} finally {
  await server?.stop();
  if (process.env.AIWS_KEEP_V16_FIXTURE !== '1') cleanup(fixture.root);
  else console.error(`fixture:${fixture.root}`);
}

async function upload(sessionId, bytes, filename, type) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), filename);
  const response = await fetch(`${baseUrl}/assist/v3/sessions/${sessionId}/attachments/upload`, {
    method: 'POST',
    body: form
  });
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  return data;
}
async function fetchJson(route, options = {}, expected = 200, error) {
  const headers = new Headers(options.headers || {}),
    init = { ...options, headers };
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${route}`, init),
    data = await response.json();
  assert.equal(response.status, expected, `${options.method || 'GET'} ${route}: ${JSON.stringify(data)}`);
  if (error) assert.equal(data.error, error);
  return { response, data };
}
async function waitForTurn(id, predicate) {
  for (let count = 0; count < 400; count++) {
    const item = await api(port, `/assist/v3/turns/${id}`);
    if (predicate(item)) return item;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`turn_timeout:${id}`);
}
async function readSseUntilCompleted(id, token) {
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/assist/v3/btw/${id}/events?token=${encodeURIComponent(token)}`, {
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let text = '';
    while (!text.includes('event: completed')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += Buffer.from(chunk.value).toString('utf8');
    }
    await reader.cancel();
    return text;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
async function deleteBtwThroughSse(id, token) {
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/assist/v3/btw/${id}/events?token=${encodeURIComponent(token)}`, {
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await fetchJson(`/assist/v3/btw/${id}`, { method: 'DELETE', headers: { 'x-aiws-btw-token': token } }, 200);
    let text = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += Buffer.from(chunk.value).toString('utf8');
    }
    return text;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
function readState() {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}
function updateState(change) {
  const state = readState();
  change(state);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
function protocolMessages() {
  return fs
    .readFileSync(path.join(profileHome(), 'fake-protocol.jsonl'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
}
function profileHome() {
  return readState().codex_profiles.find((item) => item.name === 'V1.6 fixture').codex_home;
}
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
