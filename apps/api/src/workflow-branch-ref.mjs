import { slugify } from '../../../packages/shared/index.mjs';

export function repositoryBranchSlug(workstream) {
  const title = asciiSlug(slugify(workstream.title, ''));
  return title || asciiSlug(workstream.id) || 'workstream';
}

function asciiSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
