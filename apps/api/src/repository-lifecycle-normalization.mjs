import fs from 'node:fs';
import path from 'node:path';
import { id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { managedProjectRoot, managedRepoPath } from './managed-workspace.mjs';
import { hashSnapshot } from './project-governance-v19.mjs';
import { cloneStateValue as structuredClone } from './state-clone.mjs';

const LIFECYCLE_COLLECTIONS = [
  'github_repositories',
  'canonical_repositories',
  'project_repository_bindings',
  'repository_deletion_intents'
];

export function ensureRepositoryLifecycleDefaults(state, { timestamp = now() } = {}) {
  for (const collection of LIFECYCLE_COLLECTIONS) if (!Array.isArray(state[collection])) state[collection] = [];
  for (const legacy of state.repository_bindings || []) normalizeLegacyRepositoryBinding(state, legacy, timestamp);
  return state;
}

export function upsertCanonicalRepositoryInState(state, repository, metadata = {}) {
  ensureRepositoryLifecycleDefaultsShallow(state);
  const identity = canonicalRepositoryIdentity(repository, metadata);
  const timestamp = metadata.timestamp || now();
  const remoteSnapshot = repositoryRemoteSnapshot(repository);
  let record = state.canonical_repositories.find(
    (item) => item.provider === identity.provider && String(item.repository_id) === identity.repositoryId
  );
  if (record) updateCanonicalRepository(record, repository, metadata, remoteSnapshot, timestamp);
  else {
    record = createCanonicalRepository(repository, metadata, identity, remoteSnapshot, timestamp);
    state.canonical_repositories.push(record);
  }
  synchronizeGithubRepositoryMirror(state, record, timestamp);
  return record;
}

export function repositoryRemoteSnapshot(repository) {
  return {
    repository_id: String(repository.repository_id || repository.id),
    full_name: String(repository.full_name),
    default_branch: repository.default_branch || 'main',
    private: repository.private !== false,
    visibility: repository.visibility || (repository.private === false ? 'public' : 'private'),
    pushed_at: repository.pushed_at || null,
    archived: Boolean(repository.archived),
    disabled: Boolean(repository.disabled)
  };
}

export function isolatedCheckoutIdentity(value) {
  if (!fs.existsSync(value)) return value;
  const real = fs.realpathSync(value);
  const root = fs.realpathSync(path.dirname(path.dirname(value)));
  const relative = path.relative(root, real);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new HttpError(409, { error: 'repository_checkout_symlink_escape' });
  return real;
}

export function normalizeRepositoryPath(value) {
  const resolved = String(value || '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeLegacyRepositoryBinding(state, legacy, timestamp) {
  if (!legacy.repository_id || !legacy.full_name) {
    legacy.lifecycle_unresolved = true;
    return;
  }
  const existingCanonical = state.canonical_repositories.find(
    (item) => (item.provider || 'github') === 'github' && String(item.repository_id) === String(legacy.repository_id)
  );
  const canonical = upsertCanonicalRepositoryInState(state, legacyRepository(legacy), {
    installation_id: legacy.installation_id,
    creator_user_id: legacyRepositoryCreator(state, legacy),
    external_import: true,
    timestamp: existingCanonical?.updated_at || legacy.updated_at || legacy.created_at || timestamp
  });
  if (hasProjectRepositoryBinding(state, legacy, canonical)) return;
  const project = state.projects.find((item) => item.id === legacy.project_id);
  if (project) state.project_repository_bindings.push(projectRepositoryBinding(project, legacy, canonical, timestamp));
}

function legacyRepository(legacy) {
  return {
    id: legacy.repository_id,
    repository_id: legacy.repository_id,
    full_name: legacy.full_name,
    default_branch: legacy.default_branch || 'main',
    private: legacy.private !== false
  };
}

function legacyRepositoryCreator(state, legacy) {
  return (
    legacy.created_by_user_id || state.projects.find((item) => item.id === legacy.project_id)?.owner_user_id || null
  );
}

function hasProjectRepositoryBinding(state, legacy, canonical) {
  return state.project_repository_bindings.some(
    (item) => item.project_id === legacy.project_id && item.canonical_repository_id === canonical.id
  );
}

function projectRepositoryBinding(project, legacy, canonical, timestamp) {
  return {
    id: id('prb'),
    project_id: project.id,
    canonical_repository_id: canonical.id,
    installation_id: legacy.installation_id || null,
    local_checkout_path: project.repo_path || managedRepoPath(project.id),
    managed_worktree_root: path.join(managedProjectRoot(project.id), 'worktrees'),
    status: legacy.status || 'ready',
    permissions: structuredClone(legacy.permissions || {}),
    created_by_user_id: legacy.created_by_user_id || project.owner_user_id,
    created_at: legacy.created_at || timestamp,
    updated_at: legacy.updated_at || timestamp
  };
}

function canonicalRepositoryIdentity(repository, metadata) {
  const provider = metadata.provider || 'github';
  const repositoryId = String(repository.repository_id || repository.id || '');
  if (!repositoryId || !String(repository.full_name || '').includes('/'))
    throw new HttpError(400, { error: 'canonical_repository_identity_invalid' });
  return { provider, repositoryId };
}

function createCanonicalRepository(repository, metadata, identity, remoteSnapshot, timestamp) {
  return {
    id: id('crep'),
    provider: identity.provider,
    repository_id: identity.repositoryId,
    full_name: String(repository.full_name),
    name: repository.name || String(repository.full_name).split('/').at(-1),
    installation_id: metadata.installation_id ? String(metadata.installation_id) : null,
    default_branch: repository.default_branch || 'main',
    private: repository.private !== false,
    visibility: repository.visibility || (repository.private === false ? 'public' : 'private'),
    creator_user_id: metadata.creator_user_id || null,
    creator_github_identity: metadata.creator_github_identity || null,
    origin: metadata.external_import ? 'external_import' : 'aiws_created',
    external_import: metadata.external_import === true,
    administration_permission: metadata.administration_permission || 'write',
    remote_state: metadata.remote_state || 'active',
    remote_snapshot: remoteSnapshot,
    remote_snapshot_hash: hashSnapshot(remoteSnapshot),
    deleted_at: null,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function updateCanonicalRepository(record, repository, metadata, remoteSnapshot, timestamp) {
  Object.assign(record, {
    full_name: String(repository.full_name || record.full_name),
    name: repository.name || record.name,
    installation_id: metadata.installation_id ? String(metadata.installation_id) : record.installation_id,
    default_branch: repository.default_branch || record.default_branch,
    private: repository.private !== undefined ? repository.private !== false : record.private,
    visibility: repository.visibility || record.visibility,
    remote_state: metadata.remote_state || record.remote_state,
    remote_snapshot: remoteSnapshot,
    remote_snapshot_hash: hashSnapshot(remoteSnapshot),
    updated_at: timestamp
  });
  fillCanonicalRepositoryProvenance(record, metadata);
}

function fillCanonicalRepositoryProvenance(record, metadata) {
  if (!record.creator_user_id && metadata.creator_user_id) record.creator_user_id = metadata.creator_user_id;
  if (!record.creator_github_identity && metadata.creator_github_identity)
    record.creator_github_identity = metadata.creator_github_identity;
  if (record.origin) return;
  Object.assign(record, {
    origin: metadata.external_import ? 'external_import' : 'aiws_created',
    external_import: metadata.external_import === true
  });
}

function synchronizeGithubRepositoryMirror(state, record, timestamp) {
  const existing = state.github_repositories.find(
    (item) =>
      item.canonical_repository_id === record.id ||
      (item.provider === record.provider && String(item.repository_id) === String(record.repository_id))
  );
  const mirror = existing || { id: id('ghr'), created_at: timestamp };
  Object.assign(mirror, {
    canonical_repository_id: record.id,
    provider: record.provider,
    repository_id: record.repository_id,
    full_name: record.full_name,
    name: record.name,
    installation_id: record.installation_id,
    default_branch: record.default_branch,
    private: record.private,
    status: record.remote_state,
    updated_at: timestamp
  });
  if (!existing) state.github_repositories.push(mirror);
}

function ensureRepositoryLifecycleDefaultsShallow(state) {
  for (const collection of [
    'github_repositories',
    'repository_bindings',
    'repository_connections',
    'canonical_repositories',
    'project_repository_bindings',
    'repository_deletion_intents'
  ])
    if (!Array.isArray(state[collection])) state[collection] = [];
}
