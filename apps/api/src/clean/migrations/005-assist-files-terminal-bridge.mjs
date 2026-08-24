import { createHash } from 'node:crypto';

export const ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION_ID = '005-assist-files-terminal-bridge';
export const ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION_VERSION = 5;
export const ASSIST_FILES_TERMINAL_BRIDGE_TOOL_VERSION = 'v3-clean-p5';

// P5 stores only bounded metadata, hashes and shared CAS references. Generic
// operations, events, cursors and aggregate heads remain the canonical ledger.
export const ASSIST_FILES_TERMINAL_BRIDGE_SQL = `
CREATE TABLE IF NOT EXISTS assist_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK(scope IN ('project','workflow','workstream','task')),
  scope_id TEXT NOT NULL,
  brief_revision INTEGER CHECK(brief_revision IS NULL OR brief_revision > 0),
  brief_hash TEXT NOT NULL DEFAULT '' CHECK(brief_hash='' OR length(brief_hash)=64),
  workflow_revision INTEGER CHECK(workflow_revision IS NULL OR workflow_revision > 0),
  workflow_hash TEXT NOT NULL DEFAULT '' CHECK(workflow_hash='' OR length(workflow_hash)=64),
  repository_workspace_id TEXT REFERENCES repository_workspaces(id) ON DELETE RESTRICT,
  repository_revision INTEGER CHECK(repository_revision IS NULL OR repository_revision > 0),
  repository_hash TEXT NOT NULL DEFAULT '' CHECK(repository_hash='' OR length(repository_hash)=64),
  context_pack_id TEXT NOT NULL REFERENCES context_packs(id) ON DELETE RESTRICT,
  context_pack_hash TEXT NOT NULL CHECK(length(context_pack_hash)=64),
  profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE RESTRICT,
  profile_revision INTEGER NOT NULL CHECK(profile_revision > 0),
  profile_hash TEXT NOT NULL CHECK(length(profile_hash)=64),
  credential_ref_id TEXT NOT NULL REFERENCES credential_refs(id) ON DELETE RESTRICT,
  credential_revision INTEGER NOT NULL CHECK(credential_revision > 0),
  provider_thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed','failed','cancelled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_assist_sessions_project ON assist_sessions(project_id,updated_at DESC,id);

CREATE TABLE IF NOT EXISTS assist_configurations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
  provider_schema_sha256 TEXT NOT NULL CHECK(length(provider_schema_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(session_id,revision)
) STRICT;

CREATE TABLE IF NOT EXISTS assist_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  turn_no INTEGER NOT NULL CHECK(turn_no > 0),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0),
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  provider_turn_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','running','awaiting_input','completed','failed','cancelled')),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  output_hash TEXT NOT NULL DEFAULT '' CHECK(output_hash='' OR length(output_hash)=64),
  terminal_notification_received INTEGER NOT NULL DEFAULT 0 CHECK(terminal_notification_received IN (0,1)),
  last_provider_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_provider_sequence >= 0),
  error_code TEXT NOT NULL DEFAULT '',
  error_details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(error_details_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(session_id,turn_no)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_assist_turns_session ON assist_turns(session_id,turn_no,id);
CREATE INDEX IF NOT EXISTS idx_assist_turns_operation ON assist_turns(operation_id);

CREATE TABLE IF NOT EXISTS assist_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  turn_id TEXT NOT NULL REFERENCES assist_turns(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','reasoning_summary')),
  kind TEXT NOT NULL DEFAULT 'message' CHECK(kind IN ('message','tool_call','tool_result','reasoning_summary')),
  provider_item_id TEXT,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  content_cas_hash TEXT NOT NULL CHECK(length(content_cas_hash)=64),
  terminal INTEGER NOT NULL DEFAULT 1 CHECK(terminal IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(turn_id,attempt,sequence),
  UNIQUE(turn_id,provider_item_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_assist_messages_turn ON assist_messages(turn_id,attempt,sequence);

CREATE TABLE IF NOT EXISTS assist_goals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  goal_json TEXT NOT NULL CHECK(json_valid(goal_json)),
  goal_sha256 TEXT NOT NULL CHECK(length(goal_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(session_id,revision)
) STRICT;

CREATE TABLE IF NOT EXISTS assist_references (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  reference_type TEXT NOT NULL CHECK(reference_type IN ('brief','workflow','repository','context_pack','attachment','file','operation')),
  reference_id TEXT NOT NULL,
  reference_revision INTEGER CHECK(reference_revision IS NULL OR reference_revision >= 0),
  reference_hash TEXT NOT NULL DEFAULT '' CHECK(reference_hash='' OR length(reference_hash)=64),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(session_id,reference_type,reference_id,reference_revision)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_assist_references_session ON assist_references(session_id,reference_type,id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 240),
  media_type TEXT NOT NULL CHECK(length(media_type) BETWEEN 1 AND 160),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 0 AND 10485760),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  content_cas_hash TEXT NOT NULL CHECK(length(content_cas_hash)=64),
  preview_cas_hash TEXT CHECK(preview_cas_hash IS NULL OR length(preview_cas_hash)=64),
  preview_byte_length INTEGER NOT NULL DEFAULT 0 CHECK(preview_byte_length BETWEEN 0 AND 262144),
  disposition TEXT NOT NULL CHECK(disposition IN ('preview','download_only','quarantine')),
  parser_status TEXT NOT NULL DEFAULT 'pending' CHECK(parser_status IN ('not_required','pending','quarantined','deleted')),
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('staged','ready','quarantined','deleted')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_attachments_project ON attachments(project_id,status,created_at DESC,id);

CREATE TABLE IF NOT EXISTS file_refs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES repository_workspaces(id) ON DELETE RESTRICT,
  relative_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 0 AND 1048576),
  media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  status TEXT NOT NULL DEFAULT 'current' CHECK(status IN ('current','deleted','stale')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(workspace_id,relative_path)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_file_refs_project ON file_refs(project_id,relative_path);

CREATE TABLE IF NOT EXISTS file_change_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES repository_workspaces(id) ON DELETE RESTRICT,
  assist_turn_id TEXT REFERENCES assist_turns(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  fencing_token_hash TEXT NOT NULL DEFAULT '' CHECK(fencing_token_hash='' OR length(fencing_token_hash)=64),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 1 AND 100),
  total_bytes INTEGER NOT NULL CHECK(total_bytes BETWEEN 0 AND 10485760),
  batch_sha256 TEXT NOT NULL CHECK(length(batch_sha256)=64),
  patch_cas_hash TEXT NOT NULL CHECK(length(patch_cas_hash)=64),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','approved','applying','applied','undoing','undone','stale','failed','expired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT,
  undone_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_file_change_batches_project ON file_change_batches(project_id,status,created_at DESC,id);

CREATE TABLE IF NOT EXISTS file_change_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES file_change_batches(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 100),
  relative_path TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','replace','delete')),
  before_sha256 TEXT NOT NULL DEFAULT '' CHECK(before_sha256='' OR length(before_sha256)=64),
  after_sha256 TEXT NOT NULL DEFAULT '' CHECK(after_sha256='' OR length(after_sha256)=64),
  before_cas_hash TEXT CHECK(before_cas_hash IS NULL OR length(before_cas_hash)=64),
  after_cas_hash TEXT CHECK(after_cas_hash IS NULL OR length(after_cas_hash)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 0 AND 1048576),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','undone','failed')),
  created_at TEXT NOT NULL,
  UNIQUE(batch_id,ordinal),
  UNIQUE(batch_id,relative_path)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_file_change_items_batch ON file_change_items(batch_id,ordinal);

CREATE TABLE IF NOT EXISTS runtime_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  assist_turn_id TEXT REFERENCES assist_turns(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 160),
  action_sha256 TEXT NOT NULL CHECK(length(action_sha256)=64),
  request_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(request_json)),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired','cancelled')),
  requested_revision INTEGER NOT NULL CHECK(requested_revision >= 0),
  decision_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  decision_reason TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_runtime_approvals_project ON runtime_approvals(project_id,status,created_at DESC,id);

CREATE TABLE IF NOT EXISTS runtime_user_inputs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  assist_turn_id TEXT REFERENCES assist_turns(id) ON DELETE RESTRICT,
  prompt_summary TEXT NOT NULL CHECK(length(prompt_summary) BETWEEN 1 AND 1000),
  input_schema_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(input_schema_json)),
  input_schema_sha256 TEXT NOT NULL CHECK(length(input_schema_sha256)=64),
  response_json TEXT,
  response_sha256 TEXT CHECK(response_sha256 IS NULL OR length(response_sha256)=64),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired','cancelled')),
  requested_revision INTEGER NOT NULL CHECK(requested_revision >= 0),
  expires_at TEXT NOT NULL,
  answered_at TEXT,
  answered_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_runtime_user_inputs_project ON runtime_user_inputs(project_id,status,created_at DESC,id);

CREATE TABLE IF NOT EXISTS semantic_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  assist_turn_id TEXT REFERENCES assist_turns(id) ON DELETE RESTRICT,
  proposal_type TEXT NOT NULL CHECK(length(proposal_type) BETWEEN 1 AND 120),
  target_type TEXT NOT NULL CHECK(length(target_type) BETWEEN 1 AND 120),
  target_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK(target_revision >= 0),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
  undo_payload_cas_hash TEXT CHECK(undo_payload_cas_hash IS NULL OR length(undo_payload_cas_hash)=64),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired','cancelled')),
  applied_operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_semantic_proposals_project ON semantic_proposals(project_id,status,created_at DESC,id);

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES repository_workspaces(id) ON DELETE RESTRICT,
  approval_id TEXT NOT NULL UNIQUE REFERENCES runtime_approvals(id) ON DELETE RESTRICT,
  assist_session_id TEXT REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  runtime TEXT NOT NULL CHECK(runtime IN ('windows_native','linux_native')),
  cwd_relative TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','running','orphaned','closed','failed','stopped')),
  cols INTEGER NOT NULL DEFAULT 120 CHECK(cols BETWEEN 20 AND 400),
  rows INTEGER NOT NULL DEFAULT 32 CHECK(rows BETWEEN 5 AND 200),
  last_client_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_client_sequence >= 0),
  output_bytes INTEGER NOT NULL DEFAULT 0 CHECK(output_bytes BETWEEN 0 AND 5242880),
  output_preview TEXT NOT NULL DEFAULT '',
  output_sha256 TEXT NOT NULL DEFAULT '' CHECK(output_sha256='' OR length(output_sha256)=64),
  exit_code INTEGER,
  error_code TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_sessions_active_workspace
  ON terminal_sessions(workspace_id) WHERE status IN ('ready','running');
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_project ON terminal_sessions(project_id,updated_at DESC,id);

CREATE TABLE IF NOT EXISTS terminal_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE RESTRICT,
  generic_event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
  generic_sequence INTEGER NOT NULL UNIQUE CHECK(generic_sequence > 0),
  event_type TEXT NOT NULL,
  chunk_cas_hash TEXT CHECK(chunk_cas_hash IS NULL OR length(chunk_cas_hash)=64),
  chunk_byte_length INTEGER NOT NULL DEFAULT 0 CHECK(chunk_byte_length BETWEEN 0 AND 1048576),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_terminal_events_session ON terminal_events(session_id,generic_sequence);

CREATE TABLE IF NOT EXISTS bridge_devices (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
  identity_public_key TEXT NOT NULL UNIQUE,
  transport_public_key TEXT NOT NULL,
  shared_secret_ref TEXT NOT NULL,
  confirmation_code_sha256 TEXT NOT NULL CHECK(length(confirmation_code_sha256)=64),
  paired_transcript_sha256 TEXT NOT NULL CHECK(length(paired_transcript_sha256)=64),
  status TEXT NOT NULL DEFAULT 'pairing' CHECK(status IN ('pairing','paired','revoked')),
  last_nonce_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_nonce_sequence >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_bridge_devices_actor ON bridge_devices(actor_id,status,updated_at DESC,id);

CREATE TABLE IF NOT EXISTS bridge_transfers (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES bridge_devices(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK(direction IN ('send','receive')),
  transfer_type TEXT NOT NULL CHECK(transfer_type IN ('git_bundle','terminal_control')),
  repository_ref TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  bundle_sha256 TEXT NOT NULL DEFAULT '' CHECK(bundle_sha256='' OR length(bundle_sha256)=64),
  byte_length INTEGER NOT NULL DEFAULT 0 CHECK(byte_length BETWEEN 0 AND 1073741824),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','failed','cancelled')),
  error_code TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_bridge_transfers_device ON bridge_transfers(device_id,created_at DESC,id);

CREATE TRIGGER IF NOT EXISTS immutable_assist_configurations_update
  BEFORE UPDATE ON assist_configurations BEGIN SELECT RAISE(ABORT, 'immutable_assist_configuration'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_configurations_delete
  BEFORE DELETE ON assist_configurations BEGIN SELECT RAISE(ABORT, 'immutable_assist_configuration'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_messages_update
  BEFORE UPDATE ON assist_messages BEGIN SELECT RAISE(ABORT, 'immutable_assist_message'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_messages_delete
  BEFORE DELETE ON assist_messages BEGIN SELECT RAISE(ABORT, 'immutable_assist_message'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_goals_update
  BEFORE UPDATE ON assist_goals BEGIN SELECT RAISE(ABORT, 'immutable_assist_goal'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_goals_delete
  BEFORE DELETE ON assist_goals BEGIN SELECT RAISE(ABORT, 'immutable_assist_goal'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_references_update
  BEFORE UPDATE ON assist_references BEGIN SELECT RAISE(ABORT, 'immutable_assist_reference'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_references_delete
  BEFORE DELETE ON assist_references BEGIN SELECT RAISE(ABORT, 'immutable_assist_reference'); END;
CREATE TRIGGER IF NOT EXISTS immutable_file_change_items_update
  BEFORE UPDATE ON file_change_items BEGIN SELECT RAISE(ABORT, 'immutable_file_change_item'); END;
CREATE TRIGGER IF NOT EXISTS immutable_file_change_items_delete
  BEFORE DELETE ON file_change_items BEGIN SELECT RAISE(ABORT, 'immutable_file_change_item'); END;
`;

export const ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION_CHECKSUM = createHash('sha256')
  .update(`${ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION_VERSION}\n${ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION_ID}\n${ASSIST_FILES_TERMINAL_BRIDGE_SQL}`)
  .digest('hex');

export const ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION = Object.freeze({
  version: ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION_VERSION,
  id: ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION_ID,
  name: ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION_ID,
  family: 'v3-clean',
  sql: ASSIST_FILES_TERMINAL_BRIDGE_SQL,
  checksum: ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION_CHECKSUM,
  toolVersion: ASSIST_FILES_TERMINAL_BRIDGE_TOOL_VERSION
});
