import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { hashString, id, now } from '../../../packages/shared/index.mjs';
import { git, isGitRepo } from './git-utils.mjs';
import { HttpError } from './http.mjs';
import { managedProjectRoot, isWithin, safeSegment } from './managed-workspace.mjs';
import { createInstallationToken, githubGitAuthEnv, resolveGithubAppConfig } from './github-service.mjs';

const SHA_PATTERN = /^[a-f0-9]{40,64}$/i;
const WORKSPACE_MODES = new Set(['read_only', 'read_write']);

export function managedRepositoryWorkspaceRoot(projectId) {
  return path.join(managedProjectRoot(projectId), 'repository-workspaces');
}

export function managedRepositoryWorkspacePath(projectId, workspaceId) {
  return path.join(managedRepositoryWorkspaceRoot(projectId), safeSegment(workspaceId));
}

export function validateRepositoryRef(value) {
  const ref = String(value || '').trim();
  const invalid =
    !ref ||
    ref.length > 240 ||
    ref === 'HEAD' ||
    ref.startsWith('-') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    ref.includes('..') ||
    ref.includes('@{') ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(ref) ||
    ref.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'));
  if (invalid) throw new HttpError(400, { error: 'repository_ref_invalid', ref });
  return ref;
}

export function repositoryBranches(state, projectId, connectionId = null) {
  const { project, connection, sourcePath } = repositorySource(state, projectId, connectionId);
  const remoteName = connection?.remote_name || 'origin';
  const lines = git(
    sourcePath,
    ['for-each-ref', '--format=%(refname)|%(objectname)', 'refs/heads', `refs/remotes/${remoteName}`],
    10_000
  );
  if (!lines.ok)
    throw new HttpError(409, { error: 'repository_branch_catalog_unavailable', detail: lines.stderr || lines.error });
  const byName = new Map();
  for (const line of lines.stdout.split(/\r?\n/).filter(Boolean)) {
    const [fullRef, sha] = line.split('|');
    if (!SHA_PATTERN.test(String(sha || '')) || fullRef === `refs/remotes/${remoteName}/HEAD`) continue;
    const remotePrefix = `refs/remotes/${remoteName}/`,
      localPrefix = 'refs/heads/';
    const name = fullRef.startsWith(remotePrefix)
      ? fullRef.slice(remotePrefix.length)
      : fullRef.startsWith(localPrefix)
        ? fullRef.slice(localPrefix.length)
        : null;
    if (!name) continue;
    const candidate = {
      name,
      ref: name,
      sha: sha.toLowerCase(),
      source: fullRef.startsWith(remotePrefix) ? 'remote' : 'local',
      full_ref: fullRef
    };
    if (!byName.has(name) || candidate.source === 'remote') byName.set(name, candidate);
  }
  const defaultBranch =
    connection?.default_branch || canonicalDefaultBranch(state, project.id) || currentBranch(sourcePath) || 'main';
  const branches = [...byName.values()].sort(
    (a, b) => Number(b.name === defaultBranch) - Number(a.name === defaultBranch) || a.name.localeCompare(b.name)
  );
  return { project, connection, default_branch: defaultBranch, mirror_path: sourcePath, branches };
}

export async function refreshRepositoryMirror(state, projectId, connectionId = null, { fetch = true, env = {} } = {}) {
  const source = repositorySource(state, projectId, connectionId),
    remoteName = source.connection?.remote_name || 'origin';
  const remote = fetch ? git(source.sourcePath, ['remote', 'get-url', remoteName], 5_000) : null;
  if (fetch && remote?.ok) {
    const auth = Object.keys(env).length
      ? env
      : await repositoryGitAuthEnv(state, source.connection, remote.stdout.trim());
    const result = git(source.sourcePath, ['fetch', '--prune', remoteName], 120_000, auth);
    if (!result.ok)
      throw new HttpError(409, {
        error: 'repository_ref_mirror_refresh_failed',
        detail: result.stderr || result.error
      });
  }
  return repositoryBranches(state, projectId, connectionId);
}

