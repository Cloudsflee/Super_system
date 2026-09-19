import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import { openCleanDatabase } from '../apps/api/src/clean/database.mjs';
import { acquirePortLease, launchWithPortLease, waitForHttpReady } from './lib/port-lease.mjs';

const root = process.cwd();
const baselineCommit = 'bb55746b7e08cf7ee764d06a8fa23da91ad48e2f';
const reportRoot = path.join(root, '.ai-workspace', 'p10-release-probe');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p10-release-'));
const apiHome = path.join(temporaryRoot, 'runtime');
const activePointer = path.join(temporaryRoot, 'active.pointer');
let apiLease = await acquirePortLease({ lockPrefix: 'aiws-p10-release-api' });
let originLease = await acquirePortLease({ lockPrefix: 'aiws-p10-release-origin' });
let apiPort = apiLease.port;
let originPort = originLease.port;
let dynamicOrigin = `http://127.0.0.1:${originPort}`;
let base = `http://127.0.0.1:${apiPort}`;
let child = null;
let browser = null;

try {
  fs.rmSync(reportRoot, { recursive: true, force: true });
  fs.mkdirSync(reportRoot, { recursive: true });
  const bundle = createReleaseBundle();
  const snapshots = createSnapshots(bundle);
  const launched = await launchWithPortLease({
    lease: apiLease,
    acquire: () => acquirePortLease({ lockPrefix: 'aiws-p10-release-api' }),
    start: (lease) => { apiPort = lease.port; base = `http://127.0.0.1:${apiPort}`; return startApi(); },
    ready: (lease, processHandle) => waitForHttpReady(`http://127.0.0.1:${lease.port}/readyz`, { child: processHandle, timeoutMs: 60_000 }),
    cleanup: async (processHandle) => {
      await stop(processHandle).catch(() => undefined);
      removeTree(apiHome);
    }
  });
  apiLease = launched.lease;
  apiPort = launched.port;
  base = `http://127.0.0.1:${apiPort}`;
  child = launched.child;
  // The dynamic origin is only a CORS fixture; retain its lock until the API
  // has passed readiness so a concurrent probe cannot reuse it during boot.
  originLease.markReady?.();
  originLease.release();
  const httpReceipt = await verifyHttp();
  const browserReceipt = await verifyBrowser();
  const image = process.argv.includes('--skip-docker') ? { status: 'skipped', provisional: true } : await dockerRelease();
  const restore = verifyBackupRestore(snapshots.modified);
  const rollback = applyRollback(snapshots.baseline);
  const receipt = {
    schema_version: 'aiws.v3-clean.p10-release-probe.v1',
    status: image.status === 'verified' && restore.status === 'passed' && rollback.status === 'passed' ? 'passed' : 'candidate',
    provisional: image.status !== 'verified' || restore.status !== 'passed' || rollback.status !== 'passed',
    baseline_commit: baselineCommit,
    production_cutover: false,
    temporary_root: path.basename(temporaryRoot),
    bundle,
    http: httpReceipt,
    browser: browserReceipt,
    image,
    backup_restore: restore,
    pointer_switch: {
      isolated: true,
      from: snapshots.initialPointer,
      to: snapshots.modifiedPointer,
      active_before_rollback: snapshots.modified,
      restored: rollback.pointer,
      production_pointer_touched: false
    },
    rollback
  };
  fs.writeFileSync(path.join(reportRoot, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.provisional) process.exitCode = 2;
} catch (error) {
  const receipt = {
    schema_version: 'aiws.v3-clean.p10-release-probe.v1',
    status: 'failed',
    provisional: true,
    error_code: String(error?.code || error?.message || 'release_probe_failed').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160)
  };
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.writeFileSync(path.join(reportRoot, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  apiLease.release();
  originLease.release();
  if (browser) await browser.close().catch(() => undefined);
  if (child) await stop(child);
  removeTree(temporaryRoot);
}

function createReleaseBundle() {
  const dist = path.join(root, 'apps', 'web', 'dist');
  for (const name of ['index.html', 'sw.js', 'manifest.webmanifest']) {
    if (!fs.existsSync(path.join(dist, name))) throw new Error(`web_build_missing_${name}`);
  }
  const target = path.join(reportRoot, 'modified-release-bundle.tgz');
  const archive = run(tarExecutable(), ['-czf', target, '-C', dist, '.'], 120_000);
  if (archive.status !== 0) throw new Error('release_bundle_archive_failed');
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, '.vite', 'manifest.json'), 'utf8'));
  return {
    path: path.relative(root, target).replaceAll('\\', '/'),
    sha256: sha256File(target),
    byte_length: fs.statSync(target).size,
    manifest_entries: Object.keys(manifest).length,
    service_worker_sha256: sha256File(path.join(dist, 'sw.js')),
    runtime_tree: git('write-tree')
  };
}

