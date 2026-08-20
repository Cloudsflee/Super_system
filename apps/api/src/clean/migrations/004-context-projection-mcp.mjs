import { createHash } from 'node:crypto';

export const CONTEXT_PROJECTION_MCP_MIGRATION_ID = '004-context-projection-mcp';
export const CONTEXT_PROJECTION_MCP_MIGRATION_VERSION = 4;
export const CONTEXT_PROJECTION_MCP_TOOL_VERSION = 'v3-clean-p4';

// P4 keeps source content and index payloads in the shared CAS.  The tables
// below contain only opaque references, immutable hashes, lifecycle state and
// the minimum metadata needed for authorization and deterministic recovery.
export const CONTEXT_PROJECTION_MCP_SQL = `
CREATE TABLE IF NOT EXISTS context_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK(source_type IN ('project','brief','repository','workflow','node_contract','note','file','diff','test_report')),
  canonical_uri TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240),
  adapter TEXT NOT NULL DEFAULT 'note',
  source_revision TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
  cas_hash TEXT NOT NULL CHECK(length(cas_hash)=64),
  sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK(sensitivity IN ('normal','sensitive','restricted','secret')),
  freshness_status TEXT NOT NULL DEFAULT 'current' CHECK(freshness_status IN ('current','stale','unknown','missing')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256)=64),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','tombstone')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(project_id, canonical_uri)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_context_sources_project ON context_sources(project_id,status,updated_at,id);

CREATE TABLE IF NOT EXISTS context_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  stable_uri TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES context_sources(id) ON DELETE RESTRICT,
  parent_id TEXT REFERENCES context_nodes(id) ON DELETE RESTRICT,
  node_kind TEXT NOT NULL CHECK(node_kind IN ('root','project','brief','repository','workflow','node_contract','note','file','diff','test_report')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240),
  source_revision TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
  sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK(sensitivity IN ('normal','sensitive','restricted','secret')),
  freshness_status TEXT NOT NULL DEFAULT 'current' CHECK(freshness_status IN ('current','stale','unknown','missing')),
  required_scopes_json TEXT NOT NULL DEFAULT '["context:read"]' CHECK(json_valid(required_scopes_json)),
  sort_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(sort_json)),
  current_document_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','tombstone')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(project_id,stable_uri)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_context_nodes_project_uri ON context_nodes(project_id,stable_uri);
CREATE INDEX IF NOT EXISTS idx_context_nodes_source ON context_nodes(source_id,status);

CREATE TABLE IF NOT EXISTS context_document_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  node_id TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version > 0),
  source_revision TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  cas_hash TEXT NOT NULL CHECK(length(cas_hash)=64),
  cas_relative_key TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0 CHECK(token_estimate >= 0),
  renderer_version TEXT NOT NULL DEFAULT 'context-renderer-v1',
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(node_id,version),
  UNIQUE(node_id,content_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_context_versions_node ON context_document_versions(node_id,version DESC);

CREATE TABLE IF NOT EXISTS context_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  parent_node_id TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE RESTRICT,
  child_node_id TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE RESTRICT,
  relation TEXT NOT NULL DEFAULT 'contains' CHECK(relation IN ('contains','references','derived_from')),
  order_index INTEGER NOT NULL DEFAULT 0 CHECK(order_index >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE(parent_node_id,child_node_id,relation)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_context_edges_parent ON context_edges(project_id,parent_node_id,order_index,child_node_id);

CREATE TABLE IF NOT EXISTS context_policies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
  policy_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(policy_json)),
  policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS context_selections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  query TEXT NOT NULL DEFAULT '',
  token_budget INTEGER NOT NULL CHECK(token_budget BETWEEN 256 AND 128000),
  policy_revision INTEGER NOT NULL CHECK(policy_revision >= 0),
  input_snapshot_hash TEXT NOT NULL CHECK(length(input_snapshot_hash)=64),
  included_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(included_json)),
  excluded_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(excluded_json)),
  token_used INTEGER NOT NULL DEFAULT 0 CHECK(token_used >= 0),
  selection_hash TEXT NOT NULL CHECK(length(selection_hash)=64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_context_selections_project ON context_selections(project_id,created_at DESC,id);

CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  selection_id TEXT NOT NULL REFERENCES context_selections(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL DEFAULT 'aiws.context_pack.v5',
  pack_hash TEXT NOT NULL CHECK(length(pack_hash)=64),
  payload_cas_hash TEXT NOT NULL CHECK(length(payload_cas_hash)=64),
  memory_manifest_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(memory_manifest_json)),
  status TEXT NOT NULL DEFAULT 'sealed' CHECK(status IN ('sealed','stale','revoked')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(project_id,pack_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_context_packs_project ON context_packs(project_id,created_at DESC,id);

CREATE TABLE IF NOT EXISTS context_projection_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','indexing','completed','failed','cancelled')),
  mode TEXT NOT NULL DEFAULT 'full' CHECK(mode IN ('full','incremental','index_rebuild')),
  input_hash TEXT NOT NULL DEFAULT '' CHECK(input_hash='' OR length(input_hash)=64),
  snapshot_hash TEXT NOT NULL DEFAULT '' CHECK(snapshot_hash='' OR length(snapshot_hash)=64),
  index_hash TEXT NOT NULL DEFAULT '' CHECK(index_hash='' OR length(index_hash)=64),
  cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
  lease_owner TEXT NOT NULL DEFAULT '',
  fencing_token TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0),
  retry_of_job_id TEXT REFERENCES context_projection_jobs(id) ON DELETE RESTRICT,
  stats_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(stats_json)),
  error_code TEXT NOT NULL DEFAULT '',
  error_details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(error_details_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_context_projection_jobs_project ON context_projection_jobs(project_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_context_projection_jobs_lease ON context_projection_jobs(status,lease_expires_at);

CREATE TABLE IF NOT EXISTS context_index_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL DEFAULT 'aiws.context_index.v3',
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  index_hash TEXT NOT NULL CHECK(length(index_hash)=64),
  payload_cas_hash TEXT NOT NULL CHECK(length(payload_cas_hash)=64),
  document_count INTEGER NOT NULL DEFAULT 0 CHECK(document_count >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,snapshot_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_context_index_snapshots_project ON context_index_snapshots(project_id,created_at DESC,id);

CREATE TABLE IF NOT EXISTS exchange_requests (
  id TEXT PRIMARY KEY,
  source_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  requester_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  source_approver_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  target_approver_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  source_approved_at TEXT,
  target_approved_at TEXT,
  scope_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(scope_json)),
  status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','partially_approved','active','rejected','revoked','expired')),
  expires_at TEXT,
  grant_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_exchange_requests_target ON exchange_requests(target_project_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exchange_requests_source ON exchange_requests(source_project_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS mcp_clients (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  transport TEXT NOT NULL CHECK(transport IN ('http','stdio')),
  endpoint TEXT NOT NULL DEFAULT '',
  token_hmac TEXT NOT NULL UNIQUE CHECK(length(token_hmac)=64),
  token_prefix TEXT NOT NULL CHECK(length(token_prefix) BETWEEN 4 AND 24),
  project_allowlist_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(project_allowlist_json)),
  tool_allowlist_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tool_allowlist_json)),
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','expired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(actor_id,name)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_mcp_clients_actor ON mcp_clients(actor_id,status,expires_at);

CREATE TABLE IF NOT EXISTS gateway_forward_receipts (
  id TEXT PRIMARY KEY,
  gateway_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE CHECK(length(nonce_hash)=64),
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  response_hash TEXT NOT NULL CHECK(length(response_hash)=64),
  decision TEXT NOT NULL CHECK(decision IN ('accepted','denied','replayed','invalid_signature')),
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_gateway_receipts_gateway ON gateway_forward_receipts(gateway_id,created_at DESC);

ALTER TABLE exchange_grants ADD COLUMN request_id TEXT REFERENCES exchange_requests(id) ON DELETE RESTRICT;
ALTER TABLE exchange_grants ADD COLUMN source_approver_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT;
ALTER TABLE exchange_grants ADD COLUMN target_approver_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT;
ALTER TABLE exchange_grants ADD COLUMN source_approved_at TEXT;
ALTER TABLE exchange_grants ADD COLUMN target_approved_at TEXT;
ALTER TABLE exchange_grants ADD COLUMN revoked_at TEXT;
ALTER TABLE exchange_grants ADD COLUMN revoked_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT;
ALTER TABLE mcp_clients ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0 CHECK(usage_count >= 0);
CREATE INDEX IF NOT EXISTS idx_exchange_grants_request ON exchange_grants(request_id,status);

CREATE TRIGGER IF NOT EXISTS immutable_context_document_versions_update
  BEFORE UPDATE ON context_document_versions BEGIN SELECT RAISE(ABORT, 'immutable_context_document_version'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_document_versions_delete
  BEFORE DELETE ON context_document_versions BEGIN SELECT RAISE(ABORT, 'immutable_context_document_version'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_selections_update
  BEFORE UPDATE ON context_selections BEGIN SELECT RAISE(ABORT, 'immutable_context_selection'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_selections_delete
  BEFORE DELETE ON context_selections BEGIN SELECT RAISE(ABORT, 'immutable_context_selection'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_packs_update
  BEFORE UPDATE ON context_packs BEGIN SELECT RAISE(ABORT, 'immutable_context_pack'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_packs_delete
  BEFORE DELETE ON context_packs BEGIN SELECT RAISE(ABORT, 'immutable_context_pack'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_index_snapshots_update
  BEFORE UPDATE ON context_index_snapshots BEGIN SELECT RAISE(ABORT, 'immutable_context_index_snapshot'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_index_snapshots_delete
  BEFORE DELETE ON context_index_snapshots BEGIN SELECT RAISE(ABORT, 'immutable_context_index_snapshot'); END;
`;

export const CONTEXT_PROJECTION_MCP_MIGRATION_CHECKSUM = createHash('sha256')
  .update(`${CONTEXT_PROJECTION_MCP_MIGRATION_VERSION}\n${CONTEXT_PROJECTION_MCP_MIGRATION_ID}\n${CONTEXT_PROJECTION_MCP_SQL}`)
  .digest('hex');

export const CONTEXT_PROJECTION_MCP_MIGRATION = Object.freeze({
  version: CONTEXT_PROJECTION_MCP_MIGRATION_VERSION,
  id: CONTEXT_PROJECTION_MCP_MIGRATION_ID,
  name: CONTEXT_PROJECTION_MCP_MIGRATION_ID,
  family: 'v3-clean',
  sql: CONTEXT_PROJECTION_MCP_SQL,
  checksum: CONTEXT_PROJECTION_MCP_MIGRATION_CHECKSUM,
  toolVersion: CONTEXT_PROJECTION_MCP_TOOL_VERSION
});
