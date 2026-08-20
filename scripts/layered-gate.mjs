import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const RESULT_SCHEMA = 'aiws.v3-clean.layered-gate-result.v2';
export const RECEIPT_SCHEMA = 'aiws.v3-clean.layered-gate-receipt.v2';
export const LOCAL_RECEIPT_DIRECTORY = '.ai-workspace/gate-receipts';

const suite = String(process.argv[2] || '');

export function main(argv = process.argv.slice(2), workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot);
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    return 2;
  }

  const records = [];
  if (!parsed.historicalOnly) records.push(runLayer('clean', parsed.suite, root));
  if (!parsed.cleanOnly) records.push(runLayer('historical', parsed.suite, root));

  const cleanRecord = records.find((record) => record.layer === 'clean') || null;
  const historicalRecord = records.find((record) => record.layer === 'historical') || null;
  const cleanFailed = Boolean(cleanRecord && !cleanRecord.ok);
  const historicalFailed = Boolean(historicalRecord && !historicalRecord.ok);
  const status = cleanFailed ? 'failed' : historicalFailed ? 'advisory' : 'passed';
  const receipt = createReceipt({
    suite: parsed.suite,
    status,
    cleanRecord,
    historicalRecord
  });

  let receiptPath = null;
  if (status !== 'passed') {
    try {
      receiptPath = writeFailureReceipt(root, receipt);
    } catch (error) {
      const detail = redact(String(error?.stack || error), root).value;
      process.stderr.write(`layered gate receipt write failed: ${detail}\n`);
      return 1;
    }
  }

  const result = publicResult({ receipt, receiptPath, cleanRecord, historicalRecord });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return cleanFailed ? 1 : 0;
}

export function parseArguments(argv) {
  const values = [...argv];
  const selectedSuite = String(values.shift() || '');
  const cleanOnly = values.includes('--clean');
  const historicalOnly = values.includes('--historical');
  const unknown = values.filter((value) => !['--clean', '--historical'].includes(value));
  if (!['integration', 'security'].includes(selectedSuite)) {
    return { ok: false, message: 'usage: node scripts/layered-gate.mjs integration|security [--clean|--historical]' };
  }
  if (cleanOnly && historicalOnly) {
    return { ok: false, message: 'choose only one of --clean or --historical' };
  }
  if (unknown.length) {
    return { ok: false, message: `unknown option: ${unknown.join(' ')}` };
  }
  return { ok: true, suite: selectedSuite, cleanOnly, historicalOnly };
}

export function commandFor(layer, selectedSuite) {
  if (selectedSuite === 'integration' && layer === 'clean') {
    return ['node', ['--test', 'tests/integration/v3-clean-p1.test.mjs', 'tests/p3/*.test.mjs']];
  }
  if (selectedSuite === 'security' && layer === 'clean') {
    return ['node', ['--test', '--test-concurrency=1', 'tests/security/v3-clean-p1.test.mjs', 'tests/security/boundary.test.mjs']];
  }
  if (selectedSuite === 'integration') {
    return ['node', ['--experimental-test-coverage', '--test-coverage-lines=85', '--test-coverage-branches=70', '--test-coverage-functions=75', '--test-coverage-exclude=apps/api/src/clean/**', '--test', 'tests/integration/*.test.mjs']];
  }
  return ['node', ['--test', '--test-concurrency=1', 'tests/security/*.test.mjs']];
}

export function runLayer(layer, selectedSuite, root = process.cwd()) {
  const [command, args] = commandFor(layer, selectedSuite);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    timeout: 900_000,
    maxBuffer: 16 * 1024 * 1024
  });
  const rawStdout = result.stdout || '';
  const rawStderr = [result.stderr || '', result.error?.message || ''].filter(Boolean).join('\n');
  const stdout = redact(rawStdout, root);
  const stderr = redact(rawStderr, root);
  const commandText = redact([command, ...args].join(' '), root);
  const exitStatus = result.status == null ? 1 : result.status;
  return {
    layer,
    command: commandText.value,
    exit_status: exitStatus,
    signal: result.signal || null,
    ok: result.status === 0,
    summary: summarize(stdout.value, stderr.value),
    output: { stdout: stdout.value, stderr: stderr.value },
    redaction: {
      passed: !containsSecretShape(commandText.value) && !containsSecretShape(stdout.value) && !containsSecretShape(stderr.value),
      removed: commandText.removed + stdout.removed + stderr.removed
    }
  };
}

export function createReceipt({ suite: selectedSuite, status, cleanRecord, historicalRecord }) {
  return {
    schema_version: RECEIPT_SCHEMA,
    suite: selectedSuite,
    status,
    blocking_layer: status === 'failed' ? 'clean' : null,
    generated_at: new Date().toISOString(),
    commands: [cleanRecord, historicalRecord].filter(Boolean),
    clean: cleanRecord,
    historical: historicalRecord ? { ...historicalRecord, advisory: true } : null,
    policy: {
      clean_failure_blocks: true,
      historical_failure_advisory: true,
      success_receipt: 'stdout-only',
      status_promotion: 'immutable-final-verification-json-only',
      redaction: 'workspace-relative-paths-and-secret-shaped-values'
    }
  };
}

export function publicResult({ receipt, receiptPath, cleanRecord, historicalRecord }) {
  const records = [cleanRecord, historicalRecord].filter(Boolean);
  return {
    schema_version: RESULT_SCHEMA,
    suite: receipt.suite,
    status: receipt.status,
    blocking_layer: receipt.blocking_layer,
    commands: records.map(({ layer, command, exit_status, signal, ok, summary, redaction, advisory }) => ({
      layer,
      command,
      exit_status,
      signal,
      ok,
      summary,
      redaction,
      ...(advisory ? { advisory: true } : {})
    })),
    clean_exit: cleanRecord?.exit_status ?? null,
    historical_exit: historicalRecord?.exit_status ?? null,
    advisory_failures: records.filter((record) => record.layer === 'historical' && !record.ok).map((record) => record.command),
    redaction: records.map((record) => ({ layer: record.layer, ...record.redaction })),
    receipt: receiptPath
  };
}

export function writeFailureReceipt(root, receipt) {
  const directory = path.join(root, LOCAL_RECEIPT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const prefix = `layered-${receipt.suite}-${Date.now()}-${process.pid}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const filename = `${prefix}${suffix}.json`;
    const target = path.join(directory, filename);
    const relative = path.relative(root, target).replaceAll('\\', '/');
    const payload = `${JSON.stringify({ ...receipt, receipt: relative }, null, 2)}\n`;
    try {
      fs.writeFileSync(target, payload, { flag: 'wx', mode: 0o600 });
      return relative;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('layered_gate_receipt_name_exhausted');
}

export function redact(value, workspaceRoot = process.cwd()) {
  let text = String(value ?? '');
  let removed = 0;
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      removed += 1;
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    });
  };

  const root = path.resolve(workspaceRoot);
  const slashRoot = root.replaceAll('\\', '/');
  const rootVariants = [...new Set([
    root,
    slashRoot,
    root.replaceAll('/', '\\'),
    encodeURI(slashRoot),
    encodeURIComponent(slashRoot)
  ])]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const variant of rootVariants) {
    const escaped = escapeRegExp(variant);
    replace(new RegExp(`${escaped}[\\\\/]`, 'gi'), '');
    replace(new RegExp(escaped, 'gi'), '<WORKSPACE>');
  }

  replace(/Bearer\s+[^\s"'`]+/gi, 'Bearer <TOKEN>');
  replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?proof|cookie|secret|password)\s*[:=]\s*)[^,\s"'`]+/gi, '$1<TOKEN>');
  replace(/file:\/\/\/[A-Za-z]:[^\r\n"'`)]+/gi, '<PATH>');
  replace(/(?:^|[\s("'=])((?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'`<>)]*)/g, (match, candidate) => `${match.slice(0, match.indexOf(candidate))}<PATH>`);
  replace(/(?:^|[\s("'=])((?:\/(?:Users|home|tmp|private|var|workspace|mnt)\/)[^\r\n"'`<>\s)]*)/g, (match, candidate) => `${match.slice(0, match.indexOf(candidate))}<PATH>`);
  replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<TOKEN>');
  return { value: text, removed };
}

export function containsSecretShape(value) {
  const text = String(value ?? '');
  return /Bearer\s+[^<\s]+/i.test(text)
    || /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?proof|cookie|secret|password)\s*[:=]\s*(?!<TOKEN>)[A-Za-z0-9+/._-]{8,}/i.test(text)
    || /file:\/\/\/[A-Za-z]:[\\/]/i.test(text)
    || /(?:^|[\s("'=])[A-Za-z]:[\\/][^\r\n\s"']+/.test(text)
    || /(?:^|\s)\/(?:Users|home|tmp|private|var|workspace|mnt)\//.test(text);
}

export function summarize(stdout, stderr) {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-8).join('\n').slice(0, 2000);
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked && invoked === import.meta.url) {
  const exitCode = main(process.argv.slice(2), process.cwd());
  if (exitCode) process.exitCode = exitCode;
}
