import { createHash } from 'node:crypto';

export const EVIDENCE_QUALITY_PARSER_OUTCOME_MIGRATION_ID = '007-evidence-quality-parser-outcome';
export const EVIDENCE_QUALITY_PARSER_OUTCOME_MIGRATION_VERSION = 7;
export const EVIDENCE_QUALITY_PARSER_OUTCOME_TOOL_VERSION = 'v3-clean-p7';
export const P7_PARSER_IMAGE_DIGEST = 'sha256:bc69569bc471a27833b7f1174ac1634b5760614c6742237c443641ac5da808e4';
export const P7_PARSER_LIMITS_JSON = '{"deadline_seconds":120,"max_archive_entries":1024,"max_cells":100000,"max_compression_ratio":1000,"max_expanded_bytes":104857600,"max_images":20,"max_input_bytes":26214400,"max_media_seconds":900,"max_pdf_pages":500,"max_recursion_depth":3,"max_slides":500,"max_text_chars":240000}';
export const P7_PARSER_LIMITS_SHA256 = '55384144948a34b8f295d3f2871095b3e0e647ab01b92e8c2c59c6cdb15fa0bc';

// P7 adds domain-owned immutable records around the existing generic
// operation, event, aggregate-head and CAS ledgers. It does not introduce a
// second cursor, event stream or content store.
export const EVIDENCE_QUALITY_PARSER_OUTCOME_SQL = `
CREATE TABLE IF NOT EXISTS parser_formats (
  id TEXT PRIMARY KEY,
  format_key TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL CHECK(family IN ('text','document','spreadsheet','presentation','image','media','archive')),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
  extensions_json TEXT NOT NULL CHECK(json_valid(extensions_json)),
  media_types_json TEXT NOT NULL CHECK(json_valid(media_types_json)),
  signatures_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(signatures_json)),
  worker_version TEXT NOT NULL CHECK(length(worker_version) BETWEEN 1 AND 120),
  worker_image_digest TEXT NOT NULL CHECK(length(worker_image_digest)=71 AND worker_image_digest LIKE 'sha256:%'),
  limits_json TEXT NOT NULL CHECK(json_valid(limits_json)),
  limits_sha256 TEXT NOT NULL CHECK(length(limits_sha256)=64),
  status TEXT NOT NULL DEFAULT 'supported' CHECK(status IN ('supported','disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_parser_formats_family ON parser_formats(family,status,format_key);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  logical_name TEXT NOT NULL CHECK(length(logical_name) BETWEEN 1 AND 512),
  asset_kind TEXT NOT NULL CHECK(asset_kind IN ('execution_output','attachment','file','parser_output','trace','digest','code_change','test_result','quality_report','other')),
  source_type TEXT NOT NULL CHECK(source_type IN ('execution','attachment','file_ref','managed_output','parser','quality','manual')),
  source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 512),
  current_version_id TEXT REFERENCES asset_versions(id) ON DELETE RESTRICT,
  current_version INTEGER NOT NULL DEFAULT 0 CHECK(current_version >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','tombstoned')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tombstoned_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(project_id,source_type,source_ref,logical_name)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id,status,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_assets_execution ON assets(execution_id,id);

CREATE TABLE IF NOT EXISTS asset_blobs (
  id TEXT PRIMARY KEY,
  cas_sha256 TEXT NOT NULL UNIQUE REFERENCES cas_objects(sha256) ON DELETE RESTRICT,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 0 AND 104857600),
  media_type TEXT NOT NULL CHECK(length(media_type) BETWEEN 1 AND 160),
  encryption_kind TEXT NOT NULL DEFAULT 'none' CHECK(encryption_kind IN ('none','vault-envelope')),
  key_ref TEXT NOT NULL DEFAULT '' CHECK(length(key_ref) <= 256),
  manifest_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(manifest_json)),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_asset_blobs_content ON asset_blobs(content_sha256,byte_length);

CREATE TABLE IF NOT EXISTS parser_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  format_id TEXT NOT NULL REFERENCES parser_formats(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  attempt_no INTEGER NOT NULL CHECK(attempt_no BETWEEN 1 AND 3),
  retry_of_parser_run_id TEXT REFERENCES parser_runs(id) ON DELETE RESTRICT,
  broker_job_id TEXT NOT NULL DEFAULT '',
  schema_version TEXT NOT NULL CHECK(schema_version='parser.job.v1'),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  input_cas_sha256 TEXT NOT NULL REFERENCES cas_objects(sha256) ON DELETE RESTRICT,
  format_sha256 TEXT NOT NULL CHECK(length(format_sha256)=64),
  limits_json TEXT NOT NULL CHECK(json_valid(limits_json)),
  limits_sha256 TEXT NOT NULL CHECK(length(limits_sha256)=64),
  checkpoint_token_hash TEXT NOT NULL CHECK(length(checkpoint_token_hash)=64),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','parsed','unsupported','invalid','resource_exceeded','failed','cancelled','external_result_unknown')),
  output_manifest_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(output_manifest_json)),
  output_manifest_sha256 TEXT NOT NULL DEFAULT '' CHECK(output_manifest_sha256='' OR length(output_manifest_sha256)=64),
  output_asset_version_id TEXT REFERENCES asset_versions(id) ON DELETE RESTRICT,
  receipt_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(receipt_json)),
  receipt_sha256 TEXT NOT NULL DEFAULT '' CHECK(receipt_sha256='' OR length(receipt_sha256)=64),
  signer_public_key TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '' CHECK(length(error_code) <= 120),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(source_asset_version_id,attempt_no)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_parser_runs_project ON parser_runs(project_id,status,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_parser_runs_retry ON parser_runs(retry_of_parser_run_id,attempt_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_parser_runs_broker_job ON parser_runs(broker_job_id) WHERE broker_job_id<>'';

CREATE TABLE IF NOT EXISTS asset_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK(version_no > 0),
  blob_id TEXT NOT NULL REFERENCES asset_blobs(id) ON DELETE RESTRICT,
  parser_run_id TEXT REFERENCES parser_runs(id) ON DELETE RESTRICT,
  source_operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  source_revision INTEGER NOT NULL DEFAULT 0 CHECK(source_revision >= 0),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(asset_id,version_no),
  UNIQUE(parser_run_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_asset_versions_asset ON asset_versions(asset_id,version_no DESC);
CREATE INDEX IF NOT EXISTS idx_asset_versions_content ON asset_versions(content_sha256,id);

CREATE TABLE IF NOT EXISTS asset_relations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  from_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  from_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  to_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  to_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL CHECK(relation_type IN ('derived_from','generated_by','contains','references','attests','supersedes','tests','changes')),
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  task_attempt_id TEXT REFERENCES task_attempts(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  policy_revision INTEGER NOT NULL CHECK(policy_revision > 0),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  output_sha256 TEXT NOT NULL CHECK(length(output_sha256)=64),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256)=64),
  created_at TEXT NOT NULL,
  UNIQUE(from_version_id,to_version_id,relation_type,operation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_asset_relations_from ON asset_relations(from_asset_id,from_version_id,created_at,id);
CREATE INDEX IF NOT EXISTS idx_asset_relations_to ON asset_relations(to_asset_id,to_version_id,created_at,id);

CREATE TABLE IF NOT EXISTS asset_attestations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  verifier_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  policy_revision INTEGER NOT NULL CHECK(policy_revision > 0),
  attestation_type TEXT NOT NULL CHECK(length(attestation_type) BETWEEN 1 AND 120),
  subject_sha256 TEXT NOT NULL CHECK(length(subject_sha256)=64),
  statement_json TEXT NOT NULL CHECK(json_valid(statement_json)),
  statement_sha256 TEXT NOT NULL CHECK(length(statement_sha256)=64),
  signature TEXT NOT NULL DEFAULT '',
  validity TEXT NOT NULL CHECK(validity IN ('valid','invalid','revoked','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_asset_attestations_version ON asset_attestations(asset_version_id,created_at DESC,id);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  asset_version_id TEXT REFERENCES asset_versions(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  trace_type TEXT NOT NULL CHECK(length(trace_type) BETWEEN 1 AND 120),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
  redactions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(redactions_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_traces_execution ON traces(execution_id,created_at,id);

CREATE TABLE IF NOT EXISTS digests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  asset_version_id TEXT REFERENCES asset_versions(id) ON DELETE RESTRICT,
  digest_type TEXT NOT NULL CHECK(digest_type IN ('content','manifest','execution','quality','outcome')),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256)=64),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(summary_json)),
  summary_sha256 TEXT NOT NULL CHECK(length(summary_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(digest_type,input_sha256,digest_sha256)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_digests_execution ON digests(execution_id,digest_type,created_at,id);

CREATE TABLE IF NOT EXISTS code_changes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  task_attempt_id TEXT REFERENCES task_attempts(id) ON DELETE RESTRICT,
  relative_path TEXT NOT NULL CHECK(length(relative_path) BETWEEN 1 AND 1024),
  change_type TEXT NOT NULL CHECK(change_type IN ('create','modify','delete','rename','binary')),
  before_sha256 TEXT NOT NULL DEFAULT '' CHECK(before_sha256='' OR length(before_sha256)=64),
  after_sha256 TEXT NOT NULL DEFAULT '' CHECK(after_sha256='' OR length(after_sha256)=64),
  patch_sha256 TEXT NOT NULL CHECK(length(patch_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_code_changes_execution ON code_changes(execution_id,relative_path,id);

CREATE TABLE IF NOT EXISTS test_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  task_attempt_id TEXT REFERENCES task_attempts(id) ON DELETE RESTRICT,
  asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  asset_version_id TEXT REFERENCES asset_versions(id) ON DELETE RESTRICT,
  check_id TEXT NOT NULL CHECK(length(check_id) BETWEEN 1 AND 160),
  status TEXT NOT NULL CHECK(status IN ('passed','failed','skipped','error')),
  command_sha256 TEXT NOT NULL CHECK(length(command_sha256)=64),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  output_sha256 TEXT NOT NULL CHECK(length(output_sha256)=64),
  duration_ms REAL NOT NULL CHECK(duration_ms >= 0),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
  details_sha256 TEXT NOT NULL CHECK(length(details_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(execution_id,check_id,input_sha256)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_test_results_execution ON test_results(execution_id,status,check_id,id);

CREATE TABLE IF NOT EXISTS quality_review_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  retry_of_quality_review_id TEXT REFERENCES quality_review_runs(id) ON DELETE RESTRICT,
  attempt_no INTEGER NOT NULL CHECK(attempt_no BETWEEN 1 AND 3),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','preparing','checking','reviewing','awaiting_human','completed','failed','cancelled','stale')),
  asset_ids_json TEXT NOT NULL CHECK(json_valid(asset_ids_json)),
  asset_count INTEGER NOT NULL CHECK(asset_count BETWEEN 1 AND 16),
  input_snapshot_json TEXT NOT NULL CHECK(json_valid(input_snapshot_json)),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  rubric_json TEXT NOT NULL CHECK(json_valid(rubric_json)),
  rubric_sha256 TEXT NOT NULL CHECK(length(rubric_sha256)=64),
  threshold REAL NOT NULL DEFAULT 80 CHECK(threshold BETWEEN 0 AND 100),
  report_id TEXT REFERENCES quality_review_reports(id) ON DELETE RESTRICT,
  human_review_id TEXT REFERENCES human_reviews(id) ON DELETE RESTRICT,
  error_code TEXT NOT NULL DEFAULT '' CHECK(length(error_code) <= 120),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_quality_runs_execution ON quality_review_runs(execution_id,created_at DESC,id);

CREATE TABLE IF NOT EXISTS quality_review_reports (
  id TEXT PRIMARY KEY,
  quality_review_id TEXT NOT NULL UNIQUE REFERENCES quality_review_runs(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL CHECK(schema_version='quality.report.v1'),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  rubric_sha256 TEXT NOT NULL CHECK(length(rubric_sha256)=64),
  deterministic_checks_json TEXT NOT NULL CHECK(json_valid(deterministic_checks_json)),
  suggestions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(suggestions_json)),
  anchors_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(anchors_json)),
  anchor_count INTEGER NOT NULL DEFAULT 0 CHECK(anchor_count BETWEEN 0 AND 500),
  report_sha256 TEXT NOT NULL UNIQUE CHECK(length(report_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS quality_review_events (
  id TEXT PRIMARY KEY,
  quality_review_id TEXT NOT NULL REFERENCES quality_review_runs(id) ON DELETE RESTRICT,
  generic_event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
  generic_sequence INTEGER NOT NULL UNIQUE CHECK(generic_sequence > 0),
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_quality_events_review ON quality_review_events(quality_review_id,generic_sequence);

CREATE TABLE IF NOT EXISTS human_reviews (
  id TEXT PRIMARY KEY,
  quality_review_id TEXT NOT NULL UNIQUE REFERENCES quality_review_runs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  reviewer_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
  dimensions_json TEXT NOT NULL CHECK(json_valid(dimensions_json)),
  dimension_count INTEGER NOT NULL CHECK(dimension_count BETWEEN 1 AND 20),
  weighted_score REAL NOT NULL CHECK(weighted_score BETWEEN 0 AND 100),
  reasoning TEXT NOT NULL CHECK(length(reasoning) BETWEEN 1 AND 4000),
  report_sha256 TEXT NOT NULL CHECK(length(report_sha256)=64),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  rubric_sha256 TEXT NOT NULL CHECK(length(rubric_sha256)=64),
  decision_sha256 TEXT NOT NULL UNIQUE CHECK(length(decision_sha256)=64),
  session_proof_hash TEXT NOT NULL CHECK(length(session_proof_hash)=64),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_human_reviews_execution ON human_reviews(execution_id,created_at DESC,id);

CREATE TABLE IF NOT EXISTS outcome_evaluations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK(generation > 0),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('passed','completed_with_gaps','waived','blocked')),
  requirement_count INTEGER NOT NULL CHECK(requirement_count BETWEEN 0 AND 100),
  passed_count INTEGER NOT NULL CHECK(passed_count BETWEEN 0 AND requirement_count),
  score REAL NOT NULL CHECK(score BETWEEN 0 AND 100),
  requirements_sha256 TEXT NOT NULL CHECK(length(requirements_sha256)=64),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  rubric_sha256 TEXT NOT NULL CHECK(length(rubric_sha256)=64),
  execution_input_sha256 TEXT NOT NULL CHECK(length(execution_input_sha256)=64),
  human_decision_sha256 TEXT NOT NULL DEFAULT '' CHECK(human_decision_sha256='' OR length(human_decision_sha256)=64),
  waiver_sha256 TEXT NOT NULL DEFAULT '' CHECK(waiver_sha256='' OR length(waiver_sha256)=64),
  evaluation_json TEXT NOT NULL CHECK(json_valid(evaluation_json)),
  evaluation_sha256 TEXT NOT NULL UNIQUE CHECK(length(evaluation_sha256)=64),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE(execution_id,generation)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_outcome_evaluations_execution ON outcome_evaluations(execution_id,generation DESC);

CREATE TABLE IF NOT EXISTS outcome_waivers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  requirement_id TEXT REFERENCES outcome_requirements(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
  revokes_waiver_id TEXT REFERENCES outcome_waivers(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  waiver_sha256 TEXT NOT NULL UNIQUE CHECK(length(waiver_sha256)=64),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  CHECK((action='grant' AND revokes_waiver_id IS NULL) OR (action='revoke' AND revokes_waiver_id IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_outcome_waivers_execution ON outcome_waivers(execution_id,created_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_waiver_single_revoke ON outcome_waivers(revokes_waiver_id) WHERE revokes_waiver_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS immutable_terminal_parser_run_update
  BEFORE UPDATE ON parser_runs
  WHEN OLD.status IN ('parsed','unsupported','invalid','resource_exceeded','failed','cancelled','external_result_unknown')
  BEGIN SELECT RAISE(ABORT, 'immutable_terminal_parser_run'); END;
CREATE TRIGGER IF NOT EXISTS immutable_parser_run_delete
  BEFORE DELETE ON parser_runs BEGIN SELECT RAISE(ABORT, 'immutable_parser_run'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_delete
  BEFORE DELETE ON assets BEGIN SELECT RAISE(ABORT, 'immutable_asset_identity'); END;
CREATE TRIGGER IF NOT EXISTS immutable_terminal_quality_run_update
  BEFORE UPDATE ON quality_review_runs
  WHEN OLD.status IN ('completed','failed','cancelled','stale')
  BEGIN SELECT RAISE(ABORT, 'immutable_terminal_quality_run'); END;
CREATE TRIGGER IF NOT EXISTS immutable_quality_run_delete
  BEFORE DELETE ON quality_review_runs BEGIN SELECT RAISE(ABORT, 'immutable_quality_run'); END;

CREATE TRIGGER IF NOT EXISTS immutable_asset_blob_update BEFORE UPDATE ON asset_blobs BEGIN SELECT RAISE(ABORT, 'immutable_asset_blob'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_blob_delete BEFORE DELETE ON asset_blobs BEGIN SELECT RAISE(ABORT, 'immutable_asset_blob'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_version_update BEFORE UPDATE ON asset_versions BEGIN SELECT RAISE(ABORT, 'immutable_asset_version'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_version_delete BEFORE DELETE ON asset_versions BEGIN SELECT RAISE(ABORT, 'immutable_asset_version'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_relation_update BEFORE UPDATE ON asset_relations BEGIN SELECT RAISE(ABORT, 'immutable_asset_relation'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_relation_delete BEFORE DELETE ON asset_relations BEGIN SELECT RAISE(ABORT, 'immutable_asset_relation'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_attestation_update BEFORE UPDATE ON asset_attestations BEGIN SELECT RAISE(ABORT, 'immutable_asset_attestation'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_attestation_delete BEFORE DELETE ON asset_attestations BEGIN SELECT RAISE(ABORT, 'immutable_asset_attestation'); END;
CREATE TRIGGER IF NOT EXISTS immutable_trace_update BEFORE UPDATE ON traces BEGIN SELECT RAISE(ABORT, 'immutable_trace'); END;
CREATE TRIGGER IF NOT EXISTS immutable_trace_delete BEFORE DELETE ON traces BEGIN SELECT RAISE(ABORT, 'immutable_trace'); END;
CREATE TRIGGER IF NOT EXISTS immutable_digest_update BEFORE UPDATE ON digests BEGIN SELECT RAISE(ABORT, 'immutable_digest'); END;
CREATE TRIGGER IF NOT EXISTS immutable_digest_delete BEFORE DELETE ON digests BEGIN SELECT RAISE(ABORT, 'immutable_digest'); END;
CREATE TRIGGER IF NOT EXISTS immutable_code_change_update BEFORE UPDATE ON code_changes BEGIN SELECT RAISE(ABORT, 'immutable_code_change'); END;
CREATE TRIGGER IF NOT EXISTS immutable_code_change_delete BEFORE DELETE ON code_changes BEGIN SELECT RAISE(ABORT, 'immutable_code_change'); END;
CREATE TRIGGER IF NOT EXISTS immutable_test_result_update BEFORE UPDATE ON test_results BEGIN SELECT RAISE(ABORT, 'immutable_test_result'); END;
CREATE TRIGGER IF NOT EXISTS immutable_test_result_delete BEFORE DELETE ON test_results BEGIN SELECT RAISE(ABORT, 'immutable_test_result'); END;
CREATE TRIGGER IF NOT EXISTS immutable_quality_report_update BEFORE UPDATE ON quality_review_reports BEGIN SELECT RAISE(ABORT, 'immutable_quality_report'); END;
CREATE TRIGGER IF NOT EXISTS immutable_quality_report_delete BEFORE DELETE ON quality_review_reports BEGIN SELECT RAISE(ABORT, 'immutable_quality_report'); END;
CREATE TRIGGER IF NOT EXISTS immutable_quality_event_update BEFORE UPDATE ON quality_review_events BEGIN SELECT RAISE(ABORT, 'immutable_quality_event'); END;
CREATE TRIGGER IF NOT EXISTS immutable_quality_event_delete BEFORE DELETE ON quality_review_events BEGIN SELECT RAISE(ABORT, 'immutable_quality_event'); END;
CREATE TRIGGER IF NOT EXISTS immutable_human_review_update BEFORE UPDATE ON human_reviews BEGIN SELECT RAISE(ABORT, 'immutable_human_review'); END;
CREATE TRIGGER IF NOT EXISTS immutable_human_review_delete BEFORE DELETE ON human_reviews BEGIN SELECT RAISE(ABORT, 'immutable_human_review'); END;
CREATE TRIGGER IF NOT EXISTS immutable_outcome_evaluation_update BEFORE UPDATE ON outcome_evaluations BEGIN SELECT RAISE(ABORT, 'immutable_outcome_evaluation'); END;
CREATE TRIGGER IF NOT EXISTS immutable_outcome_evaluation_delete BEFORE DELETE ON outcome_evaluations BEGIN SELECT RAISE(ABORT, 'immutable_outcome_evaluation'); END;
CREATE TRIGGER IF NOT EXISTS immutable_outcome_waiver_update BEFORE UPDATE ON outcome_waivers BEGIN SELECT RAISE(ABORT, 'immutable_outcome_waiver'); END;
CREATE TRIGGER IF NOT EXISTS immutable_outcome_waiver_delete BEFORE DELETE ON outcome_waivers BEGIN SELECT RAISE(ABORT, 'immutable_outcome_waiver'); END;

INSERT INTO parser_formats(id,format_key,family,label,extensions_json,media_types_json,signatures_json,worker_version,worker_image_digest,limits_json,limits_sha256,status,revision,created_at,updated_at) VALUES
('parser_format_text','text','text','Plain text','["txt","log"]','["text/plain"]','[]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_markdown','markdown','text','Markdown','["md","markdown"]','["text/markdown"]','[]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_json','json','text','JSON','["json"]','["application/json"]','[]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_csv','csv','spreadsheet','CSV','["csv"]','["text/csv"]','[]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_xml','xml','text','XML','["xml"]','["application/xml","text/xml"]','[]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_svg','svg','image','SVG','["svg"]','["image/svg+xml"]','[]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_pdf','pdf','document','PDF','["pdf"]','["application/pdf"]','["25504446"]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_docx','docx','document','DOCX','["docx"]','["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]','["504b0304"]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_xlsx','xlsx','spreadsheet','XLSX','["xlsx"]','["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]','["504b0304"]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_pptx','pptx','presentation','PPTX','["pptx"]','["application/vnd.openxmlformats-officedocument.presentationml.presentation"]','["504b0304"]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_png','png','image','PNG','["png"]','["image/png"]','["89504e470d0a1a0a"]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_jpeg','jpeg','image','JPEG','["jpg","jpeg"]','["image/jpeg"]','["ffd8ff"]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_webp','webp','image','WebP','["webp"]','["image/webp"]','["52494646"]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_gif','gif','image','GIF','["gif"]','["image/gif"]','["47494638"]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_audio','audio','media','Audio','["mp3","wav","m4a","ogg","flac"]','["audio/mpeg","audio/wav","audio/mp4","audio/ogg","audio/flac"]','[]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_video','video','media','Video','["mp4","webm","mov","mkv"]','["video/mp4","video/webm","video/quicktime","video/x-matroska"]','[]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_zip','zip','archive','ZIP','["zip"]','["application/zip"]','["504b0304"]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_tar','tar','archive','TAR','["tar"]','["application/x-tar"]','[]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_gzip','gzip','archive','GZIP','["gz","tgz"]','["application/gzip"]','["1f8b08"]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_7z','7z','archive','7-Zip','["7z"]','["application/x-7z-compressed"]','["377abcaf271c"]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z'),
('parser_format_rar','rar','archive','RAR','["rar"]','["application/vnd.rar","application/x-rar-compressed"]','["526172211a07"]','node24-p7','${P7_PARSER_IMAGE_DIGEST}','${P7_PARSER_LIMITS_JSON}','${P7_PARSER_LIMITS_SHA256}','supported',1,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z');
`;

export const EVIDENCE_QUALITY_PARSER_OUTCOME_MIGRATION_CHECKSUM = createHash('sha256')
  .update(`${EVIDENCE_QUALITY_PARSER_OUTCOME_MIGRATION_VERSION}\n${EVIDENCE_QUALITY_PARSER_OUTCOME_MIGRATION_ID}\n${EVIDENCE_QUALITY_PARSER_OUTCOME_SQL}`)
  .digest('hex');

export const EVIDENCE_QUALITY_PARSER_OUTCOME_MIGRATION = Object.freeze({
  version: EVIDENCE_QUALITY_PARSER_OUTCOME_MIGRATION_VERSION,
  id: EVIDENCE_QUALITY_PARSER_OUTCOME_MIGRATION_ID,
  name: EVIDENCE_QUALITY_PARSER_OUTCOME_MIGRATION_ID,
  family: 'v3-clean',
  sql: EVIDENCE_QUALITY_PARSER_OUTCOME_SQL,
  checksum: EVIDENCE_QUALITY_PARSER_OUTCOME_MIGRATION_CHECKSUM,
  toolVersion: EVIDENCE_QUALITY_PARSER_OUTCOME_TOOL_VERSION
});
