import fs from 'node:fs';
import { ESLint } from 'eslint';
import { createEslintConfig, eslintPatterns } from './eslint-config.mjs';
import { collectSourceFiles, evaluateFileLength, normalizePath } from './quality-policy.mjs';

const sourceFiles = collectSourceFiles();
const blockingOnly = process.argv.includes('--blocking-only');
const fileFindings = sourceFiles
  .map((filePath) => evaluateFileLength(filePath, fs.readFileSync(filePath, 'utf8')))
  .filter((finding) => finding.level !== 'ok');

const warningResults = blockingOnly ? [] : await lintAtLevel('warning');
const blockingResults = await lintAtLevel('blocking');
const warnings = [
  ...fileFindings.filter((finding) => finding.level === 'warning').map(formatFileFinding),
  ...collectLintMessages(warningResults, 1)
];
const blockers = [
  ...fileFindings.filter((finding) => finding.level === 'blocking').map(formatFileFinding),
  ...collectLintMessages(blockingResults, 2)
];

if (!blockingOnly) printFindings('warning', warnings, 80);
if (blockers.length > 0) {
  printFindings('blocking', blockers, 200);
  process.exit(1);
}

console.log(
  `[quality] passed (${sourceFiles.length} source files, ${blockingOnly ? 'warnings skipped' : `${warnings.length} warnings`}, 0 blockers)`
);

async function lintAtLevel(level) {
  const eslint = new ESLint({
    cwd: process.cwd(),
    errorOnUnmatchedPattern: false,
    overrideConfigFile: true,
    overrideConfig: createEslintConfig(level)
  });
  return eslint.lintFiles(eslintPatterns);
}

function collectLintMessages(results, severity) {
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.severity === severity)
      .map((message) => {
        const location = `${normalizePath(result.filePath).replace(`${normalizePath(process.cwd())}/`, '')}:${message.line}:${message.column}`;
        return `${location} ${message.ruleId || 'parse-error'} ${message.message}`;
      })
  );
}

function formatFileFinding(finding) {
  return `${finding.filePath}:1:1 max-lines File has ${finding.value} lines`;
}

function printFindings(level, findings, limit) {
  if (findings.length === 0) return;
  console.error(`[quality] ${findings.length} ${level} finding(s):`);
  for (const finding of findings.slice(0, limit)) console.error(`  ${finding}`);
  if (findings.length > limit) console.error(`  ... ${findings.length - limit} more`);
}
