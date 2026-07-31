import fsp from 'node:fs/promises';
import { HttpError } from './http.mjs';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_ENTRIES = 5_000;
const MAX_CENTRAL_BYTES = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;

export async function inspectOfficeArchive(file, mime) {
  const handle = await fsp.open(file, 'r');
  try {
    const metadata = await readArchiveMetadata(handle);
    const central = await readCentralDirectory(handle, metadata);
    const inspection = inspectCentralDirectory(central, metadata);
    validateOfficePackage(inspection.names, mime);
    return {
      entries: metadata.entries,
      central_bytes: metadata.centralSize,
      compressed_bytes: inspection.totalCompressed,
      uncompressed_bytes: inspection.totalUncompressed
    };
  } finally {
    await handle.close();
  }
}

async function readArchiveMetadata(handle) {
  const stat = await handle.stat();
  const tailSize = Math.min(stat.size, 65_557);
  const tail = Buffer.alloc(tailSize);
  await handle.read(tail, 0, tail.length, stat.size - tail.length);
  const eocd = findEocd(tail);
  if (eocd < 0) throw invalidArchive();
  const metadata = parseEndRecord(tail, eocd);
  validateEndRecord(metadata, tail.length, stat.size - tail.length + eocd);
  return metadata;
}

function parseEndRecord(tail, eocd) {
  return {
    eocd,
    disk: tail.readUInt16LE(eocd + 4),
    centralDisk: tail.readUInt16LE(eocd + 6),
    diskEntries: tail.readUInt16LE(eocd + 8),
    entries: tail.readUInt16LE(eocd + 10),
    centralSize: tail.readUInt32LE(eocd + 12),
    centralOffset: tail.readUInt32LE(eocd + 16),
    commentSize: tail.readUInt16LE(eocd + 20)
  };
}

function validateEndRecord(metadata, tailLength, absoluteEocd) {
  const malformed =
    metadata.eocd + 22 + metadata.commentSize > tailLength ||
    metadata.disk ||
    metadata.centralDisk ||
    metadata.diskEntries !== metadata.entries ||
    metadata.entries === 0;
  if (malformed) throw invalidArchive();
  if (metadata.entries === 0xffff || metadata.centralSize === 0xffffffff || metadata.centralOffset === 0xffffffff)
    throw archiveLimit('zip64_unsupported');
  const overLimit =
    metadata.entries > MAX_ENTRIES ||
    metadata.centralSize > MAX_CENTRAL_BYTES ||
    metadata.centralOffset + metadata.centralSize > absoluteEocd;
  if (overLimit) throw archiveLimit('central_directory_limit');
}

async function readCentralDirectory(handle, metadata) {
  const central = Buffer.alloc(metadata.centralSize);
  await handle.read(central, 0, central.length, metadata.centralOffset);
  return central;
}

function inspectCentralDirectory(central, metadata) {
  const names = new Set();
  let cursor = 0;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < metadata.entries; index++) {
    const entry = parseCentralEntry(central, cursor, metadata.centralOffset);
    names.add(entry.name.toLowerCase());
    totalCompressed += entry.compressed;
    totalUncompressed += entry.uncompressed;
    cursor = entry.next;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw archiveLimit('uncompressed_size_limit');
  }
  validateCompressionTotals(central.length, cursor, totalCompressed, totalUncompressed);
  return { names, totalCompressed, totalUncompressed };
}

function parseCentralEntry(central, cursor, centralOffset) {
  if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw invalidArchive();
  const flags = central.readUInt16LE(cursor + 8);
  const method = central.readUInt16LE(cursor + 10);
  const compressed = central.readUInt32LE(cursor + 20);
  const uncompressed = central.readUInt32LE(cursor + 24);
  const nameLength = central.readUInt16LE(cursor + 28);
  const extraLength = central.readUInt16LE(cursor + 30);
  const commentLength = central.readUInt16LE(cursor + 32);
  const localOffset = central.readUInt32LE(cursor + 42);
  const next = cursor + 46 + nameLength + extraLength + commentLength;
  const invalid =
    next > central.length ||
    ![0, 8].includes(method) ||
    Boolean(flags & 1) ||
    [compressed, uncompressed, localOffset].includes(0xffffffff) ||
    localOffset >= centralOffset;
  if (invalid) throw invalidArchive();
  const name = central
    .subarray(cursor + 46, cursor + 46 + nameLength)
    .toString('utf8')
    .replaceAll('\\', '/');
  validateEntryName(name);
  return { name, compressed, uncompressed, next };
}

function validateCompressionTotals(centralLength, cursor, totalCompressed, totalUncompressed) {
  const suspiciousRatio =
    totalUncompressed > 1024 * 1024 && totalUncompressed / Math.max(1, totalCompressed) > MAX_COMPRESSION_RATIO;
  if (cursor !== centralLength || suspiciousRatio) throw archiveLimit('compression_ratio_limit');
}

function validateOfficePackage(names, mime) {
  if ([...names].some((name) => /(?:^|\/)vbaproject\.bin$/i.test(name)))
    throw new HttpError(422, { error: 'attachment_office_active_content', reason: 'vba_project' });
  const prefix = officeContentPrefix(mime);
  if (!prefix || !names.has('[content_types].xml') || ![...names].some((name) => name.startsWith(prefix)))
    throw invalidArchive();
}

function officeContentPrefix(mime) {
  if (mime.includes('wordprocessingml')) return 'word/';
  if (mime.includes('spreadsheetml')) return 'xl/';
  if (mime.includes('presentationml')) return 'ppt/';
  return null;
}

function findEocd(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset--)
    if (
      buffer.readUInt32LE(offset) === EOCD_SIGNATURE &&
      offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length
    )
      return offset;
  return -1;
}
function validateEntryName(name) {
  if (
    !name ||
    name.length > 512 ||
    /[\0\r\n]/.test(name) ||
    name.startsWith('/') ||
    /^[a-z]:/i.test(name) ||
    name.split('/').includes('..')
  )
    throw invalidArchive();
}
function invalidArchive() {
  return new HttpError(422, { error: 'attachment_office_archive_invalid' });
}
function archiveLimit(reason) {
  return new HttpError(413, {
    error: 'attachment_office_archive_limit',
    reason,
    max_entries: MAX_ENTRIES,
    max_uncompressed_bytes: MAX_UNCOMPRESSED_BYTES
  });
}
