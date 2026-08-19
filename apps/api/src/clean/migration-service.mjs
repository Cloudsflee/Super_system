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

export const CLEAN_MIGRATION_REGISTRY = Object.freeze([...CLEAN_MIGRATIONS, IDENTITY_MIGRATION, PROJECT_WORKFLOW_MIGRATION]);
export { CLEAN_MIGRATIONS, IDENTITY_MIGRATION, PROJECT_WORKFLOW_MIGRATION };
