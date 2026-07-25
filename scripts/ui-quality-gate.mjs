import fs from 'node:fs';
import { collectSourceFiles } from './quality-policy.mjs';

const webComponents = collectSourceFiles().filter((file) => /^apps[\\/]web[\\/]src[\\/].*\.tsx$/.test(file));
const violations = webComponents.flatMap((file) => findUiViolations(file, fs.readFileSync(file, 'utf8')));

if (violations.length > 0) {
  console.error(`[ui-quality] ${violations.length} violation(s):\n${violations.join('\n')}`);
  process.exit(1);
}

console.log(`[ui-quality] passed (${webComponents.length} TSX modules)`);

export function findUiViolations(file, source) {
  const violations = [];
  if (/<(?:button|span|div|small|code)\b[^>]*\btitle=/.test(source)) {
    violations.push(`${file}: native title attribute`);
  }
  for (const match of source.matchAll(/<button\b([^>]*)>\s*<[A-Z][A-Za-z0-9]*\b[^>]*\/>\s*<\/button>/g)) {
    if (!/aria-label=/.test(match[1])) violations.push(`${file}: bare icon button without aria-label`);
  }
  return violations;
}
