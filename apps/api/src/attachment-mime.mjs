import path from 'node:path';

export function sniffMime(head, filename, declared = 'application/octet-stream') {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (head.subarray(0, 4).toString('ascii') === 'OggS') return declared.startsWith('video/') ? 'video/ogg' : 'audio/ogg';
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (head.subarray(0, 3).toString('ascii') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (head.subarray(4, 8).toString('ascii') === 'ftyp') return /^audio\//.test(declared) ? 'audio/mp4' : 'video/mp4';
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return /^audio\//.test(declared) ? 'audio/webm' : 'video/webm';
  const ext = path.extname(filename).toLowerCase();
  if (head[0] === 0x50 && head[1] === 0x4b) return ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : ext === '.pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/zip';
  if (looksText(head)) return ext === '.md' ? 'text/markdown' : ext === '.csv' ? 'text/csv' : ext === '.json' ? 'application/json' : normalizeTextMime(declared);
  return 'application/octet-stream';
}

export function previewKind(mime, filename = '') {
  const ext = path.extname(filename).toLowerCase();
  if (mime.startsWith('image/')) return mime === 'image/svg+xml' ? 'text' : 'image';
  if (mime.startsWith('audio/')) return 'audio'; if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf'; if (mime.includes('wordprocessingml') || ext === '.docx') return 'docx'; if (mime.includes('spreadsheetml') || ext === '.xlsx') return 'xlsx'; if (mime.includes('presentationml') || ext === '.pptx') return 'metadata';
  if (mime === 'text/markdown' || ext === '.md') return 'markdown'; if (mime === 'text/csv' || ext === '.csv') return 'csv'; if (mime === 'application/json' || ext === '.json') return 'json'; if (mime.startsWith('text/') || /(?:javascript|typescript|xml|yaml)/.test(mime)) return 'text';
  return 'metadata';
}

function normalizeTextMime(declared) { const mime = normalizeMime(declared); return mime.startsWith('text/') || /(?:json|javascript|typescript|xml|yaml|markdown)/.test(mime) ? mime : 'text/plain'; }
function normalizeMime(value) { const mime = String(value || '').toLowerCase().split(';')[0].trim(); return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : 'application/octet-stream'; }
function looksText(buffer) { if (!buffer.length) return true; let controls = 0; for (const value of buffer) { if (value === 0) return false; if (value < 9 || (value > 13 && value < 32)) controls++; } return controls / buffer.length < 0.02; }
