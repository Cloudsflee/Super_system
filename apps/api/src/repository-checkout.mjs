import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { command, HttpError } from './http.mjs';
import { git, isGitRepo } from './git-utils.mjs';
import { createInstallationToken, githubGitAuthEnv, resolveGithubAppConfig } from './github-service.mjs';
import { managedProjectRoot, managedRepoPath } from './project-lifecycle.mjs';

export async function ensureRepositoryCheckout(state, { project, installation, repository, adapted = false, adaptedFailure = null }) {
  const currentBinding = state.repository_bindings.find((item) => item.project_id === project.id && item.status !== 'removed');
  const root = managedProjectRoot(project.id);
  const target = managedRepoPath(project.id);
  await fsp.mkdir(root, { recursive: true });
  if (isGitRepo(target) && currentBinding && String(currentBinding.repository_id) === String(repository.id)) return verifyCheckout(target, repository, false);
  if (fs.existsSync(target) && (await fsp.readdir(target)).length) throw new HttpError(409, { error: 'repository_checkout_path_not_empty', path: target });

  if (adapted) {
    if (adaptedFailure === 'clone') throw new HttpError(409, { error: 'repository_clone_failed', detail: 'test checkout clone failure' });
    await fsp.mkdir(target, { recursive: true });
    const initialized = git(target, ['init'], 10000);
    if (!initialized.ok) throw new HttpError(409, { error: 'repository_clone_failed', detail: initialized.stderr || initialized.error });
    const configured = git(target, ['remote', 'add', 'origin', `https://github.com/${repository.full_name}.git`], 5000);
    if (!configured.ok) throw new HttpError(409, { error: 'git_remote_configuration_failed', detail: configured.stderr || configured.error });
    if (adaptedFailure === 'head' || adaptedFailure === 'remote') {
      await fsp.rm(target, { recursive: true, force: true });
      throw new HttpError(409, { error: adaptedFailure === 'head' ? 'repository_head_verification_failed' : 'repository_remote_verification_failed' });
    }
    return verifyCheckout(target, repository, true);
  }

  const config = resolveGithubAppConfig(state);
  if (!config) throw new HttpError(409, { error: 'github_app_config_required' });
  const access = await createInstallationToken(config, installation.installation_id);
  const env = githubGitAuthEnv(access.token);
  const remote = `https://github.com/${repository.full_name}.git`;
  const result = command('git', ['clone', '--origin', 'origin', remote, target], root, 120000, env);
  if (!result.ok) {
    if (within(root, target)) await fsp.rm(target, { recursive: true, force: true });
    throw new HttpError(409, { error: 'repository_clone_failed', detail: result.stderr || result.error });
  }
  return verifyCheckout(target, repository, true);
}

function verifyCheckout(target, repository, cloned) {
  const remoteName = configureRemote(target, repository);
  const head = git(target, ['rev-parse', '--verify', 'HEAD'], 5000);
  if (!head.ok) {
    const unborn = git(target, ['symbolic-ref', '--quiet', 'HEAD'], 5000);
    if (!unborn.ok) throw new HttpError(409, { error: 'repository_head_verification_failed' });
  }
  const remote = git(target, ['remote', 'get-url', remoteName], 5000);
  if (!remote.ok || normalizeRemote(remote.stdout) !== normalizeRemote(`https://github.com/${repository.full_name}.git`)) throw new HttpError(409, { error: 'repository_remote_verification_failed' });
  return { repo_path: target, cloned, remote_name: remoteName, head: head.ok ? head.stdout.trim() : null, ready: true };
}

function configureRemote(repoPath, repository) {
  const expected = `https://github.com/${repository.full_name}.git`;
  const origin = git(repoPath, ['remote', 'get-url', 'origin'], 5000);
  if (!origin.ok) { const added = git(repoPath, ['remote', 'add', 'origin', expected], 5000); if (!added.ok) throw new HttpError(409, { error: 'git_remote_configuration_failed', detail: added.stderr || added.error }); return 'origin'; }
  if (normalizeRemote(origin.stdout) === normalizeRemote(expected)) return 'origin';
  const dedicated = git(repoPath, ['remote', 'get-url', 'aiws-github'], 5000);
  const configured = dedicated.ok ? git(repoPath, ['remote', 'set-url', 'aiws-github', expected], 5000) : git(repoPath, ['remote', 'add', 'aiws-github', expected], 5000);
  if (!configured.ok) throw new HttpError(409, { error: 'git_remote_configuration_failed', detail: configured.stderr || configured.error });
  return 'aiws-github';
}

function safe(value) { return String(value || 'repository').replace(/[^a-zA-Z0-9._-]/g, '_'); }
function within(root, target) { const relative = path.relative(root, target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
function normalizeRemote(value) { return String(value || '').trim().replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '').toLowerCase(); }
