import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const checks = [
  ['V1.2 dev plan', '开发计划v1.2.md', '相对 `开发计划v1.1.md`'],
  ['V1.2 test plan', '测试计划v1.2.md', 'Setup 是前后端共同执行的硬门禁'],
  ['V1.3 dev plan', '开发计划v1.3.md', '相对 `开发计划v1.2.md`'],
  ['V1.3 test plan', '测试计划v1.3.md', 'Project Lifecycle'],
  ['V1.4 dev plan', '开发计划v1.4.md', '完全容器化增量'],
  ['V1.4 test plan', '测试计划v1.4.md', '真实容器 Smoke'],
  ['Production Dockerfile', 'Dockerfile', 'FROM workspace-deps AS verify'],
  ['V1.4 Compose', 'compose.yml', '127.0.0.1:${AIWS_PORT:-4317}:4317'],
  ['Runner image', 'docker/codex-runner.Dockerfile', 'ARG CODEX_VERSION=0.144.0'],
  ['PowerShell operations', 'scripts/aiws.ps1', "'backup'"],
  ['POSIX operations', 'scripts/aiws.sh', 'restore_data'],
  ['React workspace', 'apps/web/package.json', '@xyflow/react'],
  ['Setup guard', 'apps/web/src/app/setup-guard.tsx', '<Navigate to="/setup"'],
  ['Setup API', 'apps/api/src/routes/setup-v12.mjs', '/setup/complete'],
  ['GitHub App JWT', 'apps/api/src/github-service.mjs', 'createAppJwt'],
  ['GitHub Manifest', 'apps/api/src/routes/github-config-v12.mjs', '/github/manifest/callback'],
  ['GitHub installation', 'apps/api/src/routes/github-installations-v12.mjs', 'fetchInstallationRepositories'],
  ['GitHub webhook', 'apps/api/src/routes/github-webhook-v12.mjs', 'timingSafeEqual'],
  ['Secret vault', 'apps/api/src/vault.mjs', 'vault:'],
  ['Codex profile home', 'apps/api/src/codex-service.mjs', 'CODEX_HOME'],
  ['Codex third-party endpoint', 'apps/api/src/codex-service.mjs', 'base_url_required'],
  ['Codex probe', 'apps/api/src/routes/codex-v12.mjs', '/codex/probe'],
  ['Codex local discovery API', 'apps/api/src/routes/codex-discovery-v12.mjs', '/codex/discovery/import'],
  ['cc-switch SQLite read-only', 'apps/api/src/cc-switch-discovery.mjs', 'readOnly: true'],
  ['Codex TOML discovery', 'apps/api/src/codex-discovery-utils.mjs', "from 'smol-toml'"],
  ['Codex four-source UI', 'apps/web/src/features/setup/CodexConnectionSetup.tsx', 'Codex 配置来源'],
  ['Codex Device public allowlist', 'apps/api/src/codex-device-auth.mjs', 'extractDeviceAuthPublicState'],
  ['cc-switch sources', 'apps/api/src/cc-switch-service.mjs', 'farion1231/cc-switch'],
  ['cc-switch conformance', 'apps/api/src/cc-switch-service.mjs', 'validateBridgeConformance'],
  ['Codex endpoint UI', 'apps/web/src/features/setup/CodexProviderFields.tsx', 'API Base URL'],
  ['Assist SSE', 'apps/api/src/routes/assist-v12.mjs', 'text/event-stream'],
  ['Assist whitelist', 'apps/api/src/assist-runtime.mjs', 'reversible'],
  ['Assist semantic dispatch', 'apps/web/src/components/assist/semantic-actions.ts', 'semantic_target_not_available'],
  ['NodeRun approval', 'apps/api/src/run-approval.mjs', 'node_run_approval_required'],
  ['Repository checkout', 'apps/api/src/repository-checkout.mjs', 'repository_clone_failed'],
  ['Workflow proposal', 'apps/api/src/routes/workflow-v12.mjs', '/workflows/:id/proposals'],
  ['File traversal guard', 'apps/api/src/file-service.mjs', 'path_outside_repository'],
  ['React Flow canvas', 'apps/web/src/features/workflow/canvas/WorkflowCanvas.tsx', '<ReactFlow'],
  ['Monaco workspace', 'apps/web/src/features/nodes/renderers/ExecutionWorkspace.tsx', '<Editor'],
  ['Five renderers', 'apps/web/src/features/nodes/registry.tsx', 'retrospective'],
  ['V1.2 integration', 'tests/integration/v12-flow.test.mjs', 'v1.2 integration tests passed'],
  ['Project draft creation', 'apps/api/src/routes/projects.mjs', 'createDraftProjectRecords'],
  ['Project onboarding', 'apps/api/src/routes/project-onboarding-v13.mjs', '/projects/:id/onboarding/confirm'],
  ['Managed staging import', 'apps/api/src/project-import-service.mjs', 'validateArchiveListing'],
  ['Archive boundary records', 'apps/api/src/project-import-service.mjs', 'validateArchiveRecords'],
  ['Managed realpath barrier', 'apps/api/src/managed-workspace.mjs', 'realPathWithin'],
  ['GitHub create state machine', 'apps/api/src/routes/github-repositories-v13.mjs', 'access_required'],
  ['Assist V3 routes', 'apps/api/src/routes/assist-v3.mjs', '/assist/v3/sessions/:id/follow-ups'],
  ['Assist V3 replay', 'apps/api/src/assist-v3-events.mjs', 'last-event-id'],
  ['Agent worktree', 'apps/api/src/assist-v3-worktree.mjs', "['worktree', 'add'"],
  ['Codex app-server', 'apps/api/src/codex-app-server.mjs', "request('turn/start'"],
  ['Unified container runtime', 'apps/api/src/container-runtime-config.mjs', 'volume-subpath='],
  ['Runner lifecycle cleanup', 'apps/api/src/container-runtime.mjs', 'cleanupStaleContainers'],
  ['Deployment API', 'apps/api/src/routes/system.mjs', '/system/deployment'],
  ['Host import root', 'apps/api/src/host-import-root.mjs', 'host_import_symlink_rejected'],
  ['Codex exec fallback', 'apps/api/src/assist-v3-runtime.mjs', 'transport_fallback'],
  ['Unified approvals', 'apps/api/src/routes/approvals-v13.mjs', 'approve_apply'],
  ['Managed cc-switch', 'apps/api/src/cc-switch-managed-cli.mjs', 'CC_SWITCH_VERSION'],
  ['Config revision reconciliation', 'apps/api/src/config-revision-service.mjs', 'manual_reconciliation_required'],
  ['Real PTY transport', 'apps/api/src/terminal-service.mjs', 'WebSocketServer'],
  ['Terminal review', 'apps/api/src/terminal-review-service.mjs', 'applyTerminalReview'],
  ['Onboarding UI', 'apps/web/src/features/projects/onboarding/ProjectOnboardingPage.tsx', 'workflow_draft'],
  ['Assist V3 workbench', 'apps/web/src/features/assist/AssistWorkbench.tsx', 'surface-${ui.assistSurface}'],
  ['xterm UI', 'apps/web/src/features/assist/TerminalPanel.tsx', "import('@xterm/xterm')"],
  ['Unified Diff UI', 'apps/web/src/features/assist/DiffReviewPanel.tsx', 'request-changes'],
  ['Terminal integration', 'tests/integration/v13-terminal-flow.test.mjs', 'Terminal PTY integration tests passed'],
  ['Legacy migration integration', 'tests/integration/v13-migration-flow.test.mjs', 'legacy migration integration tests passed'],
  ['Secure import integration', 'tests/integration/v13-import-security-flow.test.mjs', 'secure import integration tests passed'],
  ['GitHub repository state machine', 'tests/integration/v13-github-repository-flow.test.mjs', 'GitHub repository state-machine integration tests passed'],
  ['Assist lifecycle integration', 'tests/integration/v13-assist-lifecycle-flow.test.mjs', 'Assist lifecycle integration tests passed'],
  ['App-server protocol unit', 'tests/unit/codex-app-server.test.mjs', 'experimentalApi'],
  ['Interaction audit', 'tests/e2e/smoke.test.mjs', 'auditButtons']
  ,['V1.4 container unit', 'tests/unit/v14-container.test.mjs', 'container runtime unit tests passed']
  ,['V1.4 container integration', 'tests/integration/v14-container-flow.test.mjs', 'container deployment/import integration tests passed']
  ,['Deployment UI test', 'apps/web/src/test/v14-deployment.test.tsx', 'V1.4 deployment capabilities']
];
for (const [name, file, needle] of checks) {
  assert.ok(fs.existsSync(file), `${name}: ${file} exists`);
  assert.ok(fs.readFileSync(file, 'utf8').includes(needle), `${name}: contains ${needle}`);
}

