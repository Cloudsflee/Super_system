import { parentPort } from 'node:worker_threads';

import { resolveQualityReviewMediaKind } from './quality-review-media.mjs';
import { extractText } from './quality-review-parser-worker-formats.mjs';
import { assertValidImage, gifFrames, imageInfo } from './quality-review-parser-worker-images.mjs';
import { normalizeText, qualityError } from './quality-review-parser-worker-utils.mjs';

parentPort.on('message', async (message) => {
  try {
    parentPort.postMessage({ ok: true, result: await parseAsset(message) });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: serializeError(error) });
  }
});

async function parseAsset(input) {
  const files = normalizeFiles(input.files),
    parsed = [],
    maxImageCount = resolveImageLimit(input),
    result = { imageCount: 0, outOfScope: [], limitations: [], reviewImages: [] };
  if (!files.length) throw qualityError('quality_review_asset_empty');
  if (files.length > 1024) throw qualityError('quality_review_file_count_exceeded', { max_files: 1024 });
  for (const file of files) {
    const parsedFile = await parseFile(file, maxImageCount - result.imageCount);
    if (parsedFile.kind === 'out_of_scope') {
      result.outOfScope.push({ path: file.path, reason: 'format_not_supported' });
      parsed.push(publicFile(file, parsedFile));
      continue;
    }
    result.imageCount += parsedFile.imageCount;
    assertImageLimit(result.imageCount, maxImageCount);
    result.limitations.push(...parsedFile.limitations);
    result.reviewImages.push(...parsedFile.reviewImages);
    parsed.push(publicFile(file, parsedFile));
  }
  const normalizedText = buildNormalizedDocument(parsed);
  if (normalizedText.length > Number(input.max_normalized_text_chars || 240_000))
    throw qualityError('quality_review_normalized_text_exceeded', {
      max_chars: Number(input.max_normalized_text_chars || 240_000)
    });
  return {
    files: parsed,
    normalized_text: normalizedText,
    image_count: result.imageCount,
    review_images: result.reviewImages,
    out_of_scope: result.outOfScope,
    limitations: [...new Set(result.limitations)]
  };
}

function normalizeFiles(files) {
  return (files || []).map((item) => ({
    path: safeFilePath(item.path),
    media_type: String(item.media_type || 'application/octet-stream'),
    bytes: Buffer.from(item.bytes)
  }));
}

function resolveImageLimit(input) {
  return Number.isInteger(input.max_direct_images) ? Math.max(0, input.max_direct_images) : Number.POSITIVE_INFINITY;
}

async function parseFile(file, remainingImageCount) {
  const resolvedKind = resolveQualityReviewMediaKind(file.path, file.media_type, file.bytes),
    kind = resolvedKind.startsWith('image/') ? 'image' : resolvedKind;
  if (kind === 'out_of_scope') return outOfScopeFile(kind);
  if (kind === 'image') return parseImageFile(file, resolvedKind);
  const extracted = await extractText(file, kind, remainingImageCount),
    text = String(extracted.text || ''),
    imageCount = Number(extracted.image_count || 0),
    segments = normalizeSegments(extracted.segments, text);
  if (!text.trim() && !imageCount) throw qualityError('quality_review_empty_content', { path: file.path });
  return {
    kind,
    text,
    imageCount,
    limitations: extracted.limitations || [],
    reviewImages: extracted.review_images || [],
    scanPageCount: Number(extracted.scan_page_count || 0),
    segments
  };
}

function outOfScopeFile(kind) {
  return { kind, imageCount: 0, limitations: [], reviewImages: [], text: '', scanPageCount: 0 };
}

async function parseImageFile(file, resolvedMediaType) {
  await assertValidImage(file.bytes, resolvedMediaType);
  const frameCount = resolvedMediaType === 'image/gif' ? Math.max(1, gifFrames(file.bytes)) : 1,
    limitations = ['图片仅提供给具备视觉能力的 Reviewer；解析器不伪造 OCR 文本。'];
  if (frameCount > 1) limitations.push('GIF 动画仅按静态帧评审。');
  return {
    kind: 'image',
    imageCount: 1,
    image: imageInfo(file.bytes, resolvedMediaType),
    limitations,
    reviewImages: [{ path: file.path, media_type: resolvedMediaType, bytes: file.bytes }],
    text: '',
    scanPageCount: 0,
    segments: [{ locator: 'frame:1', text: '' }]
  };
}

function publicFile(file, parsed) {
  const value = {
    path: file.path,
    media_type: file.media_type,
    size_bytes: file.bytes.length,
    kind: parsed.kind,
    text: parsed.text || ''
  };
  if (parsed.image) value.image = parsed.image;
  if (parsed.scanPageCount) value.scan_page_count = parsed.scanPageCount;
  value.segments = parsed.segments || [];
  return value;
}

function buildNormalizedDocument(files) {
  const lines = [];
  let textFileCount = 0;
  for (const file of files) {
    const textSegments = file.segments.filter((segment) => String(segment.text || '').length > 0);
    if (textSegments.length) {
      if (textFileCount) lines.push('', `--- ${file.path} ---`, '');
      textFileCount += 1;
    }
    for (const segment of file.segments) {
      const text = normalizeText(segment.text || '');
      if (!text) continue;
      segment.global_line = lines.length + 1;
      if (!segment.locator) segment.locator = `line:${segment.global_line}`;
      lines.push(...text.split('\n'));
      segment.text = text;
    }
  }
  return lines.join('\n').trim();
}

function normalizeSegments(segments, fallbackText) {
  const values = Array.isArray(segments) ? segments : [];
  if (values.length)
    return values.map((segment) => ({
      locator: segment?.locator ? String(segment.locator).slice(0, 500) : null,
      text: normalizeText(segment?.text || '')
    }));
  const text = normalizeText(fallbackText);
  return text ? text.split('\n').map((line) => ({ locator: null, text: line })) : [];
}

function safeFilePath(value) {
  const candidate = String(value || 'payload.bin').replaceAll('\\', '/');
  if (
    !candidate ||
    candidate.startsWith('/') ||
    /^[A-Za-z]:/.test(candidate) ||
    candidate.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\0\r\n]/.test(candidate)
  )
    throw qualityError('quality_review_file_path_invalid');
  return candidate.slice(0, 2000);
}

function assertImageLimit(actual, maximum) {
  if (actual <= maximum) return;
  throw qualityError('quality_review_image_count_exceeded', { max_images: maximum });
}

function serializeError(error) {
  return {
    code: error.code || 'quality_review_parse_failed',
    message: error.message,
    details: error.details || {},
    retryable: error.retryable === true
  };
}
