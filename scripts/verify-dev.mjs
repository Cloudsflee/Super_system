import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveGitCommit } from './lib/git-blob.mjs';
import {
  executableInvocation,
  nodeInvocation,
  pnpmInvocation,
  gateBudget,
  gateRecordFailure,
  runGateCommand
} from './lib/gate-process.mjs';

export const DEV_RESULT_SCHEMA = 'aiws.v3-clean.dev-verification.v1';
export const DEV_RECEIPT_SCHEMA = 'aiws.v3-clean.dev-verification-receipt.v1';
const LOCAL_RECEIPT_DIRECTORY = '.ai-workspace/gate-receipts';

const COMMAND_ORDER = [
  'check', 'scan-clean', 'git-diff-check', 'audit-p1', 'audit-parity',
  'recovery-plan', 'recovery-catalog', 'recovery-coverage', 'recovery-impact',
  'test-p1', 'test-p2', 'test-p3', 'test-p31', 'test-p4', 'test-p5', 'test-p6', 'test-p7', 'test-p8', 'test-p9', 'test-p10',
  'unit-test', 'web-typecheck', 'web-test',
  'integration-clean', 'integration-historical', 'integration',
  'security-clean', 'security-historical', 'security',
  'p4-performance', 'p6-performance', 'p7-performance', 'p8-performance',
  'build', 'e2e'
];

const GOVERNANCE_PATTERNS = [
  /^AGENTS\.md$/,
  /^package\.json$/,
  /^feature-catalog(?:\.(?:clean|historical|index))?\.json$/,
  /^docs\/(?:testing\.md|architecture\/)/,
  /^\.githooks\//,
  /^scripts\/(?:check|verify|verify-dev|test|layered-gate)\.mjs$/,
  /^scripts\/lib\/(?:gate-process|port-lease|git-blob|v3-clean-p1-scope)\.mjs$/,
  /^tests\/(?:p1|p31|p10)\/(?:.*governance|.*gate|development-reliability).*\.test\.mjs$/
];
const GOLDEN_PATTERNS = [
  /^tests\/golden\//,
  /^tests\/unit\/recovery-golden\.test\.mjs$/,
  /^tests\/integration\/mcp-stdio-r5\.test\.mjs$/,
  /^scripts\/(?:recovery-golden|mcp-stdio)\.mjs$/,
  /^scripts\/lib\/git-blob\.mjs$/
];
const SHARED_CORE_PATTERNS = [
  /^apps\/api\/src\/clean\/(?:database|operations|events|authorization|registry|command-dispatcher|runtime|http|app-server-adapter)\.mjs$/,
  /^apps\/api\/src\/clean\/migrations\//,
  /^apps\/api\/src\/modules\/registry\.mjs$/,
  /^apps\/api\/src\/(?:command-registry|query-registry|http)\.mjs$/
];
const WEB_DEEP_PATTERNS = [
  /^scripts\/lib\/port-lease\.mjs$/,
  /^apps\/web\/(?:vite\.config|src\/(?:App|router|routes|sw|service-worker|shell))[^/]*\.(?:ts|tsx|js|mjs)$/,
  /^scripts\/e2e\.mjs$/
];
const MAINTENANCE_NO_PHASE_PATTERNS = [
  /^scripts\/development-receipt\.mjs$/,
  /^scripts\/e2e\.mjs$/
];
const EXTERNAL_SIDE_EFFECT_PATTERN = /(?:scripts\/[^\s]*(?:github|deletion|release|assist|docker-runner|bridge-runner|host-runner|parser)[^\s]*-probe\.mjs|\btest:release\b)/i;

