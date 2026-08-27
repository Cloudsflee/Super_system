import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCleanDatabase } from '../apps/api/src/clean/database.mjs';
import { buildPlan, runImport, verifyTarget } from '../apps/importer/cli.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-import-probe-'));
try {
  const v23 = path.join(root, 'v23.sqlite');
  const v3 = path.join(root, 'v7.sqlite');
  const target = path.join(root, 'v8.sqlite');
  const legacy = new DatabaseSync(v23);
  legacy.exec("CREATE TABLE users(id TEXT PRIMARY KEY,display_name TEXT,status TEXT,revision INTEGER,created_at TEXT,updated_at TEXT) STRICT; INSERT INTO users VALUES('probe_user','Probe user','active',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'); PRAGMA user_version=23");
  legacy.close();
  openCleanDatabase(v3, { targetVersion: 7, receiptRoot: path.join(root, 'receipts') }).close();
  const options = { v23, v3, target, targetCas: path.join(root, 'target-cas'), checkpointKey: 'p8-import-probe-checkpoint-key' };
  const first = buildPlan(options);
  const second = buildPlan(options);
  const run = await runImport(options);
  const verify = verifyTarget(options);
  const passed = JSON.stringify(first) === JSON.stringify(second) && run.status === 'sealed' && verify.status === 'passed' && verify.mapping.mapped_rows === 1;
  const result = { schema_version: 'aiws.v3-clean.p8-importer-probe.v2', status: passed ? 'passed' : 'failed', provisional: false, deterministic: JSON.stringify(first) === JSON.stringify(second), sealed: run.status === 'sealed', mapped_rows: verify.mapping.mapped_rows, verify };
  console.log(JSON.stringify(result, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
