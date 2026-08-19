import { createHash } from 'node:crypto';

export const IDENTITY_MIGRATION_ID = '002-identity-acl';
export const IDENTITY_MIGRATION_VERSION = 2;
export const IDENTITY_TOOL_VERSION = 'v3-clean-p2';

// Identity owns these records.  Projects are deliberately referenced by an
// opaque id until the Project domain creates its clean table in P3.
export const IDENTITY_ACL_SQL = `
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','archived')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256) = 64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  deleted_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS team_memberships (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','observer')),
  status TEXT NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','active','suspended','revoked','expired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  invited_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  accepted_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  deleted_at TEXT,
  UNIQUE(team_id, actor_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_team_memberships_actor ON team_memberships(actor_id, status);
CREATE INDEX IF NOT EXISTS idx_team_memberships_team ON team_memberships(team_id, status);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  subject_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  effective_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  proof_hash TEXT NOT NULL UNIQUE CHECK(length(proof_hash) = 64),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  deleted_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions(subject_actor_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS project_memberships (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','runner','reviewer','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','revoked','expired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  deleted_at TEXT,
  UNIQUE(project_id, actor_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_project_memberships_project ON project_memberships(project_id, status);
CREATE INDEX IF NOT EXISTS idx_project_memberships_actor ON project_memberships(actor_id, status);

CREATE TABLE IF NOT EXISTS project_invitations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  invitee_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  invitee_ref TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','runner','reviewer','viewer')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked','expired')),
  expires_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  accepted_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  deleted_at TEXT,
  CHECK(invitee_actor_id IS NOT NULL OR length(invitee_ref) > 0)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_project_invitations_project ON project_invitations(project_id, status);

CREATE TABLE IF NOT EXISTS project_acl_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  principal_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  principal_team_id TEXT REFERENCES teams(id) ON DELETE RESTRICT,
  resource TEXT NOT NULL DEFAULT '*',
  action TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK(policy_revision > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  deleted_at TEXT,
  CHECK((principal_actor_id IS NOT NULL) <> (principal_team_id IS NOT NULL)),
  CHECK(length(action) BETWEEN 1 AND 120)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_project_acl_lookup ON project_acl_entries(project_id, action, resource, effect);

CREATE TABLE IF NOT EXISTS credential_refs (
  id TEXT PRIMARY KEY,
  owner_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK(provider IN ('codex','github','mcp')),
  scope_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(scope_json)),
  status TEXT NOT NULL DEFAULT 'rebind_required' CHECK(status IN ('rebind_required','pending','active','failed','revoked')),
  external_ref TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256) = 64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  deleted_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_credential_refs_owner ON credential_refs(owner_actor_id, status);

CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY,
  owner_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK(provider IN ('codex','github','mcp')),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
  credential_ref_id TEXT REFERENCES credential_refs(id) ON DELETE RESTRICT,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config_json)),
  config_sha256 TEXT NOT NULL CHECK(length(config_sha256) = 64),
  status TEXT NOT NULL DEFAULT 'unprobed' CHECK(status IN ('unprobed','probing','available','unavailable','rebind_required')),
  last_probe_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  deleted_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_provider_profiles_owner ON provider_profiles(owner_actor_id, provider, status);

-- Exchange owns writes to this table in a later phase.  P2 only consumes it
-- as a narrowing input for the shared authorization predicate.
CREATE TABLE IF NOT EXISTS exchange_grants (
  id TEXT PRIMARY KEY,
  source_project_id TEXT NOT NULL,
  target_project_id TEXT NOT NULL,
  grantee_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  scope_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(scope_json)),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active','revoked','expired')),
  expires_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  deleted_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_exchange_grants_target ON exchange_grants(target_project_id, grantee_actor_id, status);
`;

export const IDENTITY_ACL_CHECKSUM = createHash('sha256')
  .update(`${IDENTITY_MIGRATION_VERSION}\n${IDENTITY_MIGRATION_ID}\n${IDENTITY_ACL_SQL}`)
  .digest('hex');

export const IDENTITY_MIGRATION = Object.freeze({
  version: IDENTITY_MIGRATION_VERSION,
  id: IDENTITY_MIGRATION_ID,
  name: IDENTITY_MIGRATION_ID,
  family: 'v3-clean',
  sql: IDENTITY_ACL_SQL,
  checksum: IDENTITY_ACL_CHECKSUM,
  toolVersion: IDENTITY_TOOL_VERSION
});
