/* R5 Context Projection, Context Pack and MCP migration.
 *
 * R1-R4 migration text is frozen.  This migration is deliberately additive:
 * earlier Context Source/Pack, MCP client and exchange rows remain readable and
 * are marked as legacy_compat by the new services.  New records use immutable
 * revisions and explicit heads/checkpoints.
 */
export const CONTEXT_PROJECTION_MCP_V5_SQL = `
/* The v1 Pack triggers must be recreated after the legacy metadata backfill. */
DROP TRIGGER IF EXISTS immutable_context_packs_update;
DROP TRIGGER IF EXISTS immutable_context_packs_delete;

/* Widen the legacy status check while retaining every checkpoint row. */
ALTER TABLE context_projection_jobs RENAME TO context_projection_jobs_v4;
CREATE TABLE context_projection_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','indexing','completed','failed','cancelled')),
  cursor TEXT NOT NULL DEFAULT '',
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL DEFAULT 'full' CHECK(mode IN ('full','incremental','index_rebuild')),
  phase TEXT NOT NULL DEFAULT 'queued' CHECK(phase IN ('queued','running','indexing','completed','failed','cancelled')),
  snapshot_hash TEXT NOT NULL DEFAULT '' CHECK(snapshot_hash='' OR length(snapshot_hash)=64),
  input_hash TEXT NOT NULL DEFAULT '' CHECK(input_hash='' OR length(input_hash)=64),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0),
  retry_of_job_id TEXT REFERENCES context_projection_jobs(id) ON DELETE RESTRICT,
  stats_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(stats_json)),
  index_hash TEXT NOT NULL DEFAULT '' CHECK(index_hash='' OR length(index_hash)=64),
  error_details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(error_details_json)),
  completed_at TEXT,
  cancelled_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
) STRICT;
INSERT INTO context_projection_jobs(id,project_id,status,cursor,error_code,created_at,updated_at,mode,phase,attempt)
  SELECT id,project_id,CASE WHEN status='pending' THEN 'queued' ELSE status END,cursor,error_code,created_at,updated_at,'full',CASE WHEN status='pending' THEN 'queued' ELSE status END,1
  FROM context_projection_jobs_v4;
DROP TABLE context_projection_jobs_v4;

/* Stable source metadata and current document pointer. */
ALTER TABLE context_nodes ADD COLUMN stable_uri TEXT NOT NULL DEFAULT '';
ALTER TABLE context_nodes ADD COLUMN source_type TEXT NOT NULL DEFAULT 'legacy_compat';
ALTER TABLE context_nodes ADD COLUMN source_id TEXT NOT NULL DEFAULT '';
ALTER TABLE context_nodes ADD COLUMN source_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE context_nodes ADD COLUMN source_hash TEXT NOT NULL DEFAULT '' CHECK(source_hash='' OR length(source_hash)=64);
ALTER TABLE context_nodes ADD COLUMN path TEXT NOT NULL DEFAULT '';
ALTER TABLE context_nodes ADD COLUMN current_document_version_id TEXT;
ALTER TABLE context_nodes ADD COLUMN authority TEXT NOT NULL DEFAULT 'observed';
ALTER TABLE context_nodes ADD COLUMN freshness_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(freshness_json));
ALTER TABLE context_nodes ADD COLUMN required_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(required_scopes_json));
ALTER TABLE context_nodes ADD COLUMN sort_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(sort_json));
ALTER TABLE context_nodes ADD COLUMN resource_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(resource_json));
ALTER TABLE context_nodes ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','tombstone'));
ALTER TABLE context_nodes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE context_nodes ADD COLUMN tombstoned_at TEXT;
UPDATE context_nodes SET stable_uri=uri WHERE stable_uri='';
UPDATE context_nodes SET source_type='legacy_compat',source_id=id,source_hash=COALESCE((SELECT content_hash FROM context_document_versions v WHERE v.node_id=context_nodes.id ORDER BY v.version DESC LIMIT 1),'') WHERE source_id='';

/* Document versions are immutable and can be backed by CAS. */
ALTER TABLE context_document_versions ADD COLUMN source_type TEXT NOT NULL DEFAULT 'inline_legacy';
ALTER TABLE context_document_versions ADD COLUMN source_id TEXT NOT NULL DEFAULT '';
ALTER TABLE context_document_versions ADD COLUMN source_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE context_document_versions ADD COLUMN source_hash TEXT NOT NULL DEFAULT '' CHECK(source_hash='' OR length(source_hash)=64);
ALTER TABLE context_document_versions ADD COLUMN token_estimate INTEGER NOT NULL DEFAULT 0 CHECK(token_estimate >= 0);
ALTER TABLE context_document_versions ADD COLUMN renderer_version TEXT NOT NULL DEFAULT 'legacy-inline-v1';
ALTER TABLE context_document_versions ADD COLUMN cas_hash TEXT NOT NULL DEFAULT '' CHECK(cas_hash='' OR length(cas_hash)=64);
ALTER TABLE context_document_versions ADD COLUMN cas_path TEXT NOT NULL DEFAULT '';
ALTER TABLE context_document_versions ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'inline_legacy' CHECK(storage_kind IN ('inline_legacy','cas'));
ALTER TABLE context_document_versions ADD COLUMN retention_until TEXT;
ALTER TABLE context_document_versions ADD COLUMN immutable INTEGER NOT NULL DEFAULT 1 CHECK(immutable IN (0,1));
UPDATE context_document_versions SET source_hash=content_hash,token_estimate=CASE WHEN length(content)=0 THEN 0 ELSE CAST((length(content)+3)/4 AS INTEGER) END WHERE source_hash='';

/* Edge ordering is part of the deterministic map contract. */
ALTER TABLE context_edges ADD COLUMN edge_id TEXT;
ALTER TABLE context_edges ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0 CHECK(order_index >= 0);
ALTER TABLE context_edges ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json));

/* Immutable selection and pack snapshots. */
ALTER TABLE context_selections ADD COLUMN selection_hash TEXT NOT NULL DEFAULT '' CHECK(selection_hash='' OR length(selection_hash)=64);
ALTER TABLE context_selections ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(policy_revision >= 0);
ALTER TABLE context_selections ADD COLUMN included_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(included_json));
ALTER TABLE context_selections ADD COLUMN excluded_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(excluded_json));
ALTER TABLE context_selections ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE context_selections ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'aiws.context_selection.v1';
ALTER TABLE context_selections ADD COLUMN compatibility TEXT NOT NULL DEFAULT 'native_v5' CHECK(compatibility IN ('legacy_compat','native_v5'));
ALTER TABLE context_packs ADD COLUMN selection_id TEXT;
ALTER TABLE context_packs ADD COLUMN selection_hash TEXT NOT NULL DEFAULT '' CHECK(selection_hash='' OR length(selection_hash)=64);
ALTER TABLE context_packs ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(policy_revision >= 0);
ALTER TABLE context_packs ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'aiws.context_pack.v5';
ALTER TABLE context_packs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE context_packs ADD COLUMN immutable INTEGER NOT NULL DEFAULT 1 CHECK(immutable IN (0,1));
ALTER TABLE context_packs ADD COLUMN compatibility TEXT NOT NULL DEFAULT 'native_v5' CHECK(compatibility IN ('legacy_compat','native_v5'));

CREATE TABLE IF NOT EXISTS context_policy_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  policy_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(policy_json)),
  policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64),
  actor TEXT NOT NULL DEFAULT 'local-user',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, revision)
) STRICT;
CREATE TABLE IF NOT EXISTS context_policy_heads (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS context_selection_heads (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  selection_id TEXT NOT NULL REFERENCES context_selections(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_at TEXT NOT NULL
) STRICT;

/* Recoverable projection worker checkpoints and persistent event cursors. */
CREATE TABLE IF NOT EXISTS context_projection_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES context_projection_jobs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS context_index_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  index_hash TEXT NOT NULL CHECK(length(index_hash)=64),
  index_path TEXT NOT NULL DEFAULT '',
  document_count INTEGER NOT NULL DEFAULT 0 CHECK(document_count >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, snapshot_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS context_index_heads (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  snapshot_id TEXT NOT NULL REFERENCES context_index_snapshots(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  updated_at TEXT NOT NULL
) STRICT;

/* MCP lifecycle revisions, explicit allowlists and one-time token metadata. */
ALTER TABLE mcp_clients ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE mcp_clients ADD COLUMN subject TEXT NOT NULL DEFAULT 'local-user';
ALTER TABLE mcp_clients ADD COLUMN token_prefix TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_clients ADD COLUMN project_allowlist_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(project_allowlist_json));
ALTER TABLE mcp_clients ADD COLUMN tool_allowlist_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tool_allowlist_json));
ALTER TABLE mcp_clients ADD COLUMN expires_at TEXT;
ALTER TABLE mcp_clients ADD COLUMN last_used_at TEXT;
ALTER TABLE mcp_clients ADD COLUMN revoked_at TEXT;
ALTER TABLE mcp_clients ADD COLUMN revoked_by TEXT;
ALTER TABLE mcp_clients ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0 CHECK(usage_count >= 0);
ALTER TABLE mcp_clients ADD COLUMN compatibility TEXT NOT NULL DEFAULT 'native_v5' CHECK(compatibility IN ('legacy_compat','native_v5'));
UPDATE mcp_clients SET token_prefix=substr(token_hash,1,12) WHERE token_prefix='';
CREATE INDEX IF NOT EXISTS idx_mcp_clients_status ON mcp_clients(status,expires_at);

ALTER TABLE exchange_requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE exchange_requests ADD COLUMN subject TEXT NOT NULL DEFAULT 'local-user';
ALTER TABLE exchange_requests ADD COLUMN transport TEXT NOT NULL DEFAULT 'http' CHECK(transport IN ('http','stdio','docker'));
ALTER TABLE exchange_requests ADD COLUMN project_allowlist_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(project_allowlist_json));
ALTER TABLE exchange_requests ADD COLUMN tool_allowlist_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tool_allowlist_json));
ALTER TABLE exchange_requests ADD COLUMN requested_ttl_seconds INTEGER NOT NULL DEFAULT 3600 CHECK(requested_ttl_seconds > 0);
ALTER TABLE exchange_requests ADD COLUMN compatibility TEXT NOT NULL DEFAULT 'native_v5' CHECK(compatibility IN ('legacy_compat','native_v5'));
ALTER TABLE exchange_grants ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE exchange_grants ADD COLUMN subject TEXT NOT NULL DEFAULT 'local-user';
ALTER TABLE exchange_grants ADD COLUMN transport TEXT NOT NULL DEFAULT 'http' CHECK(transport IN ('http','stdio','docker'));
ALTER TABLE exchange_grants ADD COLUMN token_prefix TEXT NOT NULL DEFAULT '';
ALTER TABLE exchange_grants ADD COLUMN project_allowlist_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(project_allowlist_json));
ALTER TABLE exchange_grants ADD COLUMN tool_allowlist_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tool_allowlist_json));
ALTER TABLE exchange_grants ADD COLUMN last_used_at TEXT;
ALTER TABLE exchange_grants ADD COLUMN revoked_by TEXT;
ALTER TABLE exchange_grants ADD COLUMN compatibility TEXT NOT NULL DEFAULT 'native_v5' CHECK(compatibility IN ('legacy_compat','native_v5'));

CREATE INDEX IF NOT EXISTS idx_context_nodes_project_uri ON context_nodes(project_id,uri);
CREATE INDEX IF NOT EXISTS idx_context_versions_node_hash ON context_document_versions(node_id,content_hash,version DESC);
CREATE INDEX IF NOT EXISTS idx_context_edges_parent_order ON context_edges(parent_id,order_index,child_id);
CREATE INDEX IF NOT EXISTS idx_context_projection_project ON context_projection_jobs(project_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_projection_events_job ON context_projection_events(job_id,cursor);
CREATE INDEX IF NOT EXISTS idx_context_policy_revisions_project ON context_policy_revisions(project_id,revision DESC);

/* Existing rows remain addressable by old APIs and are explicitly legacy. */
UPDATE context_selections SET schema_version='aiws.context_selection.v1' WHERE schema_version='';
UPDATE context_selections SET compatibility='legacy_compat';
UPDATE context_packs SET compatibility='legacy_compat';
UPDATE mcp_clients SET compatibility='legacy_compat';
UPDATE exchange_requests SET compatibility='legacy_compat';
UPDATE exchange_grants SET compatibility='legacy_compat';

CREATE TRIGGER IF NOT EXISTS immutable_context_document_versions_update BEFORE UPDATE ON context_document_versions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_document_versions_delete BEFORE DELETE ON context_document_versions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_selections_update BEFORE UPDATE ON context_selections BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_selections_delete BEFORE DELETE ON context_selections BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_edges_update BEFORE UPDATE ON context_edges BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_edges_delete BEFORE DELETE ON context_edges BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_summaries_update BEFORE UPDATE ON context_summaries BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_summaries_delete BEFORE DELETE ON context_summaries BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_policy_revisions_update BEFORE UPDATE ON context_policy_revisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_policy_revisions_delete BEFORE DELETE ON context_policy_revisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_projection_events_update BEFORE UPDATE ON context_projection_events BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_projection_events_delete BEFORE DELETE ON context_projection_events BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_index_snapshots_update BEFORE UPDATE ON context_index_snapshots BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_index_snapshots_delete BEFORE DELETE ON context_index_snapshots BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_packs_update BEFORE UPDATE ON context_packs BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_context_packs_delete BEFORE DELETE ON context_packs BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
`;

export const CONTEXT_PROJECTION_MCP_V5 = Object.freeze({
  version: 5,
  name: 'context_projection_mcp',
  sql: CONTEXT_PROJECTION_MCP_V5_SQL
});
