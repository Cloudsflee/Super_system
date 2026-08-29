import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { parse as parseCsv } from 'csv-parse/sync';
import { SaxesParser } from 'saxes';
import { parseOffice } from 'officeparser';
import { loadImage } from '@napi-rs/canvas';
import ffprobe from 'ffprobe-static';
import { canonicalJson, sha256Hex } from '../api/src/clean/canonical.mjs';
import { DEFAULT_PARSER_LIMITS } from '../api/src/clean/parser-limits.mjs';

export { DEFAULT_PARSER_LIMITS } from '../api/src/clean/parser-limits.mjs';

const execFileAsync = promisify(execFile);
const ARCHIVE_FORMATS = new Set(['zip', 'tar', 'gzip', '7z', 'rar']);
const OFFICE_FORMATS = new Set(['pdf', 'docx', 'xlsx', 'pptx']);
const IMAGE_FORMATS = new Set(['png', 'jpeg', 'webp', 'gif']);
const MEDIA_FORMATS = new Set(['audio', 'video']);
const SIGNATURES = Object.freeze({
  pdf: ['25504446'], docx: ['504b0304'], xlsx: ['504b0304'], pptx: ['504b0304'],
  png: ['89504e470d0a1a0a'], jpeg: ['ffd8ff'], webp: ['52494646'], gif: ['47494638'],
  zip: ['504b0304', '504b0506', '504b0708'], gzip: ['1f8b08'], '7z': ['377abcaf271c'], rar: ['526172211a07']
});

export async function parseAssetBytes(bytesValue, formatValue, options = {}) {
  const bytes = Buffer.from(bytesValue || []);
  const format = String(formatValue || '').toLowerCase();
  const limits = normalizeLimits(options.limits);
  if (bytes.byteLength > limits.max_input_bytes) return terminal('resource_exceeded', 'parser_input_too_large');
  if (!format) return terminal('unsupported', 'parser_format_unsupported');
  const mismatch = signatureMismatch(bytes, format);
  if (mismatch) return terminal('invalid', 'parser_media_signature_mismatch');
  try {
    const result = await withDeadline(dispatch(bytes, format, limits, options), limits.deadline_seconds * 1000, options.signal);
    const outputs = normalizeOutputs(result.outputs || [result], limits);
    return { status: 'parsed', error_code: '', outputs, metadata: result.metadata || {} };
  } catch (error) {
    const code = String(error?.code || 'parser_failed');
    if (code === 'parser_deadline_exceeded' || code.startsWith('parser_quota_')) return terminal('resource_exceeded', code);
    if (code === 'parser_cancelled') return terminal('cancelled', code);
    if (code.startsWith('parser_invalid_') || code === 'parser_media_signature_mismatch') return terminal('invalid', code);
    if (code === 'parser_format_unsupported') return terminal('unsupported', code);
    return terminal('failed', code);
  }
}

async function dispatch(bytes, format, limits, options) {
  if (format === 'text' || format === 'markdown') return parseText(bytes, format, limits);
  if (format === 'json') return parseJson(bytes, limits);
  if (format === 'csv') return parseCsvDocument(bytes, limits);
  if (format === 'xml' || format === 'svg') return parseXml(bytes, format, limits);
  if (OFFICE_FORMATS.has(format)) return parseOfficeDocument(bytes, format, limits, options.signal);
  if (IMAGE_FORMATS.has(format)) return parseImage(bytes, format);
  if (MEDIA_FORMATS.has(format)) return parseMedia(bytes, format, limits);
  if (ARCHIVE_FORMATS.has(format)) return parseArchive(bytes, format, limits);
  throw parserError('parser_format_unsupported');
}

function parseText(bytes, format, limits) {
  const text = decodeUtf8(bytes);
  if (text.length > limits.max_text_chars) throw parserError('parser_quota_text');
  return output(Buffer.from(text, 'utf8'), format === 'markdown' ? 'text/markdown' : 'text/plain', { characters: text.length, lines: lineCount(text), format });
}

