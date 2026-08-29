import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { GitHubAppAdapter } from '../apps/api/src/clean/p8/github-adapter.mjs';
import { emitProbe } from './lib/v3-clean-p6-runner-probe.mjs';

const API = 'https://api.github.com';

await emitProbe('aiws.v3-clean.p10-github-deletion-probe.v1', async () => {
  const fixture = loadAppFixture();
  const privateKey = Buffer.from(String(fixture.private_key || ''), 'utf8');
  const credential = loadGitCredential();
  const token = Buffer.from(credential.password, 'utf8');
  fixture.private_key = '';
  credential.password = '';
  const adapter = new GitHubAppAdapter();
  const auth = { appId: fixture.app_id, installationId: fixture.installation_id, privateKey };
  let created = null;
  let stage = 'identity';

  try {
    const account = await githubJson('/user', token);
    const owner = String(account.value?.login || credential.username || '');
    if (!owner) throw new Error('github_account_missing');
    const suffix = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${process.pid}-${randomBytes(4).toString('hex')}`;
    const name = `aiws-p10-delete-${suffix}`.toLowerCase();
    const fullName = `${owner}/${name}`;

    stage = 'collision-check';
    const collision = await githubJson(`/repos/${encodeRepository(fullName)}`, token, { allowStatus: [404] });
    if (collision.status !== 404) throw new Error('github_fixture_name_preexisting');

    stage = 'create';
    const create = await githubJson('/user/repos', token, {
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

    stage = 'head';
    const head = await waitForHead(created.full_name, created.default_branch, token);
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('github_fixture_head_missing');

    stage = 'app-discovery';
    const discovery = await waitForAppDiscovery(adapter, auth, created);

    stage = 'delete';
    let deleted;
    try {
      deleted = await adapter.deleteRepository(auth, {
        repository: created.full_name,
        repositoryId: created.id,
        branch: created.default_branch,
        expectedHeadSha: head
      });
    } catch (error) {
      if (error?.code !== 'external_result_unknown') throw error;
      const reconciledAfterUnknown = await adapter.reconcileRepositoryDeletion(auth, { repository: created.full_name, repositoryId: created.id });
      if (reconciledAfterUnknown.exists) throw error;
      deleted = { deleted: true, repository_id: created.id, full_name: created.full_name, head_sha: head, reconciled_after_unknown: true };
    }
    if (deleted.deleted !== true || String(deleted.repository_id) !== created.id) throw new Error('github_fixture_delete_identity_mismatch');

    stage = 'reconcile';
    const reconciled = await adapter.reconcileRepositoryDeletion(auth, { repository: created.full_name, repositoryId: created.id });
    if (reconciled.exists !== false || String(reconciled.repository_id) !== created.id) throw new Error('github_fixture_delete_reconcile_failed');

    const receipt = {
      external: {
        status: 'verified',
        adapter: 'github-app',
        repository: created.full_name,
        generated_repository_id: created.id,
        repository_selection: discovery.repository_selection,
        preexisting_check: 'absent'
      },
      deletion: {
        deleted: true,
        reconciled_absent: true,
        target_full_name_bound: true,
        repository_id_bound: true,
        expected_head_sha_bound: true,
        head_sha: head,
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
    if (created?.id) await cleanupCreatedRepository(created, token).catch(() => undefined);
    token.fill(0);
    privateKey.fill(0);
  }
});

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

async function waitForHead(repository, branch, token) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await githubJson(`/repos/${encodeRepository(repository)}/git/ref/heads/${encodeURIComponent(branch)}`, token, { allowStatus: [404, 409] });
    const sha = String(response.value?.object?.sha || '');
    if (response.status === 200 && /^[a-f0-9]{40}$/.test(sha)) return sha;
    await delay(500);
  }
  return '';
}

async function waitForAppDiscovery(adapter, auth, repository) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await adapter.listRepositories(auth, { cursor, limit: 100 });
      if (result.repositories.some((item) => String(item.id) === repository.id && item.full_name.toLowerCase() === repository.full_name.toLowerCase())) {
        return { repository_selection: 'all', discovered: true };
      }
      if (!result.next_cursor) break;
      cursor = result.next_cursor;
    }
    await delay(500);
  }
  throw new Error('github_fixture_not_discovered_by_app');
}

async function cleanupCreatedRepository(created, token) {
  const route = `/repos/${encodeRepository(created.full_name)}`;
  const current = await githubJson(route, token, { allowStatus: [404] });
  if (current.status === 404) return;
  if (String(current.value?.id || '') !== String(created.id)) throw new Error('github_cleanup_identity_mismatch');
  const deleted = await githubJson(route, token, { method: 'DELETE', allowStatus: [404] });
  if (![204, 404].includes(deleted.status)) throw new Error('github_cleanup_failed');
}

async function githubJson(route, token, { method = 'GET', body = null, allowStatus = [] } = {}) {
  const response = await fetch(`${API}${route}`, {
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
  if (!response.ok && !allowStatus.includes(response.status)) throw new Error(`github_fixture_request_${response.status}`);
  return { status: response.status, value };
}

function encodeRepository(value) {
  const parts = String(value).split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) throw new Error('github_repository_invalid');
  return parts.map(encodeURIComponent).join('/');
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
