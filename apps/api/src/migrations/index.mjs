import { createHash } from 'node:crypto';
import { SCHEMA_SQL, SCHEMA_VERSION } from '../schema.mjs';
import { IDENTITY_SETUP_V2_SQL } from './002-identity-setup.mjs';
import { PROJECT_REPOSITORY_INTAKE_V3 } from './003-project-repository-intake.mjs';
import { WORKFLOW_GENERATION_CRITIC_V4 } from './004-workflow-generation-critic.mjs';
import { CONTEXT_PROJECTION_MCP_V5 } from './005-context-projection-mcp.mjs';
import { ASSIST_RUNTIME_V6 } from './006-assist-runtime.mjs';

export const V1_MIGRATION_CHECKSUM = '49e206dad8a7b76051f6561aada0af375c164b5dd8bec7c9a615844f598ce8ca';
export const V2_MIGRATION_CHECKSUM = '474cd76da2e8be23a5c7b66fd46e5a0f2cb3db03213c20e4241694f677f966bc';
export const V3_MIGRATION_CHECKSUM = '1c03a0fad89946a23f4dcd4874c2737f6597a002355264cd0412a90e5d86de6f';
export const V4_MIGRATION_CHECKSUM = 'e5d4ccaef7c0672c6a7ff4aa0d2fd47437696c92e565220cb10f3ff03d1af2e7';
export const V5_MIGRATION_CHECKSUM = 'e4b6a9f85f25d8f604872164454e23c0d2a32004a50fcd7122458145d15de44c';
export const V6_MIGRATION_CHECKSUM = '3d415a3d8c0f23d4586e653ebb5c40fb2a281b7136ebd44c74ba3386310b2b8f';

export const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: 'initial_v3_schema', sql: SCHEMA_SQL }),
  Object.freeze({ version: 2, name: 'identity_setup_providers', sql: IDENTITY_SETUP_V2_SQL }),
  PROJECT_REPOSITORY_INTAKE_V3,
  WORKFLOW_GENERATION_CRITIC_V4,
  CONTEXT_PROJECTION_MCP_V5,
  ASSIST_RUNTIME_V6
]);

if (MIGRATIONS.at(-1).version !== SCHEMA_VERSION) throw new Error('schema_version_migration_mismatch');
if (migrationChecksum(MIGRATIONS[0]) !== V1_MIGRATION_CHECKSUM) throw new Error('v1_migration_checksum_changed');
if (migrationChecksum(MIGRATIONS[1]) !== V2_MIGRATION_CHECKSUM) throw new Error('v2_migration_checksum_changed');
if (migrationChecksum(MIGRATIONS[2]) !== V3_MIGRATION_CHECKSUM) throw new Error('v3_migration_checksum_changed');
if (migrationChecksum(MIGRATIONS[3]) !== V4_MIGRATION_CHECKSUM) throw new Error('v4_migration_checksum_changed');
if (migrationChecksum(MIGRATIONS[4]) !== V5_MIGRATION_CHECKSUM) throw new Error('v5_migration_checksum_changed');
if (migrationChecksum(MIGRATIONS[5]) !== V6_MIGRATION_CHECKSUM) throw new Error('v6_migration_checksum_changed');

export function migrationChecksum(migration) {
  return createHash('sha256')
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest('hex');
}
