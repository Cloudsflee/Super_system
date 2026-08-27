import { createHash } from 'node:crypto';

export const DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_MIGRATION_ID = '008-delivery-deployment-importer-operations';
export const DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_MIGRATION_VERSION = 8;
export const DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_TOOL_VERSION = 'v3-clean-p8';

export const DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_SQL = `
CREATE TABLE IF NOT EXISTS delivery_policies (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL, required_checks_json TEXT NOT NULL CHECK(json_valid(required_checks_json)),
  approval_policy_json TEXT NOT NULL CHECK(json_valid(approval_policy_json)), snapshot_sha256 TEXT NOT NULL UNIQUE CHECK(length(snapshot_sha256)=64),
  revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_delivery_policies_project ON delivery_policies(project_id,created_at,id);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT, policy_id TEXT NOT NULL REFERENCES delivery_policies(id) ON DELETE RESTRICT,
  repository_target_id TEXT NOT NULL REFERENCES repository_targets(id) ON DELETE RESTRICT, operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  retry_of_delivery_id TEXT REFERENCES deliveries(id) ON DELETE RESTRICT, generation INTEGER NOT NULL CHECK(generation>0),
  handoff_sha256 TEXT NOT NULL CHECK(length(handoff_sha256)=64), evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64), outcome_sha256 TEXT NOT NULL CHECK(length(outcome_sha256)=64),
  target_head_sha TEXT NOT NULL CHECK(length(target_head_sha)>=7), branch_name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','preparing','draft_pr','ready','merging','merged','failed','cancelled','needs_reconcile')),
  revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(project_id,generation)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_deliveries_project ON deliveries(project_id,status,updated_at DESC,id);

CREATE TABLE IF NOT EXISTS pull_request_intents (
  id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE RESTRICT, generation INTEGER NOT NULL CHECK(generation>0),
  action TEXT NOT NULL CHECK(action IN ('create_draft','mark_ready','merge','reconcile')), prior_intent_id TEXT REFERENCES pull_request_intents(id) ON DELETE RESTRICT,
  patch_cas_sha256 TEXT NOT NULL REFERENCES cas_objects(sha256) ON DELETE RESTRICT, patch_sha256 TEXT NOT NULL CHECK(length(patch_sha256)=64),
  base_sha TEXT NOT NULL, head_sha TEXT NOT NULL, required_checks_json TEXT NOT NULL CHECK(json_valid(required_checks_json)), approval_sha256 TEXT NOT NULL CHECK(length(approval_sha256)=64),
  remote_ref_digest TEXT NOT NULL DEFAULT '' CHECK(remote_ref_digest='' OR length(remote_ref_digest)=64), status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','unknown','reconciled')),
  intent_sha256 TEXT NOT NULL UNIQUE CHECK(length(intent_sha256)=64), created_at TEXT NOT NULL, created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(delivery_id,generation)
) STRICT;

CREATE TABLE IF NOT EXISTS delivery_events (
  id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE RESTRICT, event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
  intent_id TEXT REFERENCES pull_request_intents(id) ON DELETE RESTRICT,
  external_receipt_sha256 TEXT NOT NULL DEFAULT '' CHECK(external_receipt_sha256='' OR length(external_receipt_sha256)=64),
  event_type TEXT NOT NULL, payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64), created_at TEXT NOT NULL,
  UNIQUE(delivery_id,event_id)
) STRICT;

CREATE TABLE IF NOT EXISTS deployment_candidates (
  id TEXT PRIMARY KEY, retry_of_candidate_id TEXT REFERENCES deployment_candidates(id) ON DELETE RESTRICT, generation INTEGER NOT NULL CHECK(generation>0),
  app_digest TEXT NOT NULL, broker_digest TEXT NOT NULL, runner_digest TEXT NOT NULL, parser_digest TEXT NOT NULL,
  bridge_identity TEXT NOT NULL, sbom_sha256 TEXT NOT NULL CHECK(length(sbom_sha256)=64), source_tree_sha256 TEXT NOT NULL CHECK(length(source_tree_sha256)=64),
  lockfile_sha256 TEXT NOT NULL CHECK(length(lockfile_sha256)=64), gate_fingerprint TEXT NOT NULL CHECK(length(gate_fingerprint)=64),
  compose_sha256 TEXT NOT NULL CHECK(length(compose_sha256)=64), volume_manifest_json TEXT NOT NULL CHECK(json_valid(volume_manifest_json)), candidate_sha256 TEXT NOT NULL UNIQUE CHECK(length(candidate_sha256)=64),
  status TEXT NOT NULL CHECK(status IN ('candidate','verifying','verified','failed','needs_reconcile')), revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS deployment_verifications (
  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES deployment_candidates(id) ON DELETE RESTRICT, operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  checks_json TEXT NOT NULL CHECK(json_valid(checks_json)), viewport_evidence_json TEXT NOT NULL CHECK(json_valid(viewport_evidence_json)),
  volume_manifest_sha256 TEXT NOT NULL CHECK(length(volume_manifest_sha256)=64), receipt_sha256 TEXT NOT NULL UNIQUE CHECK(length(receipt_sha256)=64),
  status TEXT NOT NULL CHECK(status IN ('passed','failed','unknown')), created_at TEXT NOT NULL, created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS backup_manifests (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT, source_user_version INTEGER NOT NULL CHECK(source_user_version BETWEEN 1 AND 8),
  sqlite_sha256 TEXT NOT NULL CHECK(length(sqlite_sha256)=64), components_json TEXT NOT NULL CHECK(json_valid(components_json)), manifest_sha256 TEXT NOT NULL UNIQUE CHECK(length(manifest_sha256)=64),
  retention_class TEXT NOT NULL CHECK(retention_class IN ('permanent','standard','diagnostic')), created_at TEXT NOT NULL, created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY, retry_of_batch_id TEXT REFERENCES import_batches(id) ON DELETE RESTRICT, generation INTEGER NOT NULL CHECK(generation>0),
  source_v23_sha256 TEXT NOT NULL CHECK(length(source_v23_sha256)=64), source_v3_sha256 TEXT NOT NULL CHECK(length(source_v3_sha256)=64),
  plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64), mapping_sha256 TEXT NOT NULL CHECK(length(mapping_sha256)=64), tool_sha256 TEXT NOT NULL CHECK(length(tool_sha256)=64), target_sha256 TEXT NOT NULL DEFAULT '' CHECK(target_sha256='' OR length(target_sha256)=64),
  status TEXT NOT NULL CHECK(status IN ('inspected','planned','running','blocked','sealed','cutover','rolled_back')), revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  UNIQUE(source_v23_sha256,source_v3_sha256,generation)
) STRICT;

CREATE TABLE IF NOT EXISTS import_checkpoints (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT, domain TEXT NOT NULL, last_source_key TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK(row_count>=0), source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64), plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
  mapping_sha256 TEXT NOT NULL CHECK(length(mapping_sha256)=64), tool_sha256 TEXT NOT NULL CHECK(length(tool_sha256)=64), target_sha256 TEXT NOT NULL CHECK(length(target_sha256)=64),
  checkpoint_sha256 TEXT NOT NULL UNIQUE CHECK(length(checkpoint_sha256)=64), signature TEXT NOT NULL, fsynced_at TEXT NOT NULL, UNIQUE(batch_id,domain,last_source_key)
) STRICT;

CREATE TABLE IF NOT EXISTS import_id_map (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT, source_family TEXT NOT NULL CHECK(source_family IN ('v23','v3-clean-v7')),
  entity_type TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, mapping_reason TEXT NOT NULL CHECK(mapping_reason IN ('canonical','preserved','deterministic_remap')),
  mapping_sha256 TEXT NOT NULL CHECK(length(mapping_sha256)=64), created_at TEXT NOT NULL, UNIQUE(batch_id,source_family,entity_type,source_id), UNIQUE(batch_id,entity_type,target_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_import_id_map_lookup ON import_id_map(batch_id,entity_type,source_id);

CREATE TABLE IF NOT EXISTS import_conflicts (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT, entity_type TEXT NOT NULL, source_ids_json TEXT NOT NULL CHECK(json_valid(source_ids_json)),
  conflict_kind TEXT NOT NULL CHECK(conflict_kind IN ('technical_remap','semantic_block','missing_reference','secret_omitted')), disposition TEXT NOT NULL CHECK(disposition IN ('remapped','blocked','omitted')),
  details_sha256 TEXT NOT NULL CHECK(length(details_sha256)=64), created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER immutable_delivery_policy_update BEFORE UPDATE ON delivery_policies BEGIN SELECT RAISE(ABORT,'immutable_delivery_policy'); END;
CREATE TRIGGER immutable_delivery_policy_delete BEFORE DELETE ON delivery_policies BEGIN SELECT RAISE(ABORT,'immutable_delivery_policy'); END;
CREATE TRIGGER immutable_pr_intent_update BEFORE UPDATE ON pull_request_intents BEGIN SELECT RAISE(ABORT,'immutable_pr_intent'); END;
CREATE TRIGGER immutable_pr_intent_delete BEFORE DELETE ON pull_request_intents BEGIN SELECT RAISE(ABORT,'immutable_pr_intent'); END;
CREATE TRIGGER immutable_delivery_event_update BEFORE UPDATE ON delivery_events BEGIN SELECT RAISE(ABORT,'immutable_delivery_event'); END;
CREATE TRIGGER immutable_delivery_event_delete BEFORE DELETE ON delivery_events BEGIN SELECT RAISE(ABORT,'immutable_delivery_event'); END;
CREATE TRIGGER immutable_deployment_verification_update BEFORE UPDATE ON deployment_verifications BEGIN SELECT RAISE(ABORT,'immutable_deployment_verification'); END;
CREATE TRIGGER immutable_deployment_verification_delete BEFORE DELETE ON deployment_verifications BEGIN SELECT RAISE(ABORT,'immutable_deployment_verification'); END;
CREATE TRIGGER immutable_backup_manifest_update BEFORE UPDATE ON backup_manifests BEGIN SELECT RAISE(ABORT,'immutable_backup_manifest'); END;
CREATE TRIGGER immutable_backup_manifest_delete BEFORE DELETE ON backup_manifests BEGIN SELECT RAISE(ABORT,'immutable_backup_manifest'); END;
CREATE TRIGGER immutable_import_checkpoint_update BEFORE UPDATE ON import_checkpoints BEGIN SELECT RAISE(ABORT,'immutable_import_checkpoint'); END;
CREATE TRIGGER immutable_import_id_map_update BEFORE UPDATE ON import_id_map BEGIN SELECT RAISE(ABORT,'immutable_import_id_map'); END;
CREATE TRIGGER immutable_import_conflict_update BEFORE UPDATE ON import_conflicts BEGIN SELECT RAISE(ABORT,'immutable_import_conflict'); END;
CREATE TRIGGER immutable_terminal_delivery_update BEFORE UPDATE ON deliveries WHEN OLD.status IN ('merged','failed','cancelled') BEGIN SELECT RAISE(ABORT,'immutable_terminal_delivery'); END;
CREATE TRIGGER immutable_terminal_candidate_update BEFORE UPDATE ON deployment_candidates WHEN OLD.status IN ('verified','failed') BEGIN SELECT RAISE(ABORT,'immutable_terminal_candidate'); END;
CREATE TRIGGER immutable_terminal_import_batch_update BEFORE UPDATE ON import_batches WHEN OLD.status IN ('blocked','sealed','cutover','rolled_back') BEGIN SELECT RAISE(ABORT,'immutable_terminal_import_batch'); END;
`;

export const DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_MIGRATION_CHECKSUM = createHash('sha256')
  .update(`${DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_MIGRATION_VERSION}\n${DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_MIGRATION_ID}\n${DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_SQL}`).digest('hex');

export const DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_MIGRATION = Object.freeze({
  version: DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_MIGRATION_VERSION,
  id: DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_MIGRATION_ID,
  name: DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_MIGRATION_ID,
  family: 'v3-clean', sql: DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_SQL,
  checksum: DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_MIGRATION_CHECKSUM,
  toolVersion: DELIVERY_DEPLOYMENT_IMPORTER_OPERATIONS_TOOL_VERSION
});
