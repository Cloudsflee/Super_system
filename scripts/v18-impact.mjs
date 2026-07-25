import fs from 'node:fs';
import path from 'node:path';
import {
  isMain,
  matchesAny,
  normalizePath,
  parseArgs,
  runCommandSync,
  utcRunId,
  writeFileEnsured
} from './v175-lib.mjs';

const ROOT = process.cwd(),
  REPORT_ROOT = path.join(ROOT, '.ai-workspace', 'test-reports', 'v1.8');

export function collectV18Impact(base = process.env.AIWS_TEST_BASE_SHA || 'HEAD') {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/v18/impact-map.json'), 'utf8'));
  const changed = new Set();
  if (base !== 'HEAD') add(changed, gitArgs('diff', '--name-only', '--diff-filter=ACDMRTUXB', `${base}...HEAD`));
  add(changed, gitArgs('diff', '--name-only', '--diff-filter=ACDMRTUXB'));
  add(changed, gitArgs('diff', '--cached', '--name-only', '--diff-filter=ACDMRTUXB'));
  add(changed, gitArgs('ls-files', '--others', '--exclude-standard'));
  const files = [...changed].filter((file) => !file.startsWith('temp/') && !file.startsWith('.ai-workspace/')).sort();
  const items = files.map((file) => ({
    file,
    suites: classifyV18ImpactFile(file, map)
  }));
  return {
    version: '1.8',
    base,
    files: items,
    suites: [...new Set(items.flatMap((item) => item.suites))].sort(),
    unclassified: items.filter((item) => !item.suites.length).map((item) => item.file)
  };
}

export function classifyV18ImpactFile(file, map) {
  return [
    ...new Set(
      map.mappings.filter((mapping) => matchesAny(file, mapping.patterns)).flatMap((mapping) => mapping.suites)
    )
  ].sort();
}

export function resolveV18ImpactBase(cliBase, env = process.env) {
  return cliBase || env.AIWS_TEST_BASE_SHA || 'HEAD';
}

function main() {
  const args = parseArgs();
  try {
    const impact = collectV18Impact(resolveV18ImpactBase(args.base));
    if (impact.unclassified.length) throw new Error(`unclassified files:\n${impact.unclassified.join('\n')}`);
    if (args.audit === true)
      console.log(
        `V1.8 impact audit passed (${impact.files.length} changed files; suites=${impact.suites.join(',') || 'none'}; base=${impact.base})`
      );
    else {
      const directory = path.join(REPORT_ROOT, utcRunId('impact-'));
      writeFileEnsured(path.join(directory, 'impact.json'), `${JSON.stringify(impact, null, 2)}\n`);
      writeFileEnsured(
        path.join(directory, '测试影响复查v1.8.md'),
        `# AIWS V1.8 测试影响复查\n\n- Base：\`${impact.base}\`\n- Suites：${impact.suites.join(', ') || 'none'}\n\n${impact.files.map((item) => `- \`${item.file}\`：${item.suites.join(', ')}`).join('\n')}\n`
      );
      console.log(`V1.8 impact review written: ${path.relative(ROOT, directory)}`);
    }
  } catch (error) {
    console.error(`V1.8 impact audit failed: ${error.message}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) main();

function add(target, argv) {
  const result = runCommandSync(argv);
  if (result.status !== 0) throw new Error(`${argv.join(' ')} failed`);
  for (const line of result.stdout.split(/\r?\n/).map(normalizePath).filter(Boolean)) target.add(line);
}
function gitArgs(...args) {
  return ['git', '-c', 'core.quotepath=false', ...args];
}
