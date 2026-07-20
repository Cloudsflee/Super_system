// V1.9 extends schema 18 in place. Keep this module as the explicit V1.9
// compatibility entry point for tooling without creating a schema 19 fork.
export {
  STATE_SCHEMA_VERSION, V18_COLLECTIONS as V19_COLLECTIONS, migrateState17To18 as migrateStateToV19,
  migrateState17To18, migrateStateFileToV18 as migrateStateFileToV19, migrateStateFileToV18,
  validateState18 as validateStateV19, validateState18 as validateState19, validateState18
} from './state-migration-v18.mjs';
