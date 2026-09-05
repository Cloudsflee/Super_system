import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  containsSensitiveGateText,
  nodeInvocation,
  redactGateText,
  runGateCommand
} from './lib/gate-process.mjs';

export const RESULT_SCHEMA = 'aiws.v3-clean.layered-gate-result.v2';
export const RECEIPT_SCHEMA = 'aiws.v3-clean.layered-gate-receipt.v2';
export const LOCAL_RECEIPT_DIRECTORY = '.ai-workspace/gate-receipts';

const suite = String(process.argv[2] || '');

export async function main(argv = process.argv.slice(2), workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot);
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    return 2;
  }

  const records = [];
  if (!parsed.historicalOnly) records.push(await runLayer('clean', parsed.suite, root));
  if (!parsed.cleanOnly) records.push(await runLayer('historical', parsed.suite, root));

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
    return ['node', ['--test', 'tests/integration/v3-clean-p1.test.mjs', 'tests/p3/http-contract.test.mjs', 'tests/p3/migration.test.mjs', 'tests/p3/project-workflow.test.mjs', 'tests/p4/*.test.mjs']];
  }
  if (selectedSuite === 'security' && layer === 'clean') {
    return ['node', ['--test', '--test-concurrency=1', 'tests/security/v3-clean-p1.test.mjs', 'tests/security/boundary.test.mjs', 'tests/p4/mcp-exchange-gateway.test.mjs']];
  }
  if (selectedSuite === 'integration') {
    return ['node', ['--experimental-test-coverage', '--test-coverage-lines=85', '--test-coverage-branches=70', '--test-coverage-functions=75', '--test-coverage-exclude=apps/api/src/clean/**', '--test', 'tests/integration/*.test.mjs', 'tests/unit/recovery-golden.test.mjs']];
  }
  return ['node', ['--test', '--test-concurrency=1',
    'tests/security/broker-http.test.mjs', 'tests/security/context-mcp-r5.test.mjs',
    'tests/security/credentials.test.mjs', 'tests/security/project-repository.test.mjs',
    'tests/security/workflow-r4.test.mjs'
  ]];
}

export async function runLayer(layer, selectedSuite, root = process.cwd()) {
  const [command, args] = commandFor(layer, selectedSuite);
  const invocation = command === 'node' ? nodeInvocation(args[0], args.slice(1)) : { command, args };
  const result = await runGateCommand(invocation, {
    cwd: root,
    workspaceRoot: root,
    cwdRole: 'repository-root',
    stdout: false,
    stderr: false,
    timeoutMs: 900_000,
    maxCaptureBytes: 16 * 1024 * 1024
  });
  const stdout = result.output.stdout;
  const stderr = result.output.stderr;
  const commandText = [result.command, ...result.args].join(' ');
  return {
    layer,
    command: commandText,
    exit_status: result.exit_status,
    signal: result.signal,
    duration_ms: result.duration_ms,
    error_code: result.error_code,
    ok: result.ok,
    summary: summarize(stdout, stderr),
    output: { stdout, stderr },
    redaction: result.redaction
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

export const redact = redactGateText;
export const containsSecretShape = containsSensitiveGateText;

export function summarize(stdout, stderr) {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-8).join('\n').slice(0, 2000);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked && invoked === import.meta.url) {
  const exitCode = await main(process.argv.slice(2), process.cwd());
  if (exitCode) process.exitCode = exitCode;
}