export async function main(argv = process.argv.slice(2), root = process.cwd(), dependencies = {}) {
  const started = Date.now();
  let parsed;
  try { parsed = parseArguments(argv); }
  catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
  let repository;
  try { repository = (dependencies.repositoryState || repositoryState)(root, parsed.base); }
  catch (error) { process.stderr.write(`${error.code || 'verify_dev_repository_error'}:${error.message}\n`); return 2; }
  const catalog = (dependencies.loadCatalog || loadCatalog)(root);
  const selection = selectDevCommands({ changedPaths: repository.changed_paths, catalog, all: parsed.all });
  const baseResult = {
    schema_version: DEV_RESULT_SCHEMA,
    mode: parsed.all ? 'all' : 'incremental',
    base: repository.base,
    base_source: repository.base_source,
    head: repository.head,
    changed_paths: repository.changed_paths,
    base_paths: repository.base_paths || [],
    worktree_paths: repository.worktree_paths || [],
    staged_paths: repository.staged_paths || [],
    untracked_paths: repository.untracked_paths || [],
    catalog_ids: selection.catalog_ids,
    owners: selection.owners,
    selected_commands: selection.commands.map(publicSelection),
    unclassified_paths: selection.unclassified_paths
  };
  if (parsed.explain) {
    process.stdout.write(`${JSON.stringify({ ...baseResult, status: selection.unclassified_paths.length ? 'failed' : 'planned', duration_ms: Date.now() - started, commands: [], clean_blocking: selection.unclassified_paths.map((changedPath) => ({ code: 'unclassified_changed_path', path: changedPath })), historical_advisory: [], receipt: null }, null, 2)}\n`);
    return selection.unclassified_paths.length ? 1 : 0;
  }

  const records = [];
  const cleanBlocking = selection.unclassified_paths.map((changedPath) => ({ code: 'unclassified_changed_path', path: changedPath }));
  const historicalAdvisory = [];
  if (!cleanBlocking.length) {
    const runOne = async (command, budget) => {
      process.stdout.write(`\n== dev:${command.id} ==\n`);
      const result = await (dependencies.runGateCommand || runGateCommand)(command.invocation, {
        cwd: root,
        workspaceRoot: root,
        cwdRole: 'repository-root',
        timeoutMs: Math.min(command.timeoutMs, budget.remaining_ms),
        maxCaptureBytes: 16 * 1024 * 1024,
        env: command.env
      });
      const layered = command.layered ? parseLayeredResult(result.output.stdout) : null;
      const policyFailure = gateRecordFailure(result);
      if (policyFailure) { result.ok = false; result.error_code = policyFailure; }
      if (command.layered && result.ok && !layered) {
        result.ok = false;
        result.error_code = 'gate_command_failed';
        result.exit_status = 1;
        result.output.stderr = `${result.output.stderr}\nlayered_gate_result_missing`.trim();
      }
      const advisory = result.ok && layered?.status === 'advisory';
      const { invocation, env, ...selectionMetadata } = command;
      return { record: { ...selectionMetadata, ...result, layered_status: layered?.status || null, advisory }, advisory, failure: !result.ok || (!command.historical && layered?.status === 'failed') ? { code: result.error_code || 'gate_command_failed', command: command.id } : null };
    };
    // The performance probe uses isolated temporary state, so overlap it with
    // the repository-sensitive sequential gates. This keeps the fixed wall
    // budget while avoiding races in workspace inventory tests.
    if (!dependencies.runGateCommand) {
      const performance = selection.commands.filter((command) => command.id.endsWith('-performance'));
      const regular = selection.commands.filter((command) => !command.id.endsWith('-performance'));
      const initialBudget = gateBudget('development', Date.now() - started);
      const performanceRuns = performance.map((command) => runOne(command, initialBudget));
      for (const command of regular) {
        const budget = gateBudget('development', Date.now() - started);
        if (budget.remaining_ms <= 0) { cleanBlocking.push({ code: 'development_time_budget_exceeded' }); break; }
        const item = await runOne(command, budget);
        records.push(item.record);
        if (item.advisory) historicalAdvisory.push({ command: item.record.id, receipt: null });
        if (item.failure) cleanBlocking.push(item.failure);
      }
      for (const item of await Promise.all(performanceRuns)) {
        records.push(item.record);
        if (item.advisory) historicalAdvisory.push({ command: item.record.id, receipt: null });
        if (item.failure) cleanBlocking.push(item.failure);
      }
    } else for (const command of selection.commands) {
      const budget = gateBudget('development', Date.now() - started);
      if (budget.remaining_ms <= 0) { cleanBlocking.push({ code: 'development_time_budget_exceeded' }); break; }
      const item = await runOne(command, budget);
      records.push(item.record);
      if (item.advisory) historicalAdvisory.push({ command: item.record.id, receipt: null });
      if (item.failure) { cleanBlocking.push(item.failure); break; }
    }
  }
  const budget = gateBudget('development', Date.now() - started);
  if (budget.exceeded && !cleanBlocking.some(failure => failure.code === 'development_time_budget_exceeded')) cleanBlocking.push({ code: 'development_time_budget_exceeded' });
  const status = cleanBlocking.length ? 'failed' : historicalAdvisory.length ? 'advisory' : 'passed';
  const receipt = {
    ...baseResult,
    schema_version: DEV_RECEIPT_SCHEMA,
    status,
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    budget,
    clean_blocking: cleanBlocking,
    historical_advisory: historicalAdvisory,
    commands: records
  };
  const receiptPath = status === 'passed' ? null : writeLocalReceipt(root, receipt);
  const result = {
    ...baseResult,
    status,
    duration_ms: receipt.duration_ms,
    budget,
    commands: records.map(publicRecord),
    clean_blocking: cleanBlocking,
    historical_advisory: historicalAdvisory,
    receipt: receiptPath
  };
  process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);
  return status === 'failed' ? 1 : 0;
}

