/* R3 Project, Brief and Repository Intake migration.
 *
 * The v1 and v2 migration strings are intentionally left untouched.  This
 * migration owns all forward-only lifecycle and repository metadata added by
 * the R3 intake flow.
 */
export const PROJECT_REPOSITORY_INTAKE_V3_SQL = `
-- projects.status was intentionally widened in a table replacement.  The
-- migration runner temporarily disables FK checks while this atomic DDL runs;
-- child declarations continue to reference the final projects table name.
CREATE TABLE "projects_v3" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived','trashed','purged')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  onboarding_state TEXT NOT NULL DEFAULT 'draft'
    CHECK(onboarding_state IN ('draft','running','ready','failed','cancelled','confirmed')),
  confirmed_brief_revision INTEGER CHECK(confirmed_brief_revision IS NULL OR confirmed_brief_revision > 0),
  confirmed_brief_hash TEXT NOT NULL DEFAULT '' CHECK(confirmed_brief_hash='' OR length(confirmed_brief_hash)=64),
  workflow_draft_id TEXT REFERENCES workflow_drafts(id) ON DELETE RESTRICT,
  workflow_draft_revision INTEGER NOT NULL DEFAULT 1 CHECK(workflow_draft_revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  trashed_at TEXT,
  purged_at TEXT
) STRICT;
INSERT INTO "projects_v3"(
  id,name,description,status,revision,onboarding_state,confirmed_brief_revision,
  confirmed_brief_hash,workflow_draft_id,workflow_draft_revision,created_at,updated_at,
  archived_at,trashed_at,purged_at
) SELECT
  id,name,description,status,revision,
  CASE WHEN status='active' THEN 'confirmed' ELSE 'ready' END,
  NULL,'','',1,created_at,updated_at,
  CASE WHEN status='archived' THEN updated_at ELSE NULL END,
  NULL,NULL
FROM projects;
DROP TABLE projects;
ALTER TABLE "projects_v3" RENAME TO projects;

ALTER TABLE project_intakes ADD COLUMN mode TEXT NOT NULL DEFAULT 'existing'
  CHECK(mode IN ('brainstorm','existing'));
ALTER TABLE project_intakes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE project_intakes ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0);
ALTER TABLE project_intakes ADD COLUMN operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT;
ALTER TABLE project_intakes ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'none'
  CHECK(source_kind IN ('none','fixture','local','git','upload','archive'));
ALTER TABLE project_intakes ADD COLUMN source_locator TEXT NOT NULL DEFAULT '';
ALTER TABLE project_intakes ADD COLUMN source_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE project_intakes ADD COLUMN source_hash TEXT NOT NULL DEFAULT '' CHECK(source_hash='' OR length(source_hash)=64);
ALTER TABLE project_intakes ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json));
ALTER TABLE project_intakes ADD COLUMN error_code TEXT NOT NULL DEFAULT '';
ALTER TABLE project_intakes ADD COLUMN completed_at TEXT;
ALTER TABLE project_intakes ADD COLUMN cancelled_at TEXT;
ALTER TABLE project_intakes ADD COLUMN interrupted_at TEXT;

ALTER TABLE workflow_drafts ADD COLUMN source_brief_revision INTEGER NOT NULL DEFAULT 0 CHECK(source_brief_revision >= 0);
ALTER TABLE workflow_drafts ADD COLUMN source_brief_hash TEXT NOT NULL DEFAULT '' CHECK(source_brief_hash='' OR length(source_brief_hash)=64);

ALTER TABLE brief_heads ADD COLUMN confirmed_revision INTEGER CHECK(confirmed_revision IS NULL OR confirmed_revision > 0);
ALTER TABLE brief_heads ADD COLUMN confirmation_revision INTEGER NOT NULL DEFAULT 0 CHECK(confirmation_revision >= 0);
ALTER TABLE brief_heads ADD COLUMN confirmed_at TEXT;
ALTER TABLE brief_heads ADD COLUMN confirmed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE brief_heads ADD COLUMN confirmed_hash TEXT NOT NULL DEFAULT '' CHECK(confirmed_hash='' OR length(confirmed_hash)=64);

ALTER TABLE repository_bindings ADD COLUMN connection_id TEXT REFERENCES repository_connections(id) ON DELETE RESTRICT;
ALTER TABLE repository_bindings ADD COLUMN target_id TEXT REFERENCES repository_targets(id) ON DELETE RESTRICT;
ALTER TABLE repository_bindings ADD COLUMN line_id TEXT REFERENCES repository_lines(id) ON DELETE RESTRICT;
ALTER TABLE repository_bindings ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'local'
  CHECK(source_kind IN ('none','fixture','local','git','upload','archive'));
ALTER TABLE repository_bindings ADD COLUMN source_locator TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_bindings ADD COLUMN source_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_bindings ADD COLUMN source_hash TEXT NOT NULL DEFAULT '' CHECK(source_hash='' OR length(source_hash)=64);
ALTER TABLE repository_bindings ADD COLUMN managed_relative_path TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_bindings ADD COLUMN trash_relative_path TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_bindings ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'
  CHECK(status IN ('pending','ready','fault','trashed','purged'));
ALTER TABLE repository_bindings ADD COLUMN fault_code TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_bindings ADD COLUMN fault_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(fault_json));
ALTER TABLE repository_bindings ADD COLUMN locked_by_operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT;
ALTER TABLE repository_bindings ADD COLUMN baseline_sha TEXT NOT NULL DEFAULT '';

ALTER TABLE repository_connections ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE repository_connections ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'none'
  CHECK(source_kind IN ('none','fixture','local','git','upload','archive'));
ALTER TABLE repository_connections ADD COLUMN source_locator TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_connections ADD COLUMN source_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_connections ADD COLUMN source_hash TEXT NOT NULL DEFAULT '' CHECK(source_hash='' OR length(source_hash)=64);
ALTER TABLE repository_connections ADD COLUMN display_label TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_connections ADD COLUMN read_only INTEGER NOT NULL DEFAULT 1 CHECK(read_only IN (0,1));
ALTER TABLE repository_connections ADD COLUMN fault_code TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_connections ADD COLUMN fault_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(fault_json));
ALTER TABLE repository_connections ADD COLUMN locked_by_operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT;

ALTER TABLE repository_targets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE repository_targets ADD COLUMN source_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_targets ADD COLUMN source_hash TEXT NOT NULL DEFAULT '' CHECK(source_hash='' OR length(source_hash)=64);
ALTER TABLE repository_targets ADD COLUMN managed_relative_path TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_targets ADD COLUMN fault_code TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_targets ADD COLUMN fault_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(fault_json));

ALTER TABLE repository_lines ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE repository_lines ADD COLUMN source_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_lines ADD COLUMN source_hash TEXT NOT NULL DEFAULT '' CHECK(source_hash='' OR length(source_hash)=64);
ALTER TABLE repository_lines ADD COLUMN baseline_sha TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_lines ADD COLUMN managed_relative_path TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_lines ADD COLUMN probe_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK(probe_status IN ('unknown','running','available','unavailable'));
ALTER TABLE repository_lines ADD COLUMN probe_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(probe_json));
ALTER TABLE repository_lines ADD COLUMN fault_code TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_lines ADD COLUMN fault_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(fault_json));
ALTER TABLE repository_lines ADD COLUMN locked_by_operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT;
ALTER TABLE repository_lines ADD COLUMN operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT;
ALTER TABLE repository_lines ADD COLUMN last_manifest_hash TEXT NOT NULL DEFAULT '' CHECK(last_manifest_hash='' OR length(last_manifest_hash)=64);
ALTER TABLE repository_lines ADD COLUMN interrupted_at TEXT;

CREATE TABLE repository_line_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  line_id TEXT NOT NULL REFERENCES repository_lines(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('upload','archive','trash','restore','probe','staging','checkout')),
  relative_path TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(manifest_json)),
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=64),
  source_hash TEXT NOT NULL DEFAULT '' CHECK(source_hash='' OR length(source_hash)=64),
  byte_size INTEGER NOT NULL DEFAULT 0 CHECK(byte_size >= 0),
  created_at TEXT NOT NULL
) STRICT;

-- Backfill the current intake, draft and confirmed head for legacy projects.
UPDATE project_intakes SET
  mode=CASE WHEN json_extract(payload_json,'$.mode')='brainstorm' THEN 'brainstorm' ELSE 'existing' END,
  revision=CASE WHEN revision < 1 THEN 1 ELSE revision END,
  result_json=CASE WHEN result_json='{}' THEN payload_json ELSE result_json END,
  completed_at=CASE WHEN status='ready' AND completed_at IS NULL THEN updated_at ELSE completed_at END;
DELETE FROM project_intakes WHERE id IN (
  SELECT older.id FROM project_intakes older
  JOIN project_intakes newer ON newer.project_id=older.project_id
    AND (newer.updated_at > older.updated_at OR (newer.updated_at=older.updated_at AND newer.id > older.id))
);
CREATE UNIQUE INDEX idx_project_intakes_current ON project_intakes(project_id);

INSERT INTO project_intakes(
  id,project_id,status, payload_json,created_at,updated_at,mode,revision,attempt,
  operation_id,source_kind,source_locator,source_revision,source_hash,result_json,error_code,
  completed_at,cancelled_at,interrupted_at
) SELECT
  'int_'||lower(hex(randomblob(16))),p.id,
  CASE WHEN p.status IN ('active','archived') THEN 'ready' ELSE 'draft' END,
  '{}',p.created_at,p.updated_at,
  CASE WHEN EXISTS(SELECT 1 FROM repository_bindings b WHERE b.project_id=p.id) THEN 'existing' ELSE 'brainstorm' END,
  1,0,NULL,'none','', '', '', '{}','',
  CASE WHEN p.status IN ('active','archived') THEN p.updated_at ELSE NULL END,NULL,NULL
FROM projects p WHERE NOT EXISTS(SELECT 1 FROM project_intakes i WHERE i.project_id=p.id);

INSERT INTO workflow_drafts(id,project_id,revision,graph_json,status,created_at,updated_at,source_brief_revision,source_brief_hash)
SELECT 'wfd_'||lower(hex(randomblob(16))),p.id,1,'{}','draft',p.created_at,p.updated_at,0,''
FROM projects p WHERE NOT EXISTS(SELECT 1 FROM workflow_drafts w WHERE w.project_id=p.id);
UPDATE projects SET workflow_draft_id=(SELECT w.id FROM workflow_drafts w WHERE w.project_id=projects.id ORDER BY w.revision DESC,w.created_at DESC LIMIT 1);

INSERT INTO brief_heads(project_id,revision,updated_at,confirmed_revision,confirmation_revision,confirmed_at,confirmed_by,confirmed_hash)
SELECT b.project_id,b.revision,b.created_at,b.revision,1,b.created_at,'migration',b.content_hash
FROM brief_revisions b
WHERE b.revision=(SELECT MAX(x.revision) FROM brief_revisions x WHERE x.project_id=b.project_id)
  AND NOT EXISTS(SELECT 1 FROM brief_heads h WHERE h.project_id=b.project_id);
UPDATE brief_heads SET
  confirmed_revision=COALESCE(confirmed_revision,revision),
  confirmation_revision=CASE WHEN confirmation_revision < 1 THEN 1 ELSE confirmation_revision END,
  confirmed_at=COALESCE(confirmed_at,updated_at),
  confirmed_by=CASE WHEN confirmed_by='' THEN 'migration' ELSE confirmed_by END,
  confirmed_hash=CASE WHEN confirmed_hash='' THEN COALESCE((SELECT content_hash FROM brief_revisions b WHERE b.project_id=brief_heads.project_id AND b.revision=brief_heads.revision),'') ELSE confirmed_hash END;
UPDATE projects SET
  confirmed_brief_revision=(SELECT h.confirmed_revision FROM brief_heads h WHERE h.project_id=projects.id),
  confirmed_brief_hash=COALESCE((SELECT h.confirmed_hash FROM brief_heads h WHERE h.project_id=projects.id),'');

-- Preserve every legacy binding while creating the canonical Connection,
-- Target and managed checkout Line rows exactly once.
UPDATE repository_bindings SET
  source_kind=CASE WHEN remote_url LIKE 'fixture://%' THEN 'fixture' WHEN remote_url LIKE 'https://%' THEN 'git' ELSE 'local' END,
  source_locator=CASE WHEN remote_url<>'' THEN remote_url ELSE local_path END,
  managed_relative_path=local_path,
  status='ready',
  baseline_sha=CASE WHEN baseline_sha='' THEN head_sha ELSE baseline_sha END;
INSERT OR IGNORE INTO repository_connections(
  id,project_id,provider,remote_url,credential_ref,status,created_at,updated_at,revision,
  source_kind,source_locator,source_revision,source_hash,display_label,read_only,fault_code,fault_json,locked_by_operation_id
) SELECT
  'con_'||b.id,b.project_id,'git',b.remote_url,NULL,'connected',b.created_at,b.updated_at,1,
  b.source_kind,b.source_locator,'',b.source_hash,
  CASE WHEN b.remote_url<>'' THEN b.remote_url ELSE b.local_path END,1,'','{}',NULL
FROM repository_bindings b;
INSERT OR IGNORE INTO repository_targets(
  id,connection_id,repository,default_branch,baseline_sha,created_at,updated_at,revision,
  source_revision,source_hash,managed_relative_path,fault_code,fault_json
) SELECT
  'tgt_'||b.id,'con_'||b.id,CASE WHEN b.remote_url<>'' THEN b.remote_url ELSE b.local_path END,
  'main',b.head_sha,b.created_at,b.updated_at,1,'',b.source_hash,b.local_path,'','{}'
FROM repository_bindings b;
INSERT OR IGNORE INTO repository_lines(
  id,project_id,target_id,line_kind,branch,head_sha,status,created_at,updated_at,revision,
  source_revision,source_hash,baseline_sha,managed_relative_path,probe_status,probe_json,
  fault_code,fault_json,locked_by_operation_id,operation_id,last_manifest_hash,interrupted_at
) SELECT
  'lin_'||b.id,b.project_id,'tgt_'||b.id,'managed_checkout','main',b.head_sha,'ready',b.created_at,b.updated_at,1,
  '',b.source_hash,b.head_sha,b.local_path,'available','{}','','{}',NULL,NULL,'',NULL
FROM repository_bindings b;
UPDATE repository_bindings SET
  connection_id='con_'||id,target_id='tgt_'||id,line_id='lin_'||id;
CREATE UNIQUE INDEX idx_repository_lines_project_kind ON repository_lines(project_id,line_kind);
CREATE UNIQUE INDEX idx_repository_connections_project ON repository_connections(project_id);
CREATE UNIQUE INDEX idx_repository_targets_connection ON repository_targets(connection_id);
`;

export const PROJECT_REPOSITORY_INTAKE_V3 = Object.freeze({
  version: 3,
  name: 'project_repository_intake',
  sql: PROJECT_REPOSITORY_INTAKE_V3_SQL,
  disableForeignKeys: true
});
