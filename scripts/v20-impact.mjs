#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import { matchesAny, normalizePath, parseArgs, readJson } from './v175-lib.mjs';

const args = parseArgs();
const impact = readJson('tests/v20/impact-map.json');
const catalog = readJson('tests/v20/catalog.json');
const knownTests = new Set(catalog.tests.map((item) => item.id));
const errors = [];
if (impact.version !== '2.0' || impact.match_mode !== 'all' || !impact.mappings?.length)
  errors.push('impact map header invalid');
for (const mapping of impact.mappings || []) {
  if (!mapping.domain || !mapping.patterns?.length || !mapping.tests?.length)
    errors.push(`impact mapping incomplete: ${mapping.domain || 'unknown'}`);
  for (const id of mapping.tests || []) if (!knownTests.has(id)) errors.push(`${mapping.domain}: unknown test ${id}`);
}

const files = changedFiles();
const classified = files.map((file) => ({
  file,
  domains: impact.mappings.filter((mapping) => matchesAny(file, mapping.patterns)).map((mapping) => mapping.domain)
}));
const unclassified = classified.filter((item) => !item.domains.length).map((item) => item.file);
if (unclassified.length) errors.push(`unclassified changed files: ${unclassified.join(', ')}`);
const auditedTrackedFiles = args.audit ? trackedFiles() : [];
if (args.audit) {
  for (const file of [
    'packages/system-context/src/index.mjs',
    'apps/api/src/context-service.mjs',
    'apps/web/src/features/context/ContextMapPage.tsx',
    'docker/v20-upgrade.mjs',
    'scripts/v20-release.mjs',
    '.github/PULL_REQUEST_TEMPLATE.md'
  ])
    if (!impact.mappings.some((mapping) => matchesAny(file, mapping.patterns)))
      errors.push(`impact audit fixture unclassified: ${file}`);
  const unclassifiedTracked = auditedTrackedFiles.filter(
    (file) => !impact.mappings.some((mapping) => matchesAny(file, mapping.patterns))
  );
  if (unclassifiedTracked.length)
    errors.push(`impact audit tracked files unclassified: ${unclassifiedTracked.join(', ')}`);
}
const selectedTests = [
  ...new Set(
    classified.flatMap((entry) =>
      impact.mappings.filter((mapping) => entry.domains.includes(mapping.domain)).flatMap((mapping) => mapping.tests)
    )
  )
].sort();

if (errors.length) {
  console.error(`V2.0 impact gate failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      version: '2.0',
      changed_files: files.length,
      ...(args.audit ? { audited_tracked_files: auditedTrackedFiles.length } : {}),
      domains: [...new Set(classified.flatMap((item) => item.domains))].sort(),
      selected_tests: selectedTests,
      unclassified: []
    },
    null,
    2
  )
);

function changedFiles() {
  const tracked = git(['diff', '--name-only', '--diff-filter=ACMRD', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/).map(normalizePath).filter(Boolean))].sort();
}

function trackedFiles() {
  return git(['ls-files']).split(/\r?\n/).map(normalizePath).filter(Boolean);
}

function git(argv) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...argv], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${argv.join(' ')} failed`).trim());
  return String(result.stdout || '');
}