function parseJson(bytes, limits) {
  const text = decodeUtf8(bytes);
  if (text.length > limits.max_text_chars) throw parserError('parser_quota_text');
  let value;
  try { value = JSON.parse(text); } catch { throw parserError('parser_invalid_json'); }
  const normalized = canonicalJson(value);
  if (normalized.length > limits.max_text_chars) throw parserError('parser_quota_text');
  return output(Buffer.from(normalized, 'utf8'), 'application/json', { characters: normalized.length, root_type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value });
}

function parseCsvDocument(bytes, limits) {
  const text = decodeUtf8(bytes);
  if (text.length > limits.max_text_chars) throw parserError('parser_quota_text');
  let rows;
  try { rows = parseCsv(text, { bom: true, columns: false, relax_column_count: false, skip_empty_lines: false, max_record_size: limits.max_text_chars }); }
  catch { throw parserError('parser_invalid_csv'); }
  const cells = rows.reduce((count, row) => count + row.length, 0);
  if (cells > limits.max_cells) throw parserError('parser_quota_cells');
  return output(Buffer.from(canonicalJson({ rows }), 'utf8'), 'application/json', { rows: rows.length, cells });
}

function parseXml(bytes, format, limits) {
  const text = decodeUtf8(bytes);
  if (text.length > limits.max_text_chars) throw parserError('parser_quota_text');
  if (/<!DOCTYPE|<!ENTITY|\bSYSTEM\b|\bPUBLIC\b/i.test(text)) throw parserError('parser_invalid_external_entity');
  if (format === 'svg' && /(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|file:|data:)/i.test(text)) throw parserError('parser_invalid_external_link');
  let elements = 0; let characters = 0; let root = '';
  try {
    const parser = new SaxesParser({ xmlns: true });
    parser.on('opentag', (tag) => { elements += 1; root ||= String(tag.local || tag.name || ''); if (elements > limits.max_cells) throw parserError('parser_quota_nodes'); });
    parser.on('text', (value) => { characters += value.length; });
    parser.write(text).close();
  } catch (error) { if (error?.code) throw error; throw parserError('parser_invalid_xml'); }
  return output(Buffer.from(canonicalJson({ format, root, elements, characters }), 'utf8'), 'application/json', { format, root, elements, characters });
}

async function parseOfficeDocument(bytes, format, limits, signal) {
  let ast;
  try {
    ast = await parseOffice(bytes, {
      fileType: format,
      extractAttachments: true,
      includeRawContent: false,
      ocr: false,
      abortSignal: signal || null,
      decompressionLimits: { maxUncompressedBytes: limits.max_expanded_bytes, maxZipEntries: limits.max_archive_entries, maxTableCells: limits.max_cells }
    });
  } catch (error) {
    const message = String(error?.message || error).toLowerCase();
    if (message.includes('limit') || message.includes('size') || message.includes('entries')) throw parserError('parser_quota_document');
    throw parserError('parser_invalid_document');
  }
  const text = String(ast?.toText?.() || '');
  if (text.length > limits.max_text_chars) throw parserError('parser_quota_text');
  const content = Array.isArray(ast?.content) ? ast.content : [];
  const counts = countOfficeNodes(content);
  const pageCount = numericMetadata(ast?.metadata, ['pageCount', 'pages', 'numPages']);
  const slideCount = format === 'pptx' ? Math.max(pageCount, counts.slides) : 0;
  if (format === 'pdf' && pageCount > limits.max_pdf_pages) throw parserError('parser_quota_pages');
  if (format === 'pptx' && slideCount > limits.max_slides) throw parserError('parser_quota_slides');
  if (counts.cells > limits.max_cells) throw parserError('parser_quota_cells');
  const attachments = Array.isArray(ast?.attachments) ? ast.attachments.slice(0, limits.max_images) : [];
  const metadata = { format, characters: text.length, pages: pageCount, slides: slideCount, cells: counts.cells, images: Math.min(counts.images + attachments.length, limits.max_images) };
  return output(Buffer.from(text, 'utf8'), 'text/plain', metadata);
}

