import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

import { readCasBlob, verifyAssetVersionPayload } from './asset-cas.mjs';

export const QUALITY_REVIEW_LIMITS = Object.freeze({
  max_assets: 16,
  max_file_bytes: 25 * 1024 * 1024,
  max_total_bytes: 100 * 1024 * 1024,
  max_normalized_text_chars: 240_000,
  max_direct_images: 20,
  parser_timeout_ms: 15_000
});

export const QUALITY_REVIEW_WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4
});

export async function parseQualityReviewAsset(
  state,
  asset,
  version,
  {
    timeoutMs = QUALITY_REVIEW_LIMITS.parser_timeout_ms,
    maxImageCount = QUALITY_REVIEW_LIMITS.max_direct_images,
    signal = null
  } = {}
) {
  throwIfAborted(signal);
  await assertAssetIntegrity(state, version);
  const entries = await loadAssetEntries(state, version),
    rawSizeBytes = validateEntryLimits(entries),
    result = await runParserWorkerWithRetry(
      {
        files: entries,
        max_direct_images: maxImageCount,
        max_normalized_text_chars: QUALITY_REVIEW_LIMITS.max_normalized_text_chars
      },
      timeoutMs,
      signal
    ),
    normalizedText = String(result.normalized_text || ''),
    normalizedTextSha256 = normalizedText ? digest(normalizedText) : null,
    files = result.files || [],
    anchors = buildAnchors(asset, version, files),
    reviewImages = deduplicateReviewImages(result.review_images || []);
  assertAnchorsResolvable(version, files, anchors);
  throwIfAborted(signal);
  return buildParsedAsset(
    asset,
    version,
    entries,
    rawSizeBytes,
    result,
    normalizedText,
    normalizedTextSha256,
    files,
    anchors,
    reviewImages
  );
}

async function assertAssetIntegrity(state, version) {
  const verification = await verifyAssetVersionPayload(state, version);
  if (verification.ok) return;
  const error = new Error('quality_review_asset_integrity_failed');
  error.code = 'quality_review_asset_integrity_failed';
  error.details = { reasons: verification.reasons };
  throw error;
}

async function loadAssetEntries(state, version) {
  const entries = await Promise.all(
    (version.manifest?.entries || [])
      .filter((item) => item?.role !== 'manifest' && item?.path !== 'manifest.json')
      .map(async (entry) => {
        const blob = state.asset_blobs.find((item) => item.sha256 === entry.sha256);
        if (!blob) throw qualityParseError('quality_review_asset_blob_missing', { sha256: entry.sha256 });
        return { path: entry.path, media_type: entry.media_type, bytes: await readCasBlob(blob, { state }) };
      })
  );
  if (entries.length || version.body == null) return entries;
  return [
    {
      path: version.title || 'payload.txt',
      media_type: version.media_type || 'text/plain',
      bytes: Buffer.from(String(version.body))
    }
  ];
}

function validateEntryLimits(entries) {
  if (!entries.length) throw qualityParseError('quality_review_asset_empty');
  if (entries.length > 1024) throw qualityParseError('quality_review_file_count_exceeded', { max_files: 1024 });
  if (entries.some((entry) => entry.bytes.length === 0)) throw qualityParseError('quality_review_file_empty');
  if (entries.some((entry) => entry.bytes.length > QUALITY_REVIEW_LIMITS.max_file_bytes))
    throw qualityParseError('quality_review_file_size_exceeded', {
      max_bytes: QUALITY_REVIEW_LIMITS.max_file_bytes
    });
  const rawSizeBytes = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  if (rawSizeBytes > QUALITY_REVIEW_LIMITS.max_total_bytes)
    throw qualityParseError('quality_review_total_size_exceeded', {
      max_bytes: QUALITY_REVIEW_LIMITS.max_total_bytes
    });
  return rawSizeBytes;
}

