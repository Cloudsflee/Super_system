import crypto, { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { HttpError } from './http.mjs';
import { STAGING_DIR } from './config.mjs';
import { mutate, readState } from './state.mjs';
import { putSecret, readSecret, removeSecret } from './vault.mjs';
import { AIWS_VERSION, id, now } from '../../../packages/shared/index.mjs';
import {
  createHostBridgeWorkspaceBundle, HOST_BRIDGE_MAX_BUNDLE_BYTES, importHostBridgeWorkspaceBundle,
  validateHostBridgeBundle
} from './host-bridge-workspace.mjs';

export const HOST_BRIDGE_PROTOCOL_VERSION = 1;
export const HOST_BRIDGE_VERSION = AIWS_VERSION;
export { validateHostBridgeBundle };
const pairingCodes = new Map(), onlineDevices = new Map(), terminalChannels = new Map();
const PAIRING_TTL_MS = 10 * 60 * 1000, READY_TIMEOUT_MS = 60_000, CHUNK_BYTES = 512 * 1024;

export function createHostBridgePairing() {
  const code = [...randomBytes(12)].map((value) => String(value % 10)).join('');
  pairingCodes.set(hash(code), { expiresAt: Date.now() + PAIRING_TTL_MS, attempts: 0 });
  return { pairing_code: code, expires_at: new Date(Date.now() + PAIRING_TTL_MS).toISOString(), protocol_version: HOST_BRIDGE_PROTOCOL_VERSION };
}

export async function exchangeHostBridgePairing(input = {}) {
  const code = String(input.pairing_code || input.code || '').replace(/\s/g, ''), key = hash(code), pending = pairingCodes.get(key);
  if (!/^\d{12}$/.test(code) || !pending || pending.expiresAt < Date.now()) throw new HttpError(401, { error: 'host_bridge_pairing_invalid_or_expired' });
  pending.attempts += 1; if (pending.attempts > 5) { pairingCodes.delete(key); throw new HttpError(429, { error: 'host_bridge_pairing_attempts_exceeded' }); }
  if (Number(input.protocol_version) !== HOST_BRIDGE_PROTOCOL_VERSION) throw new HttpError(409, { error: 'host_bridge_protocol_incompatible', expected: HOST_BRIDGE_PROTOCOL_VERSION });
  pairingCodes.delete(key);
  const credential = randomBytes(32).toString('base64url'), vaultRef = await putSecret('host_bridge', credential), verifier = hash(credential), at = now();
  const device = await mutate((state) => {
    const item = { id: id('hbd'), name: safeName(input.device_name), status: 'offline', protocol_version: HOST_BRIDGE_PROTOCOL_VERSION, bridge_version: safeVersion(input.bridge_version), credential_verifier: verifier, vault_ref: vaultRef, capabilities: {}, last_seen_at: null, paired_at: at, revoked_at: null, created_at: at, updated_at: at };
    state.host_bridge_devices.push(item); return publicDevice(item);
  });
  return { device, credential, websocket_url: '/api/assist/v3/host-bridge/ws', protocol_version: HOST_BRIDGE_PROTOCOL_VERSION };
}

export async function listHostBridgeDevices() { const state = await readState(); return state.host_bridge_devices.map((item) => publicDevice(item)); }
export async function revokeHostBridgeDevice(deviceId) {
  const result = await mutate((state) => { const item = state.host_bridge_devices.find((entry) => entry.id === deviceId); if (!item) throw new HttpError(404, { error: 'host_bridge_device_not_found' }); Object.assign(item, { status: 'revoked', revoked_at: now(), updated_at: now() }); return { item: publicDevice(item), vault_ref: item.vault_ref }; });
  onlineDevices.get(deviceId)?.close(1008, 'device_revoked'); onlineDevices.delete(deviceId); await removeSecret(result.vault_ref); return result.item;
}

export async function hostBridgeCapability() {
  const state = await readState(), paired = state.host_bridge_devices.filter((item) => !item.revoked_at), online = paired.filter((item) => onlineDevices.get(item.id)?.readyState === 1);
  if (!paired.length) return unavailable('windows_bridge_not_paired');
  if (!online.length) return { ...unavailable('windows_bridge_offline'), paired_devices: paired.length };
  const protocol = online.filter((item) => item.protocol_version === HOST_BRIDGE_PROTOCOL_VERSION && item.bridge_version === HOST_BRIDGE_VERSION);
  if (!protocol.length) return unavailable('windows_bridge_version_incompatible');
  const codex = protocol.filter((item) => item.capabilities?.codex_available);
  if (!codex.length) return unavailable('windows_codex_unavailable');
  const compatibleCodex = codex.filter((item) => String(item.capabilities?.codex_version || '').includes('0.144.0'));
  if (!compatibleCodex.length) return unavailable('windows_codex_version_unsupported');
  const compatible = compatibleCodex.find((item) => item.capabilities?.conpty);
  if (!compatible) return unavailable('windows_conpty_unavailable');
  return { available: true, runtime: 'windows_bridge', reason: null, protocol_version: HOST_BRIDGE_PROTOCOL_VERSION, bridge_version: compatible.bridge_version, codex_version: compatible.capabilities.codex_version, device_id: compatible.id };
}

export async function openHostBridgeTerminal({ deviceId, sessionId, worktree, model, reasoning, cols, rows, onFrame }) {
  const ws = onlineDevices.get(deviceId); if (!ws || ws.readyState !== 1) throw new HttpError(409, { error: 'windows_bridge_offline' });
  if (terminalChannels.has(sessionId)) throw new HttpError(409, { error: 'windows_bridge_terminal_exists' });
  const bundle = await createHostBridgeWorkspaceBundle({ worktree, sessionId });
  let resolveReady, rejectReady, resolveDone;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const channel = { deviceId, sessionId, ws, worktree, onFrame, bundle, resolveReady, rejectReady, resolveDone, ready: false, imported: false, receiving: null };
  terminalChannels.set(sessionId, channel);
  try {
    await sendJson(ws, { type: 'workspace_begin', session_id: sessionId, transfer_id: bundle.transfer_id, bundle_ref: bundle.bundle_ref, base_commit: bundle.base_commit, head_commit: bundle.head_commit, total_bytes: bundle.size_bytes, sha256: bundle.sha256 });
    await sendFile(ws, bundle.bundle_path, bundle.transfer_id, sessionId);
    await sendJson(ws, { type: 'workspace_end', session_id: sessionId, transfer_id: bundle.transfer_id });
    await withTimeout(ready, READY_TIMEOUT_MS, 'windows_bridge_workspace_timeout');
    await sendJson(ws, { type: 'terminal_start', session_id: sessionId, command: 'codex.exe', args: ['--model', model, '-c', `model_reasoning_effort=${JSON.stringify(reasoning || 'high')}`], cols, rows });
  } catch (error) { await closeChannel(channel, error); throw error; }
  finally { await bundle.cleanup().catch(() => undefined); }
  return {
    done,
    input: (data) => sendJson(ws, { type: 'terminal_input', session_id: sessionId, data: String(data).slice(0, 65536) }),
    resize: (nextCols, nextRows) => sendJson(ws, { type: 'terminal_resize', session_id: sessionId, cols: nextCols, rows: nextRows }),
    stop: () => sendJson(ws, { type: 'terminal_stop', session_id: sessionId })
  };
}

export function attachHostBridgeWebSocket(server) {
  const sockets = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const parsed = new URL(request.url || '/', 'http://127.0.0.1');
    if (parsed.pathname.replace(/^\/api/, '') !== '/assist/v3/host-bridge/ws') return;
    authenticateBridge(request, parsed).then((device) => sockets.handleUpgrade(request, socket, head, (ws) => connectDevice(ws, device))).catch((error) => rejectUpgrade(socket, error));
  });
  server.on('close', () => { for (const ws of onlineDevices.values()) ws.close(1012, 'server_shutdown'); onlineDevices.clear(); });
  return sockets;
}

