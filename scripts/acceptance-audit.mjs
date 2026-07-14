import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const checks = [
  ['V1.2 dev plan', '开发计划v1.2.md', '相对 `开发计划v1.1.md`'],
  ['V1.3 dev plan', '开发计划v1.3.md', '相对 `开发计划v1.2.md`'],
  ['V1.4 dev plan', '开发计划v1.4.md', '完全容器化增量'],
  ['V1.5 dev plan', '开发计划v1.5.md', 'state schema 14'],
  ['V1.5 test plan', '测试计划v1.5.md', 'Windows Native Bridge 测试'],
  ['V1.6 dev plan', '开发计划v1.6.md', 'V1.6-14'],
  ['V1.6 test plan', '测试计划v1.6.md', 'P0/P1 用例必须 100%'],
  ['V1.6 cutover appendix', 'docs/v1.6-cutover.md', '27810352c6abe6b36c5be57c17c375acce8571b2b1b262050e8e6b1b6f85f48f'],
  ['Production Dockerfile', 'Dockerfile', 'FROM workspace-deps AS verify'],
  ['Offline native Node headers', 'Dockerfile', 'npm_config_nodedir=/usr/local'],
  ['Windows Bridge export', 'Dockerfile', 'FROM scratch AS windows-bridge-export'],
  ['Validated archive creation', 'docker/backup_archive.py', 'def create_archive'],
  ['Safe archive sanitization', 'docker/backup_archive.py', 'def sanitize_archive'],
  ['Transient Codex backup exclusion', 'docker/backup_archive.py', 'def transient_codex_path'],
  ['Safe relative symlink restore', 'docker/backup_archive.py', 'target.symlink_to(member.linkname)'],
  ['Release volume audit', 'docker/release_volume.mjs', 'source_changed_after_clone'],
  ['Release clone orchestration', 'docker/release_orchestrator.mjs', 'initializeFromSource'],
  ['Offline verify refresh', 'docker/verify-refresh.Dockerfile', 'pnpm install --offline --frozen-lockfile'],
  ['Explicit discard fallback', 'docker/release_orchestrator.mjs', 'discarded_unmigratable'],
  ['Legacy purge confirmation', 'docker/release_volume.mjs', 'purge_legacy_requires_confirm'],
  ['V1.6 Compose', 'compose.yml', 'name: aiws-v16'],
  ['Runner image', 'docker/codex-runner.Dockerfile', 'ARG CODEX_VERSION=0.144.0'],
  ['PowerShell bridge operations', 'scripts/aiws.ps1', "@('install','start','stop','status','uninstall')"],
  ['PowerShell backup validation', 'scripts/aiws.ps1', 'backup_validation_failed'],
  ['PowerShell verify cache validation', 'scripts/aiws.ps1', 'cmp -s /app/pnpm-lock.yaml'],
  ['POSIX V1.6 migration operations', 'scripts/aiws.sh', '--discard-unmigratable'],
  ['PowerShell legacy purge', 'scripts/aiws.ps1', "'purge-legacy'"],
  ['Setup guard', 'apps/web/src/app/setup-guard.tsx', '<Navigate to="/setup"'],
  ['GitHub App JWT', 'apps/api/src/github-service.mjs', 'createAppJwt'],
  ['GitHub webhook', 'apps/api/src/routes/github-webhook-v12.mjs', 'timingSafeEqual'],
  ['Secret vault', 'apps/api/src/vault.mjs', 'vault:'],
  ['Codex profile home', 'apps/api/src/codex-service.mjs', 'CODEX_HOME'],
  ['Codex local discovery', 'apps/api/src/routes/codex-discovery-v12.mjs', '/codex/discovery/import'],
  ['Managed realpath barrier', 'apps/api/src/managed-workspace.mjs', 'realPathWithin'],
  ['File traversal guard', 'apps/api/src/file-service.mjs', 'path_outside_repository'],
  ['Assist V3 routes', 'apps/api/src/routes/assist-v3.mjs', '/assist/v3/sessions/:id/follow-ups'],
  ['Assist V3 replay', 'apps/api/src/assist-v3-events.mjs', 'last-event-id'],
  ['Codex app-server', 'apps/api/src/codex-app-server.mjs', "request('turn/start'"],
  ['Native collaboration mode', 'apps/api/src/codex-app-server.mjs', 'collaborationMode: nativeCollaborationMode'],
  ['Application context channel', 'apps/api/src/assist-v3-context.mjs', "return [{ kind: 'application'"],
  ['App-server-only Assist', 'apps/api/src/assist-v3-runtime.mjs', 'runCodexAppServer'],
  ['Raw model catalog', 'apps/api/src/assist-models.mjs', "method: 'model/list'"],
  ['Reasoning catalog passthrough', 'apps/api/src/assist-models.mjs', 'supportedReasoningEfforts'],
  ['Assist configuration CRUD', 'apps/api/src/routes/assist-v3.mjs', "'PATCH', '/assist/v3/configurations/:id'"],
  ['Native Goal RPC', 'apps/api/src/assist-goals.mjs', "'thread/goal/set'"],
  ['Session coordinator', 'apps/api/src/assist-session-coordinator.mjs', 'coordinateAssistSession'],
  ['Native user input', 'apps/api/src/codex-app-server.mjs', 'item/tool/requestUserInput'],
  ['Secret answers memory-only', 'apps/api/src/assist-user-input.mjs', 'deliberately never passed through state/event/logging'],
  ['Schema 14 migration', 'apps/api/src/state-migration-v14.mjs', 'STATE_SCHEMA_VERSION = 14'],
  ['Schema 14 collections', 'apps/api/src/state-migration-v14.mjs', 'host_bridge_devices'],
  ['Atomic migration backup', 'apps/api/src/state-migration-v14.mjs', 'migration_failed_and_backup_corrupt'],
  ['Schema 15 migration', 'apps/api/src/state-migration-v15.mjs', 'STATE_SCHEMA_VERSION = 15'],
  ['Official Runner normalization', 'apps/api/src/state-migration-v15.mjs', 'LEGACY_OFFICIAL_RUNNER_PATTERN'],
  ['Shared Fork isolation', 'apps/api/src/state-migration-v15.mjs', 'historical_shared_codex_thread_id'],
  ['Native thread Fork', 'apps/api/src/assist-session-lifecycle.mjs', "method: 'thread/fork'"],
  ['Root delete protection', 'apps/api/src/assist-session-lifecycle.mjs', 'assist_root_session_not_deletable'],
  ['Delete batch restore', 'apps/api/src/routes/assist-v3.mjs', '/restore-deleted'],
  ['Ephemeral BTW', 'apps/api/src/codex-ephemeral-thread.mjs', "request('thread/fork'"],
  ['BTW memory lifecycle', 'apps/api/src/assist-btw.mjs', 'BTW_GLOBAL_LIMIT = 4'],
  ['Streaming upload', 'apps/api/src/assist-attachments.mjs', 'streamMultipartFile'],
  ['Attachment Range', 'apps/api/src/assist-attachments.mjs', 'parseSingleRange'],
  ['Reference candidates', 'apps/api/src/assist-references.mjs', 'listAssistReferences'],
  ['Native mention input', 'apps/api/src/assist-v3-context.mjs', "type: 'mention'"],
  ['Context menu registry', 'apps/web/src/components/common/ContextMenu.tsx', 'ContextMenuResolver'],
  ['Unified Tooltip', 'apps/web/src/components/common/Tooltip.tsx', 'data-tooltip'],
  ['Composer commands', 'apps/web/src/features/assist/composer-support.ts', "['btw'"],
  ['Long paste boundary', 'apps/web/src/features/assist/useComposerFiles.ts', 'LONG_PASTE_THRESHOLD = 8000'],
  ['Lazy preview engines', 'apps/web/src/features/assist/AttachmentPreview.tsx', "lazy(() => import('./PdfPreview'))"],
  ['Bundle budgets', 'scripts/bundle-budget.mjs', '300 * 1024'],
  ['Change batches', 'apps/api/src/assist-change-batches.mjs', 'assist_change_batch_locked'],
  ['Batch checkpoints', 'apps/api/src/assist-change-batches.mjs', 'state.assist_checkpoints.push'],
  ['Batch review API', 'apps/api/src/routes/assist-v3.mjs', '/assist/v3/change-batches/:id/review/apply'],
  ['Dynamic page tools', 'apps/api/src/assist-operations.mjs', "name: 'aiws_page'"],
  ['Operation conflict', 'apps/api/src/assist-operations.mjs', 'assist_operation_undo_conflict'],
  ['Compensating Undo', 'apps/api/src/assist-operations.mjs', 'inverse_of: original.id'],
  ['Terminal capabilities', 'apps/api/src/routes/terminal-v13.mjs', '/assist/v3/terminal-capabilities'],
  ['Host Bridge pairing', 'apps/api/src/routes/host-bridge-v15.mjs', '/assist/v3/host-bridge/pairing'],
  ['One-time pairing secret', 'apps/api/src/routes/host-bridge-v15.mjs', 'sendOneTimeSecret'],
  ['Host Bridge round trip', 'apps/api/src/host-bridge-service.mjs', 'workspace_return_begin'],
  ['Bundle fsck', 'apps/api/src/host-bridge-workspace.mjs', "['fsck', '--strict'"],
  ['Bundle symlink guard', 'apps/api/src/host-bridge-workspace.mjs', 'host_bridge_bundle_symlink_rejected'],
  ['Bundle case collision guard', 'apps/api/src/host-bridge-workspace.mjs', 'host_bridge_bundle_case_collision'],
  ['Windows DPAPI CurrentUser', 'bridge/dpapi_windows.go', 'DPAPI is bound to Windows CurrentUser'],
  ['Windows ConPTY', 'bridge/main.go', 'conpty.Start'],
  ['Windows loopback-only bridge', 'bridge/main.go', 'parsed.Hostname() != "127.0.0.1"'],
  ['Desktop composer model', 'apps/web/src/features/assist/AssistComposer.tsx', 'composer-text-control'],
  ['One-shot Plan UI', 'apps/web/src/features/assist/AssistComposer.tsx', 'composer-plan-toggle'],
  ['Goal card', 'apps/web/src/features/assist/AssistWorkbench.tsx', '<GoalCard'],
  ['Activity ledger', 'apps/web/src/features/assist/AssistWorkbench.tsx', '<ActivityLedger'],
  ['Runtime chooser', 'apps/web/src/features/assist/AssistWorkbench.tsx', '<TerminalRuntimeSelector'],
  ['Request user input UI', 'apps/web/src/features/assist/UserInputCard.tsx', 'Codex 需要你的输入'],
  ['Forced Undo confirmation', 'apps/web/src/features/assist/OperationReceipt.tsx', '确认强制撤回'],
  ['Dock resize handle', 'apps/web/src/features/assist/AssistWorkbench.tsx', 'assist-dock-resizer'],
  ['Real PTY transport', 'apps/api/src/terminal-service.mjs', 'WebSocketServer'],
  ['V1.5 core unit', 'tests/unit/v15-core.test.mjs', 'V1.5 core unit tests passed'],
  ['V1.5 operations unit', 'tests/unit/v15-operations.test.mjs', 'V1.5 operation ledger unit tests passed'],
  ['V1.5 Bridge unit', 'tests/unit/v15-change-bridge.test.mjs', 'V1.5 change batch and Host Bridge unit tests passed'],
  ['V1.5 Assist integration', 'tests/integration/v15-native-assist-flow.test.mjs', 'V1.5 native Assist integration tests passed'],
  ['V1.5 Bridge integration', 'tests/integration/v15-host-bridge-flow.test.mjs', 'V1.5 Windows Host Bridge integration tests passed'],
  ['V1.5 Web interactions', 'apps/web/src/test/assist-v15-interactions.test.tsx', 'Assist V1.5 interactions'],
  ['V1.6 core unit', 'tests/unit/v16-core.test.mjs', 'V1.6 core unit tests passed'],
  ['V1.6 release unit', 'tests/unit/v16-release.test.mjs', 'V1.6 release volume unit tests passed'],
  ['V1.6 release Docker flow', 'tests/release/v16-volume-flow.test.mjs', 'V1.6 Docker release volume flow tests passed'],
  ['V1.6 Assist files integration', 'tests/integration/v16-assist-files-flow.test.mjs', 'V1.6 Assist files and native Fork integration tests passed'],
  ['V1.6 Web interactions', 'apps/web/src/test/assist-v16-interactions.test.tsx', 'Assist V1.6 interactions'],
  ['Interaction audit', 'tests/e2e/smoke.test.mjs', 'auditButtons']
];

