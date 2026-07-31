#!/usr/bin/env node
import { matchesAny, parseArgs, readJson } from './v175-lib.mjs';
import { collectImpactRange, trackedFilesNul } from './impact-range.mjs';

const args = parseArgs(),
  impact = readJson('tests/v22/impact-map.json'),
  catalog = readJson('tests/v22/catalog.json'),
  knownTests = new Set(catalog.tests.map((item) => item.id)),
  errors = [];
if (impact.version !== '2.2' || impact.match_mode !== 'all' || !impact.mappings?.length)
  errors.push('impact map header invalid');
for (const mapping of impact.mappings || []) {
  if (!mapping.domain || !mapping.patterns?.length || !mapping.tests?.length)
    errors.push(`impact mapping incomplete: ${mapping.domain || 'unknown'}`);
  for (const id of mapping.tests || []) if (!knownTests.has(id)) errors.push(`${mapping.domain}: unknown test ${id}`);
}

let range;
try {
  range = collectImpactRange({ base: args.base, head: args.head });
} catch (error) {
  console.error(
    `V2.2 impact gate failed: ${error.code || error.message}${error.details ? ` ${JSON.stringify(error.details)}` : ''}`
  );
  process.exit(1);
}
const classified = range.files.map((file) => ({
    file,
    domains: impact.mappings.filter((mapping) => matchesAny(file, mapping.patterns)).map((mapping) => mapping.domain)
  })),
  unclassified = classified.filter((item) => !item.domains.length).map((item) => item.file);
if (unclassified.length) errors.push(`unclassified changed files: ${unclassified.join(', ')}`);
const auditedTrackedFiles = args.audit ? trackedFilesNul() : [];
if (args.audit) {
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
  console.error(`V2.2 impact gate failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      version: '2.2',
      mode: range.mode,
      base_sha: range.base_sha,
      head_sha: range.head_sha,
      changed_files: range.files,
      changed_file_count: range.files.length,
      changes: range.changes,
      ...(args.audit ? { audited_tracked_files: auditedTrackedFiles.length } : {}),
      domains: [...new Set(classified.flatMap((item) => item.domains))].sort(),
      selected_tests: selectedTests,
      unclassified: []
    },
    null,
    2
  )
);
