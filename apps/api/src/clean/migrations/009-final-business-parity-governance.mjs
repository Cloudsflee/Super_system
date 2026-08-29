import { createHash } from 'node:crypto';

export const FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION_ID = '009-final-business-parity-governance';
export const FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION_VERSION = 9;
export const FINAL_BUSINESS_PARITY_GOVERNANCE_TOOL_VERSION = 'v3-clean-p10';
export const P10_PARSER_IMAGE_DIGEST = 'sha256:3c2c0f8f550f4c8a14c33661f1e4e85227aa02e3bd0844a8e1044ed368d202a0';

// P10 adds revisioned business records only. Operations, events, aggregate
// heads, CAS, authorization, and cursor ownership stay with existing owners.
export const FINAL_BUSINESS_PARITY_GOVERNANCE_SQL = `
UPDATE parser_formats SET worker_version='node24-p10',worker_image_digest='${P10_PARSER_IMAGE_DIGEST}',revision=revision+1,updated_at='2026-08-29T00:00:00.000Z';

ALTER TABLE provider_profiles ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'enabled'
  CHECK(lifecycle_status IN ('enabled','disabled'));
ALTER TABLE provider_profiles ADD COLUMN disabled_at TEXT;

CREATE TABLE IF NOT EXISTS brief_templates (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK(current_revision >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(team_id,name)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_brief_templates_team ON brief_templates(team_id,status,updated_at DESC,id);

CREATE TABLE IF NOT EXISTS brief_template_revisions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES brief_templates(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(template_id,revision)
) STRICT;

ALTER TABLE brief_revisions ADD COLUMN template_id TEXT REFERENCES brief_templates(id) ON DELETE RESTRICT;
ALTER TABLE brief_revisions ADD COLUMN template_revision INTEGER CHECK(template_revision IS NULL OR template_revision > 0);
ALTER TABLE brief_revisions ADD COLUMN template_sha256 TEXT NOT NULL DEFAULT ''
  CHECK(template_sha256='' OR length(template_sha256)=64);

ALTER TABLE assist_sessions ADD COLUMN title TEXT NOT NULL DEFAULT '' CHECK(length(title) <= 160);
ALTER TABLE assist_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'guided' CHECK(mode IN ('guided','agent','side_thread'));
ALTER TABLE assist_sessions ADD COLUMN parent_session_id TEXT REFERENCES assist_sessions(id) ON DELETE RESTRICT;
ALTER TABLE assist_sessions ADD COLUMN fork_source_turn_id TEXT REFERENCES assist_turns(id) ON DELETE RESTRICT;
ALTER TABLE assist_sessions ADD COLUMN pinned_at TEXT;
ALTER TABLE assist_sessions ADD COLUMN archived_at TEXT;
ALTER TABLE assist_sessions ADD COLUMN deleted_at TEXT;

CREATE TABLE IF NOT EXISTS workflow_quality_policies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  rubric_json TEXT NOT NULL CHECK(json_valid(rubric_json)),
  rubric_sha256 TEXT NOT NULL CHECK(length(rubric_sha256)=64),
  threshold REAL NOT NULL DEFAULT 80 CHECK(threshold BETWEEN 0 AND 100),
  reviewer_profile_id TEXT REFERENCES provider_profiles(id) ON DELETE RESTRICT,
  reviewer_profile_revision INTEGER CHECK(reviewer_profile_revision IS NULL OR reviewer_profile_revision > 0),
  policy_sha256 TEXT NOT NULL UNIQUE CHECK(length(policy_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(workflow_id,revision)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_workflow_quality_policy ON workflow_quality_policies(workflow_id,revision DESC,id);

ALTER TABLE quality_review_runs ADD COLUMN policy_revision INTEGER CHECK(policy_revision IS NULL OR policy_revision > 0);
ALTER TABLE quality_review_runs ADD COLUMN policy_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(policy_snapshot_json));
ALTER TABLE quality_review_runs ADD COLUMN policy_sha256 TEXT NOT NULL DEFAULT '' CHECK(policy_sha256='' OR length(policy_sha256)=64);
ALTER TABLE quality_review_runs ADD COLUMN reviewer_profile_id TEXT REFERENCES provider_profiles(id) ON DELETE RESTRICT;
ALTER TABLE quality_review_runs ADD COLUMN reviewer_profile_revision INTEGER CHECK(reviewer_profile_revision IS NULL OR reviewer_profile_revision > 0);
ALTER TABLE quality_review_runs ADD COLUMN reviewer_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(reviewer_snapshot_json));
ALTER TABLE quality_review_runs ADD COLUMN reviewer_snapshot_sha256 TEXT NOT NULL DEFAULT '' CHECK(reviewer_snapshot_sha256='' OR length(reviewer_snapshot_sha256)=64);
ALTER TABLE quality_review_runs ADD COLUMN supersedes_quality_review_id TEXT REFERENCES quality_review_runs(id) ON DELETE RESTRICT;
ALTER TABLE quality_review_runs ADD COLUMN superseded_by_quality_review_id TEXT REFERENCES quality_review_runs(id) ON DELETE RESTRICT;
ALTER TABLE quality_review_runs ADD COLUMN stale_at TEXT;
ALTER TABLE quality_review_runs ADD COLUMN stale_reason TEXT NOT NULL DEFAULT '' CHECK(length(stale_reason) <= 240);

CREATE TABLE IF NOT EXISTS quality_review_asset_selections (
  id TEXT PRIMARY KEY,
  quality_review_id TEXT NOT NULL REFERENCES quality_review_runs(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  disposition TEXT NOT NULL CHECK(disposition IN ('included','excluded')),
  exclusion_reason TEXT NOT NULL DEFAULT '',
  asset_revision INTEGER NOT NULL CHECK(asset_revision > 0),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  selection_sha256 TEXT NOT NULL UNIQUE CHECK(length(selection_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  CHECK((disposition='included' AND exclusion_reason='') OR (disposition='excluded' AND length(exclusion_reason) BETWEEN 1 AND 500)),
  UNIQUE(quality_review_id,asset_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_quality_asset_selection ON quality_review_asset_selections(quality_review_id,disposition,asset_id);

CREATE TABLE IF NOT EXISTS quality_review_advices (
  id TEXT PRIMARY KEY,
  quality_review_id TEXT NOT NULL UNIQUE REFERENCES quality_review_runs(id) ON DELETE RESTRICT,
  profile_id TEXT REFERENCES provider_profiles(id) ON DELETE RESTRICT,
  profile_revision INTEGER CHECK(profile_revision IS NULL OR profile_revision > 0),
  schema_version TEXT NOT NULL CHECK(schema_version='quality.advice.v1'),
  status TEXT NOT NULL CHECK(status IN ('valid','invalid','unavailable')),
  advice_json TEXT NOT NULL CHECK(json_valid(advice_json)),
  advice_sha256 TEXT NOT NULL UNIQUE CHECK(length(advice_sha256)=64),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  lease_sha256 TEXT NOT NULL DEFAULT '' CHECK(lease_sha256='' OR length(lease_sha256)=64),
  error_code TEXT NOT NULL DEFAULT '' CHECK(length(error_code) <= 120),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_quality_one_active ON quality_review_runs(execution_id)
  WHERE status IN ('queued','preparing','checking','reviewing','awaiting_human');
DROP TRIGGER IF EXISTS immutable_terminal_quality_run_update;
CREATE TRIGGER IF NOT EXISTS immutable_terminal_quality_run_update
  BEFORE UPDATE ON quality_review_runs
  WHEN OLD.status IN ('failed','cancelled','stale') OR (
    OLD.status='completed' AND NEW.status<>'stale' AND NOT (
      NEW.status='completed' AND OLD.superseded_by_quality_review_id IS NULL
      AND NEW.superseded_by_quality_review_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM quality_review_runs successor
        WHERE successor.id=NEW.superseded_by_quality_review_id
          AND successor.execution_id=OLD.execution_id
          AND successor.status='completed'
          AND successor.supersedes_quality_review_id=OLD.id
      )
      AND NEW.revision=OLD.revision+1
      AND NEW.id IS OLD.id AND NEW.project_id IS OLD.project_id
      AND NEW.execution_id IS OLD.execution_id AND NEW.operation_id IS OLD.operation_id
      AND NEW.retry_of_quality_review_id IS OLD.retry_of_quality_review_id
      AND NEW.attempt_no IS OLD.attempt_no AND NEW.asset_ids_json IS OLD.asset_ids_json
      AND NEW.asset_count IS OLD.asset_count AND NEW.input_snapshot_json IS OLD.input_snapshot_json
      AND NEW.input_sha256 IS OLD.input_sha256 AND NEW.rubric_json IS OLD.rubric_json
      AND NEW.rubric_sha256 IS OLD.rubric_sha256 AND NEW.threshold IS OLD.threshold
      AND NEW.report_id IS OLD.report_id AND NEW.human_review_id IS OLD.human_review_id
      AND NEW.error_code IS OLD.error_code AND NEW.created_at IS OLD.created_at
      AND NEW.completed_at IS OLD.completed_at AND NEW.created_by_actor_id IS OLD.created_by_actor_id
      AND NEW.updated_by_actor_id IS OLD.updated_by_actor_id
      AND NEW.policy_revision IS OLD.policy_revision AND NEW.policy_snapshot_json IS OLD.policy_snapshot_json
      AND NEW.policy_sha256 IS OLD.policy_sha256 AND NEW.reviewer_profile_id IS OLD.reviewer_profile_id
      AND NEW.reviewer_profile_revision IS OLD.reviewer_profile_revision
      AND NEW.reviewer_snapshot_json IS OLD.reviewer_snapshot_json
      AND NEW.reviewer_snapshot_sha256 IS OLD.reviewer_snapshot_sha256
      AND NEW.supersedes_quality_review_id IS OLD.supersedes_quality_review_id
      AND NEW.stale_at IS OLD.stale_at AND NEW.stale_reason IS OLD.stale_reason
    )
  )
  BEGIN SELECT RAISE(ABORT, 'immutable_terminal_quality_run'); END;

CREATE TABLE IF NOT EXISTS assist_review_comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES assist_sessions(id) ON DELETE RESTRICT,
  turn_id TEXT NOT NULL REFERENCES assist_turns(id) ON DELETE RESTRICT,
  parent_comment_id TEXT REFERENCES assist_review_comments(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('comment','request_changes','resolution')),
  relative_path TEXT NOT NULL DEFAULT '' CHECK(length(relative_path) <= 1024),
  line_number INTEGER CHECK(line_number IS NULL OR line_number > 0),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  content_cas_sha256 TEXT NOT NULL REFERENCES cas_objects(sha256) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_assist_review_comments_turn ON assist_review_comments(turn_id,created_at,id);

CREATE TABLE IF NOT EXISTS project_deletion_intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','creator_confirmed','ready','executing','blocked','completed','cancelled')),
  expected_project_revision INTEGER NOT NULL CHECK(expected_project_revision > 0),
  target_name TEXT NOT NULL CHECK(length(target_name) BETWEEN 1 AND 160),
  blockers_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(blockers_json)),
  blockers_sha256 TEXT NOT NULL CHECK(length(blockers_sha256)=64),
  creator_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  creator_session_id TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
  creator_session_proof_sha256 TEXT NOT NULL DEFAULT '' CHECK(creator_session_proof_sha256='' OR length(creator_session_proof_sha256)=64),
  creator_confirmed_at TEXT,
  owner_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  owner_session_id TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
  owner_session_proof_sha256 TEXT NOT NULL DEFAULT '' CHECK(owner_session_proof_sha256='' OR length(owner_session_proof_sha256)=64),
  owner_confirmed_at TEXT,
  tombstone_sha256 TEXT NOT NULL DEFAULT '' CHECK(tombstone_sha256='' OR length(tombstone_sha256)=64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_deletion_active ON project_deletion_intents(project_id)
  WHERE status NOT IN ('completed','cancelled');

CREATE TABLE IF NOT EXISTS repository_deletion_intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  repository_target_id TEXT NOT NULL REFERENCES repository_targets(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','creator_confirmed','ready','executing','needs_reconcile','failed','completed','cancelled')),
  target_full_name TEXT NOT NULL CHECK(length(target_full_name) BETWEEN 3 AND 260),
  expected_head_sha TEXT NOT NULL CHECK(length(expected_head_sha) BETWEEN 7 AND 128),
  expected_target_revision INTEGER NOT NULL CHECK(expected_target_revision > 0),
  creator_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  creator_session_id TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
  creator_session_proof_sha256 TEXT NOT NULL DEFAULT '' CHECK(creator_session_proof_sha256='' OR length(creator_session_proof_sha256)=64),
  creator_confirmed_at TEXT,
  owner_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  owner_session_id TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
  owner_session_proof_sha256 TEXT NOT NULL DEFAULT '' CHECK(owner_session_proof_sha256='' OR length(owner_session_proof_sha256)=64),
  owner_confirmed_at TEXT,
  external_repository_id TEXT NOT NULL DEFAULT '' CHECK(length(external_repository_id) <= 160),
  external_receipt_sha256 TEXT NOT NULL DEFAULT '' CHECK(external_receipt_sha256='' OR length(external_receipt_sha256)=64),
  error_code TEXT NOT NULL DEFAULT '' CHECK(length(error_code) <= 120),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_repository_deletion_active ON repository_deletion_intents(repository_target_id)
  WHERE status NOT IN ('completed','cancelled','failed');

CREATE TRIGGER IF NOT EXISTS immutable_brief_revision_update BEFORE UPDATE ON brief_revisions BEGIN SELECT RAISE(ABORT,'immutable_brief_revision'); END;
CREATE TRIGGER IF NOT EXISTS immutable_brief_revision_delete BEFORE DELETE ON brief_revisions BEGIN SELECT RAISE(ABORT,'immutable_brief_revision'); END;
CREATE TRIGGER IF NOT EXISTS immutable_brief_template_revision_update BEFORE UPDATE ON brief_template_revisions BEGIN SELECT RAISE(ABORT,'immutable_brief_template_revision'); END;
CREATE TRIGGER IF NOT EXISTS immutable_brief_template_revision_delete BEFORE DELETE ON brief_template_revisions BEGIN SELECT RAISE(ABORT,'immutable_brief_template_revision'); END;
CREATE TRIGGER IF NOT EXISTS immutable_workflow_quality_policy_update BEFORE UPDATE ON workflow_quality_policies BEGIN SELECT RAISE(ABORT,'immutable_workflow_quality_policy'); END;
CREATE TRIGGER IF NOT EXISTS immutable_workflow_quality_policy_delete BEFORE DELETE ON workflow_quality_policies BEGIN SELECT RAISE(ABORT,'immutable_workflow_quality_policy'); END;
CREATE TRIGGER IF NOT EXISTS immutable_quality_asset_selection_update BEFORE UPDATE ON quality_review_asset_selections BEGIN SELECT RAISE(ABORT,'immutable_quality_asset_selection'); END;
CREATE TRIGGER IF NOT EXISTS immutable_quality_asset_selection_delete BEFORE DELETE ON quality_review_asset_selections BEGIN SELECT RAISE(ABORT,'immutable_quality_asset_selection'); END;
CREATE TRIGGER IF NOT EXISTS immutable_quality_advice_update BEFORE UPDATE ON quality_review_advices BEGIN SELECT RAISE(ABORT,'immutable_quality_advice'); END;
CREATE TRIGGER IF NOT EXISTS immutable_quality_advice_delete BEFORE DELETE ON quality_review_advices BEGIN SELECT RAISE(ABORT,'immutable_quality_advice'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_review_comment_update BEFORE UPDATE ON assist_review_comments BEGIN SELECT RAISE(ABORT,'immutable_assist_review_comment'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_review_comment_delete BEFORE DELETE ON assist_review_comments BEGIN SELECT RAISE(ABORT,'immutable_assist_review_comment'); END;
CREATE TRIGGER IF NOT EXISTS immutable_terminal_project_deletion_intent_update BEFORE UPDATE ON project_deletion_intents WHEN OLD.status IN ('completed','cancelled') BEGIN SELECT RAISE(ABORT,'immutable_terminal_project_deletion_intent'); END;
CREATE TRIGGER IF NOT EXISTS immutable_terminal_project_deletion_intent_delete BEFORE DELETE ON project_deletion_intents WHEN OLD.status IN ('completed','cancelled') BEGIN SELECT RAISE(ABORT,'immutable_terminal_project_deletion_intent'); END;
CREATE TRIGGER IF NOT EXISTS immutable_terminal_repository_deletion_intent_update BEFORE UPDATE ON repository_deletion_intents WHEN OLD.status IN ('completed','cancelled') BEGIN SELECT RAISE(ABORT,'immutable_terminal_repository_deletion_intent'); END;
CREATE TRIGGER IF NOT EXISTS immutable_terminal_repository_deletion_intent_delete BEFORE DELETE ON repository_deletion_intents WHEN OLD.status IN ('completed','cancelled') BEGIN SELECT RAISE(ABORT,'immutable_terminal_repository_deletion_intent'); END;
`;

export const FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION_CHECKSUM = createHash('sha256')
  .update(`${FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION_VERSION}\n${FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION_ID}\n${FINAL_BUSINESS_PARITY_GOVERNANCE_SQL}`)
  .digest('hex');

export const FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION = Object.freeze({
  version: FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION_VERSION,
  id: FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION_ID,
  name: FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION_ID,
  family: 'v3-clean',
  sql: FINAL_BUSINESS_PARITY_GOVERNANCE_SQL,
  checksum: FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION_CHECKSUM,
  toolVersion: FINAL_BUSINESS_PARITY_GOVERNANCE_TOOL_VERSION
});