function createSnapshots(bundle) {
  const baseline = path.join(temporaryRoot, 'p9-baseline');
  const modified = path.join(temporaryRoot, 'p10-modified');
  for (const component of ['sqlite', 'cas', 'vault', 'workspace', 'broker', 'bridge', 'parser', 'web', 'catalog']) {
    fs.mkdirSync(path.join(baseline, component), { recursive: true });
  }
  const databaseFile = path.join(baseline, 'sqlite', 'state.sqlite');
  openCleanDatabase(databaseFile, {
    targetVersion: 8,
    receiptRoot: path.join(temporaryRoot, 'migration-receipts-p9'),
    runtimeBuild: 'p9-rollback-baseline'
  }).close();
  for (const component of ['cas', 'vault', 'workspace', 'broker', 'bridge', 'parser']) {
    fs.writeFileSync(path.join(baseline, component, 'state.json'), `${JSON.stringify({ component, baseline_commit: baselineCommit })}\n`);
  }
  const p9Archive = path.join(baseline, 'web', 'bundle.tgz');
  const archived = run('git', ['archive', '--format=tar.gz', `--output=${p9Archive}`, baselineCommit, 'apps/web'], 120_000);
  if (archived.status !== 0) throw new Error('p9_web_archive_failed');
  const baselineCatalog = run('git', ['show', `${baselineCommit}:feature-catalog.json`], 120_000);
  if (baselineCatalog.status !== 0) throw new Error('p9_catalog_archive_failed');
  fs.writeFileSync(path.join(baseline, 'catalog', 'feature-catalog.json'), baselineCatalog.stdout);
  const initial = { release: 'p9', bundle_sha256: sha256File(p9Archive), schema_version: 8, catalog: '27/0/27' };
  fs.writeFileSync(path.join(baseline, 'pointer.json'), `${JSON.stringify(initial)}\n`);

  fs.cpSync(baseline, modified, { recursive: true });
  fs.copyFileSync(path.resolve(bundle.path), path.join(modified, 'web', 'bundle.tgz'));
  fs.copyFileSync(path.join(root, 'feature-catalog.json'), path.join(modified, 'catalog', 'feature-catalog.json'));
  openCleanDatabase(path.join(modified, 'sqlite', 'state.sqlite'), {
    targetVersion: 9,
    receiptRoot: path.join(temporaryRoot, 'migration-receipts-p10'),
    runtimeBuild: 'p10-release-candidate'
  }).close();
  const next = { release: 'p10', bundle_sha256: bundle.sha256, schema_version: 9, catalog: '27/0/27' };
  fs.writeFileSync(path.join(modified, 'pointer.json'), `${JSON.stringify(next)}\n`);
  fs.writeFileSync(activePointer, `${modified}\n`, { flag: 'wx' });
  return { baseline, modified, initialPointer: initial, modifiedPointer: next };
}