export function parseArguments(argv) {
  const result = { base: null, all: false, explain: false };
  const values = [...argv];
  while (values.length) {
    const value = values.shift();
    if (value === '--') continue;
    if (value === '--all') result.all = true;
    else if (value === '--explain') result.explain = true;
    else if (value === '--base') {
      if (!values.length) throw new Error('verify_dev_base_required');
      result.base = values.shift();
    } else throw new Error(`verify_dev_unknown_option:${value}`);
  }
  return result;
}

export function repositoryState(root, requestedBase = null) {
  const head = resolveGitCommit(root, 'HEAD');
  const base = requestedBase ? validateRequestedBase(root, requestedBase) : defaultBase(root);
  const list = (args) => gitText(root, args).split('\0').map(normalizePath).filter(Boolean).sort();
  const basePaths = list(['diff', '-z', '--name-only', '--no-renames', '--diff-filter=ACDMRTUXB', `${base.commit}...${head}`, '--']);
  const stagedPaths = list(['diff', '-z', '--cached', '--name-only', '--no-renames', '--diff-filter=ACDMRTUXB', '--']);
  const worktreePaths = list(['diff', '-z', '--name-only', '--no-renames', '--diff-filter=ACDMRTUXB', '--']);
  const untrackedPaths = list(['ls-files', '-z', '--others', '--exclude-standard']);
  const changed = new Set([...basePaths, ...stagedPaths, ...worktreePaths, ...untrackedPaths]);
  return {
    base: base.commit,
    base_source: base.source,
    head,
    base_paths: basePaths,
    worktree_paths: worktreePaths,
    staged_paths: stagedPaths,
    untracked_paths: untrackedPaths,
    changed_paths: [...changed].sort()
  };
}

