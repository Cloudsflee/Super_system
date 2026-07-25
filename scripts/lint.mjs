import fs from 'node:fs';
import path from 'node:path';

const roots = ['apps', 'packages', 'tests', 'scripts'];
const jsFiles = roots.flatMap((root) => walk(root)).filter((file) => /\.(mjs|js|ts|tsx)$/.test(file));
const tooLong = [];
const uiViolations = [];
for (const file of jsFiles) {
  const source = fs.readFileSync(file, 'utf8'),
    lines = source.split(/\r?\n/).length;
  if (lines > 260) tooLong.push(`${file}: ${lines}`);
  if (/apps[\\/]web[\\/]src[\\/].*\.tsx$/.test(file)) {
    if (/<(?:button|span|div|small|code)\b[^>]*\btitle=/.test(source))
      uiViolations.push(`${file}: native title attribute`);
    for (const match of source.matchAll(/<button\b([^>]*)>\s*<[A-Z][A-Za-z0-9]*\b[^>]*\/>\s*<\/button>/g))
      if (!/aria-label=/.test(match[1])) uiViolations.push(`${file}: bare icon button without aria-label`);
  }
}
if (tooLong.length) throw new Error(`files too long:\n${tooLong.join('\n')}`);
if (uiViolations.length) throw new Error(`icon/tooltip gate failed:\n${uiViolations.join('\n')}`);
console.log(`lint passed (${jsFiles.length} js modules, max <= 260 lines)`);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'coverage'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
