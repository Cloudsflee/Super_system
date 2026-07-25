import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const files = walk('.').filter(
  (file) => /\.(mjs|js)$/.test(file) && !file.includes('node_modules') && !file.includes('.ai-workspace')
);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    throw new Error(`syntax check failed: ${file}`);
  }
}
console.log(`typecheck/syntax passed (${files.length} files)`);
const web =
  process.platform === 'win32'
    ? spawnSync(
        process.execPath,
        [
          path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js'),
          '--filter',
          '@aiws/web',
          'typecheck'
        ],
        { stdio: 'inherit' }
      )
    : spawnSync('corepack', ['pnpm', '--filter', '@aiws/web', 'typecheck'], { stdio: 'inherit' });
if (web.status !== 0) process.exit(web.status || 1);
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (['.git', '.ai-workspace', '.ai-workspace-test-integration', 'node_modules'].includes(entry.name)) return [];
    return entry.isDirectory() ? walk(full) : [full];
  });
}
