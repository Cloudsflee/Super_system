import { createHash } from 'node:crypto';
import { SCHEMA_SQL, SCHEMA_VERSION } from '../schema.mjs';
import { IDENTITY_SETUP_V2_SQL } from './002-identity-setup.mjs';
import { PROJECT_REPOSITORY_INTAKE_V3 } from './003-project-repository-intake.mjs';

export const V1_MIGRATION_CHECKSUM = '49e206dad8a7b76051f6561aada0af375c164b5dd8bec7c9a615844f598ce8ca';

export const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: 'initial_v3_schema', sql: SCHEMA_SQL }),
  Object.freeze({ version: 2, name: 'identity_setup_providers', sql: IDENTITY_SETUP_V2_SQL }),
  PROJECT_REPOSITORY_INTAKE_V3
]);

if (MIGRATIONS.at(-1).version !== SCHEMA_VERSION) throw new Error('schema_version_migration_mismatch');
if (migrationChecksum(MIGRATIONS[0]) !== V1_MIGRATION_CHECKSUM) throw new Error('v1_migration_checksum_changed');

export function migrationChecksum(migration) {
  return createHash('sha256')
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest('hex');
}
