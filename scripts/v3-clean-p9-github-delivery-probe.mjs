import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createSign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { GitHubAppAdapter } from '../apps/api/src/clean/p8/github-adapter.mjs';
import { emitProbe } from './lib/v3-clean-p6-runner-probe.mjs';

await emitProbe('aiws.v3-clean.p9-github-delivery-probe.v1', async () => {
  const fixture = loadFixture();
  const privateKey = Buffer.from(fixture.private_key, 'utf8');
  let installationToken = null;
  let pullNumber = null;
  let merged = false;
  let stage = 'discovery';
  const branch = `aiws/p9-release-${Date.now()}`;
  const adapter = new GitHubAppAdapter();
  const auth = { appId: fixture.app_id, installationId: fixture.installation_id, privateKey };
  try {
    const repositories = await adapter.listRepositories(auth, { limit: 100 });
    if (!repositories.repositories.some((row) => row.full_name.toLowerCase() === fixture.repository.toLowerCase())) throw new Error('github_fixture_not_discovered');
    stage = 'repository'; const repository = await publicJson(`/repos/${fixture.repository}`);
    const base = String(repository.default_branch || 'main');
    const baseRef = await publicJson(`/repos/${fixture.repository}/git/ref/heads/${encodeURIComponent(base)}`);
    const baseSha = String(baseRef.object?.sha || '');
    if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error('github_fixture_base_sha_missing');
    stage = 'branch'; await adapter.createBranch(auth, { repository: fixture.repository, branch, headSha: baseSha });
    stage = 'token'; installationToken = await installationTokenFor(fixture, privateKey);
    const marker = `p9-release-${Date.now()}.txt`;
    stage = 'commit'; const committed = await githubJson(`/repos/${fixture.repository}/contents/.aiws-release/${marker}`, installationToken, {
      method: 'PUT', body: { message: 'AIWS P9 isolated release probe', content: Buffer.from(`AIWS P9 release probe ${marker}\n`).toString('base64'), branch }
    });
    const headSha = String(committed.commit?.sha || '');
    if (!/^[a-f0-9]{40}$/.test(headSha) || headSha === baseSha) throw new Error('github_fixture_commit_missing');
    stage = 'draft'; const pull = await adapter.createDraft(auth, { repository: fixture.repository, title: 'AIWS P9 delivery probe', body: 'P9 fixed-identity isolated delivery verification', head: branch, base });
    pullNumber = pull.number;
    stage = 'checks'; const checks = await adapter.checks(auth, { repository: fixture.repository, ref: headSha });
    stage = 'ready'; await adapter.markReady(auth, { repository: fixture.repository, pullNumber });
    stage = 'merge'; const merge = await adapter.merge(auth, { repository: fixture.repository, pullNumber, headSha, method: 'squash' });
    stage = 'reconcile'; const reconciled = await adapter.reconcile(auth, { repository: fixture.repository, pullNumber });
    if (!merge.merged || !reconciled.merged) throw new Error('github_merge_reconcile_failed');
    merged = true;
    stage = 'branch-delete'; await deleteBranch(fixture.repository, branch, installationToken);
    return { status: 'passed', provisional: false, external: { status: 'verified', repository: fixture.repository, discovery_count: repositories.repositories.length, pull_number: pullNumber, merge_sha: merge.sha, checks: checks.map((row) => row.name), branch_deleted: true } };
  } catch (error) {
    error.code = `github_p9_${stage}_${String(error?.code || error?.message || 'failed').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)}`;
    throw error;
  } finally {
    if (installationToken) {
      if (pullNumber && !merged) await githubJson(`/repos/${fixture.repository}/pulls/${pullNumber}`, installationToken, { method: 'PATCH', body: { state: 'closed' }, allowFailure: true });
      await deleteBranch(fixture.repository, branch, installationToken, true).catch(() => undefined);
      installationToken.fill(0);
    }
    privateKey.fill(0);
  }
});

function loadFixture() {
  if (process.env.AIWS_P9_GITHUB_FIXTURE) return JSON.parse(process.env.AIWS_P9_GITHUB_FIXTURE);
  const databaseFile = path.resolve('.ai-workspace/data/state-v23.sqlite');
  const receiptFile = path.resolve('docs/evidence/v3-clean-p8-delivery-deployment-importer-20260825/github-delivery-probe.json');
  if (!fs.existsSync(databaseFile) || !fs.existsSync(receiptFile)) throw new Error('github_fixture_identity_missing');
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const appRow = db.prepare('SELECT value_json FROM state_records WHERE collection=? ORDER BY ordinal LIMIT 1').get('github_app_configs');
    const installRow = db.prepare('SELECT value_json FROM state_records WHERE collection=? ORDER BY ordinal LIMIT 1').get('github_installations');
    const app = JSON.parse(appRow?.value_json || '{}'); const installation = JSON.parse(installRow?.value_json || '{}');
    const repository = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))?.external?.repository;
    const reference = String(app.refs?.private_key || '').replace(/^vault:/, '');
    const keyFile = path.resolve('.ai-workspace/vault', `${reference}.secret`);
    if (!app.app_id || !installation.installation_id || !repository || !reference || !fs.existsSync(keyFile)) throw new Error('github_fixture_identity_incomplete');
    return { app_id: app.app_id, installation_id: installation.installation_id, repository, private_key: fs.readFileSync(keyFile, 'utf8') };
  } finally { db.close(); }
}

async function installationTokenFor(fixture, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 30, exp: now + 540, iss: String(fixture.app_id) })).toString('base64url');
  const signer = createSign('RSA-SHA256'); signer.update(`${header}.${payload}`); signer.end();
  const jwt = `${header}.${payload}.${signer.sign(createPrivateKey(privateKey)).toString('base64url')}`;
  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(fixture.installation_id)}/access_tokens`, { method: 'POST', headers: headersFor(`Bearer ${jwt}`) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || !value.token) throw new Error(`github_installation_token_${response.status}`);
  return Buffer.from(String(value.token), 'utf8');
}

async function publicJson(route) { const response = await fetch(`https://api.github.com${route}`, { headers: headersFor(null) }); const value = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`github_public_${response.status}`); return value; }
async function githubJson(route, token, { method = 'GET', body = null, allowFailure = false } = {}) { const response = await fetch(`https://api.github.com${route}`, { method, headers: headersFor(`Bearer ${token.toString('utf8')}`), ...(body == null ? {} : { body: JSON.stringify(body) }) }); const value = await response.json().catch(() => ({})); if (!response.ok && !allowFailure) throw new Error(`github_mutation_${response.status}`); return value; }
async function deleteBranch(repository, branch, token, allowMissing = false) { const route=`/repos/${repository}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;const response=await fetch(`https://api.github.com${route}`,{method:'DELETE',headers:headersFor(`Bearer ${token.toString('utf8')}`)});if(response.status!==204&&!(allowMissing&&response.status===404))throw new Error(`github_branch_delete_${response.status}`);return true; }
function headersFor(authorization) { return { accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'aiws-v3-clean-p9-release', 'x-github-api-version': '2022-11-28', ...(authorization ? { authorization } : {}) }; }
