import { File } from 'node:buffer';
import { inflateRawSync, gunzipSync } from 'node:zlib';
import { Worker, parentPort, workerData } from 'node:worker_threads';

const bytes = Buffer.from(workerData.bytes || []);
const format = String(workerData.format || '');
const limits = workerData.limits || {};

try {
  const state = { entries: 0, expanded: 0, inventory: [] };
  await scanArchive(bytes, `${format}.${format === 'gzip' ? 'gz' : format}`, 0, limits, state);
  const ratio = bytes.byteLength ? state.expanded / bytes.byteLength : 0;
  if (ratio > limits.max_compression_ratio) throw parserError('parser_quota_compression_ratio');
  parentPort.postMessage({
    status: 'ok',
    metadata: {
      format,
      entries: state.entries,
      expanded_bytes: state.expanded,
      recursion_depth: state.inventory.reduce((maximum, item) => Math.max(maximum, item.depth), 0),
      inventory: state.inventory
    }
  });
} catch (error) {
  parentPort.postMessage({ status: 'failed', error_code: String(error?.code || 'parser_invalid_archive') });
}

async function scanArchive(input, filename, depth, quota, state) {
  if (depth > quota.max_recursion_depth) throw parserError('parser_quota_archive_depth');
  if (archiveFormatFromName(filename) === 'gzip') return scanNativeArchive(input, filename, depth, quota, state);
  let Archive;
  try {
    const moduleUrl = import.meta.resolve('libarchive.js/dist/libarchive-node.mjs');
    ({ Archive } = await import(moduleUrl));
    if (process.platform === 'win32') {
      const Comlink = await import(new URL('../../comlink/dist/esm/comlink.mjs', moduleUrl));
      const { default: nodeEndpoint } = await import(new URL('../../comlink/dist/esm/node-adapter.mjs', moduleUrl));
      const workerUrl = new URL('./worker-bundle-node.mjs', moduleUrl);
      Archive.init({ getWorker: () => new Worker(workerUrl), createClient: (worker) => Comlink.wrap(nodeEndpoint(worker)) });
    }
  }
  catch { return scanNativeArchive(input, filename, depth, quota, state); }
  let archive;
  try { archive = await Archive.open(new File([input], filename)); }
  catch { return scanNativeArchive(input, filename, depth, quota, state); }
  try {
    const encrypted = await archive.hasEncryptedData();
    if (encrypted === true) throw parserError('parser_invalid_encrypted_archive');
    const entries = await archive.getFilesArray();
    for (const entry of entries) {
      state.entries += 1;
      if (state.entries > quota.max_archive_entries) throw parserError('parser_quota_archive_entries');
      const name = [String(entry.path || ''), String(entry.file?.name || '')].filter(Boolean).join('/').replaceAll('\\', '/');
      assertArchivePath(name);
      const size = Number(entry.file?.size || 0);
      state.expanded += size;
      if (state.expanded > quota.max_expanded_bytes) throw parserError('parser_quota_expanded_bytes');
      state.inventory.push({ path: name, byte_length: size, depth });
      const nested = archiveFormatFromName(name);
      let extracted;
      try { extracted = await entry.file.extract(); }
      catch { throw parserError('parser_invalid_archive'); }
      if (nested && size > 0) {
        if (depth >= quota.max_recursion_depth) throw parserError('parser_quota_archive_depth');
        await scanArchive(Buffer.from(await extracted.arrayBuffer()), name, depth + 1, quota, state);
      }
    }
  } finally { await archive.close().catch(() => undefined); }
}

function scanNativeArchive(input, filename, depth, quota, state) {
  const format = archiveFormatFromName(filename);
  if (format === 'zip') return scanZip(input, depth, quota, state);
  if (format === 'tar') return scanTar(input, depth, quota, state);
  if (format === 'gzip') {
    let expanded;
    try { expanded = gunzipSync(input, { finishFlush: 2, maxOutputLength: Math.max(1, quota.max_expanded_bytes - state.expanded) }); }
    catch (error) { throw parserError(error?.code === 'ERR_BUFFER_TOO_LARGE' ? 'parser_quota_expanded_bytes' : 'parser_invalid_archive'); }
    state.entries += 1;
    if (state.entries > quota.max_archive_entries) throw parserError('parser_quota_archive_entries');
    state.expanded += expanded.byteLength;
    if (state.expanded > quota.max_expanded_bytes) throw parserError('parser_quota_expanded_bytes');
    const name = filename.replace(/\.gz$/i, '') || 'content';
    assertArchivePath(name);
    state.inventory.push({ path: name, byte_length: expanded.byteLength, depth });
    const nested = archiveFormatFromName(name);
    if (nested) {
      if (depth >= quota.max_recursion_depth) throw parserError('parser_quota_archive_depth');
      return scanNativeArchive(expanded, name, depth + 1, quota, state);
    }
    return;
  }
  if (format === '7z' || format === 'rar') {
    // The signatures are validated by the parent parser. Keep bounded metadata
    // when a platform has no native extractor, while never exposing contents.
    state.entries += 1;
    if (state.entries > quota.max_archive_entries) throw parserError('parser_quota_archive_entries');
    state.inventory.push({ path: filename, byte_length: input.byteLength, depth, opaque: true });
    state.expanded += input.byteLength;
    if (state.expanded > quota.max_expanded_bytes) throw parserError('parser_quota_expanded_bytes');
    return;
  }
  throw parserError('parser_invalid_archive');
}

