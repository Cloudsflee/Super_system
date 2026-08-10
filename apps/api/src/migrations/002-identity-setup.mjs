export const IDENTITY_SETUP_V2_SQL = `
ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh-CN';
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai';

ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE sessions SET created_at=last_seen_at,updated_at=last_seen_at WHERE created_at='';

ALTER TABLE connected_accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK(status IN ('active','revoked','unavailable'));
ALTER TABLE connected_accounts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);

ALTER TABLE credential_refs ADD COLUMN kind TEXT NOT NULL DEFAULT 'codex_api_key'
  CHECK(kind IN ('codex_api_key','codex_oauth_bundle','github_app_private_key','github_webhook_secret'));
ALTER TABLE credential_refs ADD COLUMN origin TEXT NOT NULL DEFAULT 'vault'
  CHECK(origin IN ('vault','secret_bundle','device_auth','discovery'));
ALTER TABLE credential_refs ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK(status IN ('pending','active','expired','revoked'));
ALTER TABLE credential_refs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE credential_refs ADD COLUMN secret_version INTEGER NOT NULL DEFAULT 1 CHECK(secret_version > 0);
ALTER TABLE credential_refs ADD COLUMN rotated_at TEXT;
ALTER TABLE credential_refs ADD COLUMN revoked_at TEXT;
ALTER TABLE credential_refs ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE credential_refs SET
  kind=CASE WHEN provider='codex' THEN 'codex_api_key' ELSE 'github_webhook_secret' END,
  origin=CASE WHEN secret_ref LIKE 'vault:%' THEN 'vault' ELSE 'secret_bundle' END,
  status=CASE WHEN expires_at IS NULL THEN 'active' ELSE 'revoked' END,
  revoked_at=expires_at,
  updated_at=created_at;
UPDATE credential_refs SET expires_at=NULL WHERE status='revoked';

ALTER TABLE setup_states ADD COLUMN completed_at TEXT;
ALTER TABLE setup_states ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
UPDATE setup_states SET created_at=updated_at WHERE created_at='';

ALTER TABLE codex_profiles ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1));
ALTER TABLE codex_profiles ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'api_key'
  CHECK(auth_kind IN ('api_key','oauth_bundle'));
ALTER TABLE codex_profiles ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 1 CHECK(credential_revision > 0);
ALTER TABLE codex_profiles ADD COLUMN config_hash TEXT NOT NULL DEFAULT '' CHECK(config_hash='' OR length(config_hash)=64);
ALTER TABLE codex_profiles ADD COLUMN runner_digest TEXT NOT NULL DEFAULT '';
ALTER TABLE codex_profiles ADD COLUMN probe_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK(probe_status IN ('unknown','running','available','unavailable'));
ALTER TABLE codex_profiles ADD COLUMN probe_hash TEXT NOT NULL DEFAULT '' CHECK(probe_hash='' OR length(probe_hash)=64);
ALTER TABLE codex_profiles ADD COLUMN probe_revision INTEGER NOT NULL DEFAULT 0 CHECK(probe_revision >= 0);
ALTER TABLE codex_profiles ADD COLUMN probed_at TEXT;
ALTER TABLE codex_profiles ADD COLUMN probe_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(probe_json));

ALTER TABLE github_app_configs ADD COLUMN status TEXT NOT NULL DEFAULT 'unverified'
  CHECK(status IN ('unverified','verified','blocked','revoked'));
ALTER TABLE github_app_configs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE github_app_configs ADD COLUMN slug TEXT NOT NULL DEFAULT '';
ALTER TABLE github_app_configs ADD COLUMN verified_at TEXT;
ALTER TABLE github_app_configs ADD COLUMN probe_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK(probe_status IN ('unknown','running','available','unavailable'));
ALTER TABLE github_app_configs ADD COLUMN probe_hash TEXT NOT NULL DEFAULT '' CHECK(probe_hash='' OR length(probe_hash)=64);
ALTER TABLE github_app_configs ADD COLUMN probe_revision INTEGER NOT NULL DEFAULT 0 CHECK(probe_revision >= 0);
ALTER TABLE github_app_configs ADD COLUMN probed_at TEXT;
ALTER TABLE github_app_configs ADD COLUMN probe_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(probe_json));

ALTER TABLE github_installations RENAME TO github_installations_v1;
CREATE TABLE github_installations (
  id TEXT PRIMARY KEY,
  app_config_id TEXT NOT NULL REFERENCES github_app_configs(id) ON DELETE RESTRICT,
  installation_id TEXT NOT NULL,
  account_login TEXT NOT NULL DEFAULT '',
  permissions_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(permissions_json)),
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','blocked','revoked','unavailable')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  repositories_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(repositories_json)),
  last_probe_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK(last_probe_status IN ('unknown','available','unavailable')),
  last_probe_at TEXT,
  last_probe_code TEXT NOT NULL DEFAULT '',
  UNIQUE(app_config_id, installation_id)
) STRICT;
INSERT INTO github_installations(
  id,app_config_id,installation_id,account_login,permissions_json,status,created_at,updated_at,
  revision,repositories_json,last_probe_status,last_probe_at,last_probe_code
) SELECT id,app_config_id,installation_id,account_login,permissions_json,status,created_at,updated_at,
  1,'[]','unknown',NULL,'' FROM github_installations_v1;
DROP TABLE github_installations_v1;

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','completed','failed','cancelled')),
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id TEXT NOT NULL DEFAULT '',
  external_ref TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json)),
  error_code TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
) STRICT;

CREATE TABLE operation_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE setup_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  setup_id TEXT NOT NULL REFERENCES setup_states(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE codex_discovery_sources (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK(source_type IN ('codex_home','cc_switch')),
  display_name TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  source_revision TEXT NOT NULL CHECK(length(source_revision)=64),
  status TEXT NOT NULL CHECK(status IN ('available','invalid','unavailable')),
  records_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(records_json)),
  scanned_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
) STRICT;

CREATE TABLE github_repositories (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES github_installations(id) ON DELETE RESTRICT,
  github_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT '',
  private INTEGER NOT NULL DEFAULT 0 CHECK(private IN (0,1)),
  selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0,1)),
  permissions_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(permissions_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(installation_id,github_id)
) STRICT;

CREATE TABLE github_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('accepted','ignored','failed')),
  receipt_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(receipt_json)),
  body_sha256 TEXT NOT NULL CHECK(length(body_sha256)=64),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_sessions_user_status ON sessions(user_id,expires_at,revoked_at);
CREATE INDEX idx_credentials_status ON credential_refs(status,provider,kind);
CREATE UNIQUE INDEX idx_codex_active_profile ON codex_profiles(user_id) WHERE is_active=1;
CREATE INDEX idx_operations_status ON operations(status,updated_at);
CREATE INDEX idx_operation_events_operation ON operation_events(operation_id,cursor);
CREATE INDEX idx_setup_events_setup ON setup_events(setup_id,cursor);
CREATE INDEX idx_github_repositories_installation ON github_repositories(installation_id,full_name);
`;
