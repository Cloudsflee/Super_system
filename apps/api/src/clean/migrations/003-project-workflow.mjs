import { createHash } from 'node:crypto';

export const PROJECT_WORKFLOW_MIGRATION_ID = '003-project-workflow';
export const PROJECT_WORKFLOW_MIGRATION_VERSION = 3;
export const PROJECT_WORKFLOW_TOOL_VERSION = 'v3-clean-p3';

// P3 owns the project-to-critic business records.  The generic operation,
// event, aggregate-head and CAS tables remain the only platform ledgers.
export const PROJECT_WORKFLOW_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  owner_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirming','active','archived')),
  onboarding_state TEXT NOT NULL DEFAULT 'draft' CHECK(onboarding_state IN ('draft','collecting','ready','confirming','confirmed','failed')),
  current_brief_revision INTEGER NOT NULL DEFAULT 0 CHECK(current_brief_revision >= 0),
  confirmed_brief_revision INTEGER CHECK(confirmed_brief_revision IS NULL OR confirmed_brief_revision > 0),
  confirmed_brief_hash TEXT NOT NULL DEFAULT '' CHECK(confirmed_brief_hash='' OR length(confirmed_brief_hash)=64),
  current_workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK(current_workflow_revision >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256)=64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  archived_at TEXT,
  deleted_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team_id,status,updated_at);