export function selectDevCommands({ changedPaths, catalog, all = false }) {
  const paths = [...new Set((changedPaths || []).map(normalizePath).filter(Boolean))].sort();
  const impacts = reverseCatalog(catalog, paths);
  const unclassified = paths.filter((file) => !impacts.path_ids.has(file));
  const commands = new Map();
  const add = (command) => mergeCommand(commands, command);
  add(pnpmCommand('check', ['check'], ['pnpm check'], 'always'));
  add(pnpmCommand('scan-clean', ['scan:clean'], ['pnpm scan:clean'], 'always'));
  add(executableCommand('git-diff-check', 'git', ['diff', '--check'], ['git diff --check'], 'always'));

  const governance = all || paths.some((file) => GOVERNANCE_PATTERNS.some((pattern) => pattern.test(file)));
  const golden = all || paths.some((file) => GOLDEN_PATTERNS.some((pattern) => pattern.test(file)));
  const sharedCore = all || paths.some((file) => SHARED_CORE_PATTERNS.some((pattern) => pattern.test(file)));
  const web = all || paths.some((file) => file.startsWith('apps/web/'));
  const webDeep = all || paths.some((file) => WEB_DEEP_PATTERNS.some((pattern) => pattern.test(file)));
  const maintenance = all || paths.some((file) => /^scripts\/(?:development-receipt|verify-dev|test)\.mjs$/.test(file));

  if (governance) {
    add(pnpmCommand('audit-p1', ['audit:p1'], ['pnpm audit:p1'], 'governance'));
    add(pnpmCommand('audit-parity', ['audit:parity'], ['pnpm audit:parity'], 'governance'));
    add(pnpmCommand('recovery-plan', ['recovery:plan'], ['pnpm recovery:plan'], 'governance'));
    add(pnpmCommand('recovery-catalog', ['recovery:catalog'], ['pnpm recovery:catalog'], 'governance'));
    add(pnpmCommand('recovery-coverage', ['recovery:coverage'], ['pnpm recovery:coverage'], 'governance'));
    add(pnpmCommand('recovery-impact', ['recovery:impact', '--', '--audit'], ['pnpm recovery:impact -- --audit'], 'governance'));
    for (const phase of [1, 31, 10]) add(phaseCommand(phase, 'governance'));
  }
  if (golden) {
    add(phaseCommand(4, 'golden'));
    add(phaseCommand(31, 'golden'));
    add(pnpmCommand('integration-historical', ['fixture:legacy:integration'], ['pnpm fixture:legacy:integration'], 'golden', { historical: true, layered: true }));
  }
  if (sharedCore) {
    for (const phase of [1, 2, 3, 31, 4, 5, 6, 7, 8, 9, 10]) add(phaseCommand(phase, 'shared-core'));
    add(pnpmCommand('integration-clean', ['test:integration:clean'], ['pnpm test:integration:clean'], 'shared-core', { layered: true }));
    add(pnpmCommand('security-clean', ['test:security:clean'], ['pnpm test:security:clean'], 'shared-core', { layered: true }));
  }
  if (web) {
    add(pnpmCommand('web-test', ['--filter', '@aiws/web', 'test'], ['pnpm --filter @aiws/web test'], 'web'));
  }
  if (webDeep) {
    add(pnpmCommand('build', ['build'], ['pnpm build'], 'web-shell-router-worker-vite'));
    add(pnpmCommand('e2e', ['test:e2e'], ['pnpm test:e2e'], 'web-shell-router-worker-vite', { timeoutMs: 1_800_000 }));
  }
  if (maintenance) add(phaseCommand(10, 'post-p10-maintenance'));

  const phaseImpacts = reverseCatalog(catalog, paths.filter((file) => !MAINTENANCE_NO_PHASE_PATTERNS.some((pattern) => pattern.test(file))));
  const owners = new Set(impacts.features.flatMap((feature) => feature.owner_modules || []));
  const implementationPhases = new Set();
  for (const feature of phaseImpacts.implementation_features) {
    const featureOwners = feature.domain === 'frontend' ? new Set() : new Set(feature.owner_modules || []);
    for (const phase of phasesFor(new Set([feature.domain]), featureOwners)) implementationPhases.add(phase);
  }
  for (const phase of implementationPhases) add(phaseCommand(phase, 'catalog-implementation-impact'));
  if (paths.some((file) => /^(?:apps\/api\/src\/(?:clean\/)?(?:modules\/)?(?:runner|execution)|apps\/runner-broker\/)/.test(file))) add(nodeCommand('p6-performance', 'scripts/v3-clean-p6-performance.mjs', 'runner-execution'));
  if (paths.some((file) => /^apps\/api\/src\/(?:clean\/)?(?:modules\/)?(?:parser|quality|evidence|outcome)/.test(file))) add(nodeCommand('p7-performance', 'scripts/v3-clean-p7-performance.mjs', 'parser-quality-evidence-outcome'));
  if (paths.some((file) => /^apps\/api\/src\/(?:clean\/)?(?:modules\/)?(?:delivery|deployment|operations)/.test(file))) add(nodeCommand('p8-performance', 'scripts/v3-clean-p8-performance.mjs', 'delivery-deployment-operations'));
  if (paths.some((file) => /^apps\/api\/src\/(?:clean\/)?(?:modules\/)?(?:context|mcp|gateway|exchange)/.test(file))) add(nodeCommand('p4-performance', 'scripts/v3-clean-p4-performance.mjs', 'context-mcp'));

  if (all) {
    for (const phase of [1, 2, 3, 31, 4, 5, 6, 7, 8, 9, 10]) add(phaseCommand(phase, 'all'));
    add(pnpmCommand('unit-test', ['test'], ['pnpm test'], 'all', { env: { AIWS_TEST_UNIT_ONLY: '1' } }));
    add(pnpmCommand('integration', ['test:integration'], ['pnpm test:integration:clean', 'pnpm fixture:legacy:integration', 'pnpm test:integration'], 'all', { layered: true }));
    add(pnpmCommand('security', ['test:security'], ['pnpm test:security:clean', 'pnpm fixture:legacy:security', 'pnpm test:security'], 'all', { layered: true }));
    add(pnpmCommand('build', ['build'], ['pnpm build'], 'all'));
    add(pnpmCommand('e2e', ['test:e2e'], ['pnpm test:e2e'], 'all', { timeoutMs: 1_800_000 }));
  }

  collapseLayered(commands, 'integration');
  collapseLayered(commands, 'security');
  const changedTests = paths.filter((file) => /^tests\/.*\.test\.mjs$/.test(file))
    .filter((file) => {
      if (file === 'tests/security/boundary.test.mjs') return false;
      const phase = file.match(/^tests\/p(\d+)\//)?.[1];
      if (phase && commands.has(`test-p${phase}`)) return false;
      if (file.startsWith('tests/integration/') && (commands.has('integration') || commands.has('integration-historical'))) return false;
      if (file === 'tests/unit/recovery-golden.test.mjs' && (commands.has('integration') || commands.has('integration-historical'))) return false;
      return true;
    });
  if (changedTests.length) {
    commands.set('changed-tests', { id: 'changed-tests', invocation: nodeInvocation('--test', changedTests), satisfies: changedTests, reasons: ['changed-behavior-tests'], owner: 'testing', env: {}, timeoutMs: 900_000, historical: false, layered: false });
  }
  if (paths.includes('tests/security/boundary.test.mjs') && !commands.has('security') && !commands.has('security-clean')) {
    commands.set('boundary-static', { id: 'boundary-static', invocation: nodeInvocation('--test', ['--test-name-pattern=resolved compose|production build context|broker readiness|broker spec', 'tests/security/boundary.test.mjs']), satisfies: ['tests/security/boundary.test.mjs#compose-and-static-contracts'], reasons: ['image-runtime-boundary-requires-formal-release'], owner: 'testing', env: {}, timeoutMs: 30_000, historical: false, layered: false });
  }
  const check = commands.get('check');
  if (!all) check.env.AIWS_CHECK_CHANGED_PATHS = JSON.stringify(paths.filter((file) => /\.(?:mjs|js|ts|tsx)$/.test(file)));
  if (commands.has('build')) {
    check.env.AIWS_CHECK_SKIP_WEB_TYPECHECK = '1';
    const build = commands.get('build');
    build.satisfies = [...new Set([...build.satisfies, 'pnpm --filter @aiws/web typecheck'])];
  } else if (web) {
    check.satisfies = [...new Set([...check.satisfies, 'pnpm --filter @aiws/web typecheck'])];
  }
  const selected = [...commands.values()].sort((left, right) => orderOf(left.id) - orderOf(right.id) || left.id.localeCompare(right.id));
  for (const command of selected) {
    const phase = command.id.match(/^test-p(\d+)$/)?.[1];
    const prefix = phase ? `tests/p${phase}/` : command.id === 'web-test' ? 'apps/web/src/test/' : null;
    const references = prefix ? impacts.features.flatMap((feature) => ['behavior_tests', 'ui_tests', 'tests'].flatMap((field) => (feature[field] || []).filter((file) => file.startsWith(prefix)))) : [];
    command.satisfies = [...new Set([...command.satisfies, ...references])];
  }
  if (selected.some((command) => EXTERNAL_SIDE_EFFECT_PATTERN.test([command.id, command.invocation.args.join(' ')].join(' ')))) {
    throw new Error('verify_dev_external_probe_selected');
  }
  return {
    catalog_ids: impacts.features.map((feature) => feature.id).sort(),
    owners: [...owners].sort(),
    commands: selected,
    unclassified_paths: unclassified
  };
}

function reverseCatalog(catalog, paths) {
  const features = catalog.features || [];
  const matched = new Map();
  const implementationMatched = new Map();
  const pathIds = new Set();
  for (const changedPath of paths) {
    for (const feature of features) {
      const implementation = ['source_files', 'target_modules'].flatMap((field) => feature[field] || []).map(normalizePath);
      const verification = ['behavior_tests', 'ui_tests', 'tests', 'evidence', 'maintenance_evidence', 'release_receipts', 'parity_receipts'].flatMap((field) => feature[field] || []).map(normalizePath);
      const implementationHit = implementation.some((candidate) => pathMatches(changedPath, candidate));
      if (!implementationHit && !verification.some((candidate) => pathMatches(changedPath, candidate))) continue;
      matched.set(feature.id, feature);
      if (implementationHit) implementationMatched.set(feature.id, feature);
      pathIds.add(changedPath);
    }
  }
  return { features: [...matched.values()], implementation_features: [...implementationMatched.values()], path_ids: pathIds };
}

function loadCatalog(root) {
  const clean = JSON.parse(fs.readFileSync(path.join(root, 'feature-catalog.clean.json'), 'utf8'));
  const historical = JSON.parse(fs.readFileSync(path.join(root, 'feature-catalog.historical.json'), 'utf8'));
  return { features: [...(clean.features || []), ...(historical.features || [])] };
}

function phasesFor(domains, owners) {
  const phases = new Set();
  if (intersects(domains, ['identity', 'setup'])) phases.add(2);
  if (intersects(domains, ['project', 'workflow', 'repository'])) phases.add(3);
  if (intersects(domains, ['mcp', 'context'])) phases.add(4);
  if (intersects(domains, ['assist'])) phases.add(5);
  if (intersects(domains, ['runner', 'execution'])) phases.add(6);
  if (intersects(domains, ['evidence', 'quality', 'outcome'])) phases.add(7);
  if (intersects(domains, ['delivery', 'operations', 'deployment'])) phases.add(8);
  if (domains.has('frontend')) phases.add(9);
  if (domains.has('governance') || domains.has('contracts')) phases.add(10);
  if (!phases.size) {
    if (intersects(owners, ['project', 'workflow', 'repository', 'critic'])) phases.add(3);
    if (intersects(owners, ['mcp', 'context', 'projection', 'gateway', 'exchange'])) phases.add(4);
    if (intersects(owners, ['assist', 'files', 'terminal', 'bridge'])) phases.add(5);
    if (intersects(owners, ['runner', 'execution'])) phases.add(6);
    if (intersects(owners, ['evidence', 'quality', 'outcome', 'parser'])) phases.add(7);
    if (intersects(owners, ['delivery', 'operations', 'deployment', 'importer', 'cas'])) phases.add(8);
  }
  return phases;
}

function phaseCommand(phase, reason) {
  const suffix = phase === 31 ? '31' : String(phase);
  return pnpmCommand(`test-p${suffix}`, [`test:p${suffix}`], [`pnpm test:p${suffix}`], reason);
}

function pnpmCommand(id, args, satisfies, reason, options = {}) {
  return { id, invocation: pnpmInvocation(args), satisfies, reasons: [reason], timeoutMs: options.timeoutMs || 900_000, env: options.env || {}, historical: Boolean(options.historical), layered: Boolean(options.layered), owner: 'testing' };
}

function nodeCommand(id, script, reason) {
  return { id, invocation: nodeInvocation(script), satisfies: [`node ${script}`], reasons: [reason], timeoutMs: 300_000, env: {}, historical: false, layered: false, owner: 'testing' };
}

function executableCommand(id, command, args, satisfies, reason) {
  return { id, invocation: executableInvocation(command, args, command), satisfies, reasons: [reason], timeoutMs: 120_000, env: {}, historical: false, layered: false, owner: 'platform' };
}

function mergeCommand(commands, command) {
  const existing = commands.get(command.id);
  if (!existing) { commands.set(command.id, command); return; }
  existing.satisfies = [...new Set([...existing.satisfies, ...command.satisfies])];
  existing.reasons = [...new Set([...existing.reasons, ...command.reasons])];
}

function collapseLayered(commands, suite) {
  if (commands.has(suite)) {
    commands.delete(`${suite}-clean`);
    commands.delete(`${suite}-historical`);
    return;
  }
  const clean = commands.get(`${suite}-clean`);
  const historical = commands.get(`${suite}-historical`);
  if (!clean || !historical) return;
  commands.delete(`${suite}-clean`);
  commands.delete(`${suite}-historical`);
  commands.set(suite, pnpmCommand(suite, [`test:${suite}`], [...clean.satisfies, ...historical.satisfies, `pnpm test:${suite}`], [...clean.reasons, ...historical.reasons].join('+'), { layered: true }));
}

export function defaultBase(root) {
  const run = args => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 1024 * 1024 });
  const mergeBase = candidate => {
    try {
      const target = resolveGitCommit(root, candidate);
      const result = run(['merge-base', 'HEAD', target]);
      const commit = String(result.stdout || '').trim();
      if (result.status !== 0 || !/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('merge_base_missing');
      if (resolveGitCommit(root, commit) !== commit) throw new Error('merge_base_invalid');
      return { commit, source: `merge-base HEAD ${candidate}` };
    } catch { throw baseError('git_base_unverifiable', candidate); }
  };
  const branch = run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch.status === 0) {
    const configured = run(['config', '--get', `branch.${branch.stdout.trim()}.merge`]);
    if (configured.status === 0) return mergeBase('@{upstream}');
    if (configured.status !== 1) throw baseError('git_base_unverifiable', 'upstream_config');
  } else if (branch.status !== 1) throw baseError('git_base_unverifiable', 'HEAD');
  for (const [candidate, ref] of [['origin/main', 'refs/remotes/origin/main'], ['main', 'refs/heads/main']]) {
    const exists = run(['show-ref', '--verify', '--quiet', ref]);
    if (exists.status === 0) return mergeBase(candidate);
    if (exists.status !== 1) throw baseError('git_base_unverifiable', candidate);
  }
  try { return { commit: resolveGitCommit(root, 'HEAD^'), source: 'HEAD^' }; }
  catch { throw baseError('git_base_unverifiable', 'HEAD^'); }
}

