import path from 'node:path';

const OUT_OF_SCOPE_EXTENSIONS = new Set([
  '.mp3', '.wav', '.m4a', '.mp4', '.mov', '.avi', '.mkv', '.pptx',
  '.zip', '.tar', '.gz', '.7z', '.rar', '.xls'
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.html', '.htm']);
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

export function qualityReviewMediaKind(filePath, mediaType, { hasBody = false } = {}) {
  const type = String(mediaType || '').toLowerCase().split(';', 1)[0].trim();
  const extension = path.extname(String(filePath || '')).toLowerCase();
  const kind = kindFromType(type) || kindFromExtension(extension);
  if (kind) return kind === 'image' ? 'image' : kind;
  if (GENERIC_TYPES.has(type)) return hasBody ? 'text' : 'probe';
  return 'out_of_scope';
}

function kindFromType(type) {
  if (GENERIC_TYPES.has(type)) return null;
  if (type === 'application/pdf') return 'pdf';
  if (type.includes('wordprocessingml')) return 'docx';
  if (type.includes('spreadsheetml')) return 'xlsx';
  if (type === 'application/json') return 'json';
  if (['application/xml', 'text/xml', 'image/svg+xml'].includes(type)) return 'xml';
  if (IMAGE_TYPES.has(type)) return 'image';
  if (type.startsWith('text/') || type.includes('markdown')) return 'text';
  if (type.startsWith('audio/') || type.startsWith('video/') || type.includes('presentation') || type === 'application/zip' || type === 'application/vnd.ms-excel') return 'out_of_scope';
  return null;
}

function kindFromExtension(extension) {
  if (extension === '.pdf') return 'pdf';
  if (extension === '.docx') return 'docx';
  if (extension === '.xlsx') return 'xlsx';
  if (extension === '.json') return 'json';
  if (['.xml', '.svg'].includes(extension)) return 'xml';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (OUT_OF_SCOPE_EXTENSIONS.has(extension)) return 'out_of_scope';
  return null;
}
