import { pathToFileURL } from 'node:url';

import { modulePathFor, qualityError } from './quality-review-parser-worker-utils.mjs';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function imageInfo(bytes, type) {
  if (isPng(bytes, type))
    return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
  if (isGif(bytes, type))
    return bytes.length >= 10 ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) } : null;
  return null;
}

export function gifFrames(bytes) {
  let count = 0;
  for (let offset = 0; offset + 10 < bytes.length; offset += 1) if (bytes[offset] === 0x2c) count += 1;
  return count || 1;
}

export async function assertValidImage(bytes, type) {
  if (!validImageHeader(bytes, type)) throw qualityError('quality_review_image_invalid', { media_type: type });
  try {
    await validateWithCanvas(bytes);
  } catch {
    throw qualityError('quality_review_image_invalid', { media_type: type });
  }
}

function validImageHeader(bytes, type) {
  const mediaType = String(type || '').toLowerCase();
  if (mediaType === 'image/png') return bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  if (mediaType === 'image/jpeg' || mediaType === 'image/jpg') return validJpeg(bytes);
  if (mediaType === 'image/gif') return bytes.length >= 10 && /GIF8[79]a/.test(bytes.toString('ascii', 0, 6));
  if (mediaType === 'image/webp') return validWebp(bytes);
  return false;
}

function validJpeg(bytes) {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
}

function validWebp(bytes) {
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

function isPng(bytes, type) {
  return type === 'image/png' || bytes.subarray(0, 8).equals(PNG_SIGNATURE);
}

function isGif(bytes, type) {
  return type === 'image/gif' || bytes.toString('ascii', 0, 3) === 'GIF';
}

async function validateWithCanvas(bytes) {
  const modulePath = modulePathFor('@napi-rs/canvas', ['index.js']),
    canvas = await import(pathToFileURL(modulePath).href);
  if (typeof canvas.loadImage !== 'function') throw new Error('load_image_unavailable');
  await canvas.loadImage(bytes);
}
