import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, runCommand, writeFileEnsured } from './v175-lib.mjs';

const args = parseArgs(),
  reportDir = path.resolve(String(args['report-dir'] || ''));
if (!args['report-dir']) {
  console.error('--report-dir is required');
  process.exit(2);
}
const unitDir = path.join(reportDir, 'coverage', 'unit'),
  webDir = path.join(reportDir, 'coverage', 'web');
fs.mkdirSync(unitDir, { recursive: true });
fs.mkdirSync(webDir, { recursive: true });

const unit = await runCommand(
  [
    'pnpm',
    'exec',
    'c8',
    '--all',
    '--src',
    'apps/api/src',
    '--src',
    'packages/shared/src',
    '--reporter',
    'json-summary',
    '--reports-dir',
    unitDir,
    'node',
    'scripts/v175-suite.mjs',
    'unit-all'
  ],
  { timeout: 600000, inherit: true }
);
if (unit.status !== 0) {
  console.error('unit coverage collection failed');
  process.exit(1);
}

const web = await runCommand(
  [
    'pnpm',
    '--filter',
    '@aiws/web',
    'exec',
    'vitest',
    'run',
    '--coverage',
    '--coverage.all',
    '--coverage.reporter=json-summary',
    `--coverage.reportsDirectory=${webDir}`
  ],
  { timeout: 600000, inherit: true }
);
if (web.status !== 0) {
  console.error('web coverage collection failed');
  process.exit(1);
}

const unitSummary = readSummary(path.join(unitDir, 'coverage-summary.json'));
const webSummary = readSummary(path.join(webDir, 'coverage-summary.json'));
const summary = {
  generated_at: new Date().toISOString(),
  policy: 'diagnostic-only',
  targets: { p0: { lines: 90, branches: 85 }, other: { lines: 80, branches: 70 } },
  unit: evaluate(unitSummary, /(?:state-migration|managed-workspace|assist-operation|codex-build|workflow|vault)/i),
  web: evaluate(webSummary, /(?:assist|operation|onboarding|workflow|api[\\/]client)/i)
};
summary.gap_count = summary.unit.gap_count + summary.web.gap_count;
summary.displayed_gap_count = summary.unit.gaps.length + summary.web.gaps.length;
writeFileEnsured(path.join(reportDir, 'coverage-summary.json'), JSON.stringify(summary, null, 2));
console.log(`V1.75 coverage diagnostic completed (gaps=${summary.gap_count}; thresholds are record-only)`);

function readSummary(file) {
  if (!fs.existsSync(file)) throw new Error(`coverage summary missing: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function evaluate(value, p0Pattern) {
  const gaps = [];
  for (const [file, metrics] of Object.entries(value)) {
    if (file === 'total') continue;
    const p0 = p0Pattern.test(file),
      target = p0 ? { lines: 90, branches: 85 } : { lines: 80, branches: 70 };
    const lines = Number(metrics.lines?.pct || 0),
      branches = Number(metrics.branches?.pct || 0);
    if (lines < target.lines || branches < target.branches)
      gaps.push({ file: path.relative(process.cwd(), file).replaceAll('\\', '/'), p0, lines, branches, target });
  }
  return {
    total: { lines: Number(value.total?.lines?.pct || 0), branches: Number(value.total?.branches?.pct || 0) },
    gap_count: gaps.length,
    displayed_gap_limit: 50,
    gaps: gaps.sort((a, b) => Number(b.p0) - Number(a.p0) || a.lines - b.lines).slice(0, 50)
  };
}
