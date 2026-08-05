import { spawn } from 'node:child_process';

const root = process.cwd();
const secret = process.env.AIWS_BROKER_HMAC_SECRET || 'dev-only-local-broker-secret';
const environment = {
  ...process.env,
  AIWS_BROKER_HMAC_SECRET: secret,
  AIWS_BROKER_MODE: 'http',
  AIWS_BROKER_URL: 'http://127.0.0.1:4321',
  AIWS_BIND_HOST: '127.0.0.1',
  PORT: '4317'
};
const children = [
  spawn(process.execPath, ['apps/runner-broker/server.mjs'], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true }),
  spawn(process.execPath, ['apps/api/server.mjs'], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true }),
  spawn('corepack', ['pnpm', '--filter', '@aiws/web', 'dev'], { cwd: root, env: environment, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true })
];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
for (const child of children) child.once('exit', (code) => { if (!stopping && code) { stop(); process.exitCode = code; } });
