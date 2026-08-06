import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const API_ROOT = 'https://api.github.com';

export class GitHubIntegrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GitHubIntegrationError';
    this.code = code;
    this.details = details;
  }
}

function encodeRef(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
}

export class GitHubIntegration {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch || globalThis.fetch;
    this.apiRoot = options.apiRoot || API_ROOT;
  }

  get configured() {
    return Boolean(this.config.githubCredential?.token && this.config.githubRepository);
  }

  async request(method, requestPath, body = undefined) {
    if (!this.config.githubCredential?.token) throw new GitHubIntegrationError('github_credential_missing', 'GitHub credential is missing');
    let response;
    try {
      response = await this.fetch(`${this.apiRoot}${requestPath}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.config.githubCredential.token}`,
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'aiws-v3'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      });
    } catch {
      throw new GitHubIntegrationError('github_api_unavailable', 'GitHub API is unavailable');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new GitHubIntegrationError('github_api_failed', 'GitHub API request failed', { status: response.status, request_path: requestPath });
    return data;
  }

  async getRef(ref, { missing = false } = {}) {
    try {
      return await this.request('GET', `/repos/${this.config.githubRepository}/git/ref/${encodeRef(ref)}`);
    } catch (error) {
      if (missing && error.details?.status === 404) return null;
      throw error;
    }
  }

  async probe(expectedFixtureSha = '') {
    const checkedAt = new Date().toISOString();
    if (!this.config.githubCredential?.token) return { provider: 'github', status: 'unavailable', checked_at: checkedAt, error_code: 'credential_missing' };
    if (!this.config.githubRepository) return { provider: 'github', status: 'unavailable', checked_at: checkedAt, error_code: 'repository_missing' };
    try {
      const repository = await this.request('GET', `/repos/${this.config.githubRepository}`);
      if (String(repository.full_name || '').toLowerCase() !== this.config.githubRepository.toLowerCase()) throw new GitHubIntegrationError('github_repository_mismatch', 'GitHub repository does not match configuration');
      if (!repository.permissions || repository.permissions.pull !== true || repository.permissions.push !== true) throw new GitHubIntegrationError('github_permission_missing', 'GitHub token lacks repository read/write permission');
      const fixture = await this.getRef('tags/aiws/fixture-baseline');
      const sha = String(fixture?.object?.sha || '');
      if (!/^[a-f0-9]{40}$/.test(sha) || (expectedFixtureSha && sha !== expectedFixtureSha)) throw new GitHubIntegrationError('github_fixture_mismatch', 'GitHub fixture ref does not match the baseline');
      return { provider: 'github', status: 'available', checked_at: checkedAt, error_code: null };
    } catch (error) {
      const code = error instanceof GitHubIntegrationError ? error.code : 'github_probe_failed';
      return { provider: 'github', status: 'unavailable', checked_at: checkedAt, error_code: code };
    }
  }

  gitEnvironment() {
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${this.config.githubCredential.token}`, 'utf8').toString('base64')}`
    };
  }

  async ensureProjectBranch(projectId, baselineSha) {
    const branch = `aiws/projects/${projectId}`;
    let remote = await this.getRef(`heads/${branch}`, { missing: true });
    if (!remote) {
      const fixture = await this.getRef('tags/aiws/fixture-baseline');
      const fixtureSha = String(fixture?.object?.sha || '');
      if (!/^[a-f0-9]{40}$/.test(fixtureSha) || (baselineSha && fixtureSha !== baselineSha)) throw new GitHubIntegrationError('github_baseline_mismatch', 'execution baseline does not match the fixture ref');
      await this.request('POST', `/repos/${this.config.githubRepository}/git/refs`, { ref: `refs/heads/${branch}`, sha: fixtureSha });
      remote = await this.getRef(`heads/${branch}`);
    }
    const remoteSha = String(remote?.object?.sha || '');
    if (baselineSha && remoteSha !== baselineSha) throw new GitHubIntegrationError('github_baseline_mismatch', 'execution baseline differs from the remote project branch', { expected_sha: baselineSha, actual_sha: remoteSha });
    return { branch, sha: remoteSha };
  }

  async findPullRequest(deliveryBranch) {
    const owner = this.config.githubRepository.split('/')[0];
    const pulls = await this.request('GET', `/repos/${this.config.githubRepository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${deliveryBranch}`)}&per_page=10`);
    return Array.isArray(pulls) ? pulls.find((pull) => pull.head?.ref === deliveryBranch) || null : null;
  }

  async submitDraft({ projectId, deliveryId, baselineSha, diff, title, body }) {
    if (!this.configured) throw new GitHubIntegrationError('github_not_configured', 'GitHub delivery is not configured');
    const project = await this.ensureProjectBranch(projectId, baselineSha);
    const deliveryBranch = `aiws/deliveries/${deliveryId}`;
    const existing = await this.findPullRequest(deliveryBranch);
    if (existing) return { url: existing.html_url, number: existing.number, state: existing.state, draft: Boolean(existing.draft), head_sha: existing.head?.sha, base_branch: project.branch, branch: deliveryBranch };
    const existingBranch = await this.getRef(`heads/${deliveryBranch}`, { missing: true });
    if (existingBranch) {
      const pull = await this.request('POST', `/repos/${this.config.githubRepository}/pulls`, { title: String(title || 'AIWS delivery').slice(0, 256), body: String(body || '').slice(0, 65_000), head: deliveryBranch, base: project.branch, draft: true });
      return { url: pull.html_url, number: pull.number, state: pull.state, draft: Boolean(pull.draft), head_sha: existingBranch.object.sha, base_branch: project.branch, branch: deliveryBranch };
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-github-delivery-'));
    const remote = `https://github.com/${this.config.githubRepository}.git`;
    const env = this.gitEnvironment();
    try {
      await execFileAsync('git', ['clone', '--no-tags', '--single-branch', '--branch', project.branch, remote, directory], { env, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
      const actual = (await execFileAsync('git', ['-C', directory, 'rev-parse', 'HEAD'], { env, encoding: 'utf8', windowsHide: true, timeout: 15_000 })).stdout.trim();
      if (actual !== project.sha) throw new GitHubIntegrationError('github_baseline_mismatch', 'cloned project branch changed during delivery');
      await execFileAsync('git', ['-C', directory, 'switch', '-c', deliveryBranch], { env, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
      const patchFile = path.join(directory, '.aiws-delivery.patch');
      fs.writeFileSync(patchFile, String(diff || ''), { encoding: 'utf8', mode: 0o600 });
      if (String(diff || '').length) await execFileAsync('git', ['-C', directory, 'apply', '--binary', '--whitespace=error-all', patchFile], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
      fs.rmSync(patchFile, { force: true });
      await execFileAsync('node', ['--test'], { cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
      await execFileAsync('git', ['-C', directory, 'diff', '--check'], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      await execFileAsync('git', ['-C', directory, 'add', '--all'], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      await execFileAsync('git', ['-C', directory, '-c', 'user.name=AIWS Delivery', '-c', 'user.email=aiws@example.invalid', 'commit', '--allow-empty', '--no-gpg-sign', '-m', String(title || 'AIWS delivery').slice(0, 200)], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
      const headSha = (await execFileAsync('git', ['-C', directory, 'rev-parse', 'HEAD'], { env, encoding: 'utf8', windowsHide: true, timeout: 15_000 })).stdout.trim();
      await execFileAsync('git', ['-C', directory, 'push', '--set-upstream', 'origin', deliveryBranch], { env, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
      const pull = await this.request('POST', `/repos/${this.config.githubRepository}/pulls`, { title: String(title || 'AIWS delivery').slice(0, 256), body: String(body || '').slice(0, 65_000), head: deliveryBranch, base: project.branch, draft: true });
      return { url: pull.html_url, number: pull.number, state: pull.state, draft: Boolean(pull.draft), head_sha: headSha, base_branch: project.branch, branch: deliveryBranch };
    } catch (error) {
      if (error instanceof GitHubIntegrationError) throw error;
      throw new GitHubIntegrationError('github_delivery_failed', 'GitHub draft delivery failed');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  async merge({ pullNumber, expectedHeadSha, branch }) {
    let pull = await this.request('GET', `/repos/${this.config.githubRepository}/pulls/${Number(pullNumber)}`);
    if (expectedHeadSha && pull.head?.sha !== expectedHeadSha) throw new GitHubIntegrationError('github_head_mismatch', 'pull request head changed before merge');
    let mergeSha = pull.merge_commit_sha || null;
    if (!pull.merged) {
      if (pull.draft) {
        if (!pull.node_id) throw new GitHubIntegrationError('github_pull_not_ready', 'draft pull request identity is missing');
        const ready = await this.request('POST', '/graphql', {
          query: 'mutation MarkReady($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { id isDraft } } }',
          variables: { pullRequestId: pull.node_id }
        });
        if (Array.isArray(ready?.errors) && ready.errors.length) throw new GitHubIntegrationError('github_pull_not_ready', 'GitHub did not mark the draft pull request ready');
        pull = await this.request('GET', `/repos/${this.config.githubRepository}/pulls/${Number(pullNumber)}`);
        if (pull.draft || pull.head?.sha !== expectedHeadSha) throw new GitHubIntegrationError('github_head_mismatch', 'pull request changed while becoming ready');
      }
      const merged = await this.request('PUT', `/repos/${this.config.githubRepository}/pulls/${Number(pullNumber)}/merge`, { sha: expectedHeadSha, merge_method: 'merge' });
      if (!merged.merged) throw new GitHubIntegrationError('github_merge_conflict', 'GitHub declined the merge');
      mergeSha = merged.sha;
    }
    if (branch) {
      try {
        await this.request('DELETE', `/repos/${this.config.githubRepository}/git/refs/heads/${encodeRef(branch)}`);
      } catch (error) {
        if (error?.details?.status !== 404) throw new GitHubIntegrationError('github_branch_delete_failed', 'GitHub delivery branch could not be removed');
      }
    }
    const updated = await this.getRef(`heads/${pull.base.ref}`);
    return { merged: true, merge_sha: mergeSha || updated.object.sha, base_sha: updated.object.sha, base_branch: pull.base.ref, pull_url: pull.html_url };
  }

  async fastForwardLocal(repositoryRoot, branch, expectedSha) {
    const env = this.gitEnvironment();
    const remote = `https://github.com/${this.config.githubRepository}.git`;
    try {
      try {
        await execFileAsync('git', ['-C', repositoryRoot, 'fetch', '--no-tags', remote, `refs/heads/${branch}`], { env, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
      } catch (branchError) {
        if (!/^[a-f0-9]{40}$/.test(String(expectedSha || ''))) throw branchError;
        await execFileAsync('git', ['-C', repositoryRoot, 'fetch', '--no-tags', remote, String(expectedSha)], { env, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
      }
      const fetched = (await execFileAsync('git', ['-C', repositoryRoot, 'rev-parse', 'FETCH_HEAD'], { env, encoding: 'utf8', windowsHide: true, timeout: 15_000 })).stdout.trim();
      if (fetched !== expectedSha) throw new GitHubIntegrationError('github_sync_race', 'remote project branch changed while syncing');
      await execFileAsync('git', ['-C', repositoryRoot, 'merge', '--ff-only', 'FETCH_HEAD'], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
      return fetched;
    } catch (error) {
      if (error instanceof GitHubIntegrationError) throw error;
      throw new GitHubIntegrationError('github_sync_failed', 'local repository synchronization failed');
    }
  }
}
