export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS brief_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS brief_heads (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS repository_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
  local_path TEXT NOT NULL,
  remote_url TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS workflow_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  name TEXT NOT NULL,
  tasks_json TEXT NOT NULL CHECK(json_valid(tasks_json)),
  graph_hash TEXT NOT NULL CHECK(length(graph_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS workflow_heads (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS context_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('brief','repository','file','diff','test_report','image','note')),
  path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  created_at TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS context_source_fts USING fts5(
  source_id UNINDEXED,
  title,
  content,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_ids_json TEXT NOT NULL CHECK(json_valid(source_ids_json)),
  pack_json TEXT NOT NULL CHECK(json_valid(pack_json)),
  pack_hash TEXT NOT NULL CHECK(length(pack_hash) = 64),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('task','delivery_create','delivery_merge','asset')),
  model_status TEXT NOT NULL CHECK(model_status IN ('available','unavailable','invalid')),
  suggestion_json TEXT NOT NULL CHECK(json_valid(suggestion_json)),
  input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision = 1),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS review_decisions (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL UNIQUE REFERENCES reviews(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','changes_requested')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS asset_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  cas_hash TEXT NOT NULL CHECK(length(cas_hash) = 64),
  cas_path TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, name, version)
) STRICT;

CREATE TABLE IF NOT EXISTS evidence_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL CHECK(target_type IN ('task','review','delivery','execution')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workflow_revision INTEGER NOT NULL,
  brief_revision INTEGER NOT NULL,
  brief_hash TEXT NOT NULL CHECK(length(brief_hash) = 64),
  repository_sha TEXT NOT NULL DEFAULT '',
  context_pack_id TEXT REFERENCES context_packs(id) ON DELETE RESTRICT,
  context_pack_hash TEXT NOT NULL DEFAULT '' CHECK(context_pack_hash = '' OR length(context_pack_hash) = 64),
  input_assets_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(input_assets_json)),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','awaiting_human','completed','failed','cancelled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id, workflow_revision) REFERENCES workflow_revisions(project_id, revision),
  FOREIGN KEY(project_id, brief_revision) REFERENCES brief_revisions(project_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
  status TEXT NOT NULL CHECK(status IN ('pending','ready','running','awaiting_human','completed','failed','cancelled')),
  mode TEXT NOT NULL CHECK(mode IN ('initial','auto_correct','human_retry','replan')),
  broker_job_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  output_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(output_json)),
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(execution_id, task_id, attempt_no)
) STRICT;

CREATE TABLE IF NOT EXISTS execution_inputs (
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  cas_hash TEXT NOT NULL CHECK(length(cas_hash) = 64),
  PRIMARY KEY(execution_id, asset_version_id)
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  task_id TEXT,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  repository_binding_id TEXT REFERENCES repository_bindings(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('draft_pr','merge')),
  status TEXT NOT NULL CHECK(status IN ('draft','ready','submitted','merged','blocked','cancelled')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  external_ref TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL DEFAULT 'local-user',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS credential_refs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('codex','github')),
  label TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  response_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope, key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_briefs_project ON brief_revisions(project_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflow_revisions(project_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_sources_project ON context_sources(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_packs_project ON context_packs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_project ON executions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_execution ON task_attempts(execution_id, task_id, attempt_no DESC);
CREATE INDEX IF NOT EXISTS idx_events_execution ON events(execution_id, cursor);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);

CREATE TRIGGER IF NOT EXISTS immutable_brief_revisions_update BEFORE UPDATE ON brief_revisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_brief_revisions_delete BEFORE DELETE ON brief_revisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_workflow_revisions_update BEFORE UPDATE ON workflow_revisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_workflow_revisions_delete BEFORE DELETE ON workflow_revisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_packs_update BEFORE UPDATE ON context_packs BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_packs_delete BEFORE DELETE ON context_packs BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_reviews_update BEFORE UPDATE ON reviews BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_reviews_delete BEFORE DELETE ON reviews BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_review_decisions_update BEFORE UPDATE ON review_decisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_review_decisions_delete BEFORE DELETE ON review_decisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_versions_update BEFORE UPDATE ON asset_versions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_versions_delete BEFORE DELETE ON asset_versions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_events_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_events_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
`;

export const IMMUTABLE_TABLES = [
  'brief_revisions',
  'workflow_revisions',
  'context_packs',
  'reviews',
  'review_decisions',
  'asset_versions',
  'events'
];