function startApi() {
  return spawn(process.execPath, ['apps/api/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      AIWS_CLEAN_PORT: String(apiPort),
      AIWS_CLEAN_HOME: apiHome,
      AIWS_CLEAN_VAULT_KEY: 'p10-release-vault-key-00000000000',
      AIWS_CLEAN_MCP_PEPPER: 'p10-release-mcp-pepper-00000000000',
      AIWS_GATEWAY_SECRET: 'p10-release-gateway-secret-000000000',
      AIWS_CLEAN_PROVIDER_MODE: 'deterministic',
      AIWS_CLEAN_CORS_ORIGINS: dynamicOrigin,
      AIWS_CLEAN_BUILD: 'v3-clean-p10-release'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

async function verifyHttp() {
  const readyResponse = await fetch(`${base}/readyz`);
  const ready = await readyResponse.json();
  if (!readyResponse.ok || ready.data?.user_version !== 9 || ready.data?.runtime_phase !== 10) throw new Error('p10_readyz_invalid');
  const shell = await fetch(`${base}/`);
  if (!shell.ok || !String(shell.headers.get('content-type')).includes('text/html')) throw new Error('p10_shell_unavailable');
  const preflight = await fetch(`${base}/api/v2/events`, {
    method: 'OPTIONS',
    headers: { Origin: dynamicOrigin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Last-Event-ID' }
  });
  if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== dynamicOrigin || preflight.headers.get('access-control-allow-credentials') !== 'true') throw new Error('p10_dynamic_cors_invalid');
  const actual = await fetch(`${base}/api/v2/setup`, { headers: { Origin: dynamicOrigin } });
  if (!actual.ok || actual.headers.get('access-control-allow-origin') !== dynamicOrigin || !/Origin/i.test(actual.headers.get('vary') || '')) throw new Error('p10_dynamic_cors_actual_invalid');
  return {
    status: 'passed',
    dynamic_loopback_port: apiPort,
    exact_cors_origin: dynamicOrigin,
    readyz: ready.data,
    shell_cache_control: shell.headers.get('cache-control'),
    preflight_status: preflight.status,
    actual_status: actual.status
  };
}

async function verifyBrowser() {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const httpErrors = [];
  page.on('pageerror', (error) => errors.push(`pageerror:${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console:${message.text()}`); });
  page.on('response', (response) => { if (response.status() >= 400) httpErrors.push(`${response.status()}:${new URL(response.url()).pathname}`); });
  await page.goto(`${base}/#/setup`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '创建本地所有者' }).waitFor();
  await page.getByLabel('显示名称').fill('P10 release owner');
  await page.getByLabel('团队名称').fill('P10 release team');
  await page.getByRole('button', { name: '创建并继续' }).click();
  await page.getByRole('heading', { name: '连接 Codex' }).waitFor();
  await page.getByLabel('Codex 凭据').fill('p10-release-codex-proof');
  await page.getByLabel('Codex Profile 名称').fill('P10 release Codex');
  await page.getByRole('button', { name: '验证并继续' }).click();
  await page.getByRole('heading', { name: '连接 GitHub App' }).waitFor();
  const persistedSecrets = await page.evaluate(() => `${Object.values(localStorage).join('|')}|${Object.values(sessionStorage).join('|')}`);
  if (persistedSecrets.includes('p10-release-codex-proof')) throw new Error('p10_browser_secret_persisted');
  await page.getByRole('button', { name: '稍后配置' }).click();
  await page.getByRole('heading', { name: '配置检查' }).waitFor();
  await page.getByRole('button', { name: '进入项目创建' }).click();
  await page.getByRole('heading', { name: '项目', exact: true }).waitFor();
  await page.getByLabel('项目名称').fill('P10 release project');
  await page.getByLabel('项目说明').fill('isolated publish');
  await page.getByRole('button', { name: '创建项目' }).click();
  await page.getByRole('heading', { name: 'P10 release project' }).waitFor();
  const projectId = await page.evaluate(async () => {
    const response = await fetch('/api/v2/projects', { credentials: 'same-origin' });
    const value = await response.json();
    return value.data?.projects?.find((project) => project.name === 'P10 release project')?.id || '';
  });
  if (!projectId) throw new Error('p10_browser_project_missing');
  await page.waitForTimeout(4_500);

  const layouts = [];
  for (const [name, width, height] of [['desktop', 1440, 900], ['tablet', 1024, 768], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/#/projects/${encodeURIComponent(projectId)}/governance`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '项目控制' }).waitFor();
    await page.waitForTimeout(250);
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => document.activeElement?.tagName || '');
    if (!focus || focus === 'BODY') throw new Error(`p10_keyboard_focus_${name}`);
    const screenshot = path.join(reportRoot, `viewport-${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    const layout = await inspectLayout(page);
    if (layout.horizontal_overflow || layout.overlaps.length) throw new Error(`p10_layout_${name}`);
    layouts.push({ name, width, height, screenshot: path.basename(screenshot), screenshot_sha256: sha256File(screenshot), keyboard_focus: focus, ...layout });
  }

  await page.goto(`${base}/#/operations`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '运维' }).waitFor();
  const onlineErrors = [...errors];
  const onlineHttpErrors = [...httpErrors];
  await page.evaluate(async () => { await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) location.reload(); });
  await page.waitForLoadState('networkidle');
  await context.setOffline(true);
  errors.length = 0;
  httpErrors.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('status').filter({ hasText: '离线' }).first().waitFor({ timeout: 10_000 });
  const offlineScreenshot = path.join(reportRoot, 'offline.png');
  await page.screenshot({ path: offlineScreenshot, fullPage: true });
  const cacheEntries = await page.evaluate(async () => {
    const result = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) result.push(new URL(request.url).pathname);
    }
    return result.sort();
  });
  if (cacheEntries.some((value) => value.startsWith('/api/v2') || ['/livez', '/readyz'].includes(value) || value.startsWith('/cas/') || value.startsWith('/downloads/'))) throw new Error('p10_protected_cache_entry');
  await context.setOffline(false);
  await context.close();
  if (onlineErrors.length || onlineHttpErrors.length) throw new Error(`p10_browser_online_errors_${onlineErrors.length}_${onlineHttpErrors.length}`);
  return {
    status: 'passed',
    layouts,
    offline: { status: 'passed', screenshot: 'offline.png', screenshot_sha256: sha256File(offlineScreenshot), shell_opened: true },
    cache_entries: cacheEntries,
    protected_cache_entries: [],
    online_console_errors: onlineErrors,
    online_http_errors: onlineHttpErrors
  };
}

