import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ImmutableEvidenceWriter } from '../../scripts/lib/immutable-evidence-writer.mjs';

test('failed receipts are immutable and resume appends an attempt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p31-evidence-'));
  try {
    const writer = new ImmutableEvidenceWriter(root, { runId: 'run-a' });
    writer.write('checkpoint.json', { status: 'checkpoint', attempt: 1 });
    assert.throws(() => writer.write('checkpoint.json', { status: 'checkpoint', attempt: 2 }), /immutable|exists/);
    const resumed = writer.resume('run-a');
    resumed.write('checkpoint.json', { status: 'failed', attempt: 2 });
    assert.equal(fs.existsSync(path.join(root, 'attempts', 'run-a', 'checkpoint.json')), true);
    assert.equal(fs.existsSync(path.join(root, 'attempts', 'run-a-2', 'checkpoint.json')), true);
    resumed.finalize({ status: 'verified' });
    assert.throws(() => resumed.finalize({ status: 'verified' }), /exists|EEXIST/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
