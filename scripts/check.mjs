import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const failures = [];

if (manifest.version !== '3.0.0') failures.push('root package version must be 3.0.0');
if (Object.keys(manifest.scripts || {}).length > 44) failures.push('package scripts exceed 44');
for (const legacy of ['apps/worker', 'apps/mcp-gateway', 'bridge', 'prisma']) {
  if (fs.existsSync(path.join(root, legacy))) failures.push(`legacy runtime directory exists: ${legacy}`);
}

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isDirectory() && /^\.tmp-v(?:12|13|14|15|16|17|175|18|19|20|21|22|23)(?:-|$)/i.test(entry.name)) {
    failures.push(`legacy temporary runtime exists: ${entry.name}`);
  }
}

const sourceRoots = ['apps', 'packages', 'scripts', 'tests'];
const files = sourceRoots
  .flatMap((directory) => walk(path.join(root, directory)))
  .concat(path.join(root, 'eslint.config.mjs'))
  .filter((file) => /\.(?:mjs|js|ts|tsx)$/.test(file));
for (const file of files.filter((item) => item.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) failures.push(`${path.relative(root, file)}: ${result.stderr.trim()}`);
}
for (const file of files.filter((item) => ['apps', 'packages', 'tests'].some((directory) => item.includes(`${path.sep}${directory}${path.sep}`)))) {
  const name = path.basename(file);
  if (/v(?:12|13|14|15|16|17|175|18|19|20|21|22|23)/i.test(name)) failures.push(`versioned runtime filename: ${path.relative(root, file)}`);
}

const runtimeFiles = files.filter((item) => ['apps', 'packages'].some((directory) => item.includes(`${path.sep}${directory}${path.sep}`)));
const legacyRuntimePatterns = [
  // v2 is the active clean-break contract. Historical versioned paths remain
  // prohibited in runtime modules; /api/v1 fixtures are checked by the clean
  // entrypoint architecture scan and may remain in deferred characterization
  // clients until their phase is migrated.
  [/\/api\/v(?:12|13|14|15|16|17|18|19|20|21|22|23)(?:\/|\b)/i, 'legacy API route'],
  [/(?:^|[\\/\s'"`(])apps[\\/]worker(?:[\\/]|\b|['"`\s)]|$)|(?:^|[\\/\s'"`(])apps[\\/]mcp-gateway(?:[\\/]|\b|['"`\s)]|$)/i, 'legacy service reference'],
  [/\b(?:host bridge|global context graph|projector)\b/i, 'legacy feature reference']
];
for (const file of runtimeFiles) {
  const content = fs.readFileSync(file, 'utf8');
  for (const [pattern, label] of legacyRuntimePatterns) {
    // Migration SQL retains historical table names as data-contract identifiers;
    // those names are not runtime service references.
    if (file.includes(`${path.sep}migrations${path.sep}`) && label === 'legacy feature reference') continue;
    if (pattern.test(content)) failures.push(`${label}: ${path.relative(root, file)}`);
  }
}

const testFiles = files.filter((item) => /(?:\.test\.|\.spec\.)/.test(path.basename(item)));
const ineffectiveTestPatterns = [
  [/\b(?:test|it|describe)\.(?:skip|only|todo)\b/, 'focused or skipped test'],
  [/\b(?:test|it)\s*\([^\n]+\{\s*(?:skip|todo)\s*:\s*true/, 'skipped test option'],
  [/\bassert\.ok\(true\)|\bexpect\(true\)\.toBe\(true\)/, 'constant assertion']
];
for (const file of testFiles) {
  const content = fs.readFileSync(file, 'utf8');
  for (const [pattern, label] of ineffectiveTestPatterns) {
    if (pattern.test(content)) failures.push(`${label}: ${path.relative(root, file)}`);
  }
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
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(full));
    else output.push(full);
  }
  return output;
}