CREATE TABLE IF NOT EXISTS project_intakes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'collecting' CHECK(status IN ('collecting','submitted','processing','ready','failed','cancelled')),
  mode TEXT NOT NULL DEFAULT 'brainstorm' CHECK(mode IN ('brainstorm','existing')),
  source_kind TEXT NOT NULL DEFAULT 'none' CHECK(source_kind IN ('none','fixture','git','https','local','bundle')),
  source_locator TEXT NOT NULL DEFAULT '',
  source_revision TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '' CHECK(source_hash='' OR length(source_hash)=64),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
  result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json)),
  error_code TEXT NOT NULL DEFAULT '',
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(project_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_project_intakes_status ON project_intakes(status,updated_at);

CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirming','confirmed')),
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK(current_revision >= 0),
  confirmed_revision INTEGER CHECK(confirmed_revision IS NULL OR confirmed_revision > 0),
  confirmed_hash TEXT NOT NULL DEFAULT '' CHECK(confirmed_hash='' OR length(confirmed_hash)=64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS brief_revisions (
  id TEXT PRIMARY KEY,
  brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  template TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(project_id,revision)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_brief_revisions_project ON brief_revisions(project_id,revision DESC);

CREATE TABLE IF NOT EXISTS repository_connections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL DEFAULT 'fixture' CHECK(provider IN ('fixture','git','https','local')),
  credential_ref_id TEXT REFERENCES credential_refs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','faulted','archived')),
  source_kind TEXT NOT NULL DEFAULT 'none' CHECK(source_kind IN ('none','fixture','git','https','local','bundle')),
  source_locator TEXT NOT NULL DEFAULT '',
  source_revision TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '' CHECK(source_hash='' OR length(source_hash)=64),
  read_only INTEGER NOT NULL DEFAULT 1 CHECK(read_only IN (0,1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256)=64),
  fault_code TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(project_id)
) STRICT;

CREATE TABLE IF NOT EXISTS repository_targets (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  branch TEXT NOT NULL DEFAULT 'main',
  remote_ref TEXT NOT NULL DEFAULT '',
  expected_head_sha TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(connection_id,name)
) STRICT;

CREATE TABLE IF NOT EXISTS repository_lines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL REFERENCES repository_targets(id) ON DELETE RESTRICT,
  line_kind TEXT NOT NULL CHECK(line_kind IN ('external_readonly','managed_staging','managed_checkout')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','faulted','recovering','removed')),
  source_revision TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '' CHECK(source_hash='' OR length(source_hash)=64),
  expected_head_sha TEXT NOT NULL DEFAULT '',
  fault_code TEXT NOT NULL DEFAULT '',
  fault_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(fault_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(project_id,line_kind)
) STRICT;

CREATE TABLE IF NOT EXISTS repository_workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  line_id TEXT NOT NULL REFERENCES repository_lines(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','provisioning','ready','locked','released','orphaned')),
  relative_path TEXT NOT NULL DEFAULT '',
  owner_operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(project_id,line_id)
) STRICT;

CREATE TABLE IF NOT EXISTS repository_locks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES repository_workspaces(id) ON DELETE RESTRICT,
  holder_operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  fencing_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','released','expired')),
  expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_repository_locks_active
  ON repository_locks(workspace_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','proposed','active','superseded','archived')),
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK(current_revision >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS workflow_revisions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  graph_json TEXT NOT NULL CHECK(json_valid(graph_json)),
  graph_sha256 TEXT NOT NULL CHECK(length(graph_sha256)=64),
  layout_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(layout_json)),
  layout_sha256 TEXT NOT NULL CHECK(length(layout_sha256)=64),
  source_brief_revision INTEGER NOT NULL DEFAULT 0 CHECK(source_brief_revision >= 0),
  source_brief_hash TEXT NOT NULL DEFAULT '' CHECK(source_brief_hash='' OR length(source_brief_hash)=64),
  proposal_id TEXT,
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(project_id,revision)
) STRICT;

CREATE TABLE IF NOT EXISTS workflow_nodes (
  id TEXT PRIMARY KEY,
  workflow_revision_id TEXT NOT NULL REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
  node_key TEXT NOT NULL,
  parent_key TEXT,
  node_kind TEXT NOT NULL CHECK(node_kind IN ('workstream','task')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config_json)),
  config_sha256 TEXT NOT NULL CHECK(length(config_sha256)=64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  UNIQUE(workflow_revision_id,node_key)
) STRICT;

CREATE TABLE IF NOT EXISTS node_contracts (
  id TEXT PRIMARY KEY,
  workflow_revision_id TEXT NOT NULL REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
  node_id TEXT NOT NULL REFERENCES workflow_nodes(id) ON DELETE RESTRICT,
  contract_json TEXT NOT NULL CHECK(json_valid(contract_json)),
  contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256)=64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  UNIQUE(workflow_revision_id,node_id)
) STRICT;

CREATE TABLE IF NOT EXISTS workflow_generations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  phase TEXT NOT NULL DEFAULT 'queued' CHECK(phase IN ('queued','running','critic_pending','proposed','applied','rejected','failed','cancelled')),
  source_brief_revision INTEGER NOT NULL DEFAULT 0 CHECK(source_brief_revision >= 0),
  source_brief_hash TEXT NOT NULL DEFAULT '' CHECK(source_brief_hash='' OR length(source_brief_hash)=64),
  source_workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK(source_workflow_revision >= 0),
  source_workflow_hash TEXT NOT NULL DEFAULT '' CHECK(source_workflow_hash='' OR length(source_workflow_hash)=64),
  source_repository_revision INTEGER NOT NULL DEFAULT 0 CHECK(source_repository_revision >= 0),
  source_repository_hash TEXT NOT NULL DEFAULT '' CHECK(source_repository_hash='' OR length(source_repository_hash)=64),
  input_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(input_json)),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  candidate_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(candidate_json)),
  candidate_sha256 TEXT NOT NULL DEFAULT '' CHECK(candidate_sha256='' OR length(candidate_sha256)=64),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0),
  retry_of_generation_id TEXT REFERENCES workflow_generations(id) ON DELETE RESTRICT,
  critic_receipt_id TEXT,
  proposal_id TEXT,
  error_code TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_workflow_generations_project ON workflow_generations(project_id,created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_critic_receipts (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES workflow_generations(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('passed','rejected','failed')),
  candidate_sha256 TEXT NOT NULL CHECK(length(candidate_sha256)=64),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  issues_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(issues_json)),
  issues_sha256 TEXT NOT NULL CHECK(length(issues_sha256)=64),
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK(policy_revision > 0),
  provider TEXT NOT NULL DEFAULT 'fake-critic',
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS workflow_generation_proposals (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL UNIQUE REFERENCES workflow_generations(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  base_workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK(base_workflow_revision >= 0),
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
  candidate_sha256 TEXT NOT NULL CHECK(length(candidate_sha256)=64),
  critic_receipt_id TEXT NOT NULL REFERENCES workflow_critic_receipts(id) ON DELETE RESTRICT,
  proposal_sha256 TEXT NOT NULL CHECK(length(proposal_sha256)=64),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','rejected','stale')),
  applied_workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK(applied_workflow_revision >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS outcome_requirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK(workflow_revision >= 0),
  requirement_key TEXT NOT NULL,
  rubric_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(rubric_json)),
  rubric_sha256 TEXT NOT NULL CHECK(length(rubric_sha256)=64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(project_id,requirement_key)
) STRICT;
`;

export const PROJECT_WORKFLOW_MIGRATION_CHECKSUM = createHash('sha256')
  .update(`${PROJECT_WORKFLOW_MIGRATION_VERSION}\n${PROJECT_WORKFLOW_MIGRATION_ID}\n${PROJECT_WORKFLOW_SQL}`)
  .digest('hex');

export const PROJECT_WORKFLOW_MIGRATION = Object.freeze({
  version: PROJECT_WORKFLOW_MIGRATION_VERSION,
  id: PROJECT_WORKFLOW_MIGRATION_ID,
  name: PROJECT_WORKFLOW_MIGRATION_ID,
  family: 'v3-clean',
  sql: PROJECT_WORKFLOW_SQL,
  checksum: PROJECT_WORKFLOW_MIGRATION_CHECKSUM,
  toolVersion: PROJECT_WORKFLOW_TOOL_VERSION
});