async function authenticateBridge(request, parsed) {
  if (!isHostBridgeLocalRequest({ remoteAddress: request.socket.remoteAddress, host: request.headers.host }, { containerized: process.env.AIWS_CONTAINERIZED === '1' })) throw new HttpError(403, { error: 'host_bridge_loopback_required' });
  const deviceId = parsed.searchParams.get('device_id') || '', authorization = String(request.headers.authorization || ''), credential = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const state = await readState(), device = state.host_bridge_devices.find((item) => item.id === deviceId && !item.revoked_at);
  if (!device || !credential || !safeEqual(hash(credential), device.credential_verifier) || !safeEqual(await readSecret(device.vault_ref), credential)) throw new HttpError(401, { error: 'host_bridge_auth_failed' });
  return device;
}

function connectDevice(ws, device) {
  let hello = false, heartbeat = setTimeout(() => ws.close(1008, 'hello_timeout'), 10_000), chain = Promise.resolve();
  ws.on('message', (raw) => { chain = chain.then(async () => {
    let message; try { message = JSON.parse(String(raw)); } catch { throw new Error('invalid_json'); }
    if (!hello) {
      if (message.type !== 'hello' || Number(message.protocol_version) !== HOST_BRIDGE_PROTOCOL_VERSION) throw new Error('protocol_incompatible');
      hello = true; clearTimeout(heartbeat);
      if (!await recordDeviceHello(device.id, message.capabilities || {}, message.bridge_version)) throw new Error('device_revoked');
      const previous = onlineDevices.get(device.id); onlineDevices.set(device.id, ws); if (previous && previous !== ws) previous.close(1012, 'replaced');
      return sendJson(ws, { type: 'hello_ack', protocol_version: HOST_BRIDGE_PROTOCOL_VERSION, app_version: HOST_BRIDGE_VERSION });
    }
    if (message.type === 'heartbeat') { await touchDevice(device.id); return sendJson(ws, { type: 'heartbeat_ack', at: now() }); }
    await handleTerminalFrame(device.id, message);
  }).catch((error) => ws.close(1008, safeProtocolError(error))); });
  ws.on('close', () => { clearTimeout(heartbeat); const wasActive = onlineDevices.get(device.id) === ws; if (wasActive) onlineDevices.delete(device.id); for (const channel of terminalChannels.values()) if (channel.deviceId === device.id && channel.ws === ws) void closeChannel(channel, new Error('windows_bridge_disconnected')); if (wasActive) void markDeviceOffline(device.id); });
}

