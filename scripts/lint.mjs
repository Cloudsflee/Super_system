import fs from 'node:fs';
import path from 'node:path';

const roots = ['apps', 'packages', 'tests', 'scripts'];
const jsFiles = roots.flatMap((root) => walk(root)).filter((file) => /\.(mjs|js|ts|tsx)$/.test(file));
const tooLong = [];
for (const file of jsFiles) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).length;
  if (lines > 220) tooLong.push(`${file}: ${lines}`);
}
if (tooLong.length) throw new Error(`files too long:\n${tooLong.join('\n')}`);
console.log(`lint passed (${jsFiles.length} js modules, max <= 220 lines)`);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'coverage'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
