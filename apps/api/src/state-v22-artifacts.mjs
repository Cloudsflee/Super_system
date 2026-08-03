import fsp from 'node:fs/promises';
import path from 'node:path';

import { id, hashString, now } from '../../../packages/shared/index.mjs';
import { ARTIFACT_DIR, DATA_DIR } from './config-v22.mjs';
import { redactKnownSecrets } from './vault.mjs';

export async function saveArtifact(kind, name, content, meta = {}) {
  const dir = path.join(ARTIFACT_DIR, String(kind || 'artifact').replace(/[^\w-]/g, '_'));
  await fsp.mkdir(dir, { recursive: true });
  const fileName = `${Date.now()}_${String(name || 'artifact')
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
    .slice(0, 80)}`;
  const full = path.join(dir, fileName),
    serialized = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  await fsp.writeFile(full, await redactKnownSecrets(serialized), 'utf8');
  const bytes = await fsp.readFile(full);
  return {
    id: id('fil'),
    kind,
    absolute_path: full,
    relative_path: path.relative(path.dirname(DATA_DIR), full),
    sha256: hashString(bytes),
    size_bytes: bytes.length,
    content_type: fileName.endsWith('.json')
      ? 'application/json'
      : fileName.endsWith('.md')
        ? 'text/markdown'
        : 'text/plain',
    meta,
    created_at: now()
  };
}
