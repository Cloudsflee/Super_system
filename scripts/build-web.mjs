import { spawnSync } from 'node:child_process';
import path from 'node:path';

const result = process.platform === 'win32'
  ? spawnSync(process.execPath, [path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js'), '--filter', '@aiws/web', 'build'], { stdio: 'inherit' })
  : spawnSync('corepack', ['pnpm', '--filter', '@aiws/web', 'build'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
