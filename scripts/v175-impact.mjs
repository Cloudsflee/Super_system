import fs from 'node:fs';
import path from 'node:path';
import { collectImpactRange } from './impact-range.mjs';
import {
  REPORT_ROOT,
  ROOT,
  isMain,
  matchesAny,
  normalizePath,
  parseArgs,
  readJson,
  redactText,
  runCommandSync,
  utcRunId,
  writeFileEnsured
} from './v175-lib.mjs';

export function collectImpact(
  base = process.env.AIWS_TEST_BASE_SHA || 'HEAD',
  head = process.env.AIWS_TEST_HEAD_SHA || null
) {
  const map = readJson('tests/v175/impact-map.json'),
    exactRange = head ? collectImpactRange({ base, head }) : null,
    changed = exactRange ? new Set(exactRange.files) : collectWorkingTreeFiles(base),
    files = [...changed].sort(),
    classified = [],
    unclassified = [],
    ignored = [];
  for (const file of files) {
    const mappingIndex = map.mappings.findIndex((mapping) => matchesAny(file, mapping.patterns));
    if (mappingIndex >= 0)
      classified.push({
        file,
        mapping_index: mappingIndex,
        domains: map.mappings[mappingIndex].domains,
        priority: map.mappings[mappingIndex].priority
      });
    else if (isBusinessFile(file, map)) unclassified.push(file);
    else ignored.push(file);
  }
  const domains = [...new Set(classified.flatMap((item) => item.domains))].sort();
  return {
    version: map.version,
    base: exactRange?.base_sha || base,
    head: exactRange?.head_sha || gitText(['git', 'rev-parse', 'HEAD']),
    files,
    classified,
    unclassified,
    ignored,
    domains,
    has_p0: classified.some((item) => item.priority === 'P0')
  };
}

function collectWorkingTreeFiles(base) {
  const verified = runCommandSync(['git', 'rev-parse', '--verify', `${base}^{commit}`]);
  if (verified.status !== 0) throw new Error(`invalid base revision: ${base}`);
  const changed = new Set();
  if (base !== 'HEAD')
    addGitNames(changed, ['git', 'diff', '--name-only', '--diff-filter=ACDMRTUXB', `${base}...HEAD`]);
  addGitNames(changed, ['git', 'diff', '--name-only', '--diff-filter=ACDMRTUXB']);
  addGitNames(changed, ['git', 'diff', '--cached', '--name-only', '--diff-filter=ACDMRTUXB']);
  addGitNames(changed, ['git', 'ls-files', '--others', '--exclude-standard']);
  return changed;
}

function addGitNames(target, command) {
  const result = runCommandSync(command);
  if (result.status !== 0) throw new Error(`${command.slice(0, 3).join(' ')} failed: ${result.stderr.trim()}`);
  for (const line of result.stdout.split(/\r?\n/).map(normalizePath).filter(Boolean)) target.add(line);
}

function gitText(command) {
  const result = runCommandSync(command);
  return result.status === 0 ? result.stdout.trim() : 'unavailable';
}

function isBusinessFile(file, map) {
  if (matchesAny(file, map.exclude || [])) return false;
  return (
    (map.business_roots || []).some((root) => file === root || file.startsWith(`${root}/`)) ||
    (map.business_files || []).includes(file)
  );
}

function validateDecision(impact, decision, reason) {
  const allowed = new Set(['existing-valid', 'tests-updated', 'not-needed']);
  if (!allowed.has(decision)) throw new Error('decision must be existing-valid, tests-updated, or not-needed');
  if (String(reason || '').trim().length < 8) throw new Error('impact reason must contain at least 8 characters');
  if (decision === 'existing-valid' && (!/(?:断言|覆盖|assert|expect|test)/i.test(reason) || reason.trim().length < 20))
    throw new Error('existing-valid must explain which existing assertion still covers the change');
  if (decision === 'not-needed' && impact.has_p0) throw new Error('not-needed is forbidden for impacted P0 domains');
}

function markdown(impact, decision, reason) {
  const lines = [
    '# AIWS V1.75 测试影响复查',
    '',
    `- Base：\`${impact.base}\``,
    `- Head：\`${impact.head}\``,
    `- 决策：\`${decision}\``,
    `- 理由：${redactText(reason)}`,
    `- 受影响域：${impact.domains.length ? impact.domains.map((item) => `\`${item}\``).join('、') : '无'}`,
    `- P0 影响：${impact.has_p0 ? '是' : '否'}`,
    '',
    '## 文件分类',
    '',
    '| 文件 | 优先级 | 测试域 |',
    '|---|---|---|'
  ];
  for (const item of impact.classified)
    lines.push(`| \`${item.file}\` | ${item.priority} | ${item.domains.join(', ')} |`);
  if (!impact.classified.length) lines.push('| _无变更_ | - | - |');
  lines.push('', '## 未分类业务文件', '');
  lines.push(...(impact.unclassified.length ? impact.unclassified.map((file) => `- \`${file}\``) : ['- 无']));
  lines.push('', `生成时间：${new Date().toISOString()}`, '');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(),
    audit = args.audit === true;
  if (!audit && !args.base) throw new Error('--base is required');
  const impact = collectImpact(args.base || process.env.AIWS_TEST_BASE_SHA || 'HEAD');
  if (impact.unclassified.length) throw new Error(`unclassified business files:\n${impact.unclassified.join('\n')}`);
  if (audit) {
    console.log(
      `V1.75 impact audit passed (${impact.files.length} changed files; domains=${impact.domains.join(',') || 'none'}; base=${impact.base})`
    );
    return;
  }
  validateDecision(impact, args.decision, args.reason);
  const directory = args.output ? path.dirname(path.resolve(args.output)) : path.join(REPORT_ROOT, utcRunId('impact-'));
  const file = args.output ? path.resolve(args.output) : path.join(directory, '测试影响复查v1.75.md');
  writeFileEnsured(file, markdown(impact, args.decision, args.reason));
  writeFileEnsured(
    path.join(directory, 'impact.json'),
    JSON.stringify(
      { ...impact, decision: args.decision, reason: redactText(args.reason), generated_at: new Date().toISOString() },
      null,
      2
    )
  );
  console.log(`V1.75 impact review written: ${path.relative(ROOT, file)}`);
}

if (isMain(import.meta.url))
  main().catch((error) => {
    console.error(`V1.75 impact review failed: ${error.message}`);
    process.exit(1);
  });