function validateRequestedBase(root, value) {
  const ref = String(value || '').trim();
  if (!/^[a-f0-9]{7,64}$/i.test(ref)) {
    if (/\s|\.\.|@\{|[\\:\0\r\n]/.test(ref)) throw baseError('git_base_ref_invalid', ref);
    const checked = spawnSync('git', ['check-ref-format', '--branch', ref], { cwd: root, encoding: 'utf8', windowsHide: true, shell: false });
    if (checked.status !== 0) throw baseError('git_base_ref_invalid', ref);
  }
  try { return { commit: resolveGitCommit(root, ref), source: `requested:${ref}` }; }
  catch { throw baseError('git_base_ref_unverifiable', ref); }
}

function gitText(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw baseError('git_command_failed', args.join(' '));
  return result.stdout || '';
}

function baseError(code, value) { const error = new Error(value); error.code = code; return error; }
function normalizePath(value) { return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, ''); }
function pathMatches(file, candidate) { return Boolean(candidate) && (file === candidate || file.startsWith(`${candidate.replace(/\/$/, '')}/`)); }
function intersects(values, candidates) { return candidates.some((candidate) => values.has(candidate)); }
function orderOf(id) { const index = COMMAND_ORDER.indexOf(id); return index < 0 ? COMMAND_ORDER.length : index; }
function publicSelection(command) { return { id: command.id, owner: command.owner, satisfies: command.satisfies, reasons: command.reasons, historical: command.historical, command: command.satisfies[0] }; }
function publicRecord(record) { return { id: record.id, owner: record.owner, satisfies: record.satisfies, reasons: record.reasons, historical: record.historical, advisory: record.advisory, command: record.command, args: record.args, exit_status: record.exit_status, signal: record.signal, duration_ms: record.duration_ms, error_code: record.error_code, ok: record.ok, layered_status: record.layered_status, redaction: record.redaction }; }

function parseLayeredResult(stdout) {
  const text = String(stdout || '').trim();
  for (let index = text.indexOf('{'); index >= 0; index = text.indexOf('{', index + 1)) {
    try { const value = JSON.parse(text.slice(index)); if (value?.schema_version === 'aiws.v3-clean.layered-gate-result.v2') return value; } catch { /* pnpm prelude */ }
  }
  return null;
}

function writeLocalReceipt(root, receipt) {
  const directory = path.join(root, LOCAL_RECEIPT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const prefix = `verify-dev-${Date.now()}-${process.pid}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const filename = `${prefix}${attempt ? `-${attempt}` : ''}.json`;
    const target = path.join(directory, filename);
    const relative = path.relative(root, target).replaceAll('\\', '/');
    try {
      fs.writeFileSync(target, `${JSON.stringify({ ...receipt, receipt: relative }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      return relative;
    } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  throw new Error('verify_dev_receipt_name_exhausted');
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked && invoked === import.meta.url) {
  const exitCode = await main();
  if (exitCode) process.exitCode = exitCode;
}
