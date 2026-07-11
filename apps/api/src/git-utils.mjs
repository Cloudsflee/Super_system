import fs from 'node:fs';
import { command } from './http.mjs';

export function isGitRepo(repoPath) { return Boolean(repoPath && fs.existsSync(repoPath) && command('git', ['rev-parse', '--is-inside-work-tree'], repoPath, 3000).ok); }
export function git(repoPath, args, timeout = 10000, env = {}) { return command('git', args, repoPath, timeout, env); }
export function parseGitStatus(status) { return String(status || '').split(/\r?\n/).filter(Boolean).map((line) => ({ status: line.slice(0, 2).trim() || 'modified', path: line.slice(3).trim() })); }
export function gitSummary(repoPath) { if (!isGitRepo(repoPath)) return { repo_path: repoPath, is_git_repo: false, status: 'not_git_repo' }; return { repo_path: repoPath, is_git_repo: true, branch: git(repoPath, ['branch', '--show-current'], 5000).stdout.trim(), head: git(repoPath, ['rev-parse', 'HEAD'], 5000).stdout.trim(), status: git(repoPath, ['status', '--porcelain'], 5000).stdout }; }
