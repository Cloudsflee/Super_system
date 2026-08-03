import fs from 'node:fs';
import path from 'node:path';

export function modulePathFor(packageName, relative) {
  const candidates = [
    path.join(process.cwd(), 'node_modules', packageName, ...relative),
    path.join(process.cwd(), 'apps', 'web', 'node_modules', packageName, ...relative)
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw qualityError('quality_review_parser_dependency_missing', { package: packageName });
  return found;
}

export function decodeUtf8(bytes) {
  return Buffer.from(bytes)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\0/g, '');
}

export function decodeUtf8Strict(bytes, errorCode) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    throw qualityError(errorCode);
  }
}

export function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function decodeXml(bytes) {
  return decodeUtf8(bytes)
    .replace(/<w:tab\s*\/?>(?:\r?\n)?/g, '\t')
    .replace(/<w:br\s*\/?>(?:\r?\n)?/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)));
}

export function qualityError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
