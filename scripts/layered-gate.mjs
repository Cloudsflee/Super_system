import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const suite = String(process.argv[2] || '');
const cleanOnly = process.argv.includes('--clean');
const historicalOnly = process.argv.includes('--historical');
if (!['integration', 'security'].includes(suite)) {
  process.stderr.write('usage: node scripts/layered-gate.mjs integration|security [--clean|--historical]\n');
  process.exit(2);
}

const evidenceRoot = path.join(root, 'docs', 'evidence', 'v3-clean-p3-1-debt-burn-down-20260820');
fs.mkdirSync(evidenceRoot, { recursive: true });
const clean = suite === 'integration'
  ? ['node', ['--test', 'tests/integration/v3-clean-p1.test.mjs', 'tests/p3/*.test.mjs']]
  : ['node', ['--test', '--test-concurrency=1', 'tests/security/v3-clean-p1.test.mjs', 'tests/security/boundary.test.mjs']];
const historical = suite === 'integration'
  ? ['node', ['--experimental-test-coverage', '--test-coverage-lines=85', '--test-coverage-branches=70', '--test-coverage-functions=75', '--test-coverage-exclude=apps/api/src/clean/**', '--test', 'tests/integration/*.test.mjs']]
  : ['node', ['--test', '--test-concurrency=1', 'tests/security/*.test.mjs']];

const records = [];
if (!historicalOnly) records.push(run('clean', clean));
if (!cleanOnly) records.push(run('historical', historical));
const cleanRecord = records.find((record) => record.layer === 'clean');
const historicalRecord = records.find((record) => record.layer === 'historical');
const receipt = {
  schema_version: 'aiws.v3-clean.layered-gate-receipt.v1',
  suite,
  status: cleanRecord && !cleanRecord.ok ? 'failed' : 'passed',
  blocking_layer: cleanRecord && !cleanRecord.ok ? 'clean' : null,
  generated_at: new Date().toISOString(),
  clean: cleanRecord || null,
  historical: historicalRecord ? { ...historicalRecord, advisory: true } : null,
  policy: { clean_failure_blocks: true, historical_failure_advisory: true, redaction: 'paths-and-secret-shaped-values' }
};
const receiptPath = path.join(evidenceRoot, `layered-${suite}-${Date.now()}.json`);
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify({ suite, status: receipt.status, clean_exit: cleanRecord?.exit_status ?? null, historical_exit: historicalRecord?.exit_status ?? null, receipt: path.relative(root, receiptPath) }, null, 2)}\n`);
if (receipt.status === 'failed') process.exit(1);

function run(layer, [command, args]) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
  const stdout = redact(result.stdout || '');
  const stderr = redact(result.stderr || '');
  return {
    layer,
    command: [command, ...args].join(' '),
    exit_status: result.status == null ? 1 : result.status,
    signal: result.signal || null,
    ok: result.status === 0,
    summary: summarize(stdout, stderr),
    output: { stdout, stderr },
    redaction: { passed: !containsSecretShape(stdout) && !containsSecretShape(stderr), removed: countRedactions(result.stdout || '') + countRedactions(result.stderr || '') }
  };
}

function redact(value) {
  return String(value)
    .replace(/[A-Za-z]:\\[^\r\n\s]+/g, '<PATH>')
    .replace(/(?:[A-Za-z0-9_-]{24,}\.)?[A-Za-z0-9_-]{32,}/g, '<TOKEN>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <TOKEN>');
}
function containsSecretShape(value) { return /Bearer\s+[^<\s]+|[A-Za-z0-9_-]{40,}/.test(String(value)); }
function countRedactions(value) { return (String(value).match(/<PATH>|<TOKEN>/g) || []).length; }
function summarize(stdout, stderr) {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-8).join('\n').slice(0, 2000);
}
