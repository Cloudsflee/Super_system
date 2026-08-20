import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = process.cwd();
const gateSource = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'layered-gate.mjs'), 'utf8');

test('a fully successful layered gate emits only the structured summary', () => {
  const root = createWorkspace();
  try {
    const run = invoke(root);
    assert.equal(run.status, 0, run.stderr);
    const result = parseResult(run);
    assert.equal(result.schema_version, 'aiws.v3-clean.layered-gate-result.v2');
    assert.equal(result.status, 'passed');
    assert.equal(result.receipt, null);
    assert.equal(result.commands.length, 2);
    for (const command of result.commands) {
      assert.equal(typeof command.command, 'string');
      assert.equal(typeof command.exit_status, 'number');
      assert.equal(typeof command.summary, 'string');
      assert.equal(typeof command.redaction.passed, 'boolean');
    }
    assert.deepEqual(receipts(root), []);
    assert.equal(fs.existsSync(path.join(root, 'docs')), false);
  } finally {
    removeWorkspace(root);
  }
});

test('a Historical failure writes a local advisory receipt and keeps the wrapper successful', () => {
  const root = createWorkspace({ historicalFailure: true });
  try {
    const run = invoke(root, '--historical');
    assert.equal(run.status, 0, run.stderr);
    const result = parseResult(run);
    assert.equal(result.schema_version, 'aiws.v3-clean.layered-gate-result.v2');
    assert.equal(result.status, 'advisory');
    assert.equal(result.receipt.startsWith('.ai-workspace/gate-receipts/'), true);
    const files = receipts(root);
    assert.equal(files.length, 1);
    assert.match(files[0], /^layered-security-\d+-\d+(?:-\d+)?\.json$/);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, '.ai-workspace', 'gate-receipts', files[0]), 'utf8'));
    assert.equal(receipt.schema_version, 'aiws.v3-clean.layered-gate-receipt.v2');
    assert.equal(receipt.status, 'advisory');
    assert.equal(receipt.blocking_layer, null);
    assert.equal(receipt.historical.advisory, true);
    assert.equal(receipt.historical.ok, false);
    assert.equal(receipt.receipt, `.ai-workspace/gate-receipts/${files[0]}`);
    const text = JSON.stringify(receipt);
    assert.equal(text.includes(root), false);
    assert.equal(text.includes('Bearer p31-fixture-token'), false);
    assert.match(text, /<PATH>|<TOKEN>/);
  } finally {
    removeWorkspace(root);
  }
});

test('a Clean failure writes a local blocking receipt and exits non-zero', () => {
  const root = createWorkspace({ cleanFailure: true });
  try {
    const run = invoke(root, '--clean');
    assert.equal(run.status, 1);
    const result = parseResult(run);
    assert.equal(result.status, 'failed');
    assert.equal(result.blocking_layer, 'clean');
    assert.equal(result.clean_exit > 0, true);
    assert.equal(result.historical_exit, null);
    assert.equal(result.receipt.startsWith('.ai-workspace/gate-receipts/'), true);
    const files = receipts(root);
    assert.equal(files.length, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, '.ai-workspace', 'gate-receipts', files[0]), 'utf8'));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.blocking_layer, 'clean');
    assert.equal(receipt.clean.ok, false);
    assert.equal(receipt.historical, null);
  } finally {
    removeWorkspace(root);
  }
});

test('failure receipts append without overwriting and retain complete redacted output', () => {
  const root = createWorkspace({ historicalFailure: true });
  try {
    const first = invoke(root, '--historical');
    const second = invoke(root, '--historical');
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    const files = receipts(root);
    assert.equal(files.length, 2);
    assert.notEqual(files[0], files[1]);
    for (const file of files) {
      const receipt = JSON.parse(fs.readFileSync(path.join(root, '.ai-workspace', 'gate-receipts', file), 'utf8'));
      assert.equal(receipt.historical.output.stdout.includes('Bearer <TOKEN>'), true);
      assert.equal(receipt.historical.output.stdout.includes('<PATH>'), true);
      assert.equal(receipt.historical.redaction.passed, true);
      assert.equal(receipt.historical.output.stdout.includes('p31-fixture-token'), false);
    }
  } finally {
    removeWorkspace(root);
  }
});

function invoke(root, ...flags) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'layered-gate.mjs'), 'security', ...flags], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env
  });
}

function parseResult(run) {
  assert.equal(typeof run.stdout, 'string');
  try {
    return JSON.parse(run.stdout);
  } catch (error) {
    assert.fail(`gate output was not JSON: ${error.message}\n${run.stdout}\n${run.stderr}`);
  }
}

function createWorkspace({ cleanFailure = false, historicalFailure = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-layered-gate-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests', 'security'), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, 'scripts', 'layered-gate.mjs'), path.join(root, 'scripts', 'layered-gate.mjs'));
  writeTest(path.join(root, 'tests', 'security', 'v3-clean-p1.test.mjs'), cleanFailure ? failureSource('clean') : passSource('clean'));
  writeTest(path.join(root, 'tests', 'security', 'boundary.test.mjs'), passSource('boundary'));
  writeTest(path.join(root, 'tests', 'security', 'historical-fixture.test.mjs'), historicalFailure ? failureSource('historical') : passSource('historical'));
  return root;
}

function passSource(name) {
  return `import test from 'node:test';\ntest(${JSON.stringify(name)} , () => {});\n`;
}

function failureSource(name) {
  return `import test from 'node:test';\ntest(${JSON.stringify(name)}, () => { process.stdout.write('path=' + process.cwd() + ' Bearer p31-fixture-token\\n'); throw new Error('fixture failure'); });\n`;
}

function writeTest(file, source) {
  fs.writeFileSync(file, source, 'utf8');
}

function receipts(root) {
  const directory = path.join(root, '.ai-workspace', 'gate-receipts');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort();
}

function removeWorkspace(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

assert.match(gateSource, /clean_failure_blocks:\s*true/);
assert.match(gateSource, /historical_failure_advisory:\s*true/);
