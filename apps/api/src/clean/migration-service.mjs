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
import { ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION } from './migrations/005-assist-files-terminal-bridge.mjs';
import { RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION } from './migrations/006-runner-execution-checkpoint-replay.mjs';
import { EVIDENCE_QUALITY_PARSER_OUTCOME_MIGRATION } from './migrations/007-evidence-quality-parser-outcome.mjs';
import { DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_MIGRATION } from './migrations/008-delivery-deployment-importer-operations.mjs';
import { FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION } from './migrations/009-final-business-parity-governance.mjs';

// The three-entry export remains the frozen P3 compatibility view used by
// historical phase fixtures. P4 consumers use the complete forward registry.
export const CLEAN_MIGRATION_REGISTRY = Object.freeze([...CLEAN_MIGRATIONS, IDENTITY_MIGRATION, PROJECT_WORKFLOW_MIGRATION]);
export const CLEAN_P4_MIGRATION_REGISTRY = Object.freeze([...CLEAN_MIGRATION_REGISTRY, CONTEXT_PROJECTION_MCP_MIGRATION]);
export const CLEAN_P5_MIGRATION_REGISTRY = Object.freeze([...CLEAN_P4_MIGRATION_REGISTRY, ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION]);
export const CLEAN_P6_MIGRATION_REGISTRY = Object.freeze([...CLEAN_P5_MIGRATION_REGISTRY, RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION]);
export const CLEAN_P7_MIGRATION_REGISTRY = Object.freeze([...CLEAN_P6_MIGRATION_REGISTRY, EVIDENCE_QUALITY_PARSER_OUTCOME_MIGRATION]);
export const CLEAN_P8_MIGRATION_REGISTRY = Object.freeze([...CLEAN_P7_MIGRATION_REGISTRY, DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_MIGRATION]);
export const CLEAN_P10_MIGRATION_REGISTRY = Object.freeze([...CLEAN_P8_MIGRATION_REGISTRY, FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION]);
export { CLEAN_MIGRATIONS, IDENTITY_MIGRATION, PROJECT_WORKFLOW_MIGRATION, CONTEXT_PROJECTION_MCP_MIGRATION, ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION, RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION, EVIDENCE_QUALITY_PARSER_OUTCOME_MIGRATION, DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_MIGRATION, FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION };
