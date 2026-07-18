import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { limitedLog } from '../../scripts/v175-lib.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v175-fault-'));
process.env.AIWS_HOME = path.join(root, 'home');
const failures = [];
const check = async (name, run) => { try { await run(); console.log(`[v175-fault] PASS ${name}`); } catch (error) { failures.push(`${name}: ${error.message}`); console.error(`[v175-fault] FAIL ${name}: ${error.message}`); } };

try {
  const { isWithin } = await import('../../apps/api/src/managed-workspace.mjs');
  const { sanitizeBuildLog } = await import('../../apps/api/src/codex-build-domain.mjs');
  const { waitForOperationResult, settleOperationResult } = await import('../../apps/api/src/assist-operation-waiters.mjs');

  await check('path-prefix-and-traversal-barrier', () => {
    assert.equal(isWithin(path.join(root, 'repo'), path.join(root, 'repo-sibling', 'file')), false);
    assert.equal(isWithin(path.join(root, 'repo'), path.join(root, 'repo', '..', 'escape')), false);
  });
  await check('log-redaction-and-cap', () => {
    const raw = Array.from({ length: 260 }, (_, index) => `line ${index} Authorization: Bearer sk-secret-${index} https://example.test/path?token=value`).join('\n');
    const value = limitedLog(raw); assert.ok(value.split(/\r?\n/).length <= 200); assert.ok(Buffer.byteLength(value) <= 64 * 1024);
    assert.doesNotMatch(value, /sk-secret|token=value|Bearer\s+(?!\[REDACTED\])/i);
    assert.doesNotMatch(sanitizeBuildLog(raw), /sk-secret|token=value/);
  });
  await check('late-result-after-abort', async () => {
    const unhandled = [], listener = (error) => unhandled.push(error); process.on('unhandledRejection', listener);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(waitForOperationResult('missing-operation', controller.signal, async () => undefined, 5), /assist_operation_cancelled/);
    settleOperationResult('missing-operation', { status: 'committed' });
    await new Promise((resolve) => setTimeout(resolve, 25)); process.removeListener('unhandledRejection', listener);
    assert.deepEqual(unhandled, []);
  });
  await check('server-browser-offline-deadlines', () => {
    const source = fs.readFileSync('apps/api/src/assist-operations.mjs', 'utf8'), timeout = Number(source.match(/OPERATION_TIMEOUT_MS\s*=\s*([\d_]+)/)?.[1].replaceAll('_', ''));
    assert.ok(timeout > 0 && timeout <= 35_000, `server browser-operation timeout must be <=35s, received ${timeout}`);
    assert.match(source, /failure_code === 'browser_claim_timeout'[\s\S]{0,300}assist_browser_executor_unavailable/, 'same-turn operations must reject after a browser claim timeout');
    const evidence = fs.readFileSync('tests/unit/v15-operations.test.mjs', 'utf8');
    assert.match(evidence, /fastFailureStarted[\s\S]{0,500}< 1_000/, 'fast-fail behavior must have a measured <1s assertion');
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures.length) throw new Error(`V1.75 fault/security diagnostics failed:\n${failures.join('\n')}`);
console.log('V1.75 fault/security diagnostics passed');