for (const [name, file, needle] of checks) {
  assert.ok(fs.existsSync(file), `${name}: ${file} exists`);
  assert.ok(fs.readFileSync(file, 'utf8').includes(needle), `${name}: contains ${needle}`);
}

for (const removed of ['apps/api/src/routes/demo.mjs', 'tests/integration/demo-flow.test.mjs', 'apps/web/app.js', 'apps/web/boot.js']) assert.equal(fs.existsSync(removed), false, `${removed} removed`);
const runtimeFiles = [...walk('apps'), ...walk('packages')].filter((file) => /\.(mjs|js|ts|tsx|html|css|json)$/.test(file) && !file.includes(`${path.sep}dist${path.sep}`));
const runtime = runtimeFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
for (const forbidden of ['/demo/full-chain', 'MockRunner', 'mock_runner', '生成演示链路', '<aiws_actions>', 'transport_fallback']) assert.equal(runtime.includes(forbidden), false, `production runtime excludes ${forbidden}`);
assert.equal(runtime.includes('buildAssistResult'), false, 'production runtime excludes fixed-rule Assist');
assert.equal(runtime.includes('codexProfileFromCcSwitch'), false, 'production runtime excludes fake cc-switch Profiles');
assert.ok(fs.existsSync('apps/web/dist/index.html'), 'production frontend build exists');

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.equal(manifest.version, '1.6.0', 'root package is V1.6');
for (const script of ['lint', 'typecheck', 'test', 'test:integration', 'test:e2e', 'test:release', 'audit:acceptance', 'verify']) assert.ok(manifest.scripts[script], `mandatory script ${script}`);
for (const dependency of ['busboy', 'node-pty', 'ws']) assert.ok(manifest.dependencies[dependency], `runtime dependency ${dependency}`);
assert.match(manifest.scripts['test:e2e'], /build-web/, 'standalone e2e builds the frontend');
assert.match(manifest.scripts['audit:acceptance'], /build-web/, 'standalone acceptance builds the frontend');
for (const suite of ['v13-terminal-flow', 'v14-container-flow', 'v15-native-assist-flow', 'v15-host-bridge-flow', 'v16-assist-files-flow']) assert.ok(manifest.scripts['test:integration'].includes(suite), `integration gate includes ${suite}`);
for (const suite of ['v14-container.test', 'v15-core.test', 'v15-operations.test', 'v15-change-bridge.test', 'v16-core.test', 'v16-release.test']) assert.ok(manifest.scripts.test.includes(suite), `unit gate includes ${suite}`);

