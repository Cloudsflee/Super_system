import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const failures = [];

if (manifest.version !== '3.0.0') failures.push('root package version must be 3.0.0');
if (Object.keys(manifest.scripts || {}).length > 25) failures.push('package scripts exceed 25');
for (const legacy of ['apps/worker', 'apps/mcp-gateway', 'bridge', 'prisma']) {
  if (fs.existsSync(path.join(root, legacy))) failures.push(`legacy runtime directory exists: ${legacy}`);
}

const files = walk(root).filter((file) => /\.(?:mjs|js|ts|tsx)$/.test(file));
for (const file of files.filter((item) => item.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) failures.push(`${path.relative(root, file)}: ${result.stderr.trim()}`);
}
for (const file of files.filter((item) => item.includes(`${path.sep}apps${path.sep}`) || item.includes(`${path.sep}packages${path.sep}`))) {
  const name = path.basename(file);
  if (/v(?:12|13|14|15|16|17|175|18|19|110|20|21|22|23)/i.test(name)) failures.push(`versioned runtime filename: ${path.relative(root, file)}`);
}

const typecheck = spawnSync('corepack', ['pnpm', '--filter', '@aiws/web', 'typecheck'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
if (typecheck.status !== 0) failures.push(typecheck.stdout + typecheck.stderr);
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`check passed: ${files.length} source files, ${Object.keys(manifest.scripts).length} scripts\n`);

function walk(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', '.ai-workspace', 'node_modules', 'dist', 'coverage', '.pnpm-store'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(full));
    else output.push(full);
  }
  return output;
}