function scanZip(input, depth, quota, state) {
  const end = findSignature(input, 0x06054b50, Math.max(0, input.length - 65_557));
  if (end < 0 || end + 22 > input.length) throw parserError('parser_invalid_archive');
  const entries = input.readUInt16LE(end + 10);
  const centralSize = input.readUInt32LE(end + 12);
  const centralOffset = input.readUInt32LE(end + 16);
  if (entries > quota.max_archive_entries || centralOffset + centralSize > input.length) throw parserError('parser_quota_archive_entries');
  let cursor = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > input.length || input.readUInt32LE(cursor) !== 0x02014b50) throw parserError('parser_invalid_archive');
    const flags = input.readUInt16LE(cursor + 8);
    const method = input.readUInt16LE(cursor + 10);
    const compressedSize = input.readUInt32LE(cursor + 20);
    const expandedSize = input.readUInt32LE(cursor + 24);
    const nameLength = input.readUInt16LE(cursor + 28);
    const extraLength = input.readUInt16LE(cursor + 30);
    const commentLength = input.readUInt16LE(cursor + 32);
    const localOffset = input.readUInt32LE(cursor + 42);
    const rawName = input.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = (flags & 0x800 ? rawName.toString('utf8') : rawName.toString('utf8')).replaceAll('\\', '/');
    assertArchivePath(name);
    if (flags & 1) throw parserError('parser_invalid_encrypted_archive');
    state.entries += 1;
    if (state.entries > quota.max_archive_entries) throw parserError('parser_quota_archive_entries');
    state.expanded += expandedSize;
    if (state.expanded > quota.max_expanded_bytes) throw parserError('parser_quota_expanded_bytes');
    state.inventory.push({ path: name, byte_length: expandedSize, depth });
    const nested = archiveFormatFromName(name);
    if (nested && expandedSize > 0 && localOffset + 30 <= input.length) {
      if (depth >= quota.max_recursion_depth) throw parserError('parser_quota_archive_depth');
      const localNameLength = input.readUInt16LE(localOffset + 26);
      const localExtraLength = input.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataStart < 0 || dataEnd > input.length) throw parserError('parser_invalid_archive');
      let nestedBytes;
      try { nestedBytes = method === 0 ? input.subarray(dataStart, dataEnd) : method === 8 ? inflateRawSync(input.subarray(dataStart, dataEnd), { maxOutputLength: Math.max(1, quota.max_expanded_bytes - state.expanded) }) : null; }
      catch (error) { throw parserError(error?.code === 'ERR_BUFFER_TOO_LARGE' ? 'parser_quota_expanded_bytes' : 'parser_invalid_archive'); }
      if (!nestedBytes) throw parserError('parser_format_unsupported');
      scanNativeArchive(Buffer.from(nestedBytes), name, depth + 1, quota, state);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
}

function scanTar(input, depth, quota, state) {
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= input.length) {
    const header = input.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) { zeroBlocks += 1; if (zeroBlocks >= 2) return; offset += 512; continue; }
    zeroBlocks = 0;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '').replaceAll('\\', '/');
    assertArchivePath(name);
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) throw parserError('parser_invalid_archive');
    state.entries += 1;
    if (state.entries > quota.max_archive_entries) throw parserError('parser_quota_archive_entries');
    state.expanded += size;
    if (state.expanded > quota.max_expanded_bytes) throw parserError('parser_quota_expanded_bytes');
    state.inventory.push({ path: name, byte_length: size, depth });
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > input.length) throw parserError('parser_invalid_archive');
    const nested = archiveFormatFromName(name);
    if (nested && size > 0) {
      if (depth >= quota.max_recursion_depth) throw parserError('parser_quota_archive_depth');
      scanNativeArchive(input.subarray(dataStart, dataEnd), name, depth + 1, quota, state);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (offset !== input.length && !zeroBlocks) throw parserError('parser_invalid_archive');
}

function findSignature(input, signature, start) {
  for (let index = input.length - 4; index >= start; index -= 1) if (input.readUInt32LE(index) === signature) return index;
  return -1;
}

function archiveFormatFromName(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.gz')) return 'gzip';
  for (const value of ['zip', 'tar', '7z', 'rar']) if (lower.endsWith(`.${value}`)) return value;
  return null;
}

function assertArchivePath(value) {
  const name = String(value || '');
  const parts = name.split('/');
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || parts.some((part) => !part || part === '.' || part === '..') || name.includes('\0')) throw parserError('parser_invalid_archive_path');
  if (name.length > 2048) throw parserError('parser_quota_archive_path');
}

function parserError(code) { const error = new Error(code); error.code = code; return error; }
