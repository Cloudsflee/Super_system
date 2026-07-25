import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { command } from '../../apps/api/src/http.mjs';
import { taskInvocation } from '../../apps/api/src/file-service.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v175-task-'));
try {
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ private: true, scripts: { test: 'node -e "process.stdout.write(\'task-ok\')"' } })
  );
  const windows = taskInvocation(root, 'test', { platform: 'win32', comspec: 'cmd.exe' });
  assert.deepEqual(windows, { command: 'cmd.exe', args: ['/d', '/s', '/c', 'corepack pnpm test'], label: 'pnpm test' });
  const posix = taskInvocation(root, 'test', { platform: 'linux' });
  assert.deepEqual(posix, { command: 'corepack', args: ['pnpm', 'test'], label: 'pnpm test' });
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(root, 'corepack.cmd'),
      '@echo off\r\nif /I not "%~1"=="pnpm" exit /b 21\r\nif /I not "%~2"=="test" exit /b 22\r\necho task-ok\r\n'
    );
    const result = command(windows.command, windows.args, root, 10_000, {}, { inheritEnv: false });
    assert.equal(result.ok, true, result.error || result.stderr);
    assert.match(result.stdout, /task-ok/);
  }
  assert.throws(
    () => taskInvocation(root, 'publish'),
    (error) => error?.payload?.error === 'unsupported_test_preset'
  );
  console.log('V1.75 cross-platform test task process tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
