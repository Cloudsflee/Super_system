// Owner: Frontend/Platform. Phase: P10+ maintenance_gate.
// Input is limited to apps/web/dist/assets and index-*.js is the only entry.
// The gate fails when the uncompressed entry exceeds 409600 bytes.
import { gzipSync } from 'node:zlib';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const dist = resolve('apps/web/dist/assets');
const files = (await readdir(dist)).filter((file) => file.endsWith('.js'));
const entry = files.filter((file) => /^index-[^/]+\.js$/.test(file));
if (entry.length !== 1) throw new Error(`Expected one index entry chunk, found ${entry.length}`);
const sizes = await Promise.all(files.map(async (file) => {
  const bytes = await readFile(join(dist, file));
  return { file, bytes: bytes.byteLength, gzip: gzipSync(bytes, { level: 9 }).byteLength };
}));
const entrySize = sizes.find((item) => item.file === entry[0]);
const asyncChunks = sizes.filter((item) => item.file !== entry[0]).sort((a, b) => b.bytes - a.bytes);
console.log(JSON.stringify({ entry: entrySize, largestAsync: asyncChunks[0] || null, chunks: sizes.sort((a, b) => a.file.localeCompare(b.file)) }, null, 2));
if (entrySize.bytes > 409600) throw new Error(`Web entry chunk exceeds 409600 bytes: ${entrySize.bytes}`);
