import { spawnSync } from 'node:child_process';

import { collectQualityAnalysis, formatQualityFinding } from './quality-analysis.mjs';
import {
  QUALITY_BASELINE_PATH,
  buildQualityBaseline,
  compareQualityBaselines,
  qualityBaselinesEqual,
  readQualityBaseline,
  validateQualityBaseline
} from './quality-baseline.mjs';
import { ABSOLUTE_FILE_LIMIT } from './quality-policy.mjs';

const blockingOnly = process.argv.includes('--blocking-only'),
  analysis = await collectQualityAnalysis(),
  expectedBaseline = buildQualityBaseline(analysis.findings);
let checkedBaseline;
try {
  checkedBaseline = readQualityBaseline();
} catch (error) {
  fail(`cannot read ${QUALITY_BASELINE_PATH}: ${error.message}\nRun corepack pnpm quality:baseline.`);
}

const failures = [...analysis.errors],
  absoluteFileFailures = analysis.findings.filter(
    (finding) => finding.ruleId === 'max-lines' && finding.value > ABSOLUTE_FILE_LIMIT
  );
failures.push(...absoluteFileFailures);

if (!qualityBaselinesEqual(expectedBaseline, checkedBaseline)) {
  const regressions = compareQualityBaselines(expectedBaseline, checkedBaseline),
    improvements = compareQualityBaselines(checkedBaseline, expectedBaseline);
  console.error(
    `[quality] baseline drift: ${regressions.length} regression(s), ${improvements.length} resolved/improved measurement(s).`
  );
  printFindings('regression', regressions.map(formatRegression), 100);
  if (improvements.length) console.error('[quality] Improvements must be recorded so they cannot return.');
  console.error('[quality] Run corepack pnpm quality:baseline after fixing regressions.');
  process.exit(1);
}

const historical = baselineAtBase();
if (historical) {
  const baselineRegressions = compareQualityBaselines(checkedBaseline, historical);
  if (baselineRegressions.length) {
    printFindings('baseline regression', baselineRegressions.map(formatRegression), 100);
    fail('quality debt increased relative to AIWS_TEST_BASE_SHA');
  }
}

if (failures.length) {
  printFindings('blocking', failures.map(formatQualityFinding), 200);
  process.exit(1);
}

if (!blockingOnly) printDebtSummary(analysis.findings);
console.log(
  `[quality] passed (${analysis.sourceFiles.length} source files, ${analysis.findings.length} ratcheted measurements, 0 regressions)`
);

function baselineAtBase() {
  const base = process.env.AIWS_TEST_BASE_SHA;
  if (!base) return null;
  const result = spawnSync('git', ['show', `${base}:${QUALITY_BASELINE_PATH}`], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) return null;
  try {
    return validateQualityBaseline(JSON.parse(result.stdout));
  } catch (error) {
    fail(`base quality baseline is invalid: ${error.message}`);
  }
}

function printDebtSummary(findings) {
  const byProfile = Object.entries(Object.groupBy(findings, (finding) => finding.profile))
    .map(([profile, items]) => `${profile}=${items.length}`)
    .join(', ');
  console.log(`[quality] ratcheted debt: ${byProfile || 'none'}`);
}

function formatRegression(item) {
  const change = item.previous === null ? `new ${item.value}` : `${item.previous} -> ${item.value}`;
  return `${item.path}:1:1 ${item.ruleId} ${change}`;
}

function printFindings(level, findings, limit) {
  if (!findings.length) return;
  console.error(`[quality] ${findings.length} ${level} finding(s):`);
  for (const finding of findings.slice(0, limit)) console.error(`  ${finding}`);
  if (findings.length > limit) console.error(`  ... ${findings.length - limit} more`);
}

function fail(message) {
  console.error(`[quality] ${message}`);
  process.exit(1);
}
