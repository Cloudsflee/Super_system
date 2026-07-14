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
    const stat = await handle.stat(), tailSize = Math.min(stat.size, 65_557), tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tail.length, stat.size - tail.length);
    const eocd = findEocd(tail); if (eocd < 0) throw invalidArchive();
    const disk = tail.readUInt16LE(eocd + 4), centralDisk = tail.readUInt16LE(eocd + 6), diskEntries = tail.readUInt16LE(eocd + 8), entries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12), centralOffset = tail.readUInt32LE(eocd + 16), commentSize = tail.readUInt16LE(eocd + 20);
    if (eocd + 22 + commentSize > tail.length || disk || centralDisk || diskEntries !== entries || entries === 0) throw invalidArchive();
    if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw archiveLimit('zip64_unsupported');
    const absoluteEocd = stat.size - tail.length + eocd;
    if (entries > MAX_ENTRIES || centralSize > MAX_CENTRAL_BYTES || centralOffset + centralSize > absoluteEocd) throw archiveLimit('central_directory_limit');
    const central = Buffer.alloc(centralSize); await handle.read(central, 0, central.length, centralOffset);
    const names = new Set(); let cursor = 0, totalCompressed = 0, totalUncompressed = 0;
    for (let index = 0; index < entries; index++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw invalidArchive();
      const flags = central.readUInt16LE(cursor + 8), method = central.readUInt16LE(cursor + 10), compressed = central.readUInt32LE(cursor + 20), uncompressed = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28), extraLength = central.readUInt16LE(cursor + 30), commentLength = central.readUInt16LE(cursor + 32), localOffset = central.readUInt32LE(cursor + 42);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (next > central.length || ![0, 8].includes(method) || flags & 1 || [compressed, uncompressed, localOffset].includes(0xffffffff) || localOffset >= centralOffset) throw invalidArchive();
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8').replaceAll('\\', '/'); validateEntryName(name);
      names.add(name.toLowerCase()); totalCompressed += compressed; totalUncompressed += uncompressed; cursor = next;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw archiveLimit('uncompressed_size_limit');
    }
    if (cursor !== central.length || (totalUncompressed > 1024 * 1024 && totalUncompressed / Math.max(1, totalCompressed) > MAX_COMPRESSION_RATIO)) throw archiveLimit('compression_ratio_limit');
    if ([...names].some((name) => /(?:^|\/)vbaproject\.bin$/i.test(name))) throw new HttpError(422, { error: 'attachment_office_active_content', reason: 'vba_project' });
    const prefix = mime.includes('wordprocessingml') ? 'word/' : mime.includes('spreadsheetml') ? 'xl/' : mime.includes('presentationml') ? 'ppt/' : null;
    if (!prefix || !names.has('[content_types].xml') || ![...names].some((name) => name.startsWith(prefix))) throw invalidArchive();
    return { entries, central_bytes: centralSize, compressed_bytes: totalCompressed, uncompressed_bytes: totalUncompressed };
  } finally { await handle.close(); }
}

function findEocd(buffer) { for (let offset = buffer.length - 22; offset >= 0; offset--) if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) return offset; return -1; }
function validateEntryName(name) { if (!name || name.length > 512 || /[\0\r\n]/.test(name) || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) throw invalidArchive(); }
function invalidArchive() { return new HttpError(422, { error: 'attachment_office_archive_invalid' }); }
function archiveLimit(reason) { return new HttpError(413, { error: 'attachment_office_archive_limit', reason, max_entries: MAX_ENTRIES, max_uncompressed_bytes: MAX_UNCOMPRESSED_BYTES }); }