for (const removed of ['apps/api/src/routes/demo.mjs', 'tests/integration/demo-flow.test.mjs', 'apps/web/app.js', 'apps/web/boot.js']) assert.equal(fs.existsSync(removed), false, `${removed} removed`);
const runtimeFiles = [...walk('apps'), ...walk('packages')].filter((file) => /\.(mjs|js|ts|tsx|html|css|json)$/.test(file) && !file.includes(`${path.sep}dist${path.sep}`));
const runtime = runtimeFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
for (const forbidden of ['/demo/full-chain', 'MockRunner', 'mock_runner', '生成演示链路']) assert.equal(runtime.includes(forbidden), false, `production runtime excludes ${forbidden}`);
assert.equal(runtime.includes('buildAssistResult'), false, 'production runtime excludes fixed-rule Assist');
assert.equal(runtime.includes('codexProfileFromCcSwitch'), false, 'production runtime excludes checkout-only fake cc-switch Profiles');
assert.ok(fs.existsSync('apps/web/dist/index.html'), 'production frontend build exists');
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.equal(manifest.version, '1.4.0', 'root package is V1.4');
for (const script of ['lint', 'typecheck', 'test', 'test:integration', 'test:e2e', 'audit:acceptance', 'verify']) assert.ok(manifest.scripts[script], `mandatory script ${script}`);
for (const dependency of ['node-pty', 'ws']) assert.ok(manifest.dependencies[dependency], `runtime dependency ${dependency}`);
assert.match(manifest.scripts['test:e2e'], /build-web/, 'standalone e2e builds the frontend');
assert.match(manifest.scripts['audit:acceptance'], /build-web/, 'standalone acceptance builds the frontend');
const verify = fs.readFileSync('scripts/verify.mjs', 'utf8');
for (const gate of ["pnpmStep('test'", "pnpmStep('test:integration'", "e2e:playwright", "acceptance:audit"]) assert.ok(verify.includes(gate), `verify includes ${gate}`);
const fileService = fs.readFileSync('apps/api/src/file-service.mjs', 'utf8');
for (const guard of ['fsp.realpath(lexicalTarget)', 'symlink_outside_repository', 'diffSummary(', "source = 'owner_editor'"]) assert.ok(fileService.includes(guard), `file capability includes ${guard}`);
const approvals = fs.readFileSync('apps/api/src/run-approval.mjs', 'utf8');
for (const approval of ['node_run_authorization', 'git_commit_authorization', 'git_publish_authorization', 'consumed_at']) assert.ok(approvals.includes(approval), `one-shot approval includes ${approval}`);
const browser = fs.readFileSync('tests/e2e/playwright.test.mjs', 'utf8');
for (const viewport of ['1440', '1024', '390', "keyboard.press('Escape')", 'workflow-empty-', 'setup-codex-third-party-']) assert.ok(browser.includes(viewport), `browser acceptance includes ${viewport}`);
const integrationScript = manifest.scripts['test:integration'];
for (const suite of ['v12-github-security-flow', 'v12-files-flow', 'v12-assist-flow', 'v12-codex-flow', 'v12-codex-discovery-flow']) assert.ok(integrationScript.includes(suite), `integration gate includes ${suite}`);
for (const suite of ['v13-migration-flow', 'v13-project-lifecycle-flow', 'v13-import-security-flow', 'v13-github-repository-flow', 'v13-governance-flow', 'v13-assist-worktree-flow', 'v13-assist-lifecycle-flow', 'v13-terminal-flow']) assert.ok(integrationScript.includes(suite), `V1.3 integration gate includes ${suite}`);
assert.ok(integrationScript.includes('v14-container-flow'), 'V1.4 integration gate includes container flow');
assert.ok(manifest.scripts.test.includes('v14-container.test'), 'unit gate includes V1.4 container runtime');
assert.ok(manifest.scripts.test.includes('codex-app-server.test'), 'unit gate includes app-server protocol');
const webManifest = JSON.parse(fs.readFileSync('apps/web/package.json', 'utf8'));
assert.equal(webManifest.version, '1.4.0', 'web package is V1.4');
for (const dependency of ['@xterm/xterm', '@xterm/addon-fit']) assert.ok(webManifest.dependencies[dependency], `web dependency ${dependency}`);
const managedCcSwitch = fs.readFileSync('apps/api/src/cc-switch-managed-cli.mjs', 'utf8');
assert.equal(/sqlite|better-sqlite3/i.test(managedCcSwitch), false, 'managed cc-switch path never writes SQLite');
assert.equal(runtime.includes('aiws-codex-runner:local'), false, 'runtime excludes mutable local Runner tag');
assert.match(fs.readFileSync('apps/api/src/state.mjs', 'utf8'), /schema_version = 13/, 'state schema remains 13');
for (const file of ['apps/worker/package.json', 'packages/context-pack/package.json', 'packages/git-tools/package.json', 'packages/mcp-bridge/package.json', 'packages/memory-policy/package.json', 'packages/runner-adapters/package.json', 'packages/shared/package.json']) assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, '1.4.0', `${file} is V1.4`);
console.log(`V1.4 acceptance audit passed (${checks.length} implementation checks)`);

function walk(dir) { if (!fs.existsSync(dir)) return []; return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => { if (['node_modules', 'dist'].includes(entry.name)) return []; const full = path.join(dir, entry.name); return entry.isDirectory() ? walk(full) : [full]; }); }
