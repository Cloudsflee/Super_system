import fs from 'node:fs';

import { collectQualityAnalysis } from './quality-analysis.mjs';
import {
  QUALITY_BASELINE_PATH,
  buildQualityBaseline,
  compareQualityBaselines,
  readQualityBaseline,
  serializeQualityBaseline
} from './quality-baseline.mjs';

const analysis = await collectQualityAnalysis();
if (analysis.errors.length) {
  console.error(`[quality-baseline] refusing to record ${analysis.errors.length} parser/configuration error(s)`);
  process.exit(1);
}

const candidate = buildQualityBaseline(analysis.findings);
if (fs.existsSync(QUALITY_BASELINE_PATH)) {
  const current = readQualityBaseline(),
    regressions = compareQualityBaselines(candidate, current);
  if (regressions.length) {
    console.error(`[quality-baseline] refusing to increase ${regressions.length} measurement(s):`);
    for (const item of regressions.slice(0, 100)) {
      const previous = item.previous === null ? 'new' : item.previous;
      console.error(`  ${item.path}: ${item.ruleId} ${previous} -> ${item.value}`);
    }
    process.exit(1);
  }
}

fs.writeFileSync(QUALITY_BASELINE_PATH, serializeQualityBaseline(candidate), 'utf8');
console.log(
  `[quality-baseline] recorded ${candidate.entries.length} files / ${analysis.findings.length} measurements in ${QUALITY_BASELINE_PATH}`
);
