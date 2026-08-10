export const SCHEMA_VERSION = 2;

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

CREATE TABLE IF NOT EXISTS repository_worktrees (
  execution_id TEXT PRIMARY KEY REFERENCES executions(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  baseline_sha TEXT NOT NULL CHECK(length(baseline_sha) = 40),
  worktree_path TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('read','write')),
  created_at TEXT NOT NULL,
  removed_at TEXT
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

CREATE TABLE IF NOT EXISTS execution_diffs (
  execution_id TEXT PRIMARY KEY REFERENCES executions(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  baseline_sha TEXT NOT NULL CHECK(baseline_sha = '' OR length(baseline_sha) = 40),
  diff TEXT NOT NULL DEFAULT '',
  files_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(files_json)),
  diff_sha256 TEXT NOT NULL CHECK(length(diff_sha256) = 64),
  asset_version_id TEXT REFERENCES asset_versions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
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

-- Optional V3 recovery tables.  The core journey above remains the hot path;
-- these tables provide durable homes for the mature setup, Assist, context,
-- runner and delivery workflows as they are enabled by later batches.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Local owner',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS connected_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, provider, account_ref)
) STRICT;

CREATE TABLE IF NOT EXISTS setup_states (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','ready','blocked')),
  checks_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(checks_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS codex_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  label TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  wire_api TEXT NOT NULL DEFAULT 'responses',
  reasoning TEXT NOT NULL DEFAULT 'medium',
  timeout_ms INTEGER NOT NULL DEFAULT 120000 CHECK(timeout_ms > 0),
  credential_ref TEXT NOT NULL REFERENCES credential_refs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'unprobed' CHECK(status IN ('unprobed','available','unavailable')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS github_app_configs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  label TEXT NOT NULL,
  app_id TEXT NOT NULL,
  client_id TEXT NOT NULL DEFAULT '',
  private_key_ref TEXT NOT NULL REFERENCES credential_refs(id) ON DELETE RESTRICT,
  webhook_secret_ref TEXT NOT NULL REFERENCES credential_refs(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS github_installations (
  id TEXT PRIMARY KEY,
  app_config_id TEXT NOT NULL REFERENCES github_app_configs(id) ON DELETE RESTRICT,
  installation_id TEXT NOT NULL,
  account_login TEXT NOT NULL DEFAULT '',
  permissions_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(permissions_json)),
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','revoked','unavailable')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(app_config_id, installation_id)
) STRICT;

CREATE TABLE IF NOT EXISTS mcp_clients (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK(transport IN ('http','stdio','docker')),
  endpoint TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  scope_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(scope_json)),
  status TEXT NOT NULL DEFAULT 'unprobed' CHECK(status IN ('unprobed','available','unavailable','revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS config_revisions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  created_at TEXT NOT NULL,
  UNIQUE(kind, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS assist_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK(scope IN ('project','workflow','workstream','task')),
  scope_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(snapshot_json)),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','cancelled','completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS assist_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  turn_no INTEGER NOT NULL CHECK(turn_no > 0),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
  goal_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(goal_json)),
  plan_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(plan_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, turn_no)
) STRICT;

CREATE TABLE IF NOT EXISTS assist_messages (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES assist_turns(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  content TEXT NOT NULL DEFAULT '',
  sequence_no INTEGER NOT NULL CHECK(sequence_no > 0),
  created_at TEXT NOT NULL,
  UNIQUE(turn_id, sequence_no)
) STRICT;

CREATE TABLE IF NOT EXISTS assist_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  turn_id TEXT REFERENCES assist_turns(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS assist_operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
  receipt_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS assist_change_batches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  base_revision INTEGER NOT NULL DEFAULT 1 CHECK(base_revision > 0),
  changes_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(changes_json)),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','approved','applied','rolled_back','stale')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS assist_checkpoints (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES assist_change_batches(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  cas_path TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS runtime_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  request_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(request_json)),
  decision TEXT NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','rejected','expired')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS runtime_user_inputs (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  prompt TEXT NOT NULL,
  response TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','cancelled')),
  created_at TEXT NOT NULL,
  answered_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS ui_action_intents (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','expired')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS file_changes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  batch_id TEXT REFERENCES assist_change_batches(id) ON DELETE RESTRICT,
  path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','delete','rename')),
  before_sha256 TEXT,
  after_sha256 TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS project_intakes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','running','ready','cancelled','failed')),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS workflow_drafts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  graph_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(graph_json)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS workflow_generations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  brief_revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','rejected','failed')),
  candidate_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(candidate_json)),
  critic_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(critic_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS workflow_generation_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id TEXT NOT NULL REFERENCES workflow_generations(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS node_contracts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workflow_revision INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  contract_json TEXT NOT NULL CHECK(json_valid(contract_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, workflow_revision, node_id)
) STRICT;

CREATE TABLE IF NOT EXISTS outcome_requirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workflow_revision INTEGER NOT NULL,
  requirement_key TEXT NOT NULL,
  rubric_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(rubric_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, workflow_revision, requirement_key)
) STRICT;

CREATE TABLE IF NOT EXISTS outcome_evaluations (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  requirement_id TEXT REFERENCES outcome_requirements(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('pending','passed','failed','waived')),
  score REAL,
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS outcome_waivers (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  requirement_id TEXT NOT NULL REFERENCES outcome_requirements(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'local-user',
  created_at TEXT NOT NULL,
  UNIQUE(execution_id, requirement_id)
) STRICT;

CREATE TABLE IF NOT EXISTS execution_stage_checkpoints (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','passed','failed','paused')),
  receipt_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(execution_id, stage)
) STRICT;

CREATE TABLE IF NOT EXISTS repository_connections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL DEFAULT 'git',
  remote_url TEXT NOT NULL DEFAULT '',
  credential_ref TEXT REFERENCES credential_refs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','fault','revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS repository_targets (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
  repository TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  baseline_sha TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS repository_lines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_id TEXT REFERENCES repository_targets(id) ON DELETE RESTRICT,
  line_kind TEXT NOT NULL CHECK(line_kind IN ('external_readonly','managed_staging','managed_checkout')),
  branch TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','busy','fault','blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS pull_request_intents (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE RESTRICT,
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  expected_head_sha TEXT NOT NULL,
  external_number INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','submitted','merged','blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS delivery_policies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  require_review INTEGER NOT NULL DEFAULT 1 CHECK(require_review IN (0,1)),
  require_checks INTEGER NOT NULL DEFAULT 1 CHECK(require_checks IN (0,1)),
  require_expected_sha INTEGER NOT NULL DEFAULT 1 CHECK(require_expected_sha IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS delivery_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS exchange_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  scope_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(scope_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','granted','denied','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS exchange_grants (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES exchange_requests(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE,
  scope_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(scope_json)),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS context_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  parent_id TEXT REFERENCES context_nodes(id) ON DELETE RESTRICT,
  uri TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK(sensitivity IN ('normal','sensitive','restricted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS context_document_versions (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version > 0),
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(node_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS context_edges (
  parent_id TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE RESTRICT,
  child_id TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE RESTRICT,
  relation TEXT NOT NULL DEFAULT 'contains',
  created_at TEXT NOT NULL,
  PRIMARY KEY(parent_id, child_id, relation)
) STRICT;

CREATE TABLE IF NOT EXISTS context_selections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  node_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(node_ids_json)),
  retrieval_plan_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(retrieval_plan_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS context_policies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  policy_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(policy_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS context_projection_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
  cursor TEXT NOT NULL DEFAULT '',
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS context_summaries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  node_id TEXT REFERENCES context_nodes(id) ON DELETE RESTRICT,
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  token_count INTEGER NOT NULL DEFAULT 0 CHECK(token_count >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS asset_blobs (
  id TEXT PRIMARY KEY,
  cas_hash TEXT NOT NULL UNIQUE CHECK(length(cas_hash) = 64),
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  cas_path TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS asset_attestations (
  id TEXT PRIMARY KEY,
  asset_blob_id TEXT NOT NULL REFERENCES asset_blobs(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  statement_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(statement_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS asset_relations (
  parent_asset_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  child_asset_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(parent_asset_id, child_asset_id, relation)
) STRICT;

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  asset_version_id TEXT REFERENCES asset_versions(id) ON DELETE RESTRICT,
  span_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(span_json)),
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS digests (
  id TEXT PRIMARY KEY,
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  value TEXT NOT NULL CHECK(length(value) = 64),
  algorithm TEXT NOT NULL DEFAULT 'sha256',
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS code_changes (
  id TEXT PRIMARY KEY,
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  path TEXT NOT NULL,
  operation TEXT NOT NULL,
  before_sha256 TEXT,
  after_sha256 TEXT,
  diff_sha256 TEXT CHECK(diff_sha256 IS NULL OR length(diff_sha256) = 64),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS test_results (
  id TEXT PRIMARY KEY,
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  task_id TEXT,
  command TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('passed','failed','cancelled','not_run')),
  exit_code INTEGER,
  stdout_sha256 TEXT CHECK(stdout_sha256 IS NULL OR length(stdout_sha256) = 64),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS quality_review_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','blocked')),
  policy_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(policy_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS quality_review_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES quality_review_runs(id) ON DELETE RESTRICT,
  parser TEXT NOT NULL,
  media_type TEXT NOT NULL,
  freshness TEXT NOT NULL DEFAULT 'fresh' CHECK(freshness IN ('fresh','stale','unknown')),
  semantic_human_score REAL,
  report_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(report_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS quality_review_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES quality_review_runs(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  assist_session_id TEXT REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  approval_id TEXT NOT NULL UNIQUE REFERENCES runtime_approvals(id) ON DELETE RESTRICT,
  runtime TEXT NOT NULL CHECK(runtime IN ('linux_native','windows_native')),
  cwd TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','running','exited','failed','stopped','orphaned')),
  cols INTEGER NOT NULL DEFAULT 120 CHECK(cols BETWEEN 20 AND 400),
  rows INTEGER NOT NULL DEFAULT 32 CHECK(rows BETWEEN 5 AND 200),
  pid INTEGER,
  output_preview TEXT NOT NULL DEFAULT '',
  output_bytes INTEGER NOT NULL DEFAULT 0 CHECK(output_bytes >= 0),
  output_sha256 TEXT NOT NULL DEFAULT '' CHECK(output_sha256 = '' OR length(output_sha256) = 64),
  output_truncated INTEGER NOT NULL DEFAULT 0 CHECK(output_truncated IN (0,1)),
  artifact_asset_id TEXT REFERENCES asset_versions(id) ON DELETE RESTRICT,
  exit_code INTEGER,
  error_code TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS terminal_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_briefs_project ON brief_revisions(project_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflow_revisions(project_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_sources_project ON context_sources(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_packs_project ON context_packs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_project ON executions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_execution ON task_attempts(execution_id, task_id, attempt_no DESC);
CREATE INDEX IF NOT EXISTS idx_events_execution ON events(execution_id, cursor);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_target ON evidence_links(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_worktrees_project ON repository_worktrees(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_terminal_project ON terminal_sessions(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_terminal_events_session ON terminal_events(session_id, cursor);
CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_active_project ON terminal_sessions(project_id) WHERE status IN ('ready','running');

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
CREATE TRIGGER IF NOT EXISTS immutable_execution_diffs_update BEFORE UPDATE ON execution_diffs BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_execution_diffs_delete BEFORE DELETE ON execution_diffs BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_evidence_links_update BEFORE UPDATE ON evidence_links BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_evidence_links_delete BEFORE DELETE ON evidence_links BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
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
  'execution_diffs',
  'evidence_links',
  'events'
];
