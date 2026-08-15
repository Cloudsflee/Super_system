/* R4 Workflow, generation and critic migration.
 *
 * V1/V2/V3 migration text is intentionally frozen.  The R4 records are
 * append-only so a draft can be edited while an applied workflow remains an
 * immutable execution contract.
 */
export const WORKFLOW_GENERATION_CRITIC_V4_SQL = `
DROP TRIGGER IF EXISTS immutable_workflow_revisions_update;
DROP TRIGGER IF EXISTS immutable_workflow_revisions_delete;

ALTER TABLE workflow_drafts ADD COLUMN hierarchy_mode TEXT NOT NULL DEFAULT 'two_level'
  CHECK(hierarchy_mode IN ('two_level','legacy_compat'));
ALTER TABLE workflow_drafts ADD COLUMN generation_status TEXT NOT NULL DEFAULT 'idle'
  CHECK(generation_status IN ('idle','queued','running','critic_pending','completed','rejected','failed','cancelled','applied'));
ALTER TABLE workflow_drafts ADD COLUMN critic_status TEXT NOT NULL DEFAULT 'not_run'
  CHECK(critic_status IN ('not_run','pending','passed','rejected'));
ALTER TABLE workflow_drafts ADD COLUMN last_generation_id TEXT;
ALTER TABLE workflow_drafts ADD COLUMN applied_workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK(applied_workflow_revision >= 0);
ALTER TABLE workflow_drafts ADD COLUMN layout_revision INTEGER NOT NULL DEFAULT 0 CHECK(layout_revision >= 0);
ALTER TABLE workflow_drafts ADD COLUMN draft_hash TEXT NOT NULL DEFAULT '' CHECK(draft_hash='' OR length(draft_hash)=64);
ALTER TABLE workflow_drafts ADD COLUMN draft_updated_at TEXT;

ALTER TABLE workflow_revisions ADD COLUMN hierarchy_mode TEXT NOT NULL DEFAULT 'legacy_compat'
  CHECK(hierarchy_mode IN ('two_level','legacy_compat'));
ALTER TABLE workflow_revisions ADD COLUMN brief_revision INTEGER NOT NULL DEFAULT 0 CHECK(brief_revision >= 0);
ALTER TABLE workflow_revisions ADD COLUMN brief_hash TEXT NOT NULL DEFAULT '' CHECK(brief_hash='' OR length(brief_hash)=64);
ALTER TABLE workflow_revisions ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0 CHECK(draft_revision >= 0);
ALTER TABLE workflow_revisions ADD COLUMN layout_revision INTEGER NOT NULL DEFAULT 0 CHECK(layout_revision >= 0);
ALTER TABLE workflow_revisions ADD COLUMN proposal_id TEXT;
ALTER TABLE workflow_revisions ADD COLUMN source_generation_id TEXT;
ALTER TABLE workflow_revisions ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json));

/* The v3 generation table had a terminal-only status check.  Rebuild it so
 * the critic-pending, rejected and applied states are durable. */
ALTER TABLE workflow_generations RENAME TO workflow_generations_v3;
CREATE TABLE workflow_generations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL DEFAULT 'initial' CHECK(mode IN ('initial','replan')),
  phase TEXT NOT NULL DEFAULT 'queued' CHECK(phase IN ('queued','running','critic_pending','completed','rejected','failed','cancelled','applied','proposal_created')),
  brief_revision INTEGER NOT NULL,
  brief_hash TEXT NOT NULL DEFAULT '' CHECK(brief_hash='' OR length(brief_hash)=64),
  source_revision TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '' CHECK(source_hash='' OR length(source_hash)=64),
  repository_revision INTEGER NOT NULL DEFAULT 0 CHECK(repository_revision >= 0),
  repository_hash TEXT NOT NULL DEFAULT '' CHECK(repository_hash='' OR length(repository_hash)=64),
  draft_revision INTEGER NOT NULL DEFAULT 0 CHECK(draft_revision >= 0),
  layout_revision INTEGER NOT NULL DEFAULT 0 CHECK(layout_revision >= 0),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0),
  retry_of_generation_id TEXT REFERENCES workflow_generations(id) ON DELETE RESTRICT,
  provider_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(provider_snapshot_json)),
  input_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(input_snapshot_json)),
  input_hash TEXT NOT NULL DEFAULT '' CHECK(input_hash='' OR length(input_hash)=64),
  candidate_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(candidate_json)),
  candidate_hash TEXT NOT NULL DEFAULT '' CHECK(candidate_hash='' OR length(candidate_hash)=64),
  critic_receipt_id TEXT REFERENCES workflow_critic_receipts(id) ON DELETE RESTRICT,
  proposal_id TEXT REFERENCES workflow_generation_proposals(id) ON DELETE RESTRICT,
  error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT
) STRICT;
INSERT INTO workflow_generations(
  id,project_id,mode,phase,brief_revision,brief_hash,candidate_json,critic_receipt_id,
  error_code,created_at,updated_at
) SELECT id,project_id,'initial',
  CASE WHEN status='completed' THEN 'completed'
       WHEN status='failed' THEN 'failed'
       ELSE status END,
  brief_revision,'',candidate_json,NULL,'',created_at,updated_at
FROM workflow_generations_v3;
DROP TABLE workflow_generations_v3;

ALTER TABLE workflow_generation_events RENAME TO workflow_generation_events_v3;
CREATE TABLE workflow_generation_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id TEXT NOT NULL REFERENCES workflow_generations(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO workflow_generation_events(cursor,generation_id,operation_id,type,data_json,created_at)
  SELECT cursor,generation_id,NULL,type,data_json,created_at FROM workflow_generation_events_v3;
DROP TABLE workflow_generation_events_v3;

CREATE TABLE workflow_layout_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL REFERENCES workflow_drafts(id) ON DELETE RESTRICT,
  draft_revision INTEGER NOT NULL CHECK(draft_revision > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  nodes_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(nodes_json)),
  viewport_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(viewport_json)),
  layout_hash TEXT NOT NULL CHECK(length(layout_hash)=64),
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','generator','legacy_compat')),
  created_at TEXT NOT NULL,
  UNIQUE(draft_id, revision)
) STRICT;

CREATE TABLE workflow_critic_receipts (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES workflow_generations(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('passed','rejected','failed')),
  candidate_hash TEXT NOT NULL CHECK(length(candidate_hash)=64),
  input_hash TEXT NOT NULL DEFAULT '' CHECK(input_hash='' OR length(input_hash)=64),
  issues_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(issues_json)),
  node_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(node_ids_json)),
  field_paths_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(field_paths_json)),
  provider_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(provider_snapshot_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE node_contract_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workflow_revision INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  contract_json TEXT NOT NULL CHECK(json_valid(contract_json)),
  contract_hash TEXT NOT NULL CHECK(length(contract_hash)=64),
  source TEXT NOT NULL DEFAULT 'workflow' CHECK(source IN ('workflow','legacy_compat','manual')),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,workflow_revision,node_id,revision),
  FOREIGN KEY(project_id,workflow_revision) REFERENCES workflow_revisions(project_id,revision)
) STRICT;

CREATE TABLE workflow_generation_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  generation_id TEXT NOT NULL REFERENCES workflow_generations(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK(mode IN ('initial','replan')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','rejected','stale')),
  base_workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK(base_workflow_revision >= 0),
  base_draft_revision INTEGER NOT NULL CHECK(base_draft_revision > 0),
  base_layout_revision INTEGER NOT NULL DEFAULT 0 CHECK(base_layout_revision >= 0),
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
  candidate_hash TEXT NOT NULL CHECK(length(candidate_hash)=64),
  critic_receipt_id TEXT REFERENCES workflow_critic_receipts(id) ON DELETE RESTRICT,
  proposal_hash TEXT NOT NULL CHECK(length(proposal_hash)=64),
  apply_operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  applied_workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK(applied_workflow_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(generation_id)
) STRICT;

CREATE INDEX idx_workflow_generation_project ON workflow_generations(project_id,created_at DESC);
CREATE INDEX idx_workflow_generation_events_generation ON workflow_generation_events(generation_id,cursor);
CREATE UNIQUE INDEX idx_workflow_draft_revision ON workflow_drafts(project_id,revision);
CREATE INDEX idx_workflow_layout_draft ON workflow_layout_revisions(draft_id,revision DESC);
CREATE INDEX idx_workflow_critic_generation ON workflow_critic_receipts(generation_id,created_at DESC);
CREATE INDEX idx_node_contract_revision ON node_contract_revisions(project_id,workflow_revision,node_id,revision DESC);
CREATE INDEX idx_workflow_proposals_project ON workflow_generation_proposals(project_id,created_at DESC);

CREATE TRIGGER immutable_workflow_layout_revisions_update BEFORE UPDATE ON workflow_layout_revisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER immutable_workflow_layout_revisions_delete BEFORE DELETE ON workflow_layout_revisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER immutable_workflow_critic_receipts_update BEFORE UPDATE ON workflow_critic_receipts BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER immutable_workflow_critic_receipts_delete BEFORE DELETE ON workflow_critic_receipts BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER immutable_node_contract_revisions_update BEFORE UPDATE ON node_contract_revisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER immutable_node_contract_revisions_delete BEFORE DELETE ON node_contract_revisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;

/* Legacy v3 workflows remain executable.  Their first layout and contract
 * snapshots are explicitly marked as compatibility records. */
INSERT INTO workflow_layout_revisions(
  id,project_id,draft_id,draft_revision,revision,nodes_json,viewport_json,layout_hash,source,created_at
) SELECT
  'wlay_legacy_'||lower(hex(randomblob(16))),w.project_id,w.id,w.revision,1,
  json('[]'),'{}',
  printf('%064d',0),'legacy_compat',w.created_at
FROM workflow_drafts w
WHERE NOT EXISTS(SELECT 1 FROM workflow_layout_revisions l WHERE l.draft_id=w.id);
UPDATE workflow_drafts SET hierarchy_mode='legacy_compat',layout_revision=1,
  draft_hash=CASE WHEN draft_hash='' THEN lower(hex(randomblob(32))) ELSE draft_hash END,
  draft_updated_at=updated_at
WHERE hierarchy_mode='two_level';
UPDATE workflow_revisions SET hierarchy_mode='legacy_compat',metadata_json='{"compatibility":"v3"}'
WHERE hierarchy_mode='legacy_compat';
CREATE TRIGGER immutable_workflow_revisions_update BEFORE UPDATE ON workflow_revisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER immutable_workflow_revisions_delete BEFORE DELETE ON workflow_revisions BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
INSERT INTO node_contract_revisions(
  id,project_id,workflow_revision,node_id,revision,contract_json,contract_hash,source,created_at
) SELECT
  'ncr_legacy_'||lower(hex(randomblob(16))),n.project_id,n.workflow_revision,n.node_id,1,
  n.contract_json,printf('%064d',0),'legacy_compat',n.created_at
FROM node_contracts n
WHERE NOT EXISTS(SELECT 1 FROM node_contract_revisions r
  WHERE r.project_id=n.project_id AND r.workflow_revision=n.workflow_revision AND r.node_id=n.node_id);
`;

export const WORKFLOW_GENERATION_CRITIC_V4 = Object.freeze({
  version: 4,
  name: 'workflow_generation_critic',
  sql: WORKFLOW_GENERATION_CRITIC_V4_SQL,
  disableForeignKeys: true
});
