import { inflateRawSync } from 'node:zlib';

import { qualityError } from './quality-review-parser-worker-utils.mjs';

const QUALITY_REVIEW_ZIP_LIMITS = Object.freeze({
  maxEntries: 1024,
  maxEntryBytes: 25 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxRatio: 1000
});

export function unzip(bytes) {
  const central = readCentralDirectory(bytes),
    result = new Map();
  let offset = 0;
  let totalBytes = 0;
  let count = 0;
  while (offset + 30 <= bytes.length) {
    const entry = readLocalEntry(bytes, offset, central, totalBytes);
    if (entry.stop) break;
    count += 1;
    totalBytes = entry.totalBytes;
    if (count > QUALITY_REVIEW_ZIP_LIMITS.maxEntries) throw qualityError('quality_review_zip_entry_count_exceeded');
    if (entry.value && !entry.name.endsWith('/')) result.set(entry.name, entry.value);
    offset = entry.nextOffset;
  }
  if (!count || (central.count && count !== central.count)) throw qualityError('quality_review_zip_invalid');
  return result;
}

function readLocalEntry(bytes, offset, central, previousTotalBytes) {
  const signature = bytes.readUInt32LE(offset);
  if (signature === 0x02014b50 || signature === 0x06054b50 || signature === 0x06064b50) return { stop: true };
  if (signature !== 0x04034b50) {
    if (!previousTotalBytes) throw qualityError('quality_review_zip_invalid');
    return { stop: true };
  }
  const metadata = localEntryMetadata(bytes, offset, central);
  const totalBytes = previousTotalBytes + metadata.uncompressedSize;
  assertZipEntryLimits(metadata, totalBytes);
  const value = inflateZipEntry(bytes.subarray(metadata.start, metadata.end), metadata.method);
  if (!value || value.length !== metadata.uncompressedSize) throw qualityError('quality_review_zip_entry_corrupt');
  return { name: metadata.name, value, totalBytes, nextOffset: metadata.end, stop: false };
}

function localEntryMetadata(bytes, offset, central) {
  const flags = bytes.readUInt16LE(offset + 6),
    method = bytes.readUInt16LE(offset + 8),
    localCompressedSize = bytes.readUInt32LE(offset + 18),
    localUncompressedSize = bytes.readUInt32LE(offset + 22),
    nameSize = bytes.readUInt16LE(offset + 26),
    extraSize = bytes.readUInt16LE(offset + 28),
    nameEnd = offset + 30 + nameSize + extraSize;
  if (flags & 0x1) throw qualityError('quality_review_zip_encrypted');
  if (nameEnd > bytes.length) throw qualityError('quality_review_zip_invalid');
  const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString('utf8'),
    descriptor = central.byOffset.get(offset),
    compressedSize = flags & 0x8 ? descriptor?.compressed_size : localCompressedSize,
    uncompressedSize = flags & 0x8 ? descriptor?.uncompressed_size : localUncompressedSize,
    start = nameEnd,
    end = start + compressedSize;
  assertSafeZipPath(name);
  if (!Number.isSafeInteger(compressedSize) || !Number.isSafeInteger(uncompressedSize))
    throw qualityError('quality_review_zip_descriptor_missing');
  if (end > bytes.length) throw qualityError('quality_review_zip_invalid');
  return { name, method, compressedSize, uncompressedSize, start, end };
}

function assertZipEntryLimits(metadata, totalBytes) {
  const { compressedSize, uncompressedSize } = metadata;
  if (
    compressedSize > QUALITY_REVIEW_ZIP_LIMITS.maxEntryBytes ||
    uncompressedSize > QUALITY_REVIEW_ZIP_LIMITS.maxEntryBytes
  )
    throw qualityError('quality_review_zip_entry_too_large');
  if (totalBytes > QUALITY_REVIEW_ZIP_LIMITS.maxTotalBytes)
    throw qualityError('quality_review_zip_total_size_exceeded');
  if (
    compressedSize > 0 &&
    uncompressedSize > 1024 * 1024 &&
    uncompressedSize / compressedSize > QUALITY_REVIEW_ZIP_LIMITS.maxRatio
  )
    throw qualityError('quality_review_zip_compression_ratio_exceeded');
}

