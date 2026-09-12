import { spawnSync } from 'node:child_process';

export const P10_FINAL_TAG = 'p10-final-governance-20260829';
export const P10_FINAL_TAG_COMMIT = '74ba5aa3adaf6b72f1a795d47859eaa3f77449f2';
export const P10_FROZEN_PATHS = Object.freeze([
  'AGENTS.md',
  'docs/architecture',
  'docs/evidence',
  'apps/api/src/clean/migrations',
  'apps/api/src/migrations'
]);
export const P10_APPEND_ONLY_MAINTENANCE_PATHS = Object.freeze({
  'AGENTS.md': '## Post-P10 development reliability maintenance',
  'docs/architecture/decision-log.md': '## D-040 - Post-P10 development reliability and dual-channel verification',
  'docs/architecture/v23-capability-matrix.md': '## Post-P10 development reliability synchronization',
  'docs/architecture/v3-clean-development-plan.md': '## 21. Post-P10 development reliability maintenance'
});
export const P10_ADDITIVE_MAINTENANCE_PREFIXES = Object.freeze([
  'docs/evidence/post-p10-development-reliability-20260905/',
  'docs/evidence/post-p10-real-development-loop-20260911/',
  'docs/evidence/post-p10-real-development-loop-20260912-134500/',
  'docs/evidence/post-p10-real-development-loop-'
]);
export const P10_CATALOG_PATHS = Object.freeze(['feature-catalog.json', 'feature-catalog.clean.json', 'feature-catalog.historical.json']);

export function postClosureFailures({ root, verification, tag = P10_FINAL_TAG, expectedTagCommit = P10_FINAL_TAG_COMMIT, prePushHead = process.env.AIWS_PRE_PUSH_HEAD || null } = {}) {
  const failures = [];
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
    return result.status === 0 ? String(result.stdout || '').trim() : '';
  };
  const succeeds = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 }).status === 0;
  const gitRaw = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
    return result.status === 0 ? String(result.stdout || '') : null;
  };
  const head = git(['rev-parse', 'HEAD']);
  const tagCommit = git(['rev-parse', `${tag}^{}`]);

  if (git(['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') failures.push('annotated_tag');
  if (!tagCommit || tagCommit !== expectedTagCommit) failures.push('tag_commit');
  if (!head || !tagCommit || !succeeds(['merge-base', '--is-ancestor', tagCommit, head])) failures.push('tag_ancestry');

  const upstream = git(['rev-parse', '@{u}']);
  if (prePushHead) {
    if (prePushHead !== head) failures.push('pre_push_head');
  } else if (!upstream || upstream !== head) failures.push('upstream_head');
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (status.status !== 0 || String(status.stdout || '').trim()) failures.push('worktree_clean');

  const implementation = String(verification?.implementation_commit || verification?.source_commit || '');
  if (!/^[a-f0-9]{40}$/.test(implementation)) failures.push('implementation_commit');
  else {
    const tree = git(['show', '-s', '--format=%T', implementation]);
    if (!tree || tree !== verification?.runtime_tree) failures.push('runtime_tree');
    if (!tagCommit || !succeeds(['merge-base', '--is-ancestor', implementation, tagCommit])) failures.push('implementation_tag_ancestry');
  }

  if (tagCommit && head) {
    const changed = git(['diff', '--name-only', `${tagCommit}..${head}`, '--', ...P10_FROZEN_PATHS]).split(/\r?\n/).filter(Boolean);
    for (const rawFile of changed) {
      const file = rawFile.replaceAll('\\', '/');
      const marker = P10_APPEND_ONLY_MAINTENANCE_PATHS[file];
      if (marker) {
        const baseline = gitRaw(['show', `${tagCommit}:${file}`]);
        const current = gitRaw(['show', `${head}:${file}`]);
        if (baseline != null && current != null && current.startsWith(baseline) && current.slice(baseline.length).includes(marker)) continue;
      }
      if (P10_ADDITIVE_MAINTENANCE_PREFIXES.some((prefix) => file.startsWith(prefix))
        && !succeeds(['cat-file', '-e', `${tagCommit}:${file}`])) continue;
      failures.push(`frozen_path:${file}`);
    }
    for (const file of P10_CATALOG_PATHS) {
      const baseline = catalogStatusProjection(git(['show', `${tagCommit}:${file}`]));
      const current = catalogStatusProjection(git(['show', `${head}:${file}`]));
      if (!baseline || !current || baseline !== current) failures.push(`catalog_status:${file}`);
    }
  }
  return [...new Set(failures)].sort();
}

function catalogStatusProjection(source) {
  try {
    const value = JSON.parse(source);
    if (!Array.isArray(value.features)) return null;
    const rows = value.features.map((entry) => ({ id: String(entry.id || ''), status: String(entry.status || '') })).sort((left, right) => left.id.localeCompare(right.id));
    if (rows.some((entry) => !entry.id || !entry.status) || new Set(rows.map((entry) => entry.id)).size !== rows.length) return null;
    return JSON.stringify(rows);
  } catch { return null; }
}
