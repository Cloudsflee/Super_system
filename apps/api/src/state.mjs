import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLocalOwner, defaultCodexProfiles, defaultTools, hashString, id, makeTrace, maskSecretsDeep, now } from '../../../packages/shared/index.mjs';
import { ARTIFACT_DIR, DATA_DIR, STATE_FILE, collections } from './config.mjs';

export async function ensureRuntime() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) return writeState(bootstrapState());
  const state = await readState();
  let changed = false;
  for (const key of collections) if (!Array.isArray(state[key])) { state[key] = []; changed = true; }
  if (!state.users.length) { const { user, session } = createLocalOwner(); state.users.push(user); state.sessions.push(session); changed = true; }
  if (!state.tools.length) { state.tools.push(...defaultTools(state.users[0].id)); changed = true; }
  if (!state.codex_profiles.length) { state.codex_profiles.push(...defaultCodexProfiles(state.users[0]?.id)); changed = true; }
  if (changed) await writeState(state);
}

export function emptyState() { return Object.fromEntries(collections.map((key) => [key, []])); }

function bootstrapState() {
  const state = emptyState();
  const { user, session } = createLocalOwner();
  state.users.push(user);
  state.sessions.push(session);
  state.tools.push(...defaultTools(user.id));
  state.codex_profiles.push(...defaultCodexProfiles(user.id));
  state.traces.push(makeTrace('human.reviewed', { summary: '首次启动：创建 Local Owner Account。' }, { type: 'system', id: user.id }));
  return state;
}

export async function readState() { return JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')); }

export async function writeState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(maskSecretsDeep(state), null, 2), 'utf8');
  await fsp.rename(tmp, STATE_FILE);
}

export async function mutate(fn) {
  const state = await readState();
  const result = await fn(state);
  await writeState(state);
  return result;
}

export function owner(state) { return state.users.find((u) => u.role === 'owner') || state.users[0]; }

export function addTrace(state, event, payload = {}, actorId = null) {
  const trace = makeTrace(event, payload, { type: actorId ? 'user' : 'system', id: actorId });
  state.traces.push(trace);
  return trace;
}

export async function saveArtifact(kind, name, content, meta = {}) {
  const dir = path.join(ARTIFACT_DIR, String(kind || 'artifact').replace(/[^\w-]/g, '_'));
  await fsp.mkdir(dir, { recursive: true });
  const fileName = `${Date.now()}_${String(name || 'artifact').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 80)}`;
  const full = path.join(dir, fileName);
  await fsp.writeFile(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  const bytes = await fsp.readFile(full);
  return {
    id: id('fil'), kind, absolute_path: full, relative_path: path.relative(path.dirname(DATA_DIR), full),
    sha256: hashString(bytes), size_bytes: bytes.length,
    content_type: fileName.endsWith('.json') ? 'application/json' : fileName.endsWith('.md') ? 'text/markdown' : 'text/plain',
    meta, created_at: now()
  };
}
