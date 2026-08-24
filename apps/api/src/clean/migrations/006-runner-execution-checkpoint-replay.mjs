import { createHash } from 'node:crypto';

export const RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION_ID = '006-runner-execution-checkpoint-replay';
export const RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION_VERSION = 6;
export const RUNNER_EXECUTION_CHECKPOINT_REPLAY_TOOL_VERSION = 'v3-clean-p6';

// P6 projects execution events into execution_events, but the generic events,
// cursors, operations, CAS and aggregate heads remain the canonical ledgers.
export const RUNNER_EXECUTION_CHECKPOINT_REPLAY_SQL = `
CREATE TABLE IF NOT EXISTS runner_profiles (
  id TEXT PRIMARY KEY,
  owner_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
  runner_type TEXT NOT NULL CHECK(runner_type IN ('docker','host','windows_bridge')),
  endpoint_ref TEXT NOT NULL DEFAULT '' CHECK(length(endpoint_ref) <= 256),
  image_digest TEXT NOT NULL DEFAULT '' CHECK(image_digest='' OR (length(image_digest)=71 AND image_digest LIKE 'sha256:%')),
  bridge_device_id TEXT REFERENCES bridge_devices(id) ON DELETE RESTRICT,
  capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(capabilities_json)),
  capabilities_sha256 TEXT NOT NULL CHECK(length(capabilities_sha256)=64),
  limits_json TEXT NOT NULL CHECK(json_valid(limits_json)),
  limits_sha256 TEXT NOT NULL CHECK(length(limits_sha256)=64),
  identity_public_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unprobed' CHECK(status IN ('unprobed','probing','ready','unavailable','disabled')),
  last_probe_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(owner_actor_id,label)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_runner_profiles_owner ON runner_profiles(owner_actor_id,status,updated_at DESC,id);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
  workflow_revision INTEGER NOT NULL CHECK(workflow_revision > 0),
  workflow_hash TEXT NOT NULL CHECK(length(workflow_hash)=64),
  brief_revision INTEGER NOT NULL CHECK(brief_revision > 0),
  brief_hash TEXT NOT NULL CHECK(length(brief_hash)=64),
  repository_workspace_id TEXT NOT NULL REFERENCES repository_workspaces(id) ON DELETE RESTRICT,
  repository_revision INTEGER NOT NULL CHECK(repository_revision > 0),
  repository_hash TEXT NOT NULL CHECK(length(repository_hash)=64),
  context_pack_id TEXT NOT NULL REFERENCES context_packs(id) ON DELETE RESTRICT,
  context_pack_hash TEXT NOT NULL CHECK(length(context_pack_hash)=64),
  runner_profile_id TEXT NOT NULL REFERENCES runner_profiles(id) ON DELETE RESTRICT,
  runner_profile_revision INTEGER NOT NULL CHECK(runner_profile_revision > 0),
  runner_profile_hash TEXT NOT NULL CHECK(length(runner_profile_hash)=64),
  parent_execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  replanned_from_stage TEXT NOT NULL DEFAULT '' CHECK(replanned_from_stage='' OR replanned_from_stage IN ('prepare','context','run','check','review','finalize','deliver')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','running','pause_requested','awaiting_approval','paused','completed','failed','cancelled')),
  current_stage TEXT NOT NULL DEFAULT '' CHECK(current_stage='' OR current_stage IN ('prepare','context','run','check','review','finalize','deliver')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
  task_count INTEGER NOT NULL CHECK(task_count BETWEEN 0 AND 100),
  dependency_edge_count INTEGER NOT NULL CHECK(dependency_edge_count BETWEEN 0 AND 500),
  handoff_manifest_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(handoff_manifest_json)),
  handoff_manifest_sha256 TEXT NOT NULL DEFAULT '' CHECK(handoff_manifest_sha256='' OR length(handoff_manifest_sha256)=64),
  error_code TEXT NOT NULL DEFAULT '' CHECK(length(error_code) <= 120),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_executions_project ON executions(project_id,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_executions_parent ON executions(parent_execution_id,id);

CREATE TABLE IF NOT EXISTS execution_inputs (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 256),
  input_type TEXT NOT NULL CHECK(input_type IN ('brief','workflow','repository','context_pack','file','attachment','asset')),
  ref_id TEXT NOT NULL,
  ref_revision INTEGER NOT NULL CHECK(ref_revision >= 0),
  ref_hash TEXT NOT NULL CHECK(length(ref_hash)=64),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(execution_id,ordinal),
  UNIQUE(execution_id,input_type,ref_id,ref_revision)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_execution_inputs_execution ON execution_inputs(execution_id,ordinal);

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK(generation > 0),
  task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 160),
  task_ordinal INTEGER NOT NULL CHECK(task_ordinal BETWEEN 1 AND 100),
  attempt_no INTEGER NOT NULL CHECK(attempt_no BETWEEN 1 AND 3),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('read','write')),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  runner_profile_id TEXT NOT NULL REFERENCES runner_profiles(id) ON DELETE RESTRICT,
  job_spec_id TEXT,
  runner_receipt_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','leased','running','succeeded','failed','cancelled','expired','external_result_unknown')),
  dependency_hash TEXT NOT NULL CHECK(length(dependency_hash)=64),
  workspace_hash TEXT NOT NULL CHECK(length(workspace_hash)=64),
  lease_id TEXT NOT NULL DEFAULT '',
  fencing_token_hash TEXT NOT NULL DEFAULT '' CHECK(fencing_token_hash='' OR length(fencing_token_hash)=64),
  leased_until TEXT,
  stdout_sha256 TEXT NOT NULL DEFAULT '' CHECK(stdout_sha256='' OR length(stdout_sha256)=64),
  stderr_sha256 TEXT NOT NULL DEFAULT '' CHECK(stderr_sha256='' OR length(stderr_sha256)=64),
  output_sha256 TEXT NOT NULL DEFAULT '' CHECK(output_sha256='' OR length(output_sha256)=64),
  error_code TEXT NOT NULL DEFAULT '' CHECK(length(error_code) <= 120),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(execution_id,generation,task_id,attempt_no),
  UNIQUE(job_spec_id),
  UNIQUE(runner_receipt_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_task_attempts_execution ON task_attempts(execution_id,generation,task_ordinal,attempt_no);
CREATE INDEX IF NOT EXISTS idx_task_attempts_status ON task_attempts(status,leased_until,id);

CREATE TABLE IF NOT EXISTS job_specs (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  task_attempt_id TEXT NOT NULL UNIQUE REFERENCES task_attempts(id) ON DELETE RESTRICT,
  runner_profile_id TEXT NOT NULL REFERENCES runner_profiles(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL CHECK(schema_version='runner.job-spec.v2'),
  spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
  spec_sha256 TEXT NOT NULL UNIQUE CHECK(length(spec_sha256)=64),
  service_key_id TEXT NOT NULL CHECK(length(service_key_id) BETWEEN 1 AND 160),
  signature TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_job_specs_execution ON job_specs(execution_id,created_at,id);

CREATE TABLE IF NOT EXISTS runner_receipts (
  id TEXT PRIMARY KEY,
  job_spec_id TEXT NOT NULL UNIQUE REFERENCES job_specs(id) ON DELETE RESTRICT,
  task_attempt_id TEXT NOT NULL UNIQUE REFERENCES task_attempts(id) ON DELETE RESTRICT,
  runner_profile_id TEXT NOT NULL REFERENCES runner_profiles(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL CHECK(schema_version='runner.receipt.v2'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK(length(receipt_sha256)=64),
  signer_public_key TEXT NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('succeeded','failed','cancelled','expired','external_result_unknown')),
  exit_code INTEGER,
  stdout_sha256 TEXT NOT NULL DEFAULT '' CHECK(stdout_sha256='' OR length(stdout_sha256)=64),
  stderr_sha256 TEXT NOT NULL DEFAULT '' CHECK(stderr_sha256='' OR length(stderr_sha256)=64),
  output_sha256 TEXT NOT NULL DEFAULT '' CHECK(output_sha256='' OR length(output_sha256)=64),
  stdout_bytes INTEGER NOT NULL DEFAULT 0 CHECK(stdout_bytes BETWEEN 0 AND 2097152),
  stderr_bytes INTEGER NOT NULL DEFAULT 0 CHECK(stderr_bytes BETWEEN 0 AND 2097152),
  output_bytes INTEGER NOT NULL DEFAULT 0 CHECK(output_bytes BETWEEN 0 AND 10485760),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_runner_receipts_profile ON runner_receipts(runner_profile_id,created_at,id);

CREATE TABLE IF NOT EXISTS execution_stage_checkpoints (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK(generation > 0),
  stage TEXT NOT NULL CHECK(stage IN ('prepare','context','run','check','review','finalize','deliver')),
  stage_ordinal INTEGER NOT NULL CHECK(stage_ordinal BETWEEN 1 AND 7),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  workspace_sha256 TEXT NOT NULL CHECK(length(workspace_sha256)=64),
  pins_sha256 TEXT NOT NULL CHECK(length(pins_sha256)=64),
  prior_checkpoint_sha256 TEXT NOT NULL DEFAULT '' CHECK(prior_checkpoint_sha256='' OR length(prior_checkpoint_sha256)=64),
  checkpoint_token_hash TEXT NOT NULL CHECK(length(checkpoint_token_hash)=64),
  checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json)),
  checkpoint_sha256 TEXT NOT NULL UNIQUE CHECK(length(checkpoint_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(execution_id,generation,stage)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_execution_checkpoints ON execution_stage_checkpoints(execution_id,generation,stage_ordinal);

CREATE TABLE IF NOT EXISTS execution_events (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  generic_event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
  generic_sequence INTEGER NOT NULL UNIQUE CHECK(generic_sequence > 0),
  generation INTEGER NOT NULL CHECK(generation > 0),
  stage TEXT NOT NULL DEFAULT '' CHECK(stage='' OR stage IN ('prepare','context','run','check','review','finalize','deliver')),
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_execution_events_execution ON execution_events(execution_id,generic_sequence);

CREATE TRIGGER IF NOT EXISTS immutable_execution_inputs_update
  BEFORE UPDATE ON execution_inputs BEGIN SELECT RAISE(ABORT, 'immutable_execution_input'); END;
CREATE TRIGGER IF NOT EXISTS immutable_execution_inputs_delete
  BEFORE DELETE ON execution_inputs BEGIN SELECT RAISE(ABORT, 'immutable_execution_input'); END;
CREATE TRIGGER IF NOT EXISTS immutable_job_specs_update
  BEFORE UPDATE ON job_specs BEGIN SELECT RAISE(ABORT, 'immutable_job_spec'); END;
CREATE TRIGGER IF NOT EXISTS immutable_job_specs_delete
  BEFORE DELETE ON job_specs BEGIN SELECT RAISE(ABORT, 'immutable_job_spec'); END;
CREATE TRIGGER IF NOT EXISTS immutable_runner_receipts_update
  BEFORE UPDATE ON runner_receipts BEGIN SELECT RAISE(ABORT, 'immutable_runner_receipt'); END;
CREATE TRIGGER IF NOT EXISTS immutable_runner_receipts_delete
  BEFORE DELETE ON runner_receipts BEGIN SELECT RAISE(ABORT, 'immutable_runner_receipt'); END;
CREATE TRIGGER IF NOT EXISTS immutable_terminal_task_attempt_update
  BEFORE UPDATE ON task_attempts
  WHEN OLD.status IN ('succeeded','failed','cancelled','expired','external_result_unknown')
  BEGIN SELECT RAISE(ABORT, 'immutable_terminal_task_attempt'); END;
CREATE TRIGGER IF NOT EXISTS immutable_task_attempt_delete
  BEFORE DELETE ON task_attempts BEGIN SELECT RAISE(ABORT, 'immutable_task_attempt'); END;
CREATE TRIGGER IF NOT EXISTS immutable_execution_checkpoint_update
  BEFORE UPDATE ON execution_stage_checkpoints BEGIN SELECT RAISE(ABORT, 'immutable_execution_checkpoint'); END;
CREATE TRIGGER IF NOT EXISTS immutable_execution_checkpoint_delete
  BEFORE DELETE ON execution_stage_checkpoints BEGIN SELECT RAISE(ABORT, 'immutable_execution_checkpoint'); END;
CREATE TRIGGER IF NOT EXISTS immutable_execution_event_update
  BEFORE UPDATE ON execution_events BEGIN SELECT RAISE(ABORT, 'immutable_execution_event'); END;
CREATE TRIGGER IF NOT EXISTS immutable_execution_event_delete
  BEFORE DELETE ON execution_events BEGIN SELECT RAISE(ABORT, 'immutable_execution_event'); END;
`;

export const RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION_CHECKSUM = createHash('sha256')
  .update(`${RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION_VERSION}\n${RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION_ID}\n${RUNNER_EXECUTION_CHECKPOINT_REPLAY_SQL}`)
  .digest('hex');

export const RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION = Object.freeze({
  version: RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION_VERSION,
  id: RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION_ID,
  name: RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION_ID,
  family: 'v3-clean',
  sql: RUNNER_EXECUTION_CHECKPOINT_REPLAY_SQL,
  checksum: RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION_CHECKSUM,
  toolVersion: RUNNER_EXECUTION_CHECKPOINT_REPLAY_TOOL_VERSION
});
