import { createHash } from 'node:crypto';

export const CLEAN_SCHEMA_FAMILY = 'v3-clean';
export const CLEAN_BASELINE_ID = '001-clean-baseline';
export const CLEAN_USER_VERSION = 1;
export const CLEAN_TOOL_VERSION = 'v3-clean-p1';

export const CLEAN_BASELINE_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_meta (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  family TEXT NOT NULL CHECK(family = 'v3-clean'),
  baseline_id TEXT NOT NULL,
  runtime_build TEXT NOT NULL,
  canonicalization_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE CHECK(version > 0),
  family TEXT NOT NULL CHECK(family = 'v3-clean'),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  tool_version TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256) = 64),
  verification_receipt_sha256 TEXT NOT NULL CHECK(length(verification_receipt_sha256) = 64),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('system','user','service','agent')),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 160),
  status TEXT NOT NULL CHECK(status IN ('active','suspended','revoked')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256) = 64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  command_version INTEGER NOT NULL CHECK(command_version > 0),
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('accepted','queued','running','paused','succeeded','failed','cancelled','expired')),
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  external_ref TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json)),
  error_code TEXT NOT NULL DEFAULT '',
  error_details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(error_details_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  cancel_requested_at TEXT,
  cancel_requested_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  completed_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS aggregate_heads (
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK(current_revision > 0),
  current_hash TEXT NOT NULL CHECK(length(current_hash) = 64),
  last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_event_sequence >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(aggregate_type, aggregate_id)
) STRICT;

CREATE TABLE IF NOT EXISTS aggregate_revisions (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(aggregate_type, aggregate_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS operation_links (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('target','retry_of','replay_of','parent','related')),
  created_at TEXT NOT NULL,
  UNIQUE(operation_id, aggregate_type, aggregate_id, relation)
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  id TEXT NOT NULL UNIQUE,
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL CHECK(aggregate_revision > 0),
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  project_id TEXT,
  occurred_at TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  data_sha256 TEXT NOT NULL CHECK(length(data_sha256) = 64),
  redactions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(redactions_json))
) STRICT;

CREATE TABLE IF NOT EXISTS event_cursors (
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  consumer_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  project_id TEXT,
  cursor_sequence INTEGER NOT NULL DEFAULT 0 CHECK(cursor_sequence >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(actor_id, consumer_id, stream)
) STRICT;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  command_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  response_status INTEGER,
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id, command_id, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  data_sha256 TEXT NOT NULL CHECK(length(data_sha256) = 64),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cas_objects (
  sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64),
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  relative_key TEXT NOT NULL UNIQUE,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','tombstoned')),
  created_at TEXT NOT NULL,
  tombstoned_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS receipt_manifests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('created','verified','failed','expired')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
  cas_sha256 TEXT CHECK(cas_sha256 IS NULL OR length(cas_sha256) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_type, aggregate_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_operation ON events(operation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, sequence);
CREATE INDEX IF NOT EXISTS idx_revisions_aggregate ON aggregate_revisions(aggregate_type, aggregate_id, revision);

CREATE TRIGGER IF NOT EXISTS immutable_schema_meta_update
  BEFORE UPDATE ON schema_meta BEGIN SELECT RAISE(ABORT, 'immutable_schema_meta'); END;
CREATE TRIGGER IF NOT EXISTS immutable_schema_meta_delete
  BEFORE DELETE ON schema_meta BEGIN SELECT RAISE(ABORT, 'immutable_schema_meta'); END;
CREATE TRIGGER IF NOT EXISTS immutable_schema_migrations_update
  BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'immutable_schema_migrations'); END;
CREATE TRIGGER IF NOT EXISTS immutable_schema_migrations_delete
  BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'immutable_schema_migrations'); END;
CREATE TRIGGER IF NOT EXISTS immutable_aggregate_revisions_update
  BEFORE UPDATE ON aggregate_revisions BEGIN SELECT RAISE(ABORT, 'immutable_aggregate_revision'); END;
CREATE TRIGGER IF NOT EXISTS immutable_aggregate_revisions_delete
  BEFORE DELETE ON aggregate_revisions BEGIN SELECT RAISE(ABORT, 'immutable_aggregate_revision'); END;
CREATE TRIGGER IF NOT EXISTS immutable_events_update
  BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'immutable_event'); END;
CREATE TRIGGER IF NOT EXISTS immutable_events_delete
  BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'immutable_event'); END;
CREATE TRIGGER IF NOT EXISTS immutable_audit_events_update
  BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'immutable_audit_event'); END;
CREATE TRIGGER IF NOT EXISTS immutable_audit_events_delete
  BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'immutable_audit_event'); END;
CREATE TRIGGER IF NOT EXISTS immutable_receipt_manifests_update
  BEFORE UPDATE ON receipt_manifests BEGIN SELECT RAISE(ABORT, 'immutable_receipt_manifest'); END;
CREATE TRIGGER IF NOT EXISTS immutable_receipt_manifests_delete
  BEFORE DELETE ON receipt_manifests BEGIN SELECT RAISE(ABORT, 'immutable_receipt_manifest'); END;
`;

export const CLEAN_BASELINE_CHECKSUM = createHash('sha256')
  .update(`${CLEAN_USER_VERSION}\n${CLEAN_BASELINE_ID}\n${CLEAN_BASELINE_SQL}`)
  .digest('hex');

export const CLEAN_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: CLEAN_USER_VERSION,
    id: CLEAN_BASELINE_ID,
    name: CLEAN_BASELINE_ID,
    family: CLEAN_SCHEMA_FAMILY,
    sql: CLEAN_BASELINE_SQL,
    checksum: CLEAN_BASELINE_CHECKSUM,
    toolVersion: CLEAN_TOOL_VERSION
  })
]);