async function handleTerminalFrame(deviceId, message) {
  const channel = terminalChannels.get(String(message.session_id || ''));
  if (!channel || channel.deviceId !== deviceId) throw new Error('terminal_session_unknown');
  if (message.type === 'workspace_ready') {
    if (message.head_commit !== channel.bundle.head_commit) throw new Error('workspace_head_mismatch');
    channel.ready = true; channel.resolveReady(message); return;
  }
  if (message.type === 'workspace_return_begin') return beginReturn(channel, message);
  if (message.type === 'workspace_return_chunk') return appendReturn(channel, message);
  if (message.type === 'workspace_return_end') return finishReturn(channel, message);
  if (message.type === 'terminal_started' || message.type === 'terminal_output') return channel.onFrame?.(message);
  if (message.type === 'terminal_exit') {
    if (!channel.imported) message = { ...message, error: message.error || 'windows_bridge_workspace_return_missing', exit_code: message.exit_code || 1 };
    await channel.onFrame?.(message); channel.resolveDone(message); terminalChannels.delete(channel.sessionId); return;
  }
  if (message.type === 'error') return channel.onFrame?.(message);
  throw new Error('bridge_frame_unsupported');
}

async function beginReturn(channel, message) {
  if (channel.receiving || message.base_commit !== channel.bundle.head_commit) throw new Error('workspace_return_base_mismatch');
  const total = Number(message.total_bytes); if (!Number.isSafeInteger(total) || total <= 0 || total > HOST_BRIDGE_MAX_BUNDLE_BYTES) throw new Error('workspace_return_size_invalid');
  const transferId = safeToken(message.transfer_id), file = path.join(STAGING_DIR, `${transferId}.return.bundle`), handle = await fsp.open(file, 'wx', 0o600);
  channel.receiving = { transferId, file, handle, expectedBytes: total, expectedHash: String(message.sha256 || ''), expectedHead: String(message.head_commit || ''), bytes: 0, sequence: 0, hash: crypto.createHash('sha256') };
}
async function appendReturn(channel, message) {
  const item = channel.receiving; if (!item || safeToken(message.transfer_id) !== item.transferId || Number(message.sequence) !== item.sequence) throw new Error('workspace_return_sequence_invalid');
  const encoded = String(message.chunk || ''); if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('workspace_return_chunk_invalid');
  const bytes = Buffer.from(encoded, 'base64'); if (!bytes.length || bytes.length > CHUNK_BYTES || item.bytes + bytes.length > item.expectedBytes) throw new Error('workspace_return_chunk_invalid');
  await item.handle.write(bytes); item.hash.update(bytes); item.bytes += bytes.length; item.sequence++;
}
async function finishReturn(channel, message) {
  const item = channel.receiving; if (!item || safeToken(message.transfer_id) !== item.transferId) throw new Error('workspace_return_transfer_invalid');
  channel.receiving = null; await item.handle.sync(); await item.handle.close();
  try {
    if (item.bytes !== item.expectedBytes || item.hash.digest('hex') !== item.expectedHash) throw new Error('workspace_return_checksum_invalid');
    const imported = await importHostBridgeWorkspaceBundle({ bundlePath: item.file, worktree: channel.worktree, expectedBase: channel.bundle.head_commit, expectedHead: item.expectedHead });
    channel.imported = true; await channel.onFrame?.({ type: 'workspace_imported', session_id: channel.sessionId, ...imported });
    await sendJson(channel.ws, { type: 'workspace_return_ack', session_id: channel.sessionId, transfer_id: item.transferId, head_commit: imported.head_commit });
  } finally { await fsp.rm(item.file, { force: true }); }
}

