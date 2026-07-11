import { spawn } from 'node:child_process';
import path from 'node:path';

const api = spawn(process.execPath, ['apps/api/server.mjs'], {
  env: { ...process.env, AIWS_PORT: '4318', AIWS_DEV_SERVER: '1' },
  stdio: 'inherit'
});
const pnpmCommand = process.platform === 'win32' ? process.execPath : 'corepack';
const pnpmArgs = process.platform === 'win32'
  ? [path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js'), '--filter', '@aiws/web', 'dev']
  : ['pnpm', '--filter', '@aiws/web', 'dev'];
const web = spawn(pnpmCommand, pnpmArgs, {
  stdio: 'inherit'
});

const stop = () => { api.kill(); web.kill(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of [api, web]) child.on('exit', (code) => {
  stop();
  if (code) process.exitCode = code;
});
