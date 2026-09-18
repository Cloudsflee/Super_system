import { createHmac, createPrivateKey, createSign, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, sha256Hex } from '../canonical.mjs';
import { PlatformError } from '../platform-error.mjs';

const API_VERSION = '2022-11-28';
const execFileAsync = promisify(execFile);

export class GitHubAppAdapter {
  constructor({ fetchImpl = globalThis.fetch, apiBaseUrl = 'https://api.github.com', clock = () => Date.now(), timeoutMs = 20_000, git = 'git', execFileImpl = execFileAsync, maxBytes = 100 * 1024 * 1024 } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('github_fetch_required');
    this.fetch = fetchImpl;
    this.apiBaseUrl = String(apiBaseUrl).replace(/\/$/, '');
    this.clock = clock;
    this.timeoutMs = Number(timeoutMs);
    this.git = git;
    this.execFile = execFileImpl;
    this.maxBytes = Number(maxBytes);
  }

  async inspectRepository(auth, { repositoryId = null, fullName, branch = 'main', expectedHeadSha = null } = {}) {
    return this.#withRepositoryToken(auth, async (token) => {
      const name = repoName(fullName);
      const branchName = bounded(branch, 256);
      if (!branchName || branchName.startsWith('/') || branchName.includes('..')) throw new PlatformError('github_branch_invalid', 'GitHub branch is invalid', {}, 422);
      const repository = await this.#request(`/repos/${repoPath(name)}`, { token });
      if (repositoryId != null && String(repository.id || '') !== String(repositoryId)) throw new PlatformError('github_repository_id_mismatch', 'GitHub repository id does not match the pin', {}, 409);
      if (String(repository.full_name || '').toLowerCase() !== name.toLowerCase()) throw new PlatformError('github_repository_full_name_mismatch', 'GitHub repository full name does not match the pin', {}, 409);
      const ref = await this.#request(`/repos/${repoPath(name)}/git/ref/heads/${encodeURIComponent(branchName)}`, { token });
      const head = String(ref.object?.sha || '');
      if (!/^[a-f0-9]{40}$/i.test(head)) throw new PlatformError('github_branch_head_invalid', 'GitHub branch head is invalid', {}, 502);
      if (expectedHeadSha && String(expectedHeadSha).toLowerCase() !== head.toLowerCase()) throw new PlatformError('github_branch_head_mismatch', 'GitHub branch head does not match the pin', {}, 409);
      const commit = await this.#request(`/repos/${repoPath(name)}/commits/${encodeURIComponent(head)}`, { token });
      const treeSha = String(commit.commit?.tree?.sha || '');
      if (!/^[a-f0-9]{40}$/i.test(treeSha)) throw new PlatformError('github_tree_invalid', 'GitHub tree is invalid', {}, 502);
      const tree = await this.#request(`/repos/${repoPath(name)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`, { token });
      if (tree.truncated === true) throw new PlatformError('repository_source_too_large', 'GitHub tree is truncated', {}, 422);
      const entries = [];
      let totalBytes = 0;
      for (const item of Array.isArray(tree.tree) ? tree.tree : []) {
        const mode = String(item.mode || '');
        const type = String(item.type || '');
        const relative = relativeSafe(item.path);
        if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new PlatformError('repository_source_invalid', 'tracked symlink, submodule or special entry', {}, 422);
        const blob = await this.#request(`/repos/${repoPath(name)}/git/blobs/${encodeURIComponent(String(item.sha || ''))}`, { token });
        const bytes = decodeGithubBlob(blob);
        totalBytes += bytes.length;
        if (entries.length >= 10000 || totalBytes > this.maxBytes) { bytes.fill(0); throw new PlatformError('repository_source_too_large', 'source quota exceeded', {}, 422); }
        if (relative === '.gitmodules' || isLfsPointer(bytes)) { bytes.fill(0); throw new PlatformError(relative === '.gitmodules' ? 'repository_submodule_unsupported' : 'repository_lfs_unsupported', 'repository feature is unsupported', {}, 422); }
        entries.push({ path: relative, mode, blob_sha1: String(item.sha || ''), sha256: sha256Hex(bytes), byte_length: bytes.length });
        bytes.fill(0);
      }
      entries.sort((a, b) => a.path.localeCompare(b.path));
      const manifestHash = sha256Hex(canonicalJson({ commit: head, tree: treeSha, entries }));
      return { repository_id: String(repository.id || ''), full_name: String(repository.full_name || name), branch: branchName, revision: head, commit_sha: head, tree_sha: treeSha, hash: manifestHash, manifest_hash: manifestHash, entries, file_count: entries.length, total_bytes: totalBytes, api_head_sha: head };
    });
  }

  async materializeRepository(auth, { repositoryId = null, fullName, branch = 'main', expectedHeadSha = null, destination } = {}) {
    const pin = await this.inspectRepository(auth, { repositoryId, fullName, branch, expectedHeadSha });
    const target = path.resolve(String(destination || ''));
    if (!target || fs.existsSync(target)) throw new PlatformError('repository_source_invalid', 'materialization requires a new directory', {}, 409);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    return this.#withRepositoryToken(auth, async (token) => {
      const url = `https://github.com/${repoName(fullName)}.git`;
      try {
        await this.execFile(this.git, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', 'clone', '--depth=1', '--no-tags', '--single-branch', '--branch', String(branch), '--', url, target], {
          encoding: 'buffer', shell: false, windowsHide: true, timeout: 120000, maxBuffer: this.maxBytes,
          env: { PATH: process.env.PATH || process.env.Path || '', SystemRoot: process.env.SystemRoot || '', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: 'true', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.toString('utf8')}` }
        });
        const observed = await inspectClonedRepository(this.execFile, this.git, target, this.maxBytes);
        if (observed.commit_sha !== pin.commit_sha || observed.manifest_hash !== pin.manifest_hash) throw new PlatformError('source_drift', 'remote Git content changed during materialization', {}, 409);
        fs.rmSync(path.join(target, '.git'), { recursive: true, force: true });
        return { ...pin, workspace_hash: sha256Hex(canonicalJson(observed.workspace_manifest)), workspace_manifest: observed.workspace_manifest };
      } catch (error) {
        await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
        if (error instanceof PlatformError) throw error;
        throw new PlatformError('repository_materialization_failed', 'remote Git materialization failed', {}, 422);
      }
    });
  }

  async listRepositories(auth, { cursor = null, limit = 50 } = {}) {
    const page = cursor == null ? 1 : Number(cursor);
    if (!Number.isInteger(page) || page < 1) throw new PlatformError('schema_invalid', 'GitHub repository cursor is invalid', {}, 422);
    const count = Math.min(100, Math.max(1, Number(limit || 50)));
    return this.#withInstallationToken(auth, async (token) => {
      const response = await this.#request(`/installation/repositories?per_page=${count}&page=${page}`, { token });
      const repositories = Array.isArray(response.repositories) ? response.repositories.map(repositoryView) : [];
      return { repositories, next_cursor: repositories.length === count ? String(page + 1) : null };
    });
  }

  async listInstallations(auth, { cursor = null, limit = 50 } = {}) {
    const page = cursor == null ? 1 : Number(cursor);
    if (!Number.isInteger(page) || page < 1) throw new PlatformError('schema_invalid', 'GitHub installation cursor is invalid', {}, 422);
    const count = Math.min(100, Math.max(1, Number(limit || 50)));
    const response = await this.#request(`/app/installations?per_page=${count}&page=${page}`, { jwt: appJwt(auth, this.clock) });
    const installations = Array.isArray(response) ? response.map(installationView) : [];
    return { installations, next_cursor: installations.length === count ? String(page + 1) : null };
  }

  async createDraft(auth, input) {
    return this.#withInstallationToken(auth, async (token) => {
      const result = await this.#request(`/repos/${repoPath(input.repository)}/pulls`, {
        method: 'POST', token, ambiguous: true,
        body: { title: bounded(input.title || `Delivery ${input.deliveryId}`, 256), head: bounded(input.head, 256), base: bounded(input.base, 256), body: bounded(input.body || '', 65_536), draft: true }
      });
      return pullRequestReceipt(result);
    });
  }

  async createBranch(auth, input) {
    return this.#withInstallationToken(auth, async (token) => {
      const branch = bounded(input.branch, 256);
      const sha = bounded(input.headSha, 128);
      try {
        const value = await this.#request(`/repos/${repoPath(input.repository)}/git/refs`, { method: 'POST', token, ambiguous: true, body: { ref: `refs/heads/${branch}`, sha } });
        return { ref: String(value.ref || `refs/heads/${branch}`), sha: String(value.object?.sha || sha), created: true };
      } catch (error) {
        if (error?.code !== 'github_request_failed' || error?.details?.status !== 422) throw error;
        const existing = await this.#request(`/repos/${repoPath(input.repository)}/git/ref/heads/${encodeURIComponent(branch)}`, { token });
        if (String(existing.object?.sha || '') !== sha) throw new PlatformError('github_branch_conflict', 'GitHub branch points at a different SHA', {}, 409);
        return { ref: String(existing.ref || `refs/heads/${branch}`), sha, created: false };
      }
    });
  }

  async markReady(auth, input) {
    return this.#withInstallationToken(auth, async (token) => {
      try {
        return pullRequestReceipt(await this.#request(
          `/repos/${repoPath(input.repository)}/pulls/${positiveInteger(input.pullNumber)}/ready_for_review`,
          { method: 'POST', token, ambiguous: true }
        ));
      } catch (error) {
      // Some GitHub App installations return 404 for the REST transition even
      // when the pull request is visible and pull_requests:write is granted.
      // Use the first-class GraphQL mutation only for that provider response;
      // all other failures retain the normal unknown-result semantics.
      if (error?.code !== 'github_request_failed' || error?.details?.status !== 404) throw error;
      const route = `/repos/${repoPath(input.repository)}/pulls/${positiveInteger(input.pullNumber)}`;
      const pull = await this.#request(route, { token });
      const nodeId = bounded(pull.node_id || '', 256);
      if (!nodeId) throw error;
      const result = await this.#graphql(
        'mutation($input: MarkPullRequestReadyForReviewInput!) { markPullRequestReadyForReview(input: $input) { pullRequest { number isDraft state } } }',
        { input: { pullRequestId: nodeId } },
        { token, ambiguous: true }
      );
      const ready = result?.data?.markPullRequestReadyForReview?.pullRequest;
      if (!ready || Number(ready.number || 0) !== Number(input.pullNumber)) throw new PlatformError('github_request_failed', 'GitHub ready response was invalid', {}, 502);
      return pullRequestReceipt({
        ...pull,
        number: ready.number,
        state: String(ready.state || pull.state || '').toLowerCase(),
        draft: ready.isDraft === true,
        merged: pull.merged === true,
        merge_commit_sha: pull.merge_commit_sha || null
      });
      }
    });
  }

  async checks(auth, input) {
    return this.#withInstallationToken(auth, async (token) => {
      const response = await this.#request(`/repos/${repoPath(input.repository)}/commits/${encodeURIComponent(bounded(input.ref, 256))}/check-runs`, { token });
      return (Array.isArray(response.check_runs) ? response.check_runs : []).map((item) => ({
        id: Number(item.id || 0), name: bounded(item.name || '', 160), status: bounded(item.status || '', 80), conclusion: item.conclusion == null ? null : bounded(item.conclusion, 80), head_sha: bounded(item.head_sha || '', 128)
      }));
    });
  }

  async merge(auth, input) {
    return this.#withInstallationToken(auth, async (token) => {
      const response = await this.#request(`/repos/${repoPath(input.repository)}/pulls/${positiveInteger(input.pullNumber)}/merge`, {
        method: 'PUT', token, ambiguous: true,
        body: { sha: bounded(input.headSha, 128), merge_method: ['merge', 'squash', 'rebase'].includes(input.method) ? input.method : 'squash' }
      });
      return { merged: response.merged === true, sha: bounded(response.sha || '', 128), message: bounded(response.message || '', 500) };
    });
  }

  async reconcile(auth, input) {
    return this.#withInstallationToken(auth, async (token) => {
      if (input.pullNumber) return pullRequestReceipt(await this.#request(`/repos/${repoPath(input.repository)}/pulls/${positiveInteger(input.pullNumber)}`, { token }));
      const [owner] = String(input.repository).split('/');
      const rows = await this.#request(`/repos/${repoPath(input.repository)}/pulls?state=all&head=${encodeURIComponent(`${owner}:${bounded(input.head, 256)}`)}&per_page=10`, { token });
      const match = Array.isArray(rows) ? rows.find((item) => !input.headSha || item?.head?.sha === input.headSha) : null;
      if (!match) throw new PlatformError('github_pull_request_missing', 'GitHub pull request was not found during reconciliation', {}, 404);
      return pullRequestReceipt(match);
    });
  }

  async deleteRepository(auth, input) {
    return this.#withInstallationToken(auth, async (token) => {
      const repository = repoPath(input.repository);
      const snapshot = await this.#request(`/repos/${repository}`, { token });
      if (input.repositoryId != null && String(input.repositoryId) !== String(snapshot.id || '')) throw new PlatformError('github_repository_identity_conflict', 'GitHub repository identity changed', {}, 409);
      const branch = bounded(input.branch || snapshot.default_branch || 'main', 256);
      const ref = await this.#request(`/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`, { token });
      const head = bounded(ref.object?.sha || '', 128);
      if (head !== bounded(input.expectedHeadSha, 128)) throw new PlatformError('repository_head_conflict', 'GitHub repository HEAD changed before deletion', {}, 409);
      await this.#request(`/repos/${repository}`, { method: 'DELETE', token, ambiguous: true });
      return { deleted: true, repository_id: String(snapshot.id || ''), full_name: bounded(snapshot.full_name || input.repository, 256), head_sha: head };
    });
  }

  async reconcileRepositoryDeletion(auth, input) {
    return this.#withInstallationToken(auth, async (token) => {
      try {
        const snapshot = await this.#request(`/repos/${repoPath(input.repository)}`, { token });
        return { exists: true, repository_id: String(snapshot.id || ''), full_name: bounded(snapshot.full_name || input.repository, 256) };
      } catch (error) {
        if (error?.code === 'github_request_failed' && error?.details?.status === 404) return { exists: false, repository_id: String(input.repositoryId || '') };
        throw error;
      }
    });
  }

  async #withInstallationToken(auth, callback) {
    const jwt = appJwt(auth, this.clock);
    const response = await this.#request(`/app/installations/${positiveInteger(auth.installationId)}/access_tokens`, { method: 'POST', jwt });
    const token = Buffer.from(String(response.token || ''), 'utf8');
    if (!token.length) throw new PlatformError('github_installation_token_missing', 'GitHub installation token was not returned', {}, 503);
    try { return await callback(token); } finally { token.fill(0); }
  }

  async #withRepositoryToken(auth, callback) {
    let jwt = null; let token = null;
    try {
      jwt = Buffer.from(appJwt(auth, this.clock), 'utf8');
      const response = await this.#request(`/app/installations/${positiveInteger(auth.installationId)}/access_tokens`, { method: 'POST', jwt: jwt.toString('utf8') });
      token = Buffer.from(String(response.token || ''), 'utf8');
      if (!token.length) throw new PlatformError('github_installation_token_missing', 'GitHub installation token was not returned', {}, 503);
      return await callback(token);
    } finally { token?.fill(0); jwt?.fill(0); }
  }

  async #request(route, { method = 'GET', body = null, jwt = null, token = null, ambiguous = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    const authorization = jwt ? `Bearer ${jwt}` : `Bearer ${token.toString('utf8')}`;
    try {
      const response = await this.fetch(`${this.apiBaseUrl}${route}`, {
        method,
        signal: controller.signal,
        headers: {
          accept: 'application/vnd.github+json',
          authorization,
          'content-type': 'application/json',
          'user-agent': 'aiws-v3-clean-delivery',
          'x-github-api-version': API_VERSION
        },
        ...(body == null ? {} : { body: canonicalJson(body) })
      });
      const text = await response.text();
      let value = {};
      try { value = text ? JSON.parse(text) : {}; } catch { value = {}; }
      if (!response.ok) {
        const uncertain = ambiguous && response.status >= 500;
        throw new PlatformError(uncertain ? 'external_result_unknown' : 'github_request_failed', uncertain ? 'GitHub result is unknown' : 'GitHub request failed', { status: response.status, request_id: response.headers.get('x-github-request-id') || null }, uncertain ? 503 : response.status === 404 ? 404 : 502);
      }
      return value;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      const unknown = ambiguous || error?.name === 'AbortError';
      throw new PlatformError(unknown ? 'external_result_unknown' : 'github_unavailable', unknown ? 'GitHub result is unknown' : 'GitHub is unavailable', { reason: String(error?.code || error?.name || 'network_error').slice(0, 80) }, 503);
    } finally {
      clearTimeout(timer);
    }
  }

  async #graphql(query, variables = {}, { token, ambiguous = false } = {}) {
    if (!token) throw new PlatformError('github_installation_token_missing', 'GitHub installation token is unavailable', {}, 503);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetch(`${this.apiBaseUrl}/graphql`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token.toString('utf8')}`,
          'content-type': 'application/json',
          'user-agent': 'aiws-v3-clean-delivery'
        },
        body: canonicalJson({ query, variables })
      });
      const text = await response.text();
      let value = {};
      try { value = text ? JSON.parse(text) : {}; } catch { value = {}; }
      if (!response.ok) {
        const unknown = ambiguous && response.status >= 500;
        throw new PlatformError(unknown ? 'external_result_unknown' : 'github_request_failed', unknown ? 'GitHub result is unknown' : 'GitHub request failed', { status: response.status, request_id: response.headers.get('x-github-request-id') || null }, unknown ? 503 : 502);
      }
      if (Array.isArray(value.errors) && value.errors.length) {
        const codes = value.errors.map((item) => String(item?.extensions?.code || 'graphql_error')).slice(0, 4);
        throw new PlatformError('github_request_failed', 'GitHub GraphQL request failed', { status: response.status, error_codes: codes }, 502);
      }
      return value;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      const unknown = ambiguous || error?.name === 'AbortError';
      throw new PlatformError(unknown ? 'external_result_unknown' : 'github_unavailable', unknown ? 'GitHub result is unknown' : 'GitHub is unavailable', { reason: String(error?.code || error?.name || 'network_error').slice(0, 80) }, 503);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class DeterministicGitHubAdapter {
  constructor({ repositories = [{ id: 1, full_name: 'fixture/delivery-target', owner: 'fixture', name: 'delivery-target', default_branch: 'main', private: true, archived: false, permissions: { push: true } }], installations = [], clock = () => new Date().toISOString() } = {}) {
    this.repositories = repositories;
    this.installations = installations;
    this.clock = clock;
    this.calls = [];
    this.pullRequests = new Map();
  }

  async listRepositories(_auth, input = {}) { this.calls.push({ action: 'list', input }); return { repositories: this.repositories.map((item) => ({ ...item })), next_cursor: null }; }
  async listInstallations(_auth, input = {}) { this.calls.push({ action: 'list_installations', input }); return { installations: this.installations.map((item) => ({ ...item })), next_cursor: null }; }
  async createBranch(_auth, input) { this.calls.push({ action: 'create_branch', input: publicInput(input) }); return { ref: `refs/heads/${input.branch}`, sha: input.headSha, created: true }; }
  async createDraft(_auth, input) { const number = this.pullRequests.size + 1; const value = { number, state: 'open', draft: true, merged: false, base_sha: input.baseSha || input.base, head_sha: input.headSha || input.head, updated_at: this.clock() }; this.pullRequests.set(number, value); this.calls.push({ action: 'create_draft', input: publicInput(input) }); return { ...value }; }
  async markReady(_auth, input) { const value = requiredPull(this.pullRequests, input.pullNumber); value.draft = false; value.updated_at = this.clock(); this.calls.push({ action: 'mark_ready', input: publicInput(input) }); return { ...value }; }
  async checks(_auth, input) { this.calls.push({ action: 'checks', input: publicInput(input) }); return (input.requiredChecks || []).map((name, index) => ({ id: index + 1, name, status: 'completed', conclusion: 'success', head_sha: input.ref })); }
  async merge(_auth, input) { const value = requiredPull(this.pullRequests, input.pullNumber); value.state = 'closed'; value.merged = true; value.draft = false; value.head_sha = input.headSha; value.merge_sha = sha256Hex(canonicalJson(publicInput(input))); value.updated_at = this.clock(); this.calls.push({ action: 'merge', input: publicInput(input) }); return { merged: true, sha: value.merge_sha, message: 'merged' }; }
  async reconcile(_auth, input) {
    this.calls.push({ action: 'reconcile', input: publicInput(input) });
    if (input.pullNumber) return { ...requiredPull(this.pullRequests, input.pullNumber) };
    const row = [...this.pullRequests.values()].find((item) => !input.headSha || item.head_sha === input.headSha);
    if (!row) throw new PlatformError('github_pull_request_missing', 'GitHub pull request was not found during reconciliation', {}, 404);
    return { ...row };
  }
  async deleteRepository(_auth, input) {
    const index = this.repositories.findIndex((item) => item.full_name === input.repository);
    if (index < 0) return { deleted: true, repository_id: String(input.repositoryId || ''), already_absent: true };
    const row = this.repositories[index];
    if (input.repositoryId != null && String(row.id) !== String(input.repositoryId)) throw new PlatformError('github_repository_identity_conflict', 'GitHub repository identity changed', {}, 409);
    if (row.head_sha && row.head_sha !== input.expectedHeadSha) throw new PlatformError('repository_head_conflict', 'GitHub repository HEAD changed before deletion', {}, 409);
    this.calls.push({ action: 'delete_repository', input: publicInput(input) });
    this.repositories.splice(index, 1);
    return { deleted: true, repository_id: String(row.id), full_name: row.full_name, head_sha: input.expectedHeadSha };
  }
  async reconcileRepositoryDeletion(_auth, input) {
    const row = this.repositories.find((item) => item.full_name === input.repository);
    this.calls.push({ action: 'reconcile_repository_deletion', input: publicInput(input) });
    return row ? { exists: true, repository_id: String(row.id), full_name: row.full_name } : { exists: false, repository_id: String(input.repositoryId || '') };
  }
}

