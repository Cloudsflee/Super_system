import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { STAGING_DIR } from './config.mjs';
import { HttpError } from './http.mjs';
import { assertWithin, safeSegment } from './managed-workspace.mjs';

export async function stageMultipartSources(projectId, body, operationKey) {
  const files = Array.isArray(body?._files) ? body._files : [];
  if (!files.length) return null;
  const root = path.join(
    STAGING_DIR,
    'uploads',
    safeSegment(projectId),
    `${safeSegment(operationKey)}-${crypto.randomBytes(6).toString('hex')}`
  );
  assertWithin(STAGING_DIR, root);
  await fsp.mkdir(root, { recursive: true });
  try {
    const codeParts = files.filter((item) => ['code_archive', 'code_file', 'code_files'].includes(item.name));
    const contextParts = files.filter((item) => ['context_file', 'context_files'].includes(item.name));
    let codeSource = null;
    if (codeParts.length === 1 && (codeParts[0].name === 'code_archive' || isArchive(codeParts[0].filename))) {
      const target = path.join(root, `code${archiveExtension(codeParts[0].filename)}`);
      await writePart(target, codeParts[0]);
      codeSource = { type: 'archive', path: target };
    } else if (codeParts.length) {
      const directory = path.join(root, 'directory'),
        names = stripSharedRoot(codeParts.map((item) => uploadPath(item.filename)));
      for (let index = 0; index < codeParts.length; index++)
        await writePart(path.join(directory, names[index]), codeParts[index], directory);
      codeSource = { type: 'local_directory', path: directory };
    }
    const contextSources = [];
    for (let index = 0; index < contextParts.length; index++) {
      const name = uploadPath(contextParts[index].filename),
        target = path.join(root, 'contexts', `${index}-${path.basename(name)}`);
      await writePart(target, contextParts[index], path.join(root, 'contexts'));
      contextSources.push({ type: contextKind(contextParts[index]), path: target, label: path.basename(name) });
    }
    if (!codeSource && !contextSources.length) throw new HttpError(400, { error: 'multipart_import_files_required' });
    return {
      code_source: codeSource,
      context_sources: contextSources,
      cleanup: () => fsp.rm(root, { recursive: true, force: true })
    };
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function writePart(target, part, boundary = path.dirname(target)) {
  assertWithin(boundary, target);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, part.data, { mode: 0o600 });
}
function uploadPath(value) {
  const name = String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
  if (
    !name ||
    name.length > 2000 ||
    name.startsWith('/') ||
    /^[A-Za-z]:\//.test(name) ||
    name.split('/').includes('..') ||
    /[\0\r\n]/.test(name)
  )
    throw new HttpError(400, { error: 'upload_path_invalid' });
  return name;
}
function stripSharedRoot(names) {
  const roots = new Set(names.map((item) => item.split('/')[0]));
  return roots.size === 1 && names.every((item) => item.includes('/'))
    ? names.map((item) => item.slice(item.indexOf('/') + 1))
    : names;
}
function isArchive(value) {
  return /\.(?:zip|tar|tar\.gz|tgz)$/i.test(String(value || ''));
}
function archiveExtension(value) {
  const match = String(value || '')
    .toLowerCase()
    .match(/(\.tar\.gz|\.tgz|\.zip|\.tar)$/);
  return match?.[1] || '.tar';
}
function contextKind(part) {
  const type = String(part.content_type || '');
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (/wordprocessingml/.test(type)) return 'docx';
  if (/spreadsheetml/.test(type)) return 'xlsx';
  return 'file';
}