for (const file of workspaceManifests()) assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, '1.6.0', `${file} is V1.6`);
const compose = fs.readFileSync('compose.yml', 'utf8');
for (const value of ['name: aiws-v16', 'aiws-app:1.6.0', 'aiws-codex-runner:1.6.0-codex-0.144.0', 'aiws-data-v16']) assert.ok(compose.includes(value), `Compose pins ${value}`);
assert.match(compose, /aiws-data:\s+[\s\S]*external: true/, 'production data volume cannot be silently replaced by Compose');
assert.equal(compose.includes('aiws-data-v14'), false, 'V1.6 Compose never mounts the legacy source volume');
assert.equal(runtime.includes('aiws-codex-runner:local'), false, 'runtime excludes mutable local Runner tag');

const verify = fs.readFileSync('scripts/verify.mjs', 'utf8');
for (const gate of ["pnpmStep('test'", "pnpmStep('test:integration'", 'e2e:playwright', 'acceptance:audit']) assert.ok(verify.includes(gate), `verify includes ${gate}`);
const composer = fs.readFileSync('apps/web/src/features/assist/AssistComposer.tsx', 'utf8');
for (const removedMode of [">Ask<", ">Agent<", ">CLI<", ">Default<"]) assert.equal(composer.includes(removedMode), false, `composer excludes ${removedMode}`);
const browser = fs.readFileSync('tests/e2e/playwright.test.mjs', 'utf8');
for (const viewport of ['1440', '1024', '390', "keyboard.press('Escape')"]) assert.ok(browser.includes(viewport), `browser acceptance includes ${viewport}`);
const managedCcSwitch = fs.readFileSync('apps/api/src/cc-switch-managed-cli.mjs', 'utf8');
assert.equal(/sqlite|better-sqlite3/i.test(managedCcSwitch), false, 'managed cc-switch path never writes SQLite');
console.log(`V1.6 acceptance audit passed (${checks.length} implementation checks)`);

function workspaceManifests() { return ['apps', 'packages'].flatMap((root) => fs.readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => path.join(root, item.name, 'package.json')).filter(fs.existsSync)); }
function walk(dir) { if (!fs.existsSync(dir)) return []; return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => { if (['node_modules', 'dist'].includes(entry.name)) return []; const full = path.join(dir, entry.name); return entry.isDirectory() ? walk(full) : [full]; }); }