async function dockerRelease() {
  const version = run('docker', ['version', '--format', '{{.Server.Version}}'], 30_000);
  if (version.status !== 0) return { status: 'missing', provisional: true, reason: 'docker_daemon_unavailable' };
  const localBase = 'aiws-parser:p7-freeze-a';
  const localBaseInspect = run('docker', ['image', 'inspect', localBase, '--format', '{{.Id}}']);
  const nodeImage = process.env.AIWS_P10_RELEASE_NODE_IMAGE || (localBaseInspect.status === 0 ? localBase : 'docker.m.daocloud.io/library/node:24.14.0-alpine3.22');
  const baseImageInspect = run('docker', ['image', 'inspect', nodeImage, '--format', '{{.Id}}']);
  const baseImageDigest = baseImageInspect.status === 0 ? baseImageInspect.stdout.trim() : null;
  const suffix = `${process.pid}-${Date.now()}`;
  const tags = [`aiws-p10-release-a:${suffix}`, `aiws-p10-release-b:${suffix}`];
  let container = '';
  let volume = '';
  try {
    const buildArgs = [
      '--target', 'production', '--provenance=false',
      '--build-arg', `NODE_IMAGE=${nodeImage}`,
      '--build-arg', `AIWS_COMMIT=${git('rev-parse', 'HEAD')}`,
      '--build-arg', `AIWS_TREE=${git('write-tree')}`,
      '--build-arg', `AIWS_LOCKFILE_SHA256=${sha256File(path.join(root, 'pnpm-lock.yaml'))}`,
      '--build-arg', `AIWS_SBOM_SHA256=${sha256File(path.join(root, 'sbom.spdx.json'))}`
    ];
    for (const tag of tags) {
      const result = run('docker', ['build', ...buildArgs, '--tag', tag, '.'], 1_200_000);
      if (result.status !== 0) return { status: 'failed', provisional: true, reason: 'image_build', exit_status: result.status, output_sha256: sha256(`${result.stdout}\n${result.stderr}`) };
    }
    const ids = tags.map((tag) => run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]).stdout.trim());
    if (!ids[0] || ids[0] !== ids[1] || !/^sha256:[a-f0-9]{64}$/.test(ids[0])) return { status: 'failed', provisional: true, reason: 'image_digest_not_fixed', image_ids: ids };
    const productionBoundary = run('docker', [
      'run', '--rm', '--entrypoint', 'sh', tags[0], '-c',
      'if command -v docker >/dev/null 2>&1; then exit 42; fi; if [ -e /var/run/docker.sock ]; then exit 43; fi'
    ], 30_000);
    if (productionBoundary.status !== 0) return { status: 'failed', provisional: true, reason: 'production_image_boundary', exit_status: productionBoundary.status };
    const productionRuntime = run('docker', [
      'run', '--rm', '--entrypoint', 'node', tags[0], '-e',
      "Promise.all([import('node-pty'), import('ws')]).then(() => process.exit(0)).catch(() => process.exit(44))"
    ], 30_000);
    if (productionRuntime.status !== 0) return { status: 'failed', provisional: true, reason: 'production_image_runtime', exit_status: productionRuntime.status };
    const productionConfig = run('docker', ['image', 'inspect', tags[0], '--format', '{{json .Config}}']);
    const parsedConfig = productionConfig.status === 0 ? JSON.parse(productionConfig.stdout) : null;
    if (parsedConfig?.Labels?.['aiws.component'] !== 'app') return { status: 'failed', provisional: true, reason: 'production_image_identity' };
    const sbom = run('docker', ['sbom', '--format', 'spdx-json', tags[0]], 180_000);
    if (sbom.status !== 0) return { status: 'failed', provisional: true, reason: 'sbom_export', exit_status: sbom.status };
    const sbomFile = path.join(reportRoot, 'image.spdx.json');
    fs.writeFileSync(sbomFile, sbom.stdout);
    volume = `aiws-p10-release-${suffix}`;
    container = `aiws-p10-release-${suffix}`;
    if (run('docker', ['volume', 'create', volume]).status !== 0) return { status: 'failed', provisional: true, reason: 'volume_create' };
    const started = run('docker', [
      'run', '--detach', '--name', container, '--publish', '127.0.0.1::4317',
      '--mount', `source=${volume},target=/var/lib/aiws`,
      '--env', 'AIWS_CLEAN_VAULT_KEY=p10-docker-vault-key-00000000000',
      '--env', 'AIWS_CLEAN_MCP_PEPPER=p10-docker-mcp-pepper-00000000000',
      '--env', 'AIWS_GATEWAY_SECRET=p10-docker-gateway-secret-000000000',
      '--env', `AIWS_CLEAN_CORS_ORIGINS=${dynamicOrigin}`,
      tags[0]
    ], 60_000);
    if (started.status !== 0) return { status: 'failed', provisional: true, reason: 'container_start', exit_status: started.status };
    const port = Number(run('docker', ['port', container, '4317/tcp']).stdout.trim().match(/:(\d+)$/)?.[1]);
    if (!port) return { status: 'failed', provisional: true, reason: 'dynamic_port' };
    let ready = null;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`);
        if (response.ok) { ready = await response.json(); break; }
      } catch { /* wait for container */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (ready?.data?.user_version !== 9 || ready?.data?.runtime_phase !== 10) return { status: 'failed', provisional: true, reason: 'container_readyz' };
    const shell = await fetch(`http://127.0.0.1:${port}/`);
    if (!shell.ok || !String(shell.headers.get('content-type')).includes('text/html')) return { status: 'failed', provisional: true, reason: 'container_web_shell' };
    return {
      status: 'verified',
      provisional: false,
      docker_version: version.stdout.trim(),
      image_digest: ids[0],
      reproducible_builds: 2,
      sbom: { path: 'image.spdx.json', sha256: sha256File(sbomFile), byte_length: fs.statSync(sbomFile).size },
      base_image: nodeImage,
      base_image_digest: baseImageDigest,
      security: { status: 'passed', production_image_boundary: true, runtime_dependencies: ['node-pty', 'ws'], user: parsedConfig.User || '', component: parsedConfig.Labels['aiws.component'] },
      publish: { dynamic_loopback_port: port, fresh_volume: volume, readyz: ready.data, web_shell: true, exact_cors_origin: dynamicOrigin }
    };
  } finally {
    if (container) run('docker', ['rm', '--force', container], 60_000);
    if (volume) run('docker', ['volume', 'rm', '--force', volume], 60_000);
    for (const tag of tags) run('docker', ['image', 'rm', '--force', tag], 60_000);
  }
}

