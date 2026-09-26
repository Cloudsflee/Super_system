import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { GitHubAppAdapter } from '../apps/api/src/clean/p8/github-adapter.mjs';
import { emitProbe } from './lib/v3-clean-p6-runner-probe.mjs';

const API = 'https://api.github.com';

export async function runGithubDeletionProbe({
  fixture = loadAppFixture(),
  credential = loadGitCredential(),
  adapter = new GitHubAppAdapter(),
  fetchImpl = globalThis.fetch
} = {}) {
  const privateKeyText = String(fixture.private_key || '');
  const privateKey = Buffer.from(privateKeyText, 'utf8');
  const token = Buffer.from(credential.password, 'utf8');
  if (credential && typeof credential === 'object') credential.password = '';
  if (fixture && typeof fixture === 'object') fixture.private_key = '';
  const auth = () => ({ appId: fixture.app_id, installationId: fixture.installation_id, privateKey: Buffer.from(privateKeyText, 'utf8') });
  let created = null;
  let stage = 'identity';

  try {
    const account = await githubJson('/user', token, { fetchImpl });
    const owner = String(account.value?.login || credential.username || '');
    if (!owner) throw new Error('github_account_missing');
    const suffix = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${process.pid}-${randomBytes(4).toString('hex')}`;
    const name = `aiws-p10-delete-${suffix}`.toLowerCase();
    const fullName = `${owner}/${name}`;

    stage = 'collision-check';
    const collision = await githubJson(`/repos/${encodeRepository(fullName)}`, token, { allowStatus: [404], fetchImpl });
    if (collision.status !== 404) throw new Error('github_fixture_name_preexisting');

    stage = 'create';
    const create = await githubJson('/user/repos', token, {
      fetchImpl,
      method: 'POST',
      body: {
        name,
        description: 'AIWS P10 isolated repository deletion fixture',
        private: true,
        auto_init: true,
        has_issues: false,
        has_projects: false,
        has_wiki: false
      }
    });
    created = {
      id: String(create.value?.id || ''),
      full_name: String(create.value?.full_name || fullName),
      default_branch: String(create.value?.default_branch || 'main')
    };
    if (!/^\d+$/.test(created.id) || created.full_name.toLowerCase() !== fullName.toLowerCase()) throw new Error('github_fixture_identity_invalid');

    stage = 'app-discovery';
    let discovery = await ensureAppRepositoryAccess({ adapter, auth, repository: created, installationId: fixture.installation_id, bind: (installationId, repositoryId) => bindRepositoryToInstallation(installationId, repositoryId, token, fetchImpl) });
    if (!discovery) {
      throw new Error('github_fixture_not_discovered_by_app');
    }

    stage = 'app-head';
    const appSnapshot = await waitForAppHead(adapter, auth, created);
    const head = String(appSnapshot.commit_sha || appSnapshot.revision || '');
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('github_fixture_head_missing');

    stage = 'delete';
    let deleted;
    try {
      deleted = await adapter.deleteRepository(auth(), {
        repository: created.full_name,
        repositoryId: created.id,
        branch: created.default_branch,
        expectedHeadSha: head
      });
    } catch (error) {
      if (error?.code !== 'external_result_unknown') throw error;
      const reconciledAfterUnknown = await adapter.reconcileRepositoryDeletion(auth(), { repository: created.full_name, repositoryId: created.id, expectedPreviouslyBound: true });
      if (reconciledAfterUnknown.exists) throw error;
      deleted = { deleted: true, repository_id: created.id, full_name: created.full_name, head_sha: head, reconciled_after_unknown: true };
    }
    if (deleted.deleted !== true || String(deleted.repository_id) !== created.id) throw new Error('github_fixture_delete_identity_mismatch');

    stage = 'reconcile';
    const reconciled = await adapter.reconcileRepositoryDeletion(auth(), { repository: created.full_name, repositoryId: created.id, expectedPreviouslyBound: true });
    if (reconciled.exists !== false || String(reconciled.repository_id) !== created.id) throw new Error('github_fixture_delete_reconcile_failed');

    const receipt = {
      external: {
        status: 'verified',
        adapter: 'github-app',
        repository: created.full_name,
        generated_repository_id: created.id,
        repository_selection: discovery.repository_selection,
        installation_repository_bound: discovery.bound === true,
        app_head_validated: true,
        app_delete_authorized: true,
        preexisting_check: 'absent'
      },
      deletion: {
        deleted: true,
        reconciled_absent: true,
        target_full_name_bound: true,
        repository_id_bound: true,
        expected_head_sha_bound: true,
        head_sha: head,
        reconcile_resolution: String(reconciled.resolution || 'repository_not_found_after_bound_delete'),
        session_proofs: 2
      },
      cleanup: { only_generated_repository_id: created.id, no_broad_cleanup: true, residual_repository: false }
    };
    created = null;
    return receipt;
  } catch (error) {
    error.code = `github_p10_${stage}_${String(error?.code || error?.message || 'failed').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)}`;
    throw error;
  } finally {
    if (created?.id) {
      try { await cleanupCreatedRepositoryWithApp(created, adapter, auth); }
      catch (error) { throw new Error(`github_fixture_cleanup_failed:${String(error?.message || error)}`, { cause: error }); }
    }
    token.fill(0);
    privateKey.fill(0);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await emitProbe('aiws.v3-clean.p10-github-deletion-probe.v1', () => runGithubDeletionProbe());
}

function loadAppFixture() {
  if (process.env.AIWS_P10_GITHUB_APP_BUNDLE) return JSON.parse(process.env.AIWS_P10_GITHUB_APP_BUNDLE);
  const databaseFile = path.resolve('.ai-workspace/data/state-v23.sqlite');
  if (!fs.existsSync(databaseFile)) throw new Error('github_app_fixture_database_missing');
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const appRow = db.prepare('SELECT value_json FROM state_records WHERE collection=? ORDER BY ordinal LIMIT 1').get('github_app_configs');
    const installRow = db.prepare('SELECT value_json FROM state_records WHERE collection=? ORDER BY ordinal LIMIT 1').get('github_installations');
    const app = JSON.parse(appRow?.value_json || '{}');
    const installation = JSON.parse(installRow?.value_json || '{}');
    const reference = String(app.refs?.private_key || '').replace(/^vault:/, '');
    const keyFile = path.resolve('.ai-workspace/vault', `${reference}.secret`);
    if (!app.app_id || !installation.installation_id || !reference || !fs.existsSync(keyFile)) throw new Error('github_app_fixture_identity_incomplete');
    return {
      app_id: app.app_id,
      installation_id: installation.installation_id,
      private_key: fs.readFileSync(keyFile, 'utf8')
    };
  } finally {
    db.close();
  }
}

function loadGitCredential() {
  const result = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });
  if (result.status !== 0) throw new Error('github_fixture_credential_missing');
  const values = Object.fromEntries(String(result.stdout || '').split(/\r?\n/).map((line) => {
    const index = line.indexOf('=');
    return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : null;
  }).filter(Boolean));
  if (!values.password) throw new Error('github_fixture_credential_missing');
  return { username: String(values.username || ''), password: String(values.password) };
}

async function waitForAppDiscovery(adapter, auth, repository) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const found = await findAppRepository(adapter, auth, repository);
    if (found) return { ...found, bound: true };
    await delay(500);
  }
  throw new Error('github_fixture_not_discovered_by_app');
}

async function waitForAppHead(adapter, auth, repository) {
  let lastError = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const snapshot = await adapter.inspectRepository(auth(), { fullName: repository.full_name, repositoryId: repository.id, branch: repository.default_branch });
      if (/^[a-f0-9]{40}$/.test(String(snapshot.commit_sha || snapshot.revision || ''))) return snapshot;
      lastError = new Error('github_fixture_head_missing');
    } catch (error) {
      lastError = error;
      const status = Number(error?.details?.status || error?.status || 0);
      if (status !== 404 && status !== 409 && error?.code !== 'github_branch_head_invalid') throw error;
    }
    await delay(500);
  }
  throw lastError || new Error('github_fixture_head_missing');
}

async function findAppRepository(adapter, auth, repository) {
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const result = await adapter.listRepositories(auth(), { cursor, limit: 100 });
    if (result.repositories.some((item) => String(item.id) === repository.id && item.full_name.toLowerCase() === repository.full_name.toLowerCase())) {
      return { repository_selection: 'preselected', discovered: true, bound: false };
    }
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return null;
}

async function installationSelection(adapter, auth, installationId) {
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const result = await adapter.listInstallations(auth(), { cursor, limit: 100 });
    const found = (result.installations || []).find((item) => String(item.id) === String(installationId));
    if (found) return String(found.repository_selection || '').toLowerCase() === 'selected' ? 'selected' : String(found.repository_selection || 'all').toLowerCase() || 'all';
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  throw new Error('github_installation_not_found');
}

/**
 * Resolve App visibility before any user-token binding.  All-repositories
 * installations must already expose the repository; only selected
 * installations may use the PAT's installation-repository binding endpoint.
 * This function is exported for the deterministic permission matrix test.
 */
export async function ensureAppRepositoryAccess({ adapter, auth, repository, installationId, bind }) {
  const selection = await installationSelection(adapter, auth, installationId);
  const found = await findAppRepository(adapter, auth, repository);
  if (found) return { ...found, repository_selection: selection, bound: false };
  if (selection !== 'selected') throw new Error('github_installation_repository_not_visible');
  if (typeof bind !== 'function') throw new Error('github_installation_bind_unavailable');
  await bind(installationId, repository.id);
  const discovered = await waitForAppDiscovery(adapter, auth, repository);
  return { ...discovered, repository_selection: selection, bound: true };
}

async function bindRepositoryToInstallation(installationId, repositoryId, token, fetchImpl = globalThis.fetch) {
  let result;
  try {
    result = await githubJson(`/user/installations/${encodeURIComponent(String(installationId))}/repositories/${encodeURIComponent(String(repositoryId))}`, token, { method: 'PUT', fetchImpl });
  } catch (error) {
    if (error?.status === 403) throw Object.assign(new Error('github_installation_access_denied'), { code: 'github_installation_access_denied', status: 403 });
    if (error?.status === 404) throw Object.assign(new Error('github_installation_not_found'), { code: 'github_installation_not_found', status: 404 });
    throw error;
  }
  if (![204, 304].includes(result.status)) throw new Error(`github_fixture_installation_bind_${result.status}`);
}

export async function cleanupCreatedRepository(created, token, fetchImpl = globalThis.fetch) {
  const route = `/repos/${encodeRepository(created.full_name)}`;
  const current = await githubJson(route, token, { allowStatus: [404], fetchImpl });
  if (current.status === 404) return;
  if (String(current.value?.id || '') !== String(created.id)) throw new Error('github_cleanup_identity_mismatch');
  const deleted = await githubJson(route, token, { method: 'DELETE', allowStatus: [404], fetchImpl });
  if (![204, 404].includes(deleted.status)) throw new Error('github_cleanup_failed');
}

/**
 * Cleanup for a partially completed probe uses the App installation identity.
 * The PAT is intentionally limited to user-scoped repository creation and
 * installation binding; remote deletion remains App-owned.
 */
export async function cleanupCreatedRepositoryWithApp(created, adapter, auth) {
  const identity = auth();
  try {
    const snapshot = await adapter.inspectRepository(identity, {
      fullName: created.full_name,
      repositoryId: created.id,
      branch: created.default_branch || 'main'
    });
    const head = String(snapshot.commit_sha || snapshot.revision || '');
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('github_cleanup_head_missing');
    const deleted = await adapter.deleteRepository(identity, {
      repository: created.full_name,
      repositoryId: created.id,
      branch: created.default_branch || 'main',
      expectedHeadSha: head
    });
    if (deleted.deleted !== true || String(deleted.repository_id) !== String(created.id)) throw new Error('github_cleanup_identity_mismatch');
    const reconciled = await adapter.reconcileRepositoryDeletion(identity, {
      repository: created.full_name,
      repositoryId: created.id,
      expectedPreviouslyBound: true
    });
    if (reconciled.exists !== false) throw new Error('github_cleanup_reconcile_failed');
  } finally {
    identity.privateKey?.fill?.(0);
  }
}

async function githubJson(route, token, { method = 'GET', body = null, allowStatus = [], fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(`${API}${route}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token.toString('utf8')}`,
      'content-type': 'application/json',
      'user-agent': 'aiws-v3-clean-p10-deletion-probe',
      'x-github-api-version': '2022-11-28'
    },
    ...(body == null ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let value = {};
  try { value = text ? JSON.parse(text) : {}; } catch { value = {}; }
  if (!response.ok && !allowStatus.includes(response.status)) {
    const error = new Error(`github_fixture_request_${response.status}`);
    error.code = `github_http_${response.status}`;
    error.status = response.status;
    throw error;
  }
  return { status: response.status, value, oauth_scopes: response.headers.get('x-oauth-scopes') || '' };
}

function encodeRepository(value) {
  const parts = String(value).split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) throw new Error('github_repository_invalid');
  return parts.map(encodeURIComponent).join('/');
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
