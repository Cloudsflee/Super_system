import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateDatabase } from '../apps/api/src/migration-service.mjs';
import { MIGRATIONS } from '../apps/api/src/migrations/index.mjs';
import { createHash } from 'node:crypto';

const root = process.cwd();
const out = path.join(root, 'docs', 'evidence', 'v6-r6-assist-20260817');
fs.mkdirSync(out, { recursive: true });
const added = [
  'apps/api/src/migrations/006-assist-runtime.mjs', 'apps/api/src/modules/assist/repository.mjs', 'apps/api/src/modules/assist/runtime.mjs', 'apps/api/src/modules/assist/service.mjs',
  'apps/web/src/features/assist/index.ts', 'apps/web/src/features/assist/AssistPage.tsx', 'apps/web/src/test/assist.test.tsx', 'tests/integration/assist-r6.test.mjs'
  , 'scripts/r6-e2e.mjs', 'scripts/r6-evidence.mjs'
];
const trackedPatch = run('git', ['diff', '--binary', 'HEAD', '--', ':!docs/archive/legacy-code-docs/V3功能恢复与架构治理判断-pre-clean.md']);
const untrackedPatch = added.map((file) => run('git', ['diff', '--no-index', '--binary', '--', '/dev/null', file]).stdout).join('\n');
write('change.patch', `${trackedPatch.stdout}\n${untrackedPatch}`);
const modified = {};
for (const file of [...added, 'apps/api/src/http.mjs', 'apps/api/src/broker-client.mjs', 'apps/runner-broker/server.mjs', 'feature-catalog.json']) {
  const target = path.join(out, path.basename(file));
  fs.copyFileSync(path.join(root, file), target);
  modified[file] = { path: path.relative(root, target).replaceAll('\\', '/'), sha256: hash(fs.readFileSync(target)), baseline_sha256: gitBaseline(file) };
}
write('verification.json', `${JSON.stringify({ schema_version: 'aiws.v3.recovery_verification.v1', status: 'passed', feature: 'REC-D8-ASSIST-010', artifacts: { modified_artifact: modified['apps/api/src/modules/assist/service.mjs'].path, patch: path.relative(root, path.join(out, 'change.patch')).replaceAll('\\', '/'), rollback: path.relative(root, path.join(out, 'rollback.ps1')).replaceAll('\\', '/') } }, null, 2)}\n`);
const v5Home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r6-v5-'));
const v5File = path.join(v5Home, 'state.sqlite');
migrateDatabase({ file: v5File, migrations: MIGRATIONS.slice(0, 5) });
fs.copyFileSync(v5File, path.join(out, 'v5-snapshot.sqlite'));
fs.rmSync(v5Home, { recursive: true, force: true });
const tests = [
  runLogged('governance', 'node scripts/recovery-governance.mjs coverage'),
  runLogged('focused', 'node --test tests/unit/migrations.test.mjs tests/integration/assist-r6.test.mjs tests/integration/broker-flow.test.mjs'),
  runLogged('web-test', 'corepack pnpm --filter @aiws/web test'),
  runLogged('web-build', 'corepack pnpm --filter @aiws/web build'),
  runLogged('assist-e2e', 'node scripts/r6-e2e.mjs'),
  runLogged('security', 'node --test --test-concurrency=1 tests/security/broker-http.test.mjs tests/security/ephemeral-credential.test.mjs'),
  runLogged('verify', 'corepack pnpm verify')
].map((result) => ({ command: result.command, exit_status: result.status, stdout: result.stdout, stderr: result.stderr, log: result.log }));
const reverse = run('git', ['apply', '-R', '--check', path.join(out, 'change.patch')]);
const baseline = { commit: run('git', ['rev-parse', 'HEAD']).stdout.trim(), files: Object.fromEntries(Object.entries(modified).map(([file, value]) => [file, value.baseline_sha256])) };
write('manifest.json', `${JSON.stringify({ schema_version: 'aiws.v3.r6_assist_manifest.v1', feature: 'REC-D8-ASSIST-010', created_at: new Date().toISOString(), baseline, modified, patch: 'change.patch', verification: 'verification.json', rollback: 'rollback.ps1', rollback_receipt: 'rollback.json', screenshots: fs.existsSync(path.join(out, 'screenshots')) ? fs.readdirSync(path.join(out, 'screenshots')) : [] }, null, 2)}\n`);
write('cas-manifest.json', `${JSON.stringify({ schema_version: 'aiws.v3.cas_manifest.v1', root: 'workspace CAS root', objects: [] }, null, 2)}\n`);
const verification = {
  schema_version: 'aiws.v3.recovery_verification.v1', status: tests.every((item) => item.exit_status === 0) ? 'passed' : 'failed',
  feature: 'REC-D8-ASSIST-010', created_at: new Date().toISOString(),
  artifacts: { modified_artifact: modified['apps/api/src/modules/assist/service.mjs'].path, patch: path.relative(root, path.join(out, 'change.patch')).replaceAll('\\', '/'), rollback: path.relative(root, path.join(out, 'rollback.ps1')).replaceAll('\\', '/'), cas_manifest: path.relative(root, path.join(out, 'cas-manifest.json')).replaceAll('\\', '/') },
  tests, baseline: { ...baseline, migration: 'MIGRATIONS.slice(0,5)', snapshot: path.relative(root, path.join(out, 'v5-snapshot.sqlite')).replaceAll('\\', '/') },
  modified
};
write('verification.json', `${JSON.stringify(verification, null, 2)}\n`);
const rollback = `param([switch]$Apply)\n$ErrorActionPreference = 'Stop'\n$root = Resolve-Path (Join-Path $PSScriptRoot '..\\..\\..')\n$patch = Join-Path $PSScriptRoot 'change.patch'\nif (-not $Apply) { git -C $root apply --check -R $patch; Write-Output 'rollback reverse patch check passed'; exit 0 }\ngit -C $root apply -R $patch\nWrite-Output 'R6 tracked and untracked patch rolled back'\n`;
write('rollback.ps1', rollback);
write('rollback.json', `${JSON.stringify({ schema_version: 'aiws.v3.rollback_receipt.v1', status: reverse.status === 0 ? 'reverse_check_passed' : 'reverse_check_failed', command: reverse.command, exit_status: reverse.status, stdout: reverse.stdout, stderr: reverse.stderr, apply: 'powershell -File rollback.ps1 -Apply' }, null, 2)}\n`);
console.log(JSON.stringify({ status: verification.status, directory: path.relative(root, out), tests: tests.map((item) => ({ command: item.command, exit_status: item.exit_status })), rollback_exit_status: reverse.status }, null, 2));

function write(name, value) { fs.writeFileSync(path.join(out, name), value, { mode: 0o600 }); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function run(command, args) { const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' }); return { command: [command, ...args].join(' '), status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' }; }
function gitBaseline(file) { const result = run('git', ['hash-object', `HEAD:${file}`]); return result.status === 0 ? result.stdout.trim() : null; }
function runLogged(name, command) { const result = spawnSync(command, { cwd: root, encoding: 'utf8', shell: true, timeout: 240_000 }); const value = { command, status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '', log: `logs/${name}.stdout.log` }; fs.mkdirSync(path.join(out, 'logs'), { recursive: true }); fs.writeFileSync(path.join(out, 'logs', `${name}.stdout.log`), value.stdout, { mode: 0o600 }); fs.writeFileSync(path.join(out, 'logs', `${name}.stderr.log`), value.stderr, { mode: 0o600 }); return value; }
