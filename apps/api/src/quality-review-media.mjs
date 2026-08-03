import path from 'node:path';

const OUT_OF_SCOPE_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.pptx',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar',
  '.xls'
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.html', '.htm']);
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

export function qualityReviewMediaKind(filePath, mediaType, { hasBody = false } = {}) {
  const type = normalizeMediaType(mediaType),
    extension = path.extname(String(filePath || '')).toLowerCase(),
    kind = mediaKindFromType(type) || mediaKindFromExtension(extension);
  if (kind) return kind.startsWith('image/') ? 'image' : kind;
  if (GENERIC_TYPES.has(type)) return hasBody ? 'text' : 'probe';
  return 'out_of_scope';
}

export function resolveQualityReviewMediaKind(filePath, mediaType, bytes) {
  const type = normalizeMediaType(mediaType),
    extension = path.extname(String(filePath || '')).toLowerCase(),
    body = Buffer.from(bytes || []),
    declared = mediaKindFromType(type),
    named = mediaKindFromExtension(extension),
    signature = mediaKindFromSignature(body);
  if (!body.length) throw mediaError('quality_review_file_empty', { path: String(filePath || '') });
  assertCompatibleMediaKinds(declared, named, signature);
  const kind = declared || signatureKindForNamed(signature, named) || named || signature || 'out_of_scope';
  assertRequiredSignature(kind, signature);
  return kind;
}

function assertCompatibleMediaKinds(declared, named, signature) {
  assertMediaPair(declared, named, { declared_kind: declared, extension_kind: named });
  assertMediaPair(declared, signature, { declared_kind: declared, signature_kind: signature });
  if (!declared) assertMediaPair(named, signature, { extension_kind: named, signature_kind: signature });
}

function assertMediaPair(left, right, details) {
  if (left && right && !compatibleKinds(left, right)) throw mediaError('quality_review_media_type_conflict', details);
}

function mediaKindFromType(type) {
  if (GENERIC_TYPES.has(type)) return null;
  if (isPdf(type, '')) return 'pdf';
  if (isDocx(type, '')) return 'docx';
  if (isXlsx(type, '')) return 'xlsx';
  if (isJson(type, '')) return 'json';
  if (isXml(type, '')) return 'xml';
  if (IMAGE_TYPES.has(type)) return imageKind(type);
  if (isText(type, '')) return 'text';
  if (isOutOfScope(type, '')) return 'out_of_scope';
  return null;
}

function mediaKindFromExtension(extension) {
  if (!extension) return null;
  if (extension === '.pdf') return 'pdf';
  if (extension === '.docx') return 'docx';
  if (extension === '.xlsx') return 'xlsx';
  if (extension === '.json') return 'json';
  if (['.xml', '.svg'].includes(extension)) return 'xml';
  if (IMAGE_EXTENSIONS.has(extension)) return imageKind(extension);
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (OUT_OF_SCOPE_EXTENSIONS.has(extension)) return 'out_of_scope';
  return null;
}

function mediaKindFromSignature(bytes) {
  return SIGNATURE_MATCHERS.find((item) => item.matches(bytes))?.kind || null;
}

const SIGNATURE_MATCHERS = Object.freeze([
  { kind: 'image/png', matches: hasPngSignature },
  { kind: 'image/jpeg', matches: hasJpegSignature },
  { kind: 'image/gif', matches: hasGifSignature },
  { kind: 'image/webp', matches: hasWebpSignature },
  { kind: 'pdf', matches: hasPdfSignature },
  { kind: 'zip', matches: hasZipSignature }
]);

function hasPngSignature(bytes) {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function hasJpegSignature(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function hasGifSignature(bytes) {
  return bytes.length >= 6 && /GIF8[79]a/.test(bytes.toString('ascii', 0, 6));
}

function hasWebpSignature(bytes) {
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

function hasPdfSignature(bytes) {
  return bytes.length >= 5 && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
}

function hasZipSignature(bytes) {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
}

function signatureKindForNamed(signature, named) {
  return signature === 'zip' && ['docx', 'xlsx'].includes(named) ? named : null;
}

function compatibleKinds(left, right) {
  if (left === right) return true;
  if (left === 'out_of_scope' || right === 'out_of_scope') return false;
  if (left === 'zip') return ['docx', 'xlsx'].includes(right);
  if (right === 'zip') return ['docx', 'xlsx'].includes(left);
  return false;
}

function assertRequiredSignature(kind, signature) {
  if (kind === 'pdf' && signature !== 'pdf') throw mediaError('quality_review_pdf_invalid');
  if (kind === 'docx' && signature !== 'zip') throw mediaError('quality_review_docx_invalid');
  if (kind === 'xlsx' && signature !== 'zip') throw mediaError('quality_review_xlsx_invalid');
  if (kind.startsWith('image/') && signature !== kind) throw mediaError('quality_review_image_invalid');
}

function imageKind(value) {
  const normalized = String(value).toLowerCase();
  if (normalized === '.jpg' || normalized === '.jpeg' || normalized === 'image/jpg') return 'image/jpeg';
  if (normalized.startsWith('.')) return `image/${normalized.slice(1)}`;
  return normalized;
}

function mediaError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function isPdf(type, extension) {
  return type === 'application/pdf' || extension === '.pdf';
}

function isDocx(type, extension) {
  return type.includes('wordprocessingml') || extension === '.docx';
}

function isXlsx(type, extension) {
  return type.includes('spreadsheetml') || extension === '.xlsx';
}

function isJson(type, extension) {
  return type === 'application/json' || extension === '.json';
}

function isXml(type, extension) {
  return ['application/xml', 'text/xml', 'image/svg+xml'].includes(type) || ['.xml', '.svg'].includes(extension);
}

function isImage(type, extension) {
  return IMAGE_TYPES.has(type) || IMAGE_EXTENSIONS.has(extension);
}

function isText(type, extension) {
  return type.startsWith('text/') || type.includes('markdown') || TEXT_EXTENSIONS.has(extension);
}

function normalizeMediaType(value) {
  return String(value || '')
    .toLowerCase()
    .split(';', 1)[0]
    .trim();
}

function isOutOfScope(type, extension) {
  return (
    type.startsWith('audio/') ||
    type.startsWith('video/') ||
    type.includes('presentation') ||
    type === 'application/zip' ||
    type === 'application/vnd.ms-excel' ||
    OUT_OF_SCOPE_EXTENSIONS.has(extension)
  );
}
