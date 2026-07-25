import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const roots = ['apps', 'packages', 'scripts', 'tests', 'docker', 'bridge'];
const check = process.argv.includes('--check');
const prettierRoot = path.dirname(fileURLToPath(import.meta.resolve('prettier')));
const prettierCli = path.join(prettierRoot, 'bin', 'prettier.cjs');
const prettierPatterns = roots.map((root) => `${root}/**/*.{js,mjs,ts,tsx,css}`);

run(process.execPath, [
  prettierCli,
  check ? '--check' : '--write',
  '--log-level',
  'warn',
  '--no-error-on-unmatched-pattern',
  '--ignore-path',
  '.prettierignore',
  ...prettierPatterns
]);

const goFiles = walk('bridge').filter((file) => file.endsWith('.go'));
if (goFiles.length > 0) {
  if (check) {
    const result = run('gofmt', ['-l', ...goFiles], { capture: true });
    const unformatted = result.stdout.trim();
    if (unformatted) {
      console.error(`Go files need formatting:\n${unformatted}`);
      process.exit(1);
    }
  } else {
    run('gofmt', ['-w', ...goFiles]);
  }
}

console.log(check ? 'format check passed' : 'format completed');

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'build', 'coverage', 'vendor', 'generated'].includes(entry.name)) return [];
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  return result;
}