export function verifyGitHubWebhook(rawBody, signatureHeader, secret) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '');
  const signature = String(signatureHeader || '').toLowerCase();
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`, 'ascii');
  const supplied = Buffer.from(signature, 'ascii');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function appJwt(auth, clock) {
  const appId = bounded(auth.appId, 80);
  const privateKey = Buffer.isBuffer(auth.privateKey) ? auth.privateKey : Buffer.from(auth.privateKey || '');
  if (!privateKey.length) throw new PlatformError('github_private_key_missing', 'GitHub App private key is unavailable', {}, 503);
  const now = Math.floor(Number(clock()) / 1000);
  const header = Buffer.from(canonicalJson({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(canonicalJson({ iat: now - 60, exp: now + 540, iss: appId })).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKey)).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function repositoryView(value = {}) {
  return { id: Number(value.id || 0), full_name: bounded(value.full_name || '', 256), owner: bounded(value.owner?.login || '', 160), name: bounded(value.name || '', 160), default_branch: bounded(value.default_branch || '', 160), private: value.private === true, archived: value.archived === true, permissions: { push: value.permissions?.push === true, maintain: value.permissions?.maintain === true, admin: value.permissions?.admin === true } };
}
function installationView(value = {}) {
  return {
    id: String(value.id || ''),
    account: {
      id: String(value.account?.id || ''),
      login: bounded(value.account?.login || '', 160),
      type: bounded(value.account?.type || '', 40)
    },
    target_type: bounded(value.target_type || '', 40),
    repository_selection: bounded(value.repository_selection || '', 40),
    suspended_at: value.suspended_at || null
  };
}
function pullRequestReceipt(value = {}) { return { number: Number(value.number || 0), state: bounded(value.state || '', 40), draft: value.draft === true, merged: value.merged === true, base_sha: bounded(value.base?.sha || value.base_sha || '', 128), head_sha: bounded(value.head?.sha || value.head_sha || '', 128), merge_sha: value.merge_commit_sha || value.merge_sha || null, updated_at: value.updated_at || null }; }
function repoPath(value) { const result = bounded(value, 256); if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result)) throw new PlatformError('github_repository_invalid', 'GitHub repository is invalid', {}, 422); return result.split('/').map(encodeURIComponent).join('/'); }
function positiveInteger(value) { const result = Number(value); if (!Number.isInteger(result) || result < 1) throw new PlatformError('schema_invalid', 'positive integer is required', {}, 422); return result; }
function bounded(value, maximum) { const result = String(value || ''); if (result.length > maximum) throw new PlatformError('schema_invalid', 'GitHub field exceeds its limit', {}, 422); return result; }
function publicInput(value = {}) { const output = { ...value }; delete output.privateKey; delete output.token; delete output.secret; return output; }
function requiredPull(rows, number) { const row = rows.get(Number(number)); if (!row) throw new PlatformError('github_pull_request_missing', 'GitHub pull request was not found', {}, 404); return row; }

function repoName(value) {
  const result = bounded(value, 256);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result)) throw new PlatformError('github_repository_invalid', 'GitHub repository is invalid', {}, 422);
  return result;
}
function relativeSafe(value) {
  const result = String(value || '').replaceAll('\\', '/');
  if (!result || result.startsWith('/') || result.split('/').includes('..')) throw new PlatformError('repository_source_invalid', 'repository path is invalid', {}, 422);
  return result;
}
function decodeGithubBlob(value) {
  if (String(value?.encoding || '') !== 'base64' || typeof value?.content !== 'string') throw new PlatformError('github_blob_invalid', 'GitHub blob response is invalid', {}, 502);
  try { return Buffer.from(value.content.replace(/\s+/g, ''), 'base64'); } catch { throw new PlatformError('github_blob_invalid', 'GitHub blob response is invalid', {}, 502); }
}
function isLfsPointer(bytes) { return bytes.subarray(0, 128).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1'); }
async function inspectClonedRepository(exec, git, root, maxBytes) {
  const run = async (args) => {
    try { const result = await exec(git, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', root, ...args], { encoding: 'buffer', shell: false, windowsHide: true, timeout: 120000, maxBuffer: maxBytes, env: { PATH: process.env.PATH || process.env.Path || '', SystemRoot: process.env.SystemRoot || '', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } }); return result.stdout; }
    catch { throw new PlatformError('repository_materialization_failed', 'materialized Git repository could not be inspected', {}, 422); }
  };
  const commit = String(await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const tree = String(await run(['rev-parse', '--verify', `${commit}^{tree}`])).trim();
  const raw = String(await run(['ls-tree', '-rz', '--full-tree', commit]));
  const entries = []; let totalBytes = 0;
  for (const record of raw.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    if (!match || !['100644', '100755'].includes(match[1]) || match[2] !== 'blob') throw new PlatformError('repository_source_invalid', 'tracked symlink, submodule or special entry', {}, 422);
    const relative = relativeSafe(match[4]);
    const file = path.join(root, ...relative.split('/'));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PlatformError('repository_source_invalid', 'tracked file is not regular', {}, 422);
    const bytes = fs.readFileSync(file); totalBytes += bytes.length;
    if (entries.length >= 10000 || totalBytes > maxBytes) throw new PlatformError('repository_source_too_large', 'source quota exceeded', {}, 422);
    if (relative === '.gitmodules' || isLfsPointer(bytes)) throw new PlatformError(relative === '.gitmodules' ? 'repository_submodule_unsupported' : 'repository_lfs_unsupported', 'repository feature is unsupported', {}, 422);
    entries.push({ path: relative, mode: match[1], blob_sha1: match[3], sha256: sha256Hex(bytes), byte_length: bytes.length });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const manifestHash = sha256Hex(canonicalJson({ commit, tree, entries }));
  return { commit_sha: commit, tree_sha: tree, manifest_hash: manifestHash, workspace_manifest: entries.map(({ path, sha256, byte_length }) => ({ path, sha256, byte_length })) };
}
