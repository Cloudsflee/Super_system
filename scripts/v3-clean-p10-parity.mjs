#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_COMMAND_REGISTRY } from '../apps/api/src/clean/registry.mjs';
import { auditParity, writeParityArtifacts } from './lib/v3-clean-p10-parity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write-baseline');
if (write) {
  const sourceIndex = process.argv.indexOf('--source-root');
  const sourceRoot = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : null;
  if (!sourceRoot) throw new Error('p10_source_root_required');
  const result = writeParityArtifacts({ root, sourceRoot });
  process.stdout.write(`${JSON.stringify({
    schema_version: 'aiws.v3-clean.p10-parity-write.v1',
    status: 'written',
    directory: result.directory,
    counts: result.inventory.counts,
    inventory_sha256: result.inventory.inventory_sha256,
    map_sha256: result.parityMap.map_sha256
  }, null, 2)}\n`);
} else {
  const result = await auditParity({ root, registry: CLEAN_COMMAND_REGISTRY, verifyGit: !process.argv.includes('--no-git') });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
}