export async function repositoryGitAuthEnv(state, connection, remoteUrl = '') {
  if (!/^https:\/\/github\.com\//i.test(String(remoteUrl || ''))) return { GIT_TERMINAL_PROMPT: '0' };
  if (!connection?.installation_id) throw new HttpError(409, { error: 'github_installation_token_required' });
  const config = resolveGithubAppConfig(state);
  if (!config) throw new HttpError(409, { error: 'github_app_config_required' });
  const access = await createInstallationToken(config, connection.installation_id);
  if (!access?.token) throw new HttpError(502, { error: 'github_installation_token_missing' });
  return githubGitAuthEnv(access.token);
}

export async function createRepositoryWorkspace(state, projectId, input, actorId) {
  const connectionId = String(input.connection_id || '').trim() || null;
  const catalog = repositoryBranches(state, projectId, connectionId);
  const ref = validateRepositoryRef(input.ref || catalog.default_branch);
  const branch = catalog.branches.find((item) => item.name === ref);
  if (!branch) throw new HttpError(404, { error: 'repository_branch_not_found', ref });
  const expectedSha = input.expected_sha ? String(input.expected_sha).trim().toLowerCase() : branch.sha;
  if (!SHA_PATTERN.test(expectedSha)) throw new HttpError(400, { error: 'repository_sha_invalid' });
  if (expectedSha !== branch.sha)
    throw new HttpError(409, {
      error: 'repository_branch_sha_changed',
      ref,
      expected_sha: expectedSha,
      actual_sha: branch.sha
    });
  const mode = String(input.mode || 'read_only');
  if (!WORKSPACE_MODES.has(mode))
    throw new HttpError(400, { error: 'repository_workspace_mode_invalid', allowed: [...WORKSPACE_MODES] });
  const operationKey =
    String(input.operation_key || '')
      .trim()
      .slice(0, 128) || null;
  if (operationKey) {
    const prior = state.repository_workspaces.find(
      (item) =>
        item.project_id === projectId &&
        item.operation_key === operationKey &&
        item.created_by_user_id === actorId &&
        item.status !== 'removed'
    );
    if (prior) return { workspace: prior, idempotent: true };
  }
  const workspaceId = id('rws'),
    target = managedRepositoryWorkspacePath(projectId, workspaceId),
    root = managedRepositoryWorkspaceRoot(projectId);
  await fsp.mkdir(root, { recursive: true });
  if (!isWithin(root, target) || fs.existsSync(target))
    throw new HttpError(409, { error: 'repository_workspace_path_occupied' });
  const cloned = git(root, ['clone', '--no-hardlinks', '--no-checkout', '--', catalog.mirror_path, target], 120_000);
  if (!cloned.ok) {
    await fsp.rm(target, { recursive: true, force: true });
    throw new HttpError(409, { error: 'repository_workspace_clone_failed', detail: cloned.stderr || cloned.error });
  }
  try {
    const remoteName = catalog.connection?.remote_name || 'origin';
    const sourceRemote = git(catalog.mirror_path, ['remote', 'get-url', remoteName], 5_000);
    if (sourceRemote.ok) {
      const configured = git(target, ['remote', 'set-url', 'origin', sourceRemote.stdout.trim()], 5_000);
      if (!configured.ok)
        throw new HttpError(409, {
          error: 'repository_workspace_remote_configuration_failed',
          detail: configured.stderr || configured.error
        });
    }
    const checkedOut = git(target, ['checkout', '--detach', expectedSha], 60_000);
    if (!checkedOut.ok)
      throw new HttpError(409, {
        error: 'repository_workspace_checkout_failed',
        detail: checkedOut.stderr || checkedOut.error
      });
    const actualSha = git(target, ['rev-parse', 'HEAD'], 5_000).stdout.trim().toLowerCase();
    if (actualSha !== expectedSha)
      throw new HttpError(409, {
        error: 'repository_workspace_sha_mismatch',
        expected_sha: expectedSha,
        actual_sha: actualSha
      });
  } catch (error) {
    await fsp.rm(target, { recursive: true, force: true });
    throw error;
  }
  const timestamp = now();
  const workspace = {
    id: workspaceId,
    project_id: projectId,
    connection_id: catalog.connection?.id || null,
    canonical_repository_id: canonicalRepositoryId(state, projectId, catalog.connection),
    ref,
    fixed_sha: expectedSha,
    current_sha: expectedSha,
    mode,
    scope: normalizeScope(input.scope),
    managed_path: target,
    sync_status: 'ready',
    stale: false,
    ahead: 0,
    behind: 0,
    dirty: false,
    status: 'active',
    revision: 1,
    operation_key: operationKey,
    last_synced_at: timestamp,
    created_by_user_id: actorId,
    created_at: timestamp,
    updated_at: timestamp
  };
  state.repository_workspaces.push(workspace);
  const project = state.projects.find((item) => item.id === projectId);
  if (project && (input.make_default === true || !project.default_repository_workspace_id))
    project.default_repository_workspace_id = workspace.id;
  return { workspace, idempotent: false };
}

export function inspectRepositoryWorkspace(state, workspaceId) {
  const workspace = requireRepositoryWorkspace(state, workspaceId),
    root = verifiedWorkspacePath(workspace);
  const head = git(root, ['rev-parse', 'HEAD'], 5_000);
  if (!head.ok || !SHA_PATTERN.test(head.stdout.trim()))
    throw new HttpError(409, { error: 'repository_workspace_head_unavailable' });
  const currentSha = head.stdout.trim().toLowerCase();
  const catalog = repositoryBranches(state, workspace.project_id, workspace.connection_id);
  const branch = catalog.branches.find((item) => item.name === workspace.ref);
  const remoteSha = branch?.sha || null;
  const counts = remoteSha
    ? git(root, ['rev-list', '--left-right', '--count', `${remoteSha}...${currentSha}`], 10_000)
    : null;
  const [behind, ahead] = counts?.ok
    ? counts.stdout
        .trim()
        .split(/\s+/)
        .map((value) => Number(value) || 0)
    : [0, 0];
  const dirty = Boolean(git(root, ['status', '--porcelain', '--untracked-files=all'], 10_000).stdout.trim());
  const stale = !remoteSha || remoteSha !== workspace.fixed_sha;
  Object.assign(workspace, {
    current_sha: currentSha,
    remote_sha: remoteSha,
    ahead,
    behind,
    dirty,
    stale,
    sync_status: stale ? 'stale' : 'ready',
    last_synced_at: now(),
    updated_at: now()
  });
  return workspace;
}

export function ensureRepositoryWorkspaceReviewRef(state, workspaceId) {
  const workspace = inspectRepositoryWorkspace(state, workspaceId);
  if (workspace.dirty) throw new HttpError(409, { error: 'repository_workspace_uncommitted_changes' });
  if (workspace.current_sha === workspace.fixed_sha) return workspace.ref;
  const reviewRef = validateRepositoryRef(
    workspace.review_ref ||
      `aiws/review-${safeSegment(workspace.id).slice(0, 40)}-${hashString(workspace.current_sha).slice(0, 8)}`
  );
  const root = verifiedWorkspacePath(workspace),
    created = git(root, ['branch', '--force', reviewRef, workspace.current_sha], 10_000);
  if (!created.ok)
    throw new HttpError(409, {
      error: 'repository_workspace_review_branch_failed',
      detail: created.stderr || created.error
    });
  Object.assign(workspace, { review_ref: reviewRef, review_sha: workspace.current_sha, updated_at: now() });
  return reviewRef;
}

export async function removeRepositoryWorkspace(state, workspaceId, actorId) {
  const workspace = requireRepositoryWorkspace(state, workspaceId);
  if (
    state.pull_request_intents.some(
      (item) =>
        item.repository_workspace_id === workspace.id &&
        !['revoked', 'expired', 'merged', 'closed'].includes(item.status)
    )
  )
    throw new HttpError(409, { error: 'repository_workspace_in_use' });
  const target = verifiedWorkspacePath(workspace),
    root = managedRepositoryWorkspaceRoot(workspace.project_id);
  if (!isWithin(root, target)) throw new HttpError(400, { error: 'managed_path_escape' });
  await fsp.rm(target, { recursive: true, force: true });
  Object.assign(workspace, { status: 'removed', removed_by_user_id: actorId, removed_at: now(), updated_at: now() });
  const project = state.projects.find((item) => item.id === workspace.project_id);
  if (project?.default_repository_workspace_id === workspace.id)
    project.default_repository_workspace_id =
      state.repository_workspaces.find(
        (item) => item.project_id === project.id && item.status === 'active' && item.id !== workspace.id
      )?.id || null;
  return workspace;
}

export function markRepositoryWorkspacesStale(
  state,
  { projectId = null, connectionId = null, ref = null, remoteSha = null } = {}
) {
  let changed = 0;
  for (const workspace of state.repository_workspaces || []) {
    if (
      workspace.status !== 'active' ||
      (projectId && workspace.project_id !== projectId) ||
      (connectionId && workspace.connection_id !== connectionId) ||
      (ref && workspace.ref !== ref)
    )
      continue;
    if (remoteSha && String(workspace.fixed_sha).toLowerCase() === String(remoteSha).toLowerCase()) continue;
    Object.assign(workspace, {
      stale: true,
      sync_status: 'stale',
      remote_sha: remoteSha || workspace.remote_sha || null,
      updated_at: now()
    });
    changed += 1;
  }
  return changed;
}

export function requireRepositoryWorkspace(state, workspaceId, projectId = null) {
  const workspace = state.repository_workspaces.find((item) => item.id === workspaceId && item.status !== 'removed');
  if (!workspace || (projectId && workspace.project_id !== projectId))
    throw new HttpError(404, { error: 'repository_workspace_not_found' });
  return workspace;
}

export function repositoryWorkspaceRoot(state, workspaceId, { write = false } = {}) {
  const workspace = requireRepositoryWorkspace(state, workspaceId);
  if (write && workspace.mode !== 'read_write') throw new HttpError(403, { error: 'repository_workspace_read_only' });
  return { workspace, root: verifiedWorkspacePath(workspace) };
}

function repositorySource(state, projectId, connectionId) {
  const project = state.projects.find((item) => item.id === projectId && !item.deleted_at);
  if (!project) throw new HttpError(404, { error: 'project_not_found' });
  const connections = state.repository_connections.filter(
    (item) => item.project_id === projectId && item.sync_status !== 'disconnected'
  );
  const connection = connectionId
    ? connections.find((item) => item.id === connectionId)
    : connections.find((item) => item.local_path && isGitRepo(item.local_path)) || connections[0] || null;
  if (connectionId && !connection) throw new HttpError(404, { error: 'repository_connection_not_found' });
  const binding = state.project_repository_bindings.find(
    (item) => item.project_id === projectId && item.status !== 'removed'
  );
  const sourcePath = path.resolve(
    connection?.local_path || binding?.local_checkout_path || project.repo_path || project.workspace_root || ''
  );
  if (!sourcePath || !isGitRepo(sourcePath)) throw new HttpError(409, { error: 'repository_ref_mirror_unavailable' });
  return { project, connection, sourcePath };
}

function verifiedWorkspacePath(workspace) {
  const expected = path.resolve(managedRepositoryWorkspacePath(workspace.project_id, workspace.id));
  if (
    path.resolve(workspace.managed_path || '') !== expected ||
    !isWithin(managedRepositoryWorkspaceRoot(workspace.project_id), expected) ||
    !isGitRepo(expected)
  )
    throw new HttpError(409, { error: 'repository_workspace_path_invalid' });
  const real = fs.realpathSync(expected);
  if (!isWithin(managedRepositoryWorkspaceRoot(workspace.project_id), real))
    throw new HttpError(409, { error: 'repository_workspace_symlink_escape' });
  return real;
}

function canonicalRepositoryId(state, projectId, connection) {
  const binding = state.project_repository_bindings.find(
    (item) => item.project_id === projectId && item.status !== 'removed'
  );
  if (binding) return binding.canonical_repository_id;
  const canonical = state.canonical_repositories.find(
    (item) => String(item.repository_id) === String(connection?.repository_id)
  );
  return canonical?.id || null;
}
function canonicalDefaultBranch(state, projectId) {
  const binding = state.project_repository_bindings.find(
    (item) => item.project_id === projectId && item.status !== 'removed'
  );
  return (
    state.canonical_repositories.find((item) => item.id === binding?.canonical_repository_id)?.default_branch || null
  );
}
function currentBranch(repoPath) {
  return git(repoPath, ['branch', '--show-current'], 5_000).stdout.trim() || null;
}
function normalizeScope(value) {
  const scope = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    type: String(scope.type || 'project'),
    id: scope.id == null ? null : String(scope.id),
    path_prefixes: [
      ...new Set(
        (Array.isArray(scope.path_prefixes) ? scope.path_prefixes : ['.']).map((item) =>
          String(item || '.').replaceAll('\\', '/')
        )
      )
    ]
  };
}

export function repositoryWorkspaceSnapshotHash(workspace) {
  return hashString(
    JSON.stringify({
      id: workspace.id,
      project_id: workspace.project_id,
      connection_id: workspace.connection_id,
      ref: workspace.ref,
      fixed_sha: workspace.fixed_sha,
      mode: workspace.mode,
      scope: workspace.scope
    })
  );
}