async function parseImage(bytes, format) {
  let image;
  try { image = await loadImage(bytes); } catch { throw parserError('parser_invalid_image'); }
  const metadata = { format, width: Number(image.width || 0), height: Number(image.height || 0), frames: format === 'gif' ? null : 1 };
  return output(Buffer.from(canonicalJson(metadata), 'utf8'), 'application/json', metadata);
}

async function parseMedia(bytes, format, limits) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-parser-media-'));
  const file = path.join(root, format === 'audio' ? 'input.audio' : 'input.video');
  try {
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    let probe;
    try {
      const result = await execFileAsync(ffprobe.path, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { encoding: 'utf8', timeout: Math.min(120000, limits.deadline_seconds * 1000), windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      probe = JSON.parse(result.stdout || '{}');
    } catch { throw parserError('parser_invalid_media'); }
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const expected = format === 'audio' ? 'audio' : 'video';
    if (!streams.some((stream) => stream.codec_type === expected)) throw parserError('parser_media_signature_mismatch');
    const duration = Math.max(Number(probe.format?.duration || 0), ...streams.map((stream) => Number(stream.duration || 0)).filter(Number.isFinite));
    if (!Number.isFinite(duration) || duration < 0) throw parserError('parser_invalid_media');
    if (duration > limits.max_media_seconds) throw parserError('parser_quota_media_duration');
    const publicStreams = streams.slice(0, 32).map((stream) => ({ type: String(stream.codec_type || ''), codec: String(stream.codec_name || ''), width: Number(stream.width || 0), height: Number(stream.height || 0), channels: Number(stream.channels || 0), language: String(stream.tags?.language || '').slice(0, 32) }));
    const metadata = {
      format,
      duration_seconds: Number(duration.toFixed(3)),
      streams: publicStreams,
      embedded_subtitles: publicStreams.filter((stream) => stream.type === 'subtitle').map((stream) => ({ codec: stream.codec, language: stream.language })),
      waveform: sampledWaveform(bytes, 64),
      keyframes: format === 'video' ? sampleTimes(duration, Math.min(20, Math.max(1, Math.ceil(duration / 60)))) : []
    };
    return output(Buffer.from(canonicalJson(metadata), 'utf8'), 'application/json', metadata);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function parseArchive(bytes, format, limits) {
  const metadata = await runArchiveWorker(bytes, format, limits);
  return output(Buffer.from(canonicalJson(metadata), 'utf8'), 'application/json', metadata);
}

function runArchiveWorker(bytes, format, limits) {
  const workerPath = fileURLToPath(new URL('./archive-worker.mjs', import.meta.url));
  const input = Uint8Array.from(bytes);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: { bytes: input.buffer, format, limits },
      transferList: [input.buffer],
      execArgv: process.execArgv.filter((argument) => !String(argument).startsWith('--input-type')),
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 }
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(parserError('parser_deadline_exceeded'));
    }, Math.max(1000, Number(limits.deadline_seconds || 60) * 1000));
    timer.unref?.();
    worker.once('message', (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (message?.status === 'ok') resolve(message.metadata);
      else reject(parserError(String(message?.error_code || 'parser_invalid_archive')));
    });
    worker.once('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(parserError(String(error?.code || 'parser_archive_worker_failed'))); } });
    worker.once('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); reject(parserError(code === 0 ? 'parser_archive_worker_empty' : 'parser_archive_worker_failed')); } });
  });
}

