import path from 'node:path';
import { restoreMigrationSnapshot } from '../apps/api/src/migration-service.mjs';

const databaseIndex = process.argv.indexOf('--database');
const manifestIndex = process.argv.indexOf('--manifest');
if (databaseIndex < 0 || manifestIndex < 0) throw new Error('restore_migration_snapshot_arguments_required');
const result = restoreMigrationSnapshot({
  file: path.resolve(process.argv[databaseIndex + 1]),
  manifestPath: path.resolve(process.argv[manifestIndex + 1])
});
process.stdout.write(`${JSON.stringify({ status: 'restored', ...result }, null, 2)}\n`);
