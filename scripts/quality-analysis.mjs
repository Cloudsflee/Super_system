import fs from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';

import { createEslintConfig, eslintPatterns } from './eslint-config.mjs';
import {
  classifyMeasurement,
  collectSourceFiles,
  evaluateFileLength,
  normalizePath,
  qualityProfileForPath
} from './quality-policy.mjs';

const RULE_KINDS = Object.freeze({
  complexity: 'complexity',
  'max-lines-per-function': 'function',
  'max-len': 'lineLength'
});

export async function collectQualityAnalysis(cwd = process.cwd()) {
  const sourceFiles = collectSourceFiles(cwd),
    fileFindings = sourceFiles
      .map((filePath) => evaluateFileLength(filePath, fs.readFileSync(path.join(cwd, filePath), 'utf8')))
      .filter((finding) => finding.level !== 'ok'),
    eslint = new ESLint({
      cwd,
      errorOnUnmatchedPattern: false,
      overrideConfigFile: true,
      overrideConfig: createEslintConfig('warning')
    }),
    lintResults = await eslint.lintFiles(eslintPatterns),
    lint = collectLintFindings(lintResults, cwd);

  return {
    sourceFiles,
    findings: [...fileFindings, ...lint.findings].sort(compareFindings),
    errors: lint.errors.sort(compareFindings)
  };
}

export function collectLintFindings(results, cwd = process.cwd()) {
  const findings = [],
    errors = [];
  for (const result of results) {
    const filePath = normalizePath(path.relative(cwd, result.filePath)),
      profile = qualityProfileForPath(filePath);
    for (const message of result.messages) {
      const kind = RULE_KINDS[message.ruleId],
        value = kind ? measurementValue(message.ruleId, message.message) : null,
        base = {
          filePath,
          ruleId: message.ruleId || 'parse-error',
          line: message.line || 1,
          column: message.column || 1,
          message: message.message,
          profile
        };
      if (!kind || value === null || message.fatal) {
        errors.push({ ...base, level: 'blocking' });
        continue;
      }
      findings.push({
        ...base,
        kind,
        value,
        level: classifyMeasurement(kind, value, { filePath, profile })
      });
    }
  }
  return { findings, errors };
}

export function measurementValue(ruleId, message) {
  const patterns = {
    complexity: /complexity of (\d+)/,
    'max-lines-per-function': /too many lines \((\d+)\)/,
    'max-len': /length of (\d+)/
  };
  const match = String(message).match(patterns[ruleId]);
  return match ? Number(match[1]) : null;
}

export function formatQualityFinding(finding) {
  const location = `${finding.filePath}:${finding.line || 1}:${finding.column || 1}`;
  if (finding.value === undefined) return `${location} ${finding.ruleId} ${finding.message}`;
  return `${location} ${finding.ruleId} ${finding.value} (${finding.profile}, ${finding.level})`;
}

function compareFindings(left, right) {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.ruleId.localeCompare(right.ruleId) ||
    (left.line || 0) - (right.line || 0) ||
    (left.column || 0) - (right.column || 0)
  );
}
