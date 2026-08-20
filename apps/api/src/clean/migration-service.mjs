export {
  CleanDatabase,
  CleanDatabaseError,
  CleanNotReadyError,
  openCleanDatabase,
  initializeCleanDatabase,
  schemaSnapshot,
  schemaSnapshotHash
} from './database.mjs';
import { CLEAN_MIGRATIONS } from './migrations/001-clean-baseline.mjs';
import { IDENTITY_MIGRATION } from './migrations/002-identity-acl.mjs';
import { PROJECT_WORKFLOW_MIGRATION } from './migrations/003-project-workflow.mjs';
import { CONTEXT_PROJECTION_MCP_MIGRATION } from './migrations/004-context-projection-mcp.mjs';

// The three-entry export remains the frozen P3 compatibility view used by
// historical phase fixtures. P4 consumers use the complete forward registry.
export const CLEAN_MIGRATION_REGISTRY = Object.freeze([...CLEAN_MIGRATIONS, IDENTITY_MIGRATION, PROJECT_WORKFLOW_MIGRATION]);
export const CLEAN_P4_MIGRATION_REGISTRY = Object.freeze([...CLEAN_MIGRATION_REGISTRY, CONTEXT_PROJECTION_MCP_MIGRATION]);
export { CLEAN_MIGRATIONS, IDENTITY_MIGRATION, PROJECT_WORKFLOW_MIGRATION, CONTEXT_PROJECTION_MCP_MIGRATION };
