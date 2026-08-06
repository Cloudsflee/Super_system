import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureDiff, createWorktree, gitHead, initializeFixture, removeWorktree } from '../../apps/api/src/git-fixture.mjs';
import { buildDockerArgs, validateJobSpec, validateTaskBundle } from '../../apps/runner-broker/src/job-spec.mjs';
import { normalizeJsonl } from '../../apps/runner-broker/src/runner-result.mjs';

test('designsignal fixture has a reproducible baseline and worktree diff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-fixture-test-'));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-fixture-repeat-'));
  const sha = await initializeFixture(root);
  assert.equal(await initializeFixture(secondRoot), sha);
  assert.equal(sha, await gitHead(root));
  const worktree = path.join(root, 'worktrees', 'exe_test');
  await createWorktree(root, worktree, sha);
  assert.equal(fs.lstatSync(path.join(worktree, '.git')).isDirectory(), true, 'runner worktree must carry self-contained Git metadata');
  assert.equal(await gitHead(worktree), sha);
  fs.writeFileSync(path.join(worktree, 'new.txt'), 'new\n', 'utf8');
  await createWorktree(root, worktree, sha, { preserveChanges: true });
  assert.equal(fs.readFileSync(path.join(worktree, 'new.txt'), 'utf8'), 'new\n');
  const captured = await captureDiff(worktree, sha);
  assert.deepEqual(captured.files, ['new.txt']);
  assert.match(captured.diff, /new\.txt/);
  assert.match(captured.sha256, /^[a-f0-9]{64}$/);
  await removeWorktree(root, worktree);
  assert.equal(fs.existsSync(worktree), false);
  await assert.rejects(() => removeWorktree(root, secondRoot), /outside/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(secondRoot, { recursive: true, force: true });
});

test('task bundle and JSONL normalizer enforce fixed checks and redaction', () => {
  assert.throws(() => validateTaskBundle({ objective: 'x', acceptance: [], checks: ['shell'] }), /fixed profile/);
  const bundle = validateTaskBundle({ objective: 'x', acceptance: ['ok'], output_paths: ['out.md'], checks: ['node_test', 'git_diff_check'] });
  assert.deepEqual(bundle.checks, ['node_test', 'git_diff_check']);
  const result = normalizeJsonl('{"type":"mystery","message":"Bearer sk-secret-value"}\n{"type":"turn.completed","usage":{"input_tokens":4}}');
  assert.equal(result.events[0].type, 'runner.unknown');
  assert.doesNotMatch(result.events[0].summary, /sk-secret/);
  assert.equal(result.usage.input_tokens, 4);
  assert.equal(normalizeJsonl('{"type":"thread.started","thread_id":"fixture"}', { secrets: ['fixture-secret'] }).events[0].summary, '');
  assert.throws(() => normalizeJsonl('x'.repeat(100), { maxBytes: 10 }), /too_large/);
});

test('Docker mounts bind only the execution worktree and fixed output volume', () => {
  const digest = `sha256:${'b'.repeat(64)}`;
  const base = {
    task_id: 'inspect', execution_id: 'exe_mount12345678', project_id: 'prj_mount12345678',
    workspace_subpath: 'projects/prj_mount12345678/worktrees/exe_mount12345678',
    image_digest: digest, execution_mode: 'read', resource_profile: 'standard', network_profile: 'none',
    input_paths: [], output_paths: ['analysis.md'],
    output_subpath: 'projects/prj_mount12345678/outputs/exe_mount12345678',
    baseline_sha: 'c'.repeat(40), deadline_at: new Date(Date.now() + 60_000).toISOString(),
    bundle: { objective: 'inspect', acceptance: [], output_paths: ['analysis.md'], checks: ['node_test', 'git_diff_check'] }
  };
  const readArgs = buildDockerArgs(validateJobSpec(base, { runnerDigest: digest }), { dataVolume: 'aiws-data-v3', runnerImage: `runner@${digest}` });
  assert.ok(readArgs.some((value) => value.includes('dst=/workspace') && value.endsWith(',readonly')));
  assert.ok(readArgs.some((value) => value.includes('dst=/inputs') && value.endsWith(',readonly')));
  assert.ok(readArgs.some((value) => value.includes('dst=/outputs')));
  assert.ok(readArgs.includes('/tmp/codex-home:rw,size=64m,mode=700,uid=10001,gid=10001'));
  const writeArgs = buildDockerArgs(validateJobSpec({ ...base, execution_mode: 'write' }, { runnerDigest: digest }), { dataVolume: 'aiws-data-v3', runnerImage: `runner@${digest}` });
  assert.ok(writeArgs.some((value) => value.includes('dst=/workspace') && !value.endsWith(',readonly')));
  assert.throws(() => validateJobSpec({ ...base, workspace_subpath: `${base.workspace_subpath},rw` }, { runnerDigest: digest }), /unsupported|invalid/);
  assert.throws(() => validateJobSpec({ ...base, workspace_subpath: `projects/${base.project_id}/worktrees/exe_different1234` }, { runnerDigest: digest }), /execution/);
  assert.throws(() => validateJobSpec({ ...base, network_profile: 'arbitrary' }, { runnerDigest: digest }), /network/);
  assert.throws(() => validateJobSpec({ ...base, model: 'unregistered-model' }, { runnerDigest: digest }), /model/);
});

test('Runner image definition pins the musl platform package and records it in SBOM', () => {
  const root = process.cwd();
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const sbom = JSON.parse(fs.readFileSync(path.join(root, 'sbom.spdx.json'), 'utf8'));
  assert.match(dockerfile, /CODEX_CLI_VERSION=0\.146\.1/);
  assert.match(dockerfile, /CODEX_LINUX_X64_VERSION=0\.146\.1-linux-x64/);
  assert.match(dockerfile, /5cf5a95b326018ad7282c50131782c90492bfae4d58ff5ce9e708fd9413db505174d6611604973ed05b5612ddbc6437a29ebf808940a6dd268a55c21fb413f4d/);
  assert.match(dockerfile, /test "\$\(codex --version\)" = "codex-cli \$\{CODEX_CLI_VERSION\}"/);
  assert.ok(sbom.packages.some((item) => item.SPDXID === 'SPDXRef-Package-OpenAICodexLinuxX64' && item.versionInfo === '0.146.1-linux-x64'));
});
