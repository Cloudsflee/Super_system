import { createHash } from 'node:crypto';
import { SCHEMA_SQL, SCHEMA_VERSION } from '../schema.mjs';

export const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: 'initial_v3_schema', sql: SCHEMA_SQL })
]);

if (MIGRATIONS.at(-1).version !== SCHEMA_VERSION) throw new Error('schema_version_migration_mismatch');

export function migrationChecksum(migration) {
  return createHash('sha256')
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest('hex');
}