function buildParsedAsset(
  asset,
  version,
  entries,
  rawSizeBytes,
  result,
  normalizedText,
  normalizedTextSha256,
  files,
  anchors,
  reviewImages
) {
  return {
    asset_id: asset.id,
    asset_version_id: version.id,
    title: asset.title || version.title || version.id,
    content_sha256: version.content_sha256,
    media_type: version.media_type || entries[0].media_type || 'application/octet-stream',
    size_bytes: Number(version.size_bytes || rawSizeBytes),
    raw_size_bytes: rawSizeBytes,
    normalized_text: normalizedText,
    normalized_text_sha256: normalizedTextSha256,
    normalized_text_length: normalizedText.length,
    image_count: Number(result.image_count || 0),
    out_of_scope: result.out_of_scope || [],
    limitations: result.limitations || [],
    files,
    review_images: reviewImages,
    anchors
  };
}

export function buildAnchors(_asset, version, files) {
  const anchors = [];
  for (const file of files) {
    if (file.kind === 'out_of_scope') continue;
    for (const [index, segment] of (file.segments || []).entries()) {
      if (anchors.length >= 500) return anchors;
      const locator = String(segment.locator || '').trim();
      if (!locator) continue;
      const excerpt = String(segment.text || '');
      anchors.push({
        anchor_id: `${version.id}:${safeAnchorPath(file.path)}:${safeAnchorPath(locator)}:${index + 1}`,
        asset_version_id: version.id,
        path: file.path,
        locator,
        excerpt_sha256: excerpt ? digest(excerpt) : null
      });
    }
  }
  return anchors;
}

export function qualityReviewAnchorResolves(version, files, anchor) {
  if (anchor?.asset_version_id !== version?.id) return false;
  const file = files.find((item) => item.path === anchor.path);
  if (!file) return false;
  return (file.segments || []).some((segment) => {
    if (segment.locator !== anchor.locator) return false;
    const excerpt = String(segment.text || '');
    return (excerpt ? digest(excerpt) : null) === anchor.excerpt_sha256;
  });
}

function assertAnchorsResolvable(version, files, anchors) {
  if (anchors.every((anchor) => qualityReviewAnchorResolves(version, files, anchor))) return;
  throw qualityParseError('quality_review_anchor_unresolvable');
}

async function runParserWorkerWithRetry(input, timeoutMs, signal = null) {
  try {
    return await runParserWorker(input, timeoutMs, signal);
  } catch (error) {
    if (!error.retryable || signal?.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return runParserWorker(input, timeoutMs, signal);
  }
}

function runParserWorker(input, timeoutMs, signal = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./quality-review-parser-worker.mjs', import.meta.url), {
      resourceLimits: QUALITY_REVIEW_WORKER_RESOURCE_LIMITS
    });
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void terminateWorker(worker).then(() => reject(qualityParseError('quality_review_cancelled')));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      const error = qualityParseError('quality_review_parser_timeout');
      error.retryable = true;
      void terminateWorker(worker).then(() => reject(error));
    }, timeoutMs);
    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void terminateWorker(worker).then(() => callback(value));
    };
    worker.once(
      'message',
      finish((message) => {
        if (message?.ok) resolve(message.result);
        else {
          const error = qualityParseError(message?.error?.code || 'quality_review_parse_failed', message?.error);
          error.retryable = Boolean(message?.error?.retryable);
          reject(error);
        }
      })
    );
    worker.once(
      'error',
      finish((error) => {
        const failure = qualityParseError(error.code || 'quality_review_parser_worker_failed');
        failure.retryable = true;
        reject(failure);
      })
    );
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const failure = qualityParseError(
        code === 0 ? 'quality_review_parser_worker_no_result' : 'quality_review_parser_worker_exited',
        { code }
      );
      failure.retryable = code !== 0;
      reject(failure);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    worker.postMessage(input);
  });
}

async function terminateWorker(worker) {
  worker.removeAllListeners();
  await worker.terminate().catch(() => undefined);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw qualityParseError('quality_review_cancelled');
}

function safeAnchorPath(value) {
  return String(value || 'file')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 100);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deduplicateReviewImages(images) {
  const seen = new Set();
  return images.filter((image) => {
    const key = `${image.path || ''}:${image.media_type || ''}:${digest(image.bytes)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function qualityParseError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