function output(bytes, mediaType, metadata = {}) { return { outputs: [{ kind: 'parsed', bytes: Buffer.from(bytes), media_type: mediaType, metadata }] , metadata }; }
function terminal(status, errorCode) { return { status, error_code: errorCode, outputs: [], metadata: {} }; }
function normalizeOutputs(values, limits) {
  if (!Array.isArray(values) || values.length > limits.max_images + 4) throw parserError('parser_quota_outputs');
  let total = 0;
  return values.map((value, index) => {
    const bytes = Buffer.from(value.bytes || []); total += bytes.byteLength;
    if (total > limits.max_expanded_bytes) throw parserError('parser_quota_expanded_bytes');
    return { kind: String(value.kind || `output_${index + 1}`).slice(0, 80), bytes, media_type: String(value.media_type || 'application/octet-stream').slice(0, 160), content_sha256: sha256Hex(bytes), byte_length: bytes.byteLength, metadata: value.metadata && typeof value.metadata === 'object' ? value.metadata : {} };
  });
}
function normalizeLimits(value = {}) {
  const merged = { ...DEFAULT_PARSER_LIMITS, ...(value && typeof value === 'object' ? value : {}) };
  for (const [key, maximum] of Object.entries(DEFAULT_PARSER_LIMITS)) {
    const number = Number(merged[key]);
    if (!Number.isInteger(number) || number < 1 || number > maximum) throw parserError('parser_quota_invalid');
    merged[key] = number;
  }
  return Object.freeze(merged);
}
function decodeUtf8(bytes) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw parserError('parser_invalid_utf8'); } }
function signatureMismatch(bytes, format) {
  const expected = SIGNATURES[format]; if (!expected) return false;
  const prefix = bytes.subarray(0, 16).toString('hex');
  if (format === 'webp') return !(prefix.startsWith('52494646') && bytes.subarray(8, 12).toString('ascii') === 'WEBP');
  return !expected.some((signature) => prefix.startsWith(signature));
}
function countOfficeNodes(nodes) { const result = { cells: 0, images: 0, slides: 0 }; const stack = [...nodes]; while (stack.length) { const node = stack.pop() || {}; const type = String(node.type || '').toLowerCase(); if (type.includes('cell')) result.cells += 1; if (type.includes('image')) result.images += 1; if (type.includes('slide') || type === 'page') result.slides += 1; for (const key of ['children', 'content']) if (Array.isArray(node[key])) stack.push(...node[key]); } return result; }
function numericMetadata(value, keys) { for (const key of keys) { const number = Number(value?.[key]); if (Number.isFinite(number) && number >= 0) return number; } return 0; }
function lineCount(text) { return text ? text.split(/\r?\n/).length : 0; }
function sampledWaveform(bytes, count) { if (!bytes.length) return []; const width = Math.max(1, Math.floor(bytes.length / count)); const values = []; for (let offset = 0; offset < bytes.length && values.length < count; offset += width) { const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + width)); let sum = 0; for (const byte of chunk) sum += Math.abs(byte - 128); values.push(Number((sum / Math.max(1, chunk.length) / 128).toFixed(4))); } return values; }
function sampleTimes(duration, count) { return Array.from({ length: count }, (_, index) => Number((((index + 1) * duration) / (count + 1)).toFixed(3))); }
function withDeadline(promise, milliseconds, externalSignal) { return new Promise((resolve, reject) => { let settled = false; const timer = setTimeout(() => { if (!settled) reject(parserError('parser_deadline_exceeded')); }, milliseconds); timer.unref?.(); const cancel = () => { if (!settled) reject(parserError('parser_cancelled')); }; externalSignal?.addEventListener?.('abort', cancel, { once: true }); Promise.resolve(promise).then((value) => { settled = true; clearTimeout(timer); externalSignal?.removeEventListener?.('abort', cancel); resolve(value); }, (error) => { settled = true; clearTimeout(timer); externalSignal?.removeEventListener?.('abort', cancel); reject(error); }); }); }
function parserError(code) { const error = new Error(code); error.code = code; return error; }