function inflateZipEntry(data, method) {
  try {
    return method === 8
      ? inflateRawSync(data, { maxOutputLength: QUALITY_REVIEW_ZIP_LIMITS.maxEntryBytes })
      : method === 0
        ? Buffer.from(data)
        : null;
  } catch {
    throw qualityError('quality_review_zip_entry_corrupt');
  }
}

function readCentralDirectory(bytes) {
  const maxComment = 65_557,
    start = Math.max(0, bytes.length - maxComment),
    eocd = findSignature(bytes, 0x06054b50, bytes.length - 22, start);
  if (eocd < 0) return { count: 0, byOffset: new Map(), entries: [] };
  const count = bytes.readUInt16LE(eocd + 10),
    centralSize = bytes.readUInt32LE(eocd + 12),
    centralOffset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    throw qualityError('quality_review_zip64_unsupported');
  if (centralOffset + centralSize > bytes.length) throw qualityError('quality_review_zip_invalid');
  const byOffset = new Map();
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    const entry = readCentralEntry(bytes, offset);
    byOffset.set(entry.localOffset, {
      compressed_size: entry.compressedSize,
      uncompressed_size: entry.uncompressedSize
    });
    entries.push(entry);
    offset = entry.nextOffset;
  }
  return { count, byOffset, entries };
}

function readCentralEntry(bytes, offset) {
  if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50)
    throw qualityError('quality_review_zip_invalid');
  const flags = bytes.readUInt16LE(offset + 8),
    compressedSize = bytes.readUInt32LE(offset + 20),
    uncompressedSize = bytes.readUInt32LE(offset + 24),
    nameSize = bytes.readUInt16LE(offset + 28),
    extraSize = bytes.readUInt16LE(offset + 30),
    commentSize = bytes.readUInt16LE(offset + 32),
    localOffset = bytes.readUInt32LE(offset + 42),
    nameEnd = offset + 46 + nameSize + extraSize + commentSize;
  if (
    nameEnd > bytes.length ||
    compressedSize === 0xffffffff ||
    uncompressedSize === 0xffffffff ||
    localOffset === 0xffffffff
  )
    throw qualityError('quality_review_zip64_unsupported');
  if (flags & 0x1) throw qualityError('quality_review_zip_encrypted');
  const name = bytes.toString('utf8', offset + 46, offset + 46 + nameSize);
  assertSafeZipPath(name);
  return { name, flags, compressedSize, uncompressedSize, localOffset, nextOffset: nameEnd };
}

export function assertZipContainerWithinLimits(bytes) {
  const central = readCentralDirectory(bytes);
  if (!central.count || central.count > QUALITY_REVIEW_ZIP_LIMITS.maxEntries)
    throw qualityError(
      central.count > QUALITY_REVIEW_ZIP_LIMITS.maxEntries
        ? 'quality_review_zip_entry_count_exceeded'
        : 'quality_review_zip_invalid'
    );
  let totalBytes = 0;
  for (const entry of central.entries) {
    totalBytes += entry.uncompressedSize;
    assertZipEntryLimits(entry, totalBytes);
    const localOffset = entry.localOffset;
    if (
      localOffset + 30 > bytes.length ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50 ||
      localOffset +
        30 +
        bytes.readUInt16LE(localOffset + 26) +
        bytes.readUInt16LE(localOffset + 28) +
        entry.compressedSize >
        bytes.length
    )
      throw qualityError('quality_review_zip_invalid');
  }
}

function findSignature(bytes, signature, from, to) {
  for (let offset = Math.min(from, bytes.length - 4); offset >= to; offset -= 1)
    if (bytes.readUInt32LE(offset) === signature) return offset;
  return -1;
}

function assertSafeZipPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..') ||
    normalized.includes('\0')
  )
    throw qualityError('quality_review_zip_path_invalid');
}