async function closeChannel(channel, error) {
  if (!terminalChannels.has(channel.sessionId)) return;
  terminalChannels.delete(channel.sessionId); channel.rejectReady(error); channel.resolveDone({ error: safeProtocolError(error) });
  if (channel.receiving) { await channel.receiving.handle.close().catch(() => undefined); await fsp.rm(channel.receiving.file, { force: true }).catch(() => undefined); }
  await channel.onFrame?.({ type: 'error', session_id: channel.sessionId, error: safeProtocolError(error) });
}
async function sendFile(ws, file, transferId, sessionId) { const handle = await fsp.open(file, 'r'); try { let sequence = 0, position = 0; while (true) { const buffer = Buffer.allocUnsafe(CHUNK_BYTES), { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break; position += bytesRead; await sendJson(ws, { type: 'workspace_chunk', session_id: sessionId, transfer_id: transferId, sequence: sequence++, chunk: buffer.subarray(0, bytesRead).toString('base64') }); } } finally { await handle.close(); } }
function sendJson(ws, value) { return new Promise((resolve, reject) => { if (ws.readyState !== 1) return reject(new Error('windows_bridge_offline')); ws.send(JSON.stringify(value), (error) => error ? reject(error) : resolve()); }); }
function withTimeout(promise, ms, code) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(code)), ms); promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); }); }); }
async function recordDeviceHello(deviceId, capabilities, bridgeVersion) { return mutate((state) => { const item = state.host_bridge_devices.find((entry) => entry.id === deviceId && !entry.revoked_at); if (!item) return false; Object.assign(item, { status: 'online', bridge_version: safeVersion(bridgeVersion || item.bridge_version), capabilities: sanitizeCapabilities(capabilities), last_seen_at: now(), updated_at: now() }); return true; }); }
async function touchDevice(deviceId) { await mutate((state) => { const item = state.host_bridge_devices.find((entry) => entry.id === deviceId && !entry.revoked_at); if (item) Object.assign(item, { status: 'online', last_seen_at: now(), updated_at: now() }); }); }
async function markDeviceOffline(deviceId) { await mutate((state) => { const item = state.host_bridge_devices.find((entry) => entry.id === deviceId); if (item && !item.revoked_at) Object.assign(item, { status: 'offline', updated_at: now() }); }); }
function unavailable(reason) { return { available: false, runtime: 'windows_bridge', reason, protocol_version: HOST_BRIDGE_PROTOCOL_VERSION }; }
function sanitizeCapabilities(value) { return { os: String(value.os || 'windows').slice(0, 40), arch: String(value.arch || '').slice(0, 40), conpty: value.conpty === true, codex_available: value.codex_available === true, codex_version: String(value.codex_version || '').slice(0, 100), code_page: String(value.code_page || '').slice(0, 40) }; }
function publicDevice(item) { return { id: item.id, name: item.name, status: item.revoked_at ? 'revoked' : onlineDevices.get(item.id)?.readyState === 1 ? 'online' : 'offline', protocol_version: item.protocol_version, bridge_version: item.bridge_version || null, capabilities: item.capabilities || {}, last_seen_at: item.last_seen_at, paired_at: item.paired_at, revoked_at: item.revoked_at }; }
function safeName(value) { return String(value || 'Windows device').replace(/[\0\r\n]/g, '').slice(0, 100); }
function safeVersion(value) { return String(value || HOST_BRIDGE_VERSION).replace(/[^a-zA-Z0-9.+_-]/g, '').slice(0, 50); }
function safeToken(value) { const result = String(value || '').replace(/[^a-zA-Z0-9._-]/g, ''); if (!result || result.length > 200) throw new Error('bridge_token_invalid'); return result; }
function safeProtocolError(error) { const value = String(error?.code || error?.message || error || 'windows_bridge_failed'); return /^[a-z0-9_.-]{1,120}$/i.test(value) ? value : 'windows_bridge_failed'; }
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function safeEqual(a, b) { const left = Buffer.from(String(a)), right = Buffer.from(String(b)); return left.length === right.length && crypto.timingSafeEqual(left, right); }
function rejectUpgrade(socket, error) { const status = error instanceof HttpError ? error.status : 500, reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bridge Unavailable'; socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
export function isHostBridgeLocalRequest({ remoteAddress, host } = {}, { containerized = false } = {}) { if (!isLoopbackHost(String(host || '').replace(/^\[|\](?::\d+)?$|:\d+$/g, ''))) return false; if (isLoopbackAddress(remoteAddress)) return true; return containerized && isPrivateContainerAddress(remoteAddress); }
function isLoopbackHost(value) { return ['127.0.0.1', 'localhost', '::1'].includes(String(value || '').toLowerCase()); }
function isLoopbackAddress(value) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(value || '').toLowerCase()); }
function isPrivateContainerAddress(value) { const octets = String(value || '').toLowerCase().replace(/^::ffff:/, '').split('.').map(Number); return octets.length === 4 && octets.every((item) => Number.isInteger(item) && item >= 0 && item <= 255) && (octets[0] === 10 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && octets[1] === 168); }