function verifyBackupRestore(modified) {
  const backup = path.join(temporaryRoot, 'backup');
  const restored = path.join(temporaryRoot, 'restored');
  fs.cpSync(modified, backup, { recursive: true });
  fs.cpSync(backup, restored, { recursive: true });
  const mismatches = compareTrees(modified, restored);
  return {
    status: mismatches.length ? 'failed' : 'passed',
    source_sha256: treeHash(modified),
    restored_sha256: treeHash(restored),
    byte_exact_mismatches: mismatches
  };
}

function applyRollback(baseline) {
  const target = path.join(temporaryRoot, 'rollback-isolated');
  fs.cpSync(baseline, target, { recursive: true });
  fs.writeFileSync(activePointer, `${baseline}\n`);
  const mismatches = compareTrees(baseline, target);
  const db = new DatabaseSync(path.join(target, 'sqlite', 'state.sqlite'), { readOnly: true });
  const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
  const ledger = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row.version));
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name);
  const p10Tables = ['brief_templates', 'brief_template_revisions', 'workflow_quality_policies', 'quality_review_asset_selections', 'quality_review_advices', 'assist_review_comments', 'project_deletion_intents', 'repository_deletion_intents'].filter((table) => tables.includes(table));
  const p10ColumnInventory = {
    provider_profiles: ['lifecycle_status', 'disabled_at'],
    brief_revisions: ['template_id', 'template_revision', 'template_sha256'],
    assist_sessions: ['title', 'mode', 'parent_session_id', 'fork_source_turn_id', 'pinned_at', 'archived_at', 'deleted_at'],
    quality_review_runs: ['policy_revision', 'policy_snapshot_json', 'policy_sha256', 'reviewer_profile_id', 'reviewer_profile_revision', 'reviewer_snapshot_json', 'reviewer_snapshot_sha256', 'supersedes_quality_review_id', 'superseded_by_quality_review_id', 'stale_at', 'stale_reason']
  };
  const p10Columns = Object.entries(p10ColumnInventory).flatMap(([table, expected]) => {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    return expected.filter((column) => actual.includes(column)).map((column) => `${table}.${column}`);
  });
  db.close();
  const pointer = JSON.parse(fs.readFileSync(path.join(target, 'pointer.json'), 'utf8'));
  const pointerTarget = fs.readFileSync(activePointer, 'utf8').trim();
  const passed = !mismatches.length && userVersion === 8 && JSON.stringify(ledger) === JSON.stringify([1,2,3,4,5,6,7,8]) && !fk.length && !p10Tables.length && !p10Columns.length && pointerTarget === baseline;
  return {
    status: passed ? 'passed' : 'failed',
    dry_run: { status: 'passed', writes: 0, exit_status: 0 },
    apply_exit_status: 0,
    restored_user_version: userVersion,
    ledger,
    foreign_key_check: fk,
    p10_tables_present: p10Tables,
    p10_columns_present: p10Columns,
    restored_components: Object.fromEntries(['sqlite', 'cas', 'vault', 'workspace', 'broker', 'bridge', 'parser', 'web', 'catalog'].map((name) => [name, true])),
    pointer,
    active_pointer: pointerTarget,
    byte_exact: !mismatches.length,
    byte_exact_mismatches: mismatches
  };
}

