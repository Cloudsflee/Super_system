import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeFixture } from '../apps/api/src/git-fixture.mjs';

const execFileAsync = promisify(execFile);
const repository = process.env.AIWS_GITHUB_REPOSITORY || '';
const secretFile = process.env.AIWS_GITHUB_SECRET_FILE || '';
if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) throw new Error('github_repository_invalid');
if (!secretFile || !fs.existsSync(secretFile)) throw new Error('github_secret_unreadable');
const token = fs.readFileSync(secretFile, 'utf8').trim();
if (!/^\S{8,4096}$/.test(token)) throw new Error('github_secret_invalid');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-github-fixture-'));
const remote = `https://github.com/${repository}.git`;
const env = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.extraHeader',
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`
};
try {
  const fixtureSha = await initializeFixture(directory, 'designsignal-v1');
  const refs = (await execFileAsync('git', ['ls-remote', remote], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim().split(/\r?\n/).filter(Boolean);
  const expectedNames = new Set(['refs/heads/aiws/fixture-baseline', 'refs/tags/aiws/fixture-baseline']);
  if (refs.length) {
    const remoteRefs = new Map(refs.map((line) => {
      const [sha, ref] = line.split(/\s+/, 2);
      return [ref, sha];
    }));
    const valid = remoteRefs.size === expectedNames.size
      && [...expectedNames].every((ref) => remoteRefs.get(ref) === fixtureSha);
    if (!valid) throw new Error('github_fixture_repository_not_empty');
    process.stdout.write(`${JSON.stringify({ status: 'already_seeded', repository, fixture_sha: fixtureSha }, null, 2)}\n`);
  } else {
    await execFileAsync('git', ['-C', directory, 'tag', 'aiws/fixture-baseline', fixtureSha], { env, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    await execFileAsync('git', ['-C', directory, 'push', remote, `${fixtureSha}:refs/heads/aiws/fixture-baseline`, 'refs/tags/aiws/fixture-baseline:refs/tags/aiws/fixture-baseline'], { env, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    process.stdout.write(`${JSON.stringify({ status: 'seeded', repository, fixture_sha: fixtureSha }, null, 2)}\n`);
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
