import fs from 'node:fs';
import path from 'node:path';
import { ROOT, limitedLog, readJson, runCommand } from './v175-lib.mjs';

const group = process.argv[2], groups = readJson('tests/v175/suite-files.json');
const files = group === 'unit-all' ? [...new Set(Object.entries(groups).filter(([name]) => name.startsWith('unit-')).flatMap(([, values]) => values))] : groups[group];
if (!Array.isArray(files) || !files.length) {
  console.error(`unknown or empty V1.75 suite group: ${group || '<missing>'}`);
  process.exit(2);
}

const failures = [], started = Date.now();
for (const file of files) {
  if (!fs.existsSync(path.join(ROOT, file))) { failures.push(`${file}: missing`); continue; }
  const result = await runCommand(['node', '--disable-warning=ExperimentalWarning', file], { timeout: Number(process.env.AIWS_TEST_FILE_TIMEOUT_MS || 240000), inherit: true });
  const state = result.timedOut ? 'TIMEOUT' : result.status === 0 ? 'PASS' : 'FAIL';
  console.log(`[v175-suite] ${state} ${file} (${result.durationMs}ms)`);
  if (state !== 'PASS') failures.push(`${file}: ${state}\n${limitedLog(`${result.stdout}\n${result.stderr}`)}`);
}

console.log(`[v175-suite] ${group}: ${files.length - failures.length}/${files.length} passed (${Date.now() - started}ms)`);
if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}