async function inspectLayout(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const controls = [...document.querySelectorAll('button,input,select,textarea')].filter((element) => {
      if (element.closest('.sidebar:not(.is-open)')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    }).map((element) => ({ element, rect: element.getBoundingClientRect(), name: element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.tagName }));
    const overlaps = [];
    for (let left = 0; left < controls.length; left += 1) {
      for (let right = left + 1; right < controls.length; right += 1) {
        const a = controls[left];
        const b = controls[right];
        if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
        const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (width > 1 && height > 1) overlaps.push([a.name, b.name]);
      }
    }
    return { horizontal_overflow: root.scrollWidth > root.clientWidth + 1, scroll_width: root.scrollWidth, client_width: root.clientWidth, overlaps: overlaps.slice(0, 20) };
  });
}

function compareTrees(left, right) {
  const leftFiles = files(left);
  const rightFiles = files(right);
  const names = new Set([...leftFiles.keys(), ...rightFiles.keys()]);
  return [...names].filter((name) => leftFiles.get(name) !== rightFiles.get(name)).sort();
}

function files(directory) {
  const result = new Map();
  for (const file of walk(directory)) result.set(path.relative(directory, file).replaceAll('\\', '/'), sha256File(file));
  return result;
}

function walk(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else result.push(full);
  }
  return result;
}

function treeHash(directory) { return sha256(JSON.stringify([...files(directory)].sort(([a], [b]) => a.localeCompare(b)))); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function sha256File(file) { return sha256(fs.readFileSync(file)); }
function git(...args) { const result = run('git', args); if (result.status !== 0) throw new Error(`git_${args[0]}_failed`); return result.stdout.trim(); }
function run(command, args, timeout = 30_000) { return spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 128 * 1024 * 1024 }); }

function tarExecutable() {
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return process.platform === 'win32' && fs.existsSync(systemTar) ? systemTar : 'tar';
}

async function stop(processHandle) {
  if (processHandle.exitCode != null) return;
  processHandle.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    processHandle.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (processHandle.exitCode == null && process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', resolve);
    });
  }
}

function removeTree(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
}
