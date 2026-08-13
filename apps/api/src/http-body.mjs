import { AppError } from './errors.mjs';
import Busboy from 'busboy';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { normalizeRelativePath } from './path-policy.mjs';

export async function readBody(req) {
  const raw = await readLimitedBody(req, 25 * 1024 * 1024);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new AppError('invalid_json', 'request body must be JSON', { status: 400 }); }
}

export function readRawBody(req) {
  return readLimitedBody(req, 2 * 1024 * 1024);
}

/** Streams bounded file parts into a private staging directory. */
export async function readMultipartUpload(req, limits = {}, stagingRoot = null) {
  const contentType = String(req.headers['content-type'] || '');
  const match = /multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) throw new AppError('invalid_input', 'multipart/form-data upload is required', { status: 400 });
  const boundary = match[1] || match[2];
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) throw new AppError('invalid_input', 'multipart boundary is invalid', { status: 400 });
  const maxFiles = positiveLimit(limits.maxFiles, 1000);
  const maxFileBytes = positiveLimit(limits.maxFileBytes, 10 * 1024 * 1024);
  const maxTotalBytes = positiveLimit(limits.maxTotalBytes, 100 * 1024 * 1024);
  const maxEnvelopeBytes = Math.max(2 * 1024 * 1024, Math.min(16 * 1024 * 1024, maxFiles * 8192));
  const maxRequestBytes = maxTotalBytes + maxEnvelopeBytes;
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) throw totalUploadLimit(maxTotalBytes);

  const files = [];
  const fields = {};
  const seenPaths = new Set();
  const fileTasks = [];
  const base = path.resolve(stagingRoot || process.env.AIWS_HOME || path.join(process.cwd(), '.ai-workspace', 'v3'));
  const uploadRoot = path.join(base, '.staging', 'uploads');
  const stageRoot = path.join(uploadRoot, randomUUID());
  let requestBytes = 0;
  let totalFileBytes = 0;
  let fatalError = null;

  try {
    fs.mkdirSync(uploadRoot, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(uploadRoot).isSymbolicLink()) throw sourceUploadError('upload staging root is invalid');
    fs.mkdirSync(stageRoot, { mode: 0o700 });
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error instanceof AppError ? error : new AppError('upload_write_failed', 'upload staging could not be created', { status: 500, retryable: true });
  }

  const fail = (error) => {
    if (!fatalError) fatalError = error instanceof AppError
      ? error
      : new AppError('upload_write_failed', 'uploaded file could not be staged', { status: 500, retryable: true });
  };

  let parser;
  try {
    parser = Busboy({
      headers: req.headers,
      preservePath: true,
      limits: { files: maxFiles, fileSize: maxFileBytes, fields: 32, fieldSize: 64 * 1024, parts: maxFiles + 32, headerPairs: 200 }
    });
  } catch {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw new AppError('invalid_input', 'multipart body is invalid', { status: 400 });
  }

  parser.on('file', (field, stream, info) => {
    if (fatalError) { stream.resume(); return; }
    let filename;
    let relative;
    try {
      filename = String(info.filename || '').replaceAll('\\', '/');
      if (!filename || filename.length > 4096 || filename.includes('\0')) throw sourceUploadError('uploaded path is invalid');
      relative = normalizeRelativePath(filename.trim());
      const segments = relative.toLowerCase().split('/');
      if (segments.some((segment) => segment === '.git' || segment === '.aiws')) throw sourceUploadError('reserved repository paths are not uploadable', relative);
      if (seenPaths.has(relative)) throw sourceUploadError('uploaded paths must be unique', relative);
      seenPaths.add(relative);
    } catch (error) {
      stream.resume();
      fail(error?.code === 'repository_source_invalid' ? error : sourceUploadError('uploaded path is invalid', filename));
      return;
    }

    const target = path.resolve(stageRoot, ...relative.split('/'));
    if (!target.startsWith(`${stageRoot}${path.sep}`)) {
      stream.resume();
      fail(sourceUploadError('uploaded path is invalid', relative));
      return;
    }

    const index = files.length;
    files.push(null);
    const digest = createHash('sha256');
    let byteSize = 0;
    let fileLimitError = null;
    stream.once('limit', () => {
      fileLimitError = new AppError('upload_limit_exceeded', 'uploaded file exceeds the per-file limit', { status: 413, details: { path: relative, max_file_bytes: maxFileBytes } });
      fail(fileLimitError);
    });

    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        if (fatalError && fatalError !== fileLimitError) { callback(fatalError); return; }
        byteSize += chunk.byteLength;
        totalFileBytes += chunk.byteLength;
        if (totalFileBytes > maxTotalBytes) {
          const error = totalUploadLimit(maxTotalBytes);
          fail(error);
          callback(error);
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      }
    });

    const task = (async () => {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        await pipeline(stream, meter, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
        if (stream.truncated || fileLimitError) throw fileLimitError || new AppError('upload_limit_exceeded', 'uploaded file exceeds the per-file limit', { status: 413, details: { path: relative, max_file_bytes: maxFileBytes } });
        if (!fatalError) files[index] = { field: String(field), filename, path: relative, byte_size: byteSize, sha256: digest.digest('hex'), staging_path: target };
      } catch (error) {
        fail(error);
      }
    })();
    fileTasks.push(task);
  });
  parser.on('field', (name, value, info) => {
    if (info.valueTruncated) fail(new AppError('upload_limit_exceeded', 'multipart field exceeds the limit', { status: 413 }));
    else if (!fatalError) fields[String(name).slice(0, 200)] = String(value);
  });
  parser.on('filesLimit', () => fail(new AppError('upload_limit_exceeded', 'multipart upload contains too many files', { status: 413, details: { max_files: maxFiles } })));
  parser.on('fieldsLimit', () => fail(new AppError('upload_limit_exceeded', 'multipart upload contains too many fields', { status: 413 })));
  parser.on('partsLimit', () => fail(new AppError('upload_limit_exceeded', 'multipart upload contains too many parts', { status: 413 })));

  const parserDone = new Promise((resolve) => {
    let settled = false;
    const settle = () => { if (!settled) { settled = true; resolve(); } };
    parser.once('finish', settle);
    parser.once('close', settle);
    parser.on('error', (error) => { fail(new AppError('invalid_input', 'multipart body is invalid', { status: 400, details: { reason: String(error?.message || '').slice(0, 120) } })); settle(); });
  });

  try {
    for await (const chunk of req) {
      requestBytes += chunk.byteLength;
      if (requestBytes > maxRequestBytes) { fail(totalUploadLimit(maxTotalBytes)); continue; }
      if (!parser.write(chunk)) await once(parser, 'drain');
    }
    if (!parser.destroyed) parser.end();
    await parserDone;
    await Promise.allSettled(fileTasks);
  } catch (error) {
    fail(error);
    if (!parser.destroyed) parser.destroy();
    await Promise.allSettled(fileTasks);
  }

  const completedFiles = files.filter(Boolean);
  if (fatalError) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw fatalError;
  }
  if (!completedFiles.length) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw new AppError('invalid_input', 'multipart upload contains no files', { status: 422 });
  }
  return { files: completedFiles, fields, staging_root: stageRoot, total_bytes: totalFileBytes };
}

function positiveLimit(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function totalUploadLimit(maxTotalBytes) {
  return new AppError('upload_limit_exceeded', 'uploaded files exceed the total limit', { status: 413, details: { max_total_bytes: maxTotalBytes } });
}

function sourceUploadError(message, relative = '') {
  return new AppError('repository_source_invalid', message, { status: 422, details: relative ? { path: relative } : {} });
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
