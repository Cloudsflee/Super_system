import { AppError } from './errors.mjs';

export async function readBody(req) {
  const raw = await readLimitedBody(req, 25 * 1024 * 1024);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new AppError('invalid_json', 'request body must be JSON', { status: 400 }); }
}

export function readRawBody(req) {
  return readLimitedBody(req, 2 * 1024 * 1024);
}

async function readLimitedBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError('payload_too_large', 'request body is too large', { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
