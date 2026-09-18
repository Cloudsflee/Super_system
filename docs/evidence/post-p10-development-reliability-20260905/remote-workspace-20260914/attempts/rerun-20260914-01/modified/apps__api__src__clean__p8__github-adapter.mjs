import { createHash, createHmac, createPrivateKey, createSign, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, sha256Hex } from '../canonical.mjs';
import { PlatformError } from '../platform-error.mjs';

const API_VERSION = '2022-11-28';
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export class GitHubAppAdapter {
  constructor({ fetchImpl = globalThis.fetch, apiBaseUrl = 'https://api.github.com', clock = () => Date.now(), timeoutMs = 20_000, git = 'git', execFileImpl = execFileAsync, execFile: execFileOption = null, maxFiles = null, maxFileCount = null, maxBytes = null, maxTotalBytes = null } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('github_fetch_required');
    this.fetch = fetchImpl;
    this.apiBaseUrl = String(apiBaseUrl).replace(/\/$/, '');
    this.clock = clock;
    this.timeoutMs = Number(timeoutMs);
    this.git = git;
    this.execFile = execFileOption || execFileImpl;
    this.maxFiles = positiveLimit(maxFiles ?? maxFileCount, DEFAULT_MAX_FILES);
    this.maxBytes = positiveLimit(maxBytes ?? maxTotalBytes, DEFAULT_MAX_BYTES);
  }

  async inspectRepository(auth, input = {}) {
    try {
      const pin = repositoryPin(input);
      return await this.#withRepositoryToken(auth, (token) => this.#inspectRepositoryWithToken(token, pin));
    } finally {
      clearPrivateKey(auth);
    }
  }

  async materializeRepository(auth, input = {}) {
    try {
      const pin = repositoryPin(input);
      const target = materializationTarget(input.destination);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      return await this.#withRepositoryToken(auth, async (token) => {
      const cloneEnv = repositoryCloneEnv(token);
      const url = `https://github.com/${pin.fullName}.git`;
      try {
        const observedPin = await this.#inspectRepositoryWithToken(token, pin);
        await this.execFile(this.git, [
          '-c', 'core.fsmonitor=false',
          '-c', 'core.hooksPath=',
          '-c', 'core.autocrlf=false',
          'clone', '--depth=1', '--no-tags', '--single-branch',
          '--branch', pin.branch, '--', url, target
        ], {
          encoding: 'buffer', shell: false, windowsHide: true,
          timeout: 120_000, maxBuffer: Math.max(this.maxBytes, 1024 * 1024), env: cloneEnv
        });
        const observed = await inspectClonedRepository(this.execFile, this.git, target, { maxFiles: this.maxFiles, maxBytes: this.maxBytes });
        if (observed.commit_sha !== observedPin.commit_sha || observed.tree_sha !== observedPin.tree_sha || observed.manifest_hash !== observedPin.manifest_hash) {
          throw new PlatformError('source_drift', 'remote Git content changed during materialization', {}, 409);
        }
        fs.rmSync(path.join(target, '.git'), { recursive: true, force: true });
        // A successful workspace contains source bytes only, never Git remote
        // configuration or a credential-bearing metadata file.
        if (fs.existsSync(path.join(target, '.git'))) throw new PlatformError('repository_materialization_failed', 'Git metadata could not be removed', {}, 422);
        return {
          ...observedPin,
          workspace_hash: sha256Hex(canonicalJson(observed.workspace_manifest)),
          workspace_manifest: observed.workspace_manifest
        };
      } catch (error) {
        await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
        if (error instanceof PlatformError) throw error;
        throw new PlatformError('repository_materialization_failed', 'remote Git materialization failed', {}, 422);
      } finally {
        clearSecretFields(cloneEnv);
      }
      });
    } finally {
      clearPrivateKey(auth);
    }
  }

  async listRepositories(auth, { cursor = null, limit = 50 } = {}) {
    try {
      const page = cursor == null ? 1 : Number(cursor);
      if (!Number.isInteger(page) || page < 1) throw new PlatformError('schema_invalid', 'GitHub repository cursor is invalid', {}, 422);
      const count = boundedPageSize(limit);
      return await this.#withInstallationToken(auth, async (token) => {
        const response = await this.#request(`/installation/repositories?per_page=${count}&page=${page}`, { token });
        const repositories = Array.isArray(response.repositories) ? response.repositories.map(repositoryView) : [];
        return { repositories, next_cursor: repositories.length === count ? String(page + 1) : null };
      });
    } finally {
      clearPrivateKey(auth);
    }
  }

  async listInstallations(auth, { cursor = null, limit = 50 } = {}) {
    try {
      const page = cursor == null ? 1 : Number(cursor);
      if (!Number.isInteger(page) || page < 1) throw new PlatformError('schema_invalid', 'GitHub installation cursor is invalid', {}, 422);
      const count = boundedPageSize(limit);
      let jwt = null;
      try {
        jwt = Buffer.from(appJwt(auth, this.clock), 'utf8');
        const response = await this.#request(`/app/installations?per_page=${count}&page=${page}`, { jwt: jwt.toString('utf8') });
        const installations = Array.isArray(response) ? response.map(installationView) : [];
        return { installations, next_cursor: installations.length === count ? String(page + 1) : null };
      } finally {
        jwt?.fill(0);
      }
    } finally {
      clearPrivateKey(auth);
    }
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
    return this.#withRepositoryToken(auth, callback);
  }

  async #withRepositoryToken(auth, callback) {
    let jwt = null;
    let token = null;
    try {
      jwt = Buffer.from(appJwt(auth, this.clock), 'utf8');
      const response = await this.#request(
        `/app/installations/${positiveInteger(auth.installationId)}/access_tokens`,
        { method: 'POST', jwt: jwt.toString('utf8') }
      );
      token = installationToken(response?.token);
      return await callback(token);
    } finally {
      token?.fill(0);
      jwt?.fill(0);
      clearPrivateKey(auth);
    }
  }

  async #inspectRepositoryWithToken(token, pin) {
    const repository = await this.#request(`/repos/${repoPath(pin.fullName)}`, { token });
    const repositoryId = safeRepositoryId(repository?.id);
    if (!repositoryId) {
      throw new PlatformError('github_repository_id_invalid', 'GitHub repository id is invalid', {}, 502);
    }
    if (pin.repositoryId != null && repositoryId !== String(pin.repositoryId)) {
      throw new PlatformError('github_repository_id_mismatch', 'GitHub repository id does not match the pin', {}, 409);
    }
    const returnedName = normalizeFullName(repository?.full_name);
    if (returnedName.toLowerCase() !== pin.fullName.toLowerCase()) {
      throw new PlatformError('github_repository_full_name_mismatch', 'GitHub repository full name does not match the pin', {}, 409);
    }

    const ref = await this.#request(
      `/repos/${repoPath(pin.fullName)}/git/ref/heads/${encodeURIComponent(pin.branch)}`,
      { token }
    );
    const head = sha40(ref?.object?.sha);
    if (!head) throw new PlatformError('github_branch_head_invalid', 'GitHub branch head is invalid', {}, 502);
    if (pin.expectedHeadSha && head.toLowerCase() !== pin.expectedHeadSha.toLowerCase()) {
      throw new PlatformError('github_branch_head_mismatch', 'GitHub branch head does not match the pin', {}, 409);
    }

    const commit = await this.#request(`/repos/${repoPath(pin.fullName)}/commits/${encodeURIComponent(head)}`, { token });
    const treeSha = sha40(commit?.commit?.tree?.sha);
    if (!treeSha) throw new PlatformError('github_tree_invalid', 'GitHub tree is invalid', {}, 502);
    const tree = await this.#request(
      `/repos/${repoPath(pin.fullName)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
      { token }
    );
    if (tree?.truncated === true) throw new PlatformError('repository_source_too_large', 'GitHub tree is truncated', {}, 422);
    if (!Array.isArray(tree?.tree)) throw new PlatformError('github_tree_invalid', 'GitHub tree response is invalid', {}, 502);

    const entries = [];
    const paths = new Set();
    const portablePaths = new Set();
    let totalBytes = 0;
    // Recursive tree responses contain directory rows as well as files. Only
    // regular blobs become manifest entries; every other file mode/type is
    // rejected rather than silently copied.
    for (const item of tree.tree) {
      const mode = String(item?.mode || '');
      const type = String(item?.type || '');
      if (type === 'tree' && mode === '040000') continue;
      const relative = relativeSafe(item?.path);
      if (type === 'commit' || mode === '160000') {
        throw new PlatformError('repository_submodule_unsupported', 'Git submodules are not supported', {}, 422);
      }
      if (mode === '120000') {
        throw new PlatformError('repository_source_invalid', 'symbolic links are not supported', {}, 422);
      }
      if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
        throw new PlatformError('repository_source_invalid', 'tracked special files are not supported', {}, 422);
      }
      if (isGitmodules(relative)) throw new PlatformError('repository_submodule_unsupported', 'Git submodule metadata is not supported', {}, 422);
      const portable = portablePathKey(relative);
      if (paths.has(relative) || portablePaths.has(portable)) throw new PlatformError('repository_source_invalid', 'repository tree contains duplicate paths', {}, 422);
      paths.add(relative);
      portablePaths.add(portable);
      if (entries.length >= this.maxFiles) throw new PlatformError('repository_source_too_large', 'source file quota exceeded', {}, 422);
      const blobSha = sha40(item?.sha);
      if (!blobSha) throw new PlatformError('github_blob_invalid', 'GitHub blob identity is invalid', {}, 502);
      const advertisedSize = item?.size == null ? null : nonNegativeInteger(item.size);
      if (advertisedSize == null && item?.size != null) throw new PlatformError('github_blob_invalid', 'GitHub blob size is invalid', {}, 502);
      if (advertisedSize != null && advertisedSize > this.maxBytes - totalBytes) throw new PlatformError('repository_source_too_large', 'source byte quota exceeded', {}, 422);
      const blob = await this.#request(`/repos/${repoPath(pin.fullName)}/git/blobs/${encodeURIComponent(blobSha)}`, { token });
      const bytes = decodeGithubBlob(blob, this.maxBytes - totalBytes);
      try {
        if (advertisedSize != null && bytes.length !== advertisedSize) throw new PlatformError('github_blob_invalid', 'GitHub blob size does not match the tree', {}, 502);
        if (blob?.sha != null && sha40(blob.sha) !== blobSha) throw new PlatformError('github_blob_invalid', 'GitHub blob identity does not match the tree', {}, 502);
        if (isLfsPointer(bytes)) throw new PlatformError('repository_lfs_unsupported', 'Git LFS pointers are not supported', {}, 422);
        if (gitBlobSha1(bytes) !== blobSha) throw new PlatformError('github_blob_invalid', 'GitHub blob content does not match the tree', {}, 502);
        totalBytes += bytes.length;
        if (totalBytes > this.maxBytes) throw new PlatformError('repository_source_too_large', 'source byte quota exceeded', {}, 422);
        entries.push({ path: relative, mode, blob_sha1: blobSha, sha256: sha256Hex(bytes), byte_length: bytes.length });
      } finally {
        bytes.fill(0);
      }
    }
    entries.sort(compareManifestEntries);
    const manifestHash = sha256Hex(canonicalJson({ commit: head, tree: treeSha, entries }));
    return {
      repository_id: repositoryId,
      full_name: returnedName,
      branch: pin.branch,
      revision: head,
      commit_sha: head,
      tree_sha: treeSha,
      hash: manifestHash,
      manifest_hash: manifestHash,
      api_head_sha: head,
      entries,
      file_count: entries.length,
      total_bytes: totalBytes
    };
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
      const ok = response?.ok === true || (response?.ok == null && Number(response?.status || 200) >= 200 && Number(response?.status || 200) < 300);
      if (!ok) {
        const uncertain = ambiguous && response.status >= 500;
        const failure = new PlatformError(uncertain ? 'external_result_unknown' : 'github_request_failed', uncertain ? 'GitHub result is unknown' : 'GitHub request failed', { status: response.status, request_id: responseHeader(response, 'x-github-request-id') }, uncertain ? 503 : response.status === 404 ? 404 : 502);
        failure.retryable = uncertain || response.status === 408 || response.status === 429 || response.status >= 500;
        throw failure;
      }
      return value;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      const unknown = ambiguous || error?.name === 'AbortError';
      const failure = new PlatformError(unknown ? 'external_result_unknown' : 'github_unavailable', unknown ? 'GitHub result is unknown' : 'GitHub is unavailable', { reason: String(error?.code || error?.name || 'network_error').slice(0, 80), retryable: true }, 503);
      failure.retryable = true;
      throw failure;
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
      const ok = response?.ok === true || (response?.ok == null && Number(response?.status || 200) >= 200 && Number(response?.status || 200) < 300);
      if (!ok) {
        const unknown = ambiguous && response.status >= 500;
        const failure = new PlatformError(unknown ? 'external_result_unknown' : 'github_request_failed', unknown ? 'GitHub result is unknown' : 'GitHub request failed', { status: response.status, request_id: responseHeader(response, 'x-github-request-id') }, unknown ? 503 : 502);
        failure.retryable = unknown || response.status === 408 || response.status === 429 || response.status >= 500;
        throw failure;
      }
      if (Array.isArray(value.errors) && value.errors.length) {
        const codes = value.errors.map((item) => String(item?.extensions?.code || 'graphql_error')).slice(0, 4);
        throw new PlatformError('github_request_failed', 'GitHub GraphQL request failed', { status: response.status, error_codes: codes }, 502);
      }
      return value;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      const unknown = ambiguous || error?.name === 'AbortError';
      const failure = new PlatformError(unknown ? 'external_result_unknown' : 'github_unavailable', unknown ? 'GitHub result is unknown' : 'GitHub is unavailable', { reason: String(error?.code || error?.name || 'network_error').slice(0, 80), retryable: true }, 503);
      failure.retryable = true;
      throw failure;
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
  const appId = bounded(auth?.appId, 80);
    const source = Buffer.isBuffer(auth?.privateKey) || auth?.privateKey instanceof Uint8Array
      ? Buffer.from(auth.privateKey)
    : Buffer.from(String(auth?.privateKey || ''), 'utf8');
    if (!appId) throw new PlatformError('github_app_id_missing', 'GitHub App id is unavailable', {}, 503);
    if (!source.length) throw new PlatformError('github_private_key_missing', 'GitHub App private key is unavailable', {}, 503);
  try {
    const now = epochSeconds(clock);
    const header = Buffer.from(canonicalJson({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(canonicalJson({ iat: now - 60, exp: now + 540, iss: appId })).toString('base64url');
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    signer.end();
    const signature = signer.sign(createPrivateKey(source)).toString('base64url');
    return `${header}.${payload}.${signature}`;
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError('github_private_key_invalid', 'GitHub App private key is invalid', {}, 422);
  } finally {
    source.fill(0);
  }
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
function boundedPageSize(value) {
  const result = value == null || value === '' ? 50 : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 100) throw new PlatformError('schema_invalid', 'GitHub page size is invalid', {}, 422);
  return result;
}
function bounded(value, maximum) { const result = String(value || ''); if (result.length > maximum) throw new PlatformError('schema_invalid', 'GitHub field exceeds its limit', {}, 422); return result; }
function publicInput(value = {}) { const output = { ...value }; delete output.privateKey; delete output.token; delete output.secret; return output; }
function requiredPull(rows, number) { const row = rows.get(Number(number)); if (!row) throw new PlatformError('github_pull_request_missing', 'GitHub pull request was not found', {}, 404); return row; }
function responseHeader(response, name) {
  const headers = response?.headers;
  if (typeof headers?.get === 'function') return headers.get(name) || null;
  if (headers && typeof headers === 'object') {
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? String(headers[key]) : null;
  }
  return null;
}

function repositoryPin(input = {}) {
  const fullName = normalizeFullName(input.fullName ?? input.full_name ?? input.repository);
  const branch = normalizeBranch(input.branch, { defaultValue: 'main' });
  const repositoryId = input.repositoryId ?? input.repository_id ?? null;
  if (repositoryId != null && !safeRepositoryId(repositoryId)) throw new PlatformError('github_repository_id_invalid', 'GitHub repository id is invalid', {}, 422);
  const expectedHeadSha = input.expectedHeadSha ?? input.expected_head_sha ?? null;
  if (expectedHeadSha != null && expectedHeadSha !== '' && !sha40(expectedHeadSha)) {
    throw new PlatformError('github_branch_head_invalid', 'expected GitHub branch HEAD is invalid', {}, 422);
  }
  return {
    repositoryId: repositoryId == null || repositoryId === '' ? null : String(repositoryId),
    fullName,
    branch,
    expectedHeadSha: expectedHeadSha == null || expectedHeadSha === '' ? null : String(expectedHeadSha).toLowerCase()
  };
}

function normalizeFullName(value) {
  let raw = String(value ?? '').trim();
  if (!raw) throw new PlatformError('github_repository_invalid', 'GitHub repository is required', {}, 422);
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try { parsed = new URL(raw); } catch { throw new PlatformError('github_repository_invalid', 'GitHub repository URL is invalid', {}, 422); }
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.includes('\\') || /(?:^|\/)\.\.?(?:\/|$)/.test(parsed.pathname) || /%2e/i.test(parsed.pathname)) {
      throw new PlatformError('github_repository_invalid', 'GitHub repository URL is invalid', {}, 422);
    }
    raw = parsed.pathname.replace(/^\/+|\/+$/g, '');
  }
  raw = raw.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  const segments = raw.split('/');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new PlatformError('github_repository_invalid', 'GitHub repository name is invalid', {}, 422);
  }
  return raw;
}

function normalizeBranch(value, { defaultValue = null } = {}) {
  const branch = String(value == null || value === '' ? (defaultValue ?? '') : value).trim();
  if (!branch || branch.length > 256 || branch === '@' || branch.startsWith('-') || branch.startsWith('/') || branch.startsWith('refs/') || branch.endsWith('/') || branch.endsWith('.lock') || branch.includes('//') || branch.includes('\\') || branch.includes('..') || branch.includes('@{') || branch.includes('~') || branch.includes('^') || branch.includes(':') || branch.includes('?') || branch.includes('*') || branch.includes('[') || branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.')) || /[\u0000-\u0020\u007f]/.test(branch)) {
    throw new PlatformError('github_branch_invalid', 'GitHub branch is invalid', {}, 422);
  }
  return branch;
}

function sha40(value) {
  const result = String(value ?? '');
  return /^[a-f0-9]{40}$/i.test(result) ? result.toLowerCase() : null;
}

function relativeSafe(value) {
  const result = String(value ?? '');
  const parts = result.split('/');
  const portable = result.toLowerCase();
  if (!result || result.includes('\\') || result.includes('\u0000') || result.startsWith('/') || /^[A-Za-z]:/.test(result) || portable === '.git' || portable.startsWith('.git/') || parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part) || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
    throw new PlatformError('repository_source_invalid', 'repository path is invalid', {}, 422);
  }
  return result;
}

function isGitmodules(value) { const pathName = String(value).toLowerCase(); return pathName === '.gitmodules' || pathName.endsWith('/.gitmodules'); }

function decodeGithubBlob(value, remainingBytes = DEFAULT_MAX_BYTES) {
  if (String(value?.encoding || '') !== 'base64' || typeof value?.content !== 'string') {
    throw new PlatformError('github_blob_invalid', 'GitHub blob response is invalid', {}, 502);
  }
  const compact = value.content.replace(/\s+/g, '');
  if (compact.length > Math.ceil(Math.max(0, Number(remainingBytes)) / 3) * 4 + 4) throw new PlatformError('repository_source_too_large', 'source byte quota exceeded', {}, 422);
  if (compact.length % 4 === 1 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new PlatformError('github_blob_invalid', 'GitHub blob encoding is invalid', {}, 502);
  }
  const bytes = Buffer.from(compact, 'base64');
  const canonical = bytes.toString('base64').replace(/=+$/, '');
  if (canonical !== compact.replace(/=+$/, '')) {
    bytes.fill(0);
    throw new PlatformError('github_blob_invalid', 'GitHub blob encoding is invalid', {}, 502);
  }
  return bytes;
}

function isLfsPointer(bytes) {
  const head = bytes.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '');
  return /^version https:\/\/git-lfs\.github\.com\/spec\/v1(?:\r?\n|$)/.test(head);
}

function gitBlobSha1(bytes) {
  const digest = createHash('sha1');
  digest.update(Buffer.from(`blob ${bytes.length}\u0000`, 'utf8'));
  digest.update(bytes);
  return digest.digest('hex');
}

function compareManifestEntries(a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; }
function portablePathKey(value) { return String(value).normalize('NFC').toLowerCase(); }

function materializationTarget(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new PlatformError('repository_source_invalid', 'materialization destination is required', {}, 422);
  const target = path.resolve(raw);
  if (fs.existsSync(target)) throw new PlatformError('repository_source_invalid', 'materialization requires a new directory', {}, 409);
  return target;
}

function repositoryCloneEnv(token) {
  const value = `Authorization: Bearer ${Buffer.isBuffer(token) ? token.toString('utf8') : String(token)}`;
  return {
    PATH: process.env.PATH || process.env.Path || '',
    SystemRoot: process.env.SystemRoot || '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_NOGLOBAL: '1',
    GIT_ASKPASS: 'true',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: value
  };
}

function clearSecretFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (/token|authorization|credential|secret|private|jwt|header|git_config_value/i.test(key)) {
      if (Buffer.isBuffer(value[key])) value[key].fill(0);
      else if (typeof value[key] === 'string') value[key] = '';
    }
  }
}

function clearPrivateKey(auth) {
  if (!auth?.reusable && (Buffer.isBuffer(auth?.privateKey) || auth?.privateKey instanceof Uint8Array)) auth.privateKey.fill(0);
}

function installationToken(value) {
  const token = Buffer.from(String(value ?? ''), 'utf8');
  if (!token.length || token.length > 4096 || !/^\S+$/.test(token.toString('utf8'))) {
    token.fill(0);
    const error = new PlatformError('github_installation_token_missing', 'GitHub installation token is invalid', { retryable: true }, 503);
    error.retryable = true;
    throw error;
  }
  return token;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function positiveLimit(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new PlatformError('repository_quota_invalid', 'repository quota is invalid', {}, 422);
  return number;
}

function safeRepositoryId(value) {
  const text = String(value ?? '');
  const number = Number(text);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(number) ? String(number) : null;
}

function epochSeconds(clock) {
  const value = typeof clock === 'function' ? clock() : clock;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new PlatformError('github_clock_invalid', 'GitHub clock is invalid', {}, 500);
  return Math.floor(number > 10_000_000_000 ? number / 1000 : number);
}

async function inspectClonedRepository(execFileImpl, git, root, { maxFiles = DEFAULT_MAX_FILES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('materialized_root_invalid');
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError('repository_materialization_failed', 'materialized Git root is invalid', {}, 422);
  }
  const run = async (args) => {
    try {
      const result = await execFileImpl(git, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', '-C', root, ...args], {
        encoding: 'buffer', shell: false, windowsHide: true, timeout: 120000,
        maxBuffer: Math.max(maxBytes, 1024 * 1024), env: {
          PATH: process.env.PATH || process.env.Path || '', SystemRoot: process.env.SystemRoot || '',
          GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_NOGLOBAL: '1'
        }
      });
      return result?.stdout ?? Buffer.alloc(0);
    } catch {
      throw new PlatformError('repository_materialization_failed', 'materialized Git repository could not be inspected', {}, 422);
    }
  };
  const commit = String(await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const tree = String(await run(['rev-parse', '--verify', `${commit}^{tree}`])).trim();
  if (!sha40(commit) || !sha40(tree)) throw new PlatformError('repository_materialization_failed', 'materialized Git revision is invalid', {}, 422);
  const raw = Buffer.from(await run(['ls-tree', '-rz', '--full-tree', commit]));
  const records = raw.toString('utf8').split('\0').filter(Boolean);
  const entries = []; const paths = new Set(); const portablePaths = new Set(); let totalBytes = 0;
  for (const record of records) {
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/i.exec(record);
    if (!match) throw new PlatformError('repository_source_invalid', 'materialized Git tree is invalid', {}, 422);
    if (match[2] === 'tree' && match[1] === '040000') continue;
    if (match[2] === 'commit' || match[1] === '160000') throw new PlatformError('repository_submodule_unsupported', 'Git submodules are not supported', {}, 422);
    if (match[1] === '120000') throw new PlatformError('repository_source_invalid', 'symbolic links are not supported', {}, 422);
    if (match[2] !== 'blob' || !['100644', '100755'].includes(match[1])) throw new PlatformError('repository_source_invalid', 'tracked special files are not supported', {}, 422);
    const relative = relativeSafe(match[4]);
    const portable = portablePathKey(relative);
    if (paths.has(relative) || portablePaths.has(portable)) throw new PlatformError('repository_source_invalid', 'materialized Git tree contains duplicate paths', {}, 422);
    paths.add(relative);
    portablePaths.add(portable);
    if (entries.length >= maxFiles) throw new PlatformError('repository_source_too_large', 'source file quota exceeded', {}, 422);
    const file = path.join(root, ...relative.split('/'));
    let stat;
    try { stat = fs.lstatSync(file); } catch { throw new PlatformError('source_drift', 'tracked file is missing', {}, 409); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PlatformError('repository_source_invalid', 'tracked file is not regular', {}, 422);
    const bytes = fs.readFileSync(file);
    try {
      totalBytes += bytes.length;
      if (totalBytes > maxBytes) throw new PlatformError('repository_source_too_large', 'source byte quota exceeded', {}, 422);
      if (isGitmodules(relative)) throw new PlatformError('repository_submodule_unsupported', 'Git submodule metadata is not supported', {}, 422);
      if (isLfsPointer(bytes)) throw new PlatformError('repository_lfs_unsupported', 'Git LFS pointers are not supported', {}, 422);
      if (gitBlobSha1(bytes) !== match[3].toLowerCase()) throw new PlatformError('source_drift', 'materialized Git blob differs from its object id', {}, 409);
      entries.push({ path: relative, mode: match[1], blob_sha1: match[3].toLowerCase(), sha256: sha256Hex(bytes), byte_length: bytes.length });
    } finally { bytes.fill(0); }
  }
  entries.sort(compareManifestEntries);
  verifyMaterializedTree(root, entries, { maxFiles, maxBytes });
  const manifestHash = sha256Hex(canonicalJson({ commit, tree, entries }));
  return {
    commit_sha: commit,
    tree_sha: tree,
    manifest_hash: manifestHash,
    workspace_manifest: entries.map(({ path, sha256, byte_length }) => ({ path, sha256, byte_length }))
  };
}

function verifyMaterializedTree(root, entries, { maxFiles, maxBytes }) {
  const expected = new Set(entries.map((entry) => entry.path));
  const expectedByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const observed = new Set();
  let count = 0;
  let bytes = 0;
  const visit = (directory, relativeDirectory = '') => {
    let children;
    try { children = fs.readdirSync(directory, { withFileTypes: true }); } catch { throw new PlatformError('repository_materialization_failed', 'materialized workspace could not be read', {}, 422); }
    for (const child of children) {
      if (!relativeDirectory && child.name === '.git') continue;
      const relative = relativeSafe(relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name);
      const file = path.join(directory, child.name);
      let stat;
      try { stat = fs.lstatSync(file); } catch { throw new PlatformError('repository_materialization_failed', 'materialized workspace entry disappeared', {}, 422); }
      if (stat.isSymbolicLink()) throw new PlatformError('repository_source_invalid', 'materialized workspace contains a symbolic link', {}, 422);
      if (stat.isDirectory()) { visit(file, relative); continue; }
      if (!stat.isFile()) throw new PlatformError('repository_source_invalid', 'materialized workspace contains a special file', {}, 422);
      if (!expected.has(relative) || observed.has(relative)) throw new PlatformError('source_drift', 'materialized workspace contains an unexpected file', {}, 409);
      const bytesValue = fs.readFileSync(file);
      try {
        const expectedEntry = expectedByPath.get(relative);
        if (bytesValue.length !== Number(expectedEntry.byte_length) || sha256Hex(bytesValue) !== expectedEntry.sha256) throw new PlatformError('source_drift', 'materialized workspace bytes differ from the API pin', {}, 409);
      } finally {
        bytesValue.fill(0);
      }
      observed.add(relative);
      count += 1;
      bytes += stat.size;
      if (count > maxFiles || bytes > maxBytes) throw new PlatformError('repository_source_too_large', 'source quota exceeded', {}, 422);
    }
  };
  visit(root);
  if (count !== entries.length || bytes !== entries.reduce((sum, entry) => sum + Number(entry.byte_length || 0), 0) || observed.size !== expected.size) {
    throw new PlatformError('source_drift', 'materialized workspace manifest differs from the API pin', {}, 409);
  }
}
