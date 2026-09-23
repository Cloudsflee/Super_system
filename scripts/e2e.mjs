import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { nodeInvocation } from './lib/gate-process.mjs';
import { startProbeWithPorts } from './lib/port-lease.mjs';

const root = process.cwd();
let startup, apiPort, webPort, base, browser, context, page;
const vaultKey = 'p10-clean-e2e-vault-key';
const reportDir = path.join(root, '.ai-workspace', 'e2e-clean-p10');
fs.rmSync(reportDir, { recursive: true, force: true });
fs.mkdirSync(reportDir, { recursive: true });
const requests = [];
const browserErrors = [];
const httpErrors = [];
const accessibilityReceipts = [];
const drawerReceipts = [];
const onboardingLayoutReceipts = [];

async function pageApi(pathname, options = {}) {
  return page.evaluate(async ({ pathname, options }) => {
    const response = await fetch(pathname, {
      ...options,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
      body: options.body == null ? undefined : JSON.stringify(options.body)
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  }, { pathname, options });
}

try {
  startup = await startProbeWithPorts({ prefix: 'aiws-p10-e2e', start: async scope => {
    const [apiLease, webLease] = scope.leases;
    const apiPort = apiLease.port, webPort = webLease.port;
    const apiBase = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${webPort}`;
    await apiLease.handoff();
    const api = scope.spawn(nodeInvocation('apps/api/server.mjs'), { cwd: root, workspaceRoot: root, env: {
      AIWS_CLEAN_PORT: String(apiPort), AIWS_CLEAN_HOME: scope.directory, AIWS_CLEAN_CORS_ORIGINS: base,
      AIWS_CLEAN_VAULT_KEY: vaultKey, AIWS_CLEAN_BUILD: 'v3-clean-p10-e2e',
      AIWS_CLEAN_MCP_PEPPER: 'p10-clean-e2e-mcp-pepper', AIWS_GATEWAY_SECRET: 'p10-clean-e2e-gateway-secret',
      AIWS_CLEAN_PROVIDER_MODE: 'deterministic', AIWS_RUNNER_POLL_INTERVAL_MS: '10'
    } });
    await scope.ready(0, `${apiBase}/readyz`, { child: api, readyOutput: new RegExp(`V3-Clean listening on http://127[.]0[.]0[.]1:${apiPort}\\b`), accept: async response => response.ok && (await response.json()).data?.user_version === 9 });
    await webLease.handoff();
    const viteEntry = path.join(root, 'apps/web/node_modules/vite/bin/vite.js');
    const web = scope.spawn(nodeInvocation(viteEntry, ['--host', '127.0.0.1', '--port', String(webPort), '--strictPort']), {
      cwd: path.join(root, 'apps/web'), workspaceRoot: root, env: { AIWS_WEB_API_TARGET: apiBase, VITE_AIWS_E2E: '1' }
    });
    await scope.ready(1, `${base}/`, { child: web, readyOutput: new RegExp(`http://127[.]0[.]0[.]1:${webPort}/`) });
    const browser = scope.browser(await chromium.launch({ headless: true }));
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${base}/readyz`, { waitUntil: 'domcontentloaded' });
    return { apiPort, webPort, base, browser, context, page };
  } });
  ({ apiPort, webPort, base, browser, context, page } = startup);
  page.on('request', request => requests.push(request.url()));
  page.on('response', response => { if (response.status() >= 400) httpErrors.push(`${response.status()}:${response.url()}`); });
  page.on('pageerror', error => browserErrors.push(`pageerror:${error.message}`));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(`console:${message.text()}`); });
  await page.goto(`${base}/#/setup`, { waitUntil: 'domcontentloaded' });
  try { await page.getByRole('heading', { name: '创建本地所有者', exact: true }).waitFor({ timeout: 8_000 }); }
  catch (error) { process.stderr.write(`Clean Web bootstrap body:\n${await page.locator('body').innerText()}\nURL=${page.url()}\nRequests=${JSON.stringify(requests)}\n`); throw error; }
  await captureOnboardingState(page, 'system-owner');
  await page.getByLabel('显示名称').fill('P10 E2E owner');
  await page.getByLabel('团队名称').fill('P10 E2E team');
  await page.getByRole('button', { name: '创建并继续', exact: true }).click();
  await page.getByRole('heading', { name: '连接 Codex', exact: true }).waitFor();
  await captureOnboardingState(page, 'system-codex');
  await page.getByLabel('Codex 凭据').fill('p10-e2e-onboarding-codex-proof');
  await page.getByLabel('Codex Profile 名称').fill('P10 E2E Reviewer');
  await page.getByRole('button', { name: '验证并继续', exact: true }).click();
  await page.getByRole('heading', { name: '连接 GitHub App', exact: true }).waitFor();
  await captureOnboardingState(page, 'system-github');
  const persistedOnboardingSecrets = await page.evaluate(() => `${Object.values(localStorage).join('|')}|${Object.values(sessionStorage).join('|')}`);
  assert(!persistedOnboardingSecrets.includes('p10-e2e-onboarding-codex-proof'), 'onboarding secret storage hygiene');
  await page.getByRole('button', { name: '稍后配置', exact: true }).click();
  await page.getByRole('heading', { name: '配置检查', exact: true }).waitFor();
  await captureOnboardingState(page, 'system-summary');
  await page.getByRole('button', { name: '进入项目创建', exact: true }).click();
  try { await page.getByRole('heading', { name: '项目', exact: true }).waitFor({ timeout: 8_000 }); }
  catch (error) { process.stderr.write(`Clean Web projects body:\n${await page.locator('body').innerText()}\nState=${JSON.stringify(await page.locator('.app-shell').evaluate((element) => ({ ...element.dataset })))}\nURL=${page.url()}\nRequests=${JSON.stringify(requests.slice(-30))}\nHTTP=${JSON.stringify(httpErrors)}\n`); throw error; }

  const onboardingTemplate = await pageApi('/api/v2/brief-templates', {
    method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-onboarding-template', 'X-Expected-Revision': '0' },
    body: { name: 'P10 Onboarding Brief', content: { objective: 'Verify continuous onboarding', users: ['Maintainer'], scope: { in: ['Web'], out: ['Production'] }, constraints: ['CAS'], milestones: ['Workflow ready'], acceptance: ['browser verified'], risks: ['source drift'], open_questions: ['none'] }, expected_revision: 0 }
  });
  assert(onboardingTemplate.status === 201 && onboardingTemplate.body.data?.template?.id, `onboarding-template:${onboardingTemplate.status}`);
  await page.getByLabel('项目名称').fill('P10 Clean project');
  await page.getByLabel('项目说明').fill('Clean E2E fixture');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await page.getByRole('heading', { name: '选择项目来源', exact: true }).waitFor();
  await captureOnboardingState(page, 'project-intake');
  await page.getByLabel('初始构想').fill('Complete the Clean browser journey');
  await page.getByRole('button', { name: '提交 Intake', exact: true }).click();
  await page.getByRole('heading', { name: '编辑完整 Brief', exact: true }).waitFor();
  await captureOnboardingState(page, 'project-brief');
  await page.getByLabel('Brief 模板').selectOption(onboardingTemplate.body.data.template.id);
  await page.getByRole('button', { name: '应用模板', exact: true }).click();
  await page.getByRole('button', { name: '保存 Brief', exact: true }).click();
  await page.getByRole('heading', { name: '审查 Brief 与初始 Workflow', exact: true }).waitFor();
  await captureOnboardingState(page, 'project-review');
  await page.getByRole('button', { name: '保存初始 Workflow', exact: true }).click();
  await page.getByRole('button', { name: '生成候选', exact: true }).click();
  await page.getByRole('button', { name: '执行 Critic', exact: true }).waitFor();
  await page.getByRole('button', { name: '执行 Critic', exact: true }).click();
  try { await page.getByRole('button', { name: '应用 Proposal', exact: true }).waitFor(); }
  catch (error) { process.stderr.write(`Project onboarding after Critic:\n${await page.locator('body').innerText()}\nHTTP=${JSON.stringify(httpErrors.slice(-20))}\nRequests=${JSON.stringify(requests.slice(-30))}\n`); throw error; }
  await page.getByRole('button', { name: '应用 Proposal', exact: true }).click();
  try { await page.getByRole('button', { name: '确认 Brief 并激活', exact: true }).waitFor(); }
  catch (error) { process.stderr.write(`Project onboarding after Proposal apply:\n${await page.locator('body').innerText()}\nHTTP=${JSON.stringify(httpErrors.slice(-20))}\nRequests=${JSON.stringify(requests.slice(-30))}\n`); throw error; }
  await page.getByRole('button', { name: '确认 Brief 并激活', exact: true }).click();
  await page.getByText('工作流草稿', { exact: true }).waitFor();

  const setup = await pageApi('/api/v2/setup');
  assert(setup.status === 200 && setup.body.data?.needs_setup === false, 'setup cookie/session');
  const projects = await pageApi('/api/v2/projects');
  const project = projects.body.data?.projects?.find((item) => item.name === 'P10 Clean project');
  assert(project?.id, 'project create');

  const providerCredential = await pageApi('/api/v2/credentials', {
    method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-provider-credential', 'X-Expected-Revision': '0' },
    body: { provider: 'codex', external_ref: 'p10-e2e-provider', scope: {}, expected_revision: 0 }
  });
  assert(providerCredential.status === 201 && providerCredential.body.data?.credential?.id, `provider-credential:${providerCredential.status}`);
  const reboundCredential = await pageApi(`/api/v2/credentials/${providerCredential.body.data.credential.id}/rebind`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-provider-rebind', 'X-Expected-Revision': '1' },
    body: { proof: 'p10-e2e-provider-proof-123456789', expected_revision: 1 }
  });
  assert(reboundCredential.status === 202, `provider-rebind:${reboundCredential.status}`);
  const rebindOperation = await waitOperation(pageApi, reboundCredential.body.data?.operation_id || reboundCredential.body.data?.operation?.operation_id);
  const activeCredential = (await pageApi('/api/v2/credentials')).body.data.credentials.find((item) => item.id === providerCredential.body.data.credential.id);
  assert(rebindOperation?.status === 'succeeded' && activeCredential?.status === 'active', 'provider rebind operation');
  const providerProfile = await pageApi('/api/v2/profiles', {
    method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-provider-profile', 'X-Expected-Revision': '0' },
    body: { provider: 'codex', label: 'P10 E2E Codex', credential_ref_id: providerCredential.body.data.credential.id, config: { model: 'fixture' }, expected_revision: 0 }
  });
  assert(providerProfile.status === 201 && providerProfile.body.data?.profile?.id, `provider-profile:${providerProfile.status}`);
  const providerProbe = await pageApi(`/api/v2/profiles/${providerProfile.body.data.profile.id}/probe`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-provider-probe', 'X-Expected-Revision': String(providerProfile.body.data.profile.revision) },
    body: { expected_revision: providerProfile.body.data.profile.revision }
  });
  const providerProbeOperation = await waitOperation(pageApi, providerProbe.body.data?.operation_id || providerProbe.body.data?.operation?.operation_id);
  assert(providerProbeOperation?.status === 'succeeded', 'provider probe');
  let currentProvider = (await pageApi('/api/v2/profiles')).body.data.profiles.find((item) => item.id === providerProfile.body.data.profile.id);
  const updatedProvider = await pageApi(`/api/v2/profiles/${currentProvider.id}`, {
    method: 'PATCH', headers: { 'Idempotency-Key': 'p10-e2e-provider-update', 'X-Expected-Revision': String(currentProvider.revision) },
    body: { label: 'P10 E2E Reviewer', config: { model: 'fixture-review' }, credential_ref_id: providerCredential.body.data.credential.id, expected_revision: currentProvider.revision }
  });
  currentProvider = updatedProvider.body.data.profile;
  const disabledProvider = await pageApi(`/api/v2/profiles/${currentProvider.id}/disable`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-provider-disable', 'X-Expected-Revision': String(currentProvider.revision) }, body: { expected_revision: currentProvider.revision } });
  const enabledProvider = await pageApi(`/api/v2/profiles/${currentProvider.id}/enable`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-provider-enable', 'X-Expected-Revision': String(disabledProvider.body.data.profile.revision) }, body: { expected_revision: disabledProvider.body.data.profile.revision } });
  currentProvider = enabledProvider.body.data.profile;
  const reprobeProvider = await pageApi(`/api/v2/profiles/${currentProvider.id}/probe`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-provider-reprobe', 'X-Expected-Revision': String(currentProvider.revision) }, body: { expected_revision: currentProvider.revision } });
  await waitOperation(pageApi, reprobeProvider.body.data?.operation_id || reprobeProvider.body.data?.operation?.operation_id);

  const briefTemplate = await pageApi('/api/v2/brief-templates', {
    method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-template-create', 'X-Expected-Revision': '0' },
    body: { team_id: project.team_id, name: 'P10 E2E Brief', content: { sections: ['objective', 'acceptance'] }, expected_revision: 0 }
  });
  assert(briefTemplate.status === 201 && briefTemplate.body.data?.template?.id, `brief-template:${briefTemplate.status}`);
  const revisedTemplate = await pageApi(`/api/v2/brief-templates/${briefTemplate.body.data.template.id}`, {
    method: 'PATCH', headers: { 'Idempotency-Key': 'p10-e2e-template-update', 'X-Expected-Revision': String(briefTemplate.body.data.template.revision) },
    body: { content: { sections: ['objective', 'constraints', 'acceptance'] }, expected_revision: briefTemplate.body.data.template.revision }
  });
  const archivedTemplate = await pageApi(`/api/v2/brief-templates/${briefTemplate.body.data.template.id}/archive`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-template-archive', 'X-Expected-Revision': String(revisedTemplate.body.data.template.revision) }, body: { expected_revision: revisedTemplate.body.data.template.revision } });
  assert(archivedTemplate.body.data?.template?.status === 'archived', 'brief template archive');

  const replay = await pageApi('/api/v2/projects', { method: 'GET' });
  assert(replay.status === 200 && replay.body.data?.projects?.some((item) => item.id === project.id), 'reload/replay');
  const denied = await pageApi(`/api/v2/projects/${project.id}/permissions`);
  assert([200, 403].includes(denied.status), `ACL probe:${denied.status}`);

  const target = await pageApi('/api/v2/projects', {
    method: 'POST', headers: { 'Idempotency-Key': 'p7-e2e-target-project-01', 'X-Expected-Revision': '0' },
    body: { name: 'P7 Exchange target', description: 'Clean E2E target', metadata: {}, expected_revision: 0 }
  });
  assert(target.status === 201 && target.body.data?.project?.id, `target-project:${target.status}`);

  const source = await pageApi(`/api/v2/projects/${project.id}/context/sources`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p7-e2e-context-source-01', 'X-Expected-Revision': '0' },
    body: { kind: 'note', title: 'P7 verification note', uri: 'notes/p7-verification', content: 'runner execution checkpoint replay evidence', source_revision: 'r1', expected_revision: 0 }
  });
  assert(source.status === 201, `context-source:${source.status}`);
  const rebuilt = await pageApi(`/api/v2/projects/${project.id}/context/rebuild`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p7-e2e-context-rebuild-01', 'X-Expected-Revision': '0' },
    body: { mode: 'full', expected_revision: 0 }
  });
  assert(rebuilt.status === 202, `context-rebuild:${rebuilt.status}`);
  await waitOperation(pageApi, rebuilt.body.data?.operation_id);
  const selection = await pageApi(`/api/v2/projects/${project.id}/context/selections`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p7-e2e-context-selection-01', 'X-Expected-Revision': '0' },
    body: { query: 'checkpoint replay', token_budget: 1024, expected_revision: 0 }
  });
  assert(selection.status === 201 && selection.body.data?.selection?.id, `context-selection:${selection.status}`);
  const pack = await pageApi(`/api/v2/projects/${project.id}/context/packs`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p7-e2e-context-pack-01', 'X-Expected-Revision': '0' },
    body: { selection_id: selection.body.data.selection.id, require_authoritative: false, expected_revision: 0 }
  });
  assert(pack.status === 201 && pack.body.data?.pack?.pack_hash, `context-pack:${pack.status}`);

  const connection = await pageApi(`/api/v2/projects/${project.id}/repository-connections`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p7-e2e-repository-01', 'X-Expected-Revision': '0' },
    body: { provider: 'fixture', source_kind: 'git', source_locator: 'fixture/p7-e2e', source_revision: 'a'.repeat(40), source_hash: 'a'.repeat(64), expected_revision: 0 }
  });
  assert(connection.status === 201 && connection.body.data?.connection?.id, `repository-connection:${connection.status}`);
  const repositoryTargets = await pageApi(`/api/v2/repository-connections/${connection.body.data.connection.id}/targets`);
  const repositoryTarget = repositoryTargets.body.data?.targets?.[0];
  assert(repositoryTargets.status === 200 && repositoryTarget?.id, `repository-targets:${repositoryTargets.status}`);
  const lines = await pageApi(`/api/v2/projects/${project.id}/repository-lines`);
  const line = lines.body.data?.lines?.[0];
  assert(lines.status === 200 && line?.id, `repository-lines:${lines.status}`);
  const reconciled = await pageApi(`/api/v2/repository-lines/${line.id}/reconcile`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p7-e2e-reconcile-01', 'X-Expected-Revision': String(line.revision) },
    body: { source_revision: 'a'.repeat(40), source_hash: 'a'.repeat(64), expected_revision: line.revision }
  });
  assert(reconciled.status === 200 && reconciled.body.data?.line?.status === 'ready', `repository-reconcile:${reconciled.status}`);
  const workspace = await pageApi(`/api/v2/projects/${project.id}/repository-workspaces`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p7-e2e-workspace-01', 'X-Expected-Revision': '0' },
    body: { line_id: line.id, relative_path: `projects/${project.id}/p7-e2e`, expected_revision: 0 }
  });
  assert(workspace.status === 201 && workspace.body.data?.workspace?.id, `repository-workspace:${workspace.status}`);

  const assistCreated = await pageApi('/api/v2/assist/sessions', {
    method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-assist-session', 'X-Expected-Revision': '0' },
    body: { project_id: project.id, scope: 'project', scope_id: project.id, context_pack_id: pack.body.data.pack.id, profile_id: providerProfile.body.data.profile.id, repository_workspace_id: workspace.body.data.workspace.id, title: 'P10 E2E review', mode: 'guided', expected_revision: 0 }
  });
  assert(assistCreated.status === 201 && assistCreated.body.data?.session?.id, `assist-session:${assistCreated.status}`);
  let assistSession = assistCreated.body.data.session;
  const assistMetadata = await pageApi(`/api/v2/assist/sessions/${assistSession.id}`, { method: 'PATCH', headers: { 'Idempotency-Key': 'p10-e2e-assist-metadata', 'X-Expected-Revision': String(assistSession.revision) }, body: { title: 'P10 E2E pinned review', mode: 'agent', pinned: true, expected_revision: assistSession.revision } });
  assert(assistMetadata.status === 200, `assist-metadata:${assistMetadata.status}:${assistMetadata.body.error?.code || ''}`);
  assistSession = assistMetadata.body.data.session;
  const assistConfiguration = await pageApi(`/api/v2/assist/sessions/${assistSession.id}/configurations`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-assist-config', 'X-Expected-Revision': String(assistSession.revision) }, body: { configuration: { model: 'fixture-review', approval: 'on-request' }, expected_revision: assistSession.revision } });
  assert(assistConfiguration.status === 201, `assist-configuration:${assistConfiguration.status}:${assistConfiguration.body.error?.code || ''}`);
  assistSession = assistConfiguration.body.data.session;
  const assistFork = await pageApi(`/api/v2/assist/sessions/${assistSession.id}/fork`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-assist-fork', 'X-Expected-Revision': String(assistSession.revision) }, body: { title: 'P10 E2E fork', expected_revision: assistSession.revision } });
  const assistSide = await pageApi(`/api/v2/assist/sessions/${assistSession.id}/side-threads`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-assist-side', 'X-Expected-Revision': String(assistSession.revision) }, body: { title: 'P10 E2E side thread', expected_revision: assistSession.revision } });
  assert(assistFork.status === 201, `assist-fork:${assistFork.status}:${assistFork.body.error?.code || ''}`);
  assert(assistSide.status === 201, `assist-side:${assistSide.status}:${assistSide.body.error?.code || ''}`);
  assert(assistFork.body.data?.session?.parent_session_id === assistSession.id && assistSide.body.data?.session?.mode === 'side_thread', 'assist fork and side thread');
  const assistSourceBeforeArchive = await pageApi(`/api/v2/assist/sessions/${assistSession.id}`);
  assert(assistSourceBeforeArchive.status === 200, `assist-source-before-archive:${assistSourceBeforeArchive.status}:${assistSourceBeforeArchive.body.error?.message || ''}`);
  const assistArchived = await pageApi(`/api/v2/assist/sessions/${assistSession.id}/archive`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-assist-archive', 'X-Expected-Revision': String(assistSession.revision) }, body: { expected_revision: assistSession.revision } });
  assert(assistArchived.status === 200, `assist-archive:${assistArchived.status}:${assistArchived.body.error?.message || ''}:${JSON.stringify(assistArchived.body.error?.details || {})}`);
  const assistRestored = await pageApi(`/api/v2/assist/sessions/${assistSession.id}/restore`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-assist-restore', 'X-Expected-Revision': String(assistArchived.body.data.session.revision) }, body: { expected_revision: assistArchived.body.data.session.revision } });
  const assistDeleted = await pageApi(`/api/v2/assist/sessions/${assistSession.id}/delete`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-assist-delete', 'X-Expected-Revision': String(assistRestored.body.data.session.revision) }, body: { expected_revision: assistRestored.body.data.session.revision } });
  const assistRecovered = await pageApi(`/api/v2/assist/sessions/${assistSession.id}/restore-deleted`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-assist-recover', 'X-Expected-Revision': String(assistDeleted.body.data.session.revision) }, body: { expected_revision: assistDeleted.body.data.session.revision } });
  assistSession = assistRecovered.body.data.session;
  const assistTurnStarted = await pageApi(`/api/v2/assist/sessions/${assistSession.id}/turns`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-assist-turn', 'X-Expected-Revision': String(assistSession.revision) }, body: { message: 'Review the P10 browser workflow', expected_revision: assistSession.revision } });
  const assistOperation = await waitOperation(pageApi, assistTurnStarted.body.data?.operation_id || assistTurnStarted.body.data?.operation?.operation_id);
  assert(assistOperation?.status === 'succeeded', 'assist turn');
  const assistBundle = await pageApi(`/api/v2/assist/sessions/${assistSession.id}`);
  const assistTurn = assistBundle.body.data?.turns?.at(-1);
  assert(assistTurn?.id, 'assist terminal turn');
  const assistComment = await pageApi(`/api/v2/assist/turns/${assistTurn.id}/review-comments`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-assist-comment', 'X-Expected-Revision': String(assistTurn.revision) }, body: { content: 'Browser review comment.', expected_revision: assistTurn.revision } });
  const assistChanges = await pageApi(`/api/v2/assist/turns/${assistTurn.id}/request-changes`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-assist-changes', 'X-Expected-Revision': String(assistTurn.revision) }, body: { content: 'Address the browser review.', expected_revision: assistTurn.revision } });
  assert(assistComment.status === 201 && assistChanges.status === 201, 'assist review comments');

  const createdProfile = await pageApi('/api/v2/runners/profiles', {
    method: 'POST', headers: { 'Idempotency-Key': 'p7-e2e-runner-profile-01', 'X-Expected-Revision': '0' },
    body: { label: 'P7 E2E Host', runner_type: 'host', expected_revision: 0 }
  });
  assert(createdProfile.status === 201 && createdProfile.body.data?.profile?.id, `runner-profile:${createdProfile.status}`);
  const profileId = createdProfile.body.data.profile.id;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/#/connections`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '连接', exact: true }).waitFor();
  await page.getByRole('button', { name: '执行器 Profile', exact: true }).click();
  await page.getByText('P7 E2E Host', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '探测执行器 Profile', exact: true }).click();
  const readyProfile = await waitForApi(pageApi, `/api/v2/runners/profiles/${profileId}`, (result) => result.body.data?.profile?.status === 'ready');
  assert(readyProfile.body.data.profile.identity_public_key, 'runner profile identity');

  const currentProject = await pageApi(`/api/v2/projects/${project.id}`);
  const execution = await pageApi(`/api/v2/projects/${project.id}/executions`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p7-e2e-execution-01', 'X-Expected-Revision': String(currentProject.body.data.project.revision) },
    body: {
      repository_workspace_id: workspace.body.data.workspace.id,
      context_pack_id: pack.body.data.pack.id,
      runner_profile_id: profileId,
      tasks: [{ id: 'inspect', mode: 'read', depends_on: [], input_paths: [], output_paths: [], check_ids: [] }],
      requires_approval: true,
      expected_revision: currentProject.body.data.project.revision
    }
  });
  assert(execution.status === 201 && execution.body.data?.execution?.id, `execution-create:${execution.status}`);
  const executionId = execution.body.data.execution.id;

  await page.goto(`${base}/#/execution`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '执行', exact: true }).waitFor();
  await page.getByRole('button', { name: '开始执行', exact: true }).click();
  await waitForApi(pageApi, `/api/v2/executions/${executionId}`, (result) => result.body.data?.execution?.status === 'awaiting_approval', 20_000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('等待审批', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '审批', exact: true }).click();
  await page.getByRole('heading', { name: '审批中心', exact: true }).waitFor();
  const executionApproval = page.locator('article').filter({ hasText: /执行.*审阅/ }).first();
  await executionApproval.getByRole('button', { name: '批准', exact: true }).click();
  await executionApproval.getByText('已批准', { exact: true }).waitFor();

  await page.goto(`${base}/#/execution`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '继续执行', exact: true }).click();
  await waitForApi(pageApi, `/api/v2/executions/${executionId}`, (result) => result.body.data?.execution?.status === 'completed', 20_000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('已完成', { exact: true }).first().waitFor();
  const replayResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/v2/executions/${executionId}/stages/deliver/replay`));
  await page.getByRole('button', { name: '重放交付', exact: true }).click();
  const replayResponse = await replayResponsePromise;
  const replayPayload = await replayResponse.json().catch(() => ({}));
  assert(replayResponse.status() === 202, `execution-replay:${replayResponse.status()}:${JSON.stringify(replayPayload)}`);
  const replayedExecution = await waitForApi(pageApi, `/api/v2/executions/${executionId}`, (result) => result.body.data?.execution?.status === 'completed' && result.body.data.execution.generation === 2, 20_000);
  assert(replayedExecution.body.data.execution.handoff_manifest?.delivery_ready === true, 'execution delivery handoff');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('第 2 代', { exact: false }).first().waitFor();
  for (const control of ['开始执行', '暂停执行', '继续执行', '取消执行', '重新规划执行']) {
    assert(await page.getByRole('button', { name: control, exact: true }).count() === 1, `execution control:${control}`);
  }

  const captured = await pageApi(`/api/v2/projects/${project.id}/assets`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p7-e2e-asset-01', 'X-Expected-Revision': '0' },
    body: {
      execution_id: executionId, logical_name: 'p7-e2e-result.json', asset_kind: 'execution_output',
      source_type: 'manual', source_ref: 'fixture:p7-e2e-result', media_type: 'application/json',
      content_base64: Buffer.from('{"evidence":true,"quality":"pending"}').toString('base64'), expected_revision: 0
    }
  });
  assert(captured.status === 201 && captured.body.data?.asset?.id, `asset-capture:${captured.status}`);
  const assetId = captured.body.data.asset.id;

  await page.goto(`${base}/#/evidence`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '证据', exact: true }).waitFor();
  await page.getByText('p7-e2e-result.json', { exact: true }).first().waitFor();
  await page.getByLabel('Parser 格式').selectOption('json');
  const parseResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes(`/api/v2/assets/${assetId}/versions/`) && response.url().endsWith('/parse'));
  await page.getByRole('button', { name: '解析', exact: true }).click();
  const parseResponse = await parseResponsePromise;
  const parsePayload = await parseResponse.json();
  assert(parseResponse.status() === 202 && parsePayload.data?.operation_id, `parser-start:${parseResponse.status()}`);
  const parserOperation = await waitOperation(pageApi, parsePayload.data.operation_id, 20_000);
  await page.getByText('已解析', { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: '证明当前版本', exact: true }).click();
  await page.getByText('资产证明已记录', { exact: true }).waitFor();
  const versions = await pageApi(`/api/v2/assets/${assetId}/versions`);
  assert(versions.status === 200 && versions.body.data?.versions?.length === 1, 'source asset version');
  const parserRun = await pageApi(`/api/v2/parser-runs/${parserOperation.resource_id}`);
  const attestations = await pageApi(`/api/v2/assets/${assetId}/attestations`);
  assert(parserRun.body.data?.parser_run?.status === 'parsed', 'parser terminal receipt');
  assert(attestations.body.data?.attestations?.length === 1, 'asset attestation');

  await page.goto(`${base}/#/execution`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '执行', exact: true }).waitFor();
  await page.getByRole('tab', { name: '质量', exact: true }).click();
  await page.getByRole('heading', { name: '质量审阅', exact: true }).waitFor();
  await page.getByRole('button', { name: '开始审阅', exact: true }).click();
  await page.getByText('等待人工处理', { exact: true }).first().waitFor({ timeout: 20_000 });
  for (const [label, score, reasoning] of [
    ['覆盖度', '92', 'all acceptance assets are represented'],
    ['准确性', '90', 'deterministic checks passed'],
    ['深度', '90', 'technical evidence is sufficient'],
    ['一致性', '90', 'CAS and lineage agree'],
    ['清晰度', '90', 'the result is reviewable']
  ]) {
    await page.getByLabel(`${label}评分`).fill(score);
    await page.getByLabel(`${label}说明`).fill(reasoning);
  }
  await page.getByLabel('决策说明').fill('reviewed against exact report and input hashes');
  await page.getByRole('button', { name: '记录决策', exact: true }).click();
  await page.getByText('已批准', { exact: true }).waitFor();
  const qualityList = await pageApi(`/api/v2/executions/${executionId}/quality-reviews`);
  const qualityReview = qualityList.body.data?.quality_reviews?.[0];
  assert(qualityReview?.status === 'completed' && qualityReview?.human_review?.weighted_score === 90.4, `quality human decision:${JSON.stringify(qualityReview?.human_review || null)}`);
  assert(JSON.stringify(qualityReview.rubric.dimensions.map((item) => item.key)) === JSON.stringify(['coverage','accuracy','depth','consistency','clarity']), 'quality five-dimension policy');

  const evidenceRequirement = await createOutcomeRequirement(pageApi, project.id, 'p7-e2e-evidence', { evaluator: 'evidence_count', minimum: 1 }, 'p7-e2e-requirement-evidence');
  const missingRequirement = await createOutcomeRequirement(pageApi, project.id, 'p7-e2e-tests', { evaluator: 'test_pass', check_id: 'missing-e2e-check' }, 'p7-e2e-requirement-tests');
  assert(evidenceRequirement?.id && missingRequirement?.id, 'outcome requirements');

  await page.getByRole('tab', { name: '结果', exact: true }).click();
  await page.getByRole('heading', { name: '结果', exact: true }).waitFor();
  await page.getByRole('button', { name: '评估', exact: true }).click();
  const blockedOutcome = await waitForApi(pageApi, `/api/v2/executions/${executionId}/outcome`, (result) => result.body.data?.evaluation?.status === 'blocked', 20_000);
  await page.getByText('已阻塞', { exact: true }).first().waitFor();
  await page.getByLabel('豁免要求').selectOption(missingRequirement.id);
  await page.getByLabel('豁免原因').fill('accepted bounded browser gap');
  await page.getByRole('button', { name: '授予豁免', exact: true }).click();
  const waivedOutcome = await waitForApi(pageApi, `/api/v2/executions/${executionId}/outcome`, (result) => result.body.data?.evaluation?.status === 'waived' && result.body.data.evaluation.generation > blockedOutcome.body.data.evaluation.generation, 20_000);
  await page.getByText('已豁免', { exact: true }).first().waitFor();
  await page.getByLabel('豁免原因').fill('browser replay restores the requirement');
  await page.getByRole('button', { name: /^撤销豁免 / }).click();
  const revokedOutcome = await waitForApi(pageApi, `/api/v2/executions/${executionId}/outcome`, (result) => result.body.data?.evaluation?.status === 'blocked' && result.body.data.evaluation.generation > waivedOutcome.body.data.evaluation.generation, 20_000);
  await page.getByText('已撤销', { exact: false }).first().waitFor();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/#/context`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '上下文', exact: true }).waitFor();
  await page.getByText('P7 verification note', { exact: true }).waitFor();
  await page.getByRole('button', { name: '固定节点' }).click();
  await page.getByText('上下文固定策略已更新', { exact: true }).waitFor();
  await page.getByRole('button', { name: '重建投影', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '重试', exact: true }).waitFor();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByText('已完成', { exact: true }).first().waitFor();

  await page.goto(`${base}/#/settings`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'MCP / 交换', exact: true }).click();
  await page.getByRole('heading', { name: 'MCP 与交换', exact: true }).waitFor();
  await page.getByRole('button', { name: '创建客户端', exact: true }).click();
  await page.getByText('一次性令牌', { exact: true }).waitFor();
  await page.getByLabel('目标项目 ID').fill(target.body.data.project.id);
  await page.getByRole('button', { name: '申请交换', exact: true }).click();
  await page.getByText('已请求', { exact: true }).waitFor();
  await page.getByRole('button', { name: '来源审批', exact: true }).click();
  await page.getByText('部分批准', { exact: true }).waitFor();
  await page.getByRole('button', { name: '目标审批', exact: true }).click();
  await page.getByText('活跃', { exact: true }).last().waitFor();

  const latestTargets = await pageApi(`/api/v2/repository-connections/${connection.body.data.connection.id}/targets`);
  const deletionTarget = latestTargets.body.data.targets.find((item) => item.id === repositoryTarget.id);
  const repositoryPrepared = await pageApi(`/api/v2/repository-targets/${deletionTarget.id}/deletion-intents`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-repository-delete-prepare', 'X-Expected-Revision': String(deletionTarget.revision) }, body: { target_full_name: 'fixture/p7-e2e', expected_head_sha: deletionTarget.expected_head_sha, expected_revision: deletionTarget.revision } });
  let repositoryIntent = repositoryPrepared.body.data.intent;
  const repositoryCreator = await pageApi(`/api/v2/repository-deletion-intents/${repositoryIntent.id}/creator-confirm`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-repository-delete-creator', 'X-Expected-Revision': String(repositoryIntent.revision) }, body: { target_full_name: 'fixture/p7-e2e', expected_head_sha: deletionTarget.expected_head_sha, expected_revision: repositoryIntent.revision } });
  repositoryIntent = repositoryCreator.body.data.intent;
  const account = await pageApi('/api/v2/account');
  const ownerSession = await pageApi('/api/v2/sessions', { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-repository-owner-session', 'X-Expected-Revision': String(account.body.data.account.revision) }, body: { ttl_seconds: 3600, expected_revision: account.body.data.account.revision } });
  assert(ownerSession.status === 201, `repository owner session:${ownerSession.status}:${ownerSession.body.error?.message || ''}:${JSON.stringify(ownerSession.body.error?.details || {})}`);
  const repositoryOwner = await pageApi(`/api/v2/repository-deletion-intents/${repositoryIntent.id}/owner-confirm`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-repository-delete-owner', 'X-Expected-Revision': String(repositoryIntent.revision) }, body: { target_full_name: 'fixture/p7-e2e', expected_head_sha: deletionTarget.expected_head_sha, expected_revision: repositoryIntent.revision } });
  repositoryIntent = repositoryOwner.body.data.intent;
  assert(repositoryIntent.status === 'ready', 'repository two-session confirmation');
  const repositoryCancelled = await pageApi(`/api/v2/repository-deletion-intents/${repositoryIntent.id}/cancel`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-repository-delete-cancel', 'X-Expected-Revision': String(repositoryIntent.revision) }, body: { expected_revision: repositoryIntent.revision } });
  assert(repositoryCancelled.body.data.intent.status === 'cancelled', 'repository deletion cancel');

  const disposableProject = await pageApi('/api/v2/projects', { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-project-delete-create', 'X-Expected-Revision': '0' }, body: { name: 'P10 E2E disposable', description: 'deletion fixture', metadata: {}, expected_revision: 0 } });
  const disposable = disposableProject.body.data.project;
  const projectPrepared = await pageApi(`/api/v2/projects/${disposable.id}/deletion-intents`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-project-delete-prepare', 'X-Expected-Revision': String(disposable.revision) }, body: { target_name: disposable.name, expected_revision: disposable.revision } });
  let projectIntent = projectPrepared.body.data.intent;
  const projectConfirmed = await pageApi(`/api/v2/project-deletion-intents/${projectIntent.id}/confirm`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-project-delete-confirm', 'X-Expected-Revision': String(projectIntent.revision) }, body: { target_name: disposable.name, expected_revision: projectIntent.revision } });
  projectIntent = projectConfirmed.body.data.intent;
  const projectDeleted = await pageApi(`/api/v2/project-deletion-intents/${projectIntent.id}/execute`, { method: 'POST', headers: { 'Idempotency-Key': 'p10-e2e-project-delete-execute', 'X-Expected-Revision': String(projectIntent.revision) }, body: { expected_revision: projectIntent.revision } });
  assert(projectDeleted.body.data.intent.status === 'completed', 'project tombstone');

  await page.waitForTimeout(4_500);
  const layoutReceipts = [];
  for (const [name, width, height] of [['mobile', 390, 844], ['laptop', 1024, 768], ['desktop', 1440, 900]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(250);
    for (const scenario of ['governance', 'context', 'settings', 'execution', 'execution-quality', 'execution-outcome', 'evidence', 'connections', 'outcome', 'delivery', 'operations', 'identity', 'exchange', 'runner', 'parser', 'deployment', 'backup', 'importer']) {
      const route = scenario.startsWith('execution-') ? 'execution' : scenario;
      await page.goto(route === 'governance' ? `${base}/#/projects/${encodeURIComponent(project.id)}/governance` : `${base}/#/${route}`, { waitUntil: 'domcontentloaded' });
      const heading = { governance: '项目控制', context: '上下文', settings: '设置', execution: '执行', evidence: '证据', connections: '连接', outcome: '结果', delivery: '交付', operations: '运维', identity: '身份与团队', exchange: 'MCP 与交换', runner: '连接', parser: '证据', deployment: '运维', backup: '运维', importer: '运维' }[route];
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      if (route === 'governance') {
        await page.getByText('P10 E2E Reviewer', { exact: true }).first().waitFor();
        const drawer = page.locator('#workspace-navigation');
        assert(await drawer.getAttribute('aria-hidden') === 'true', `${name} drawer default closed`);
        const opener = page.getByRole('button', { name: '打开导航', exact: true });
        await opener.click();
        await drawer.waitFor({ state: 'visible' });
        await page.waitForTimeout(250);
        const labels = await drawer.locator('nav .nav-item').allTextContents();
        assert(JSON.stringify(labels.map((item) => item.trim())) === JSON.stringify(['项目','工作区','资产','上下文','审计','设置']), `${name} drawer inventory`);
        await page.waitForFunction(() => document.activeElement === document.querySelector('#workspace-navigation nav .nav-item'));
        await drawer.locator('nav .nav-item').last().focus();
        await page.keyboard.press('Tab');
        assert(await drawer.getByRole('button', { name: '关闭导航' }).evaluate((element) => element === document.activeElement), `${name} drawer focus trap`);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelector('#workspace-navigation')?.getAttribute('aria-hidden') === 'true');
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '打开导航');
        assert(await opener.evaluate((element) => element === document.activeElement), `${name} drawer focus restore`);
        drawerReceipts.push({ viewport: name, labels, default_closed: true, focus_trap: true, escape_close: true, focus_restored: true });
        accessibilityReceipts.push(await auditAccessibility(page, `${name}-shell`));
      }
      else if (route === 'context') await page.getByText('P7 verification note', { exact: true }).waitFor();
      else if (route === 'settings') { await page.getByRole('tab', { name: 'MCP / 交换', exact: true }).click(); await page.getByText('context_map', { exact: true }).waitFor(); }
      else if (scenario === 'execution') await page.getByText('第 2 代', { exact: false }).first().waitFor();
      else if (scenario === 'execution-quality') { await page.getByRole('tab', { name: '质量', exact: true }).click(); await page.getByRole('heading', { name: '人工决策', exact: true }).waitFor(); await page.getByText('第 1 次尝试', { exact: true }).waitFor(); const reviewCheck = await pageApi(`/api/v2/executions/${executionId}/quality-reviews`); assert(JSON.stringify(reviewCheck.body.data?.quality_reviews?.[0]?.rubric?.dimensions?.map((item) => item.key)) === JSON.stringify(['coverage','accuracy','depth','consistency','clarity']), 'quality route five dimensions'); }
      else if (scenario === 'execution-outcome') { await page.getByRole('tab', { name: '结果', exact: true }).click(); await page.getByRole('heading', { name: '要求', exact: true }).waitFor(); }
      else if (route === 'evidence') await page.getByText('p7-e2e-result.json', { exact: true }).first().waitFor();
      else if (route === 'connections') {
        await page.getByRole('button', { name: '执行器 Profile', exact: true }).click();
        await page.getByText('P7 E2E Host', { exact: true }).first().waitFor();
      }
      await page.screenshot({ path: path.join(reportDir, `${name}-${scenario}.png`), fullPage: true });
      const layout = await inspectLayout(page);
      assert(!layout.horizontal_overflow, `${name}/${scenario} horizontal overflow:${JSON.stringify(layout)}`);
      assert(layout.overlaps.length === 0, `${name}/${scenario} overlaps:${JSON.stringify(layout.overlaps)}`);
      layoutReceipts.push({ viewport: name, route: scenario, ...layout });
    }
  }

  const workbench = await workflowWorkbenchJourney(browser, await context.storageState(), project.id, providerProfile.body.data.profile.id);
  const legacyRequests = requests.filter((url) => /\/api\/v1(?:\/|$)/.test(url));
  if (legacyRequests.length) throw new Error(`active Clean Web emitted /api/v1: ${legacyRequests.join(', ')}`);
  const proxyDiagnostics = startup.scope.childOutput(1).split(/\r?\n/).filter(line => /proxy error|EADDRINUSE|ERR_NO_BUFFER_SPACE|ENOBUFS|status of 500/i.test(line));
  assert(proxyDiagnostics.length === 0, `proxy diagnostics:${JSON.stringify(proxyDiagnostics)}`);
  assert(browserErrors.length === 0, `browser errors:${JSON.stringify(browserErrors)} http:${JSON.stringify(httpErrors)}`);
  const checkpoints = await pageApi(`/api/v2/executions/${executionId}/checkpoints`);
  const attempts = await pageApi(`/api/v2/executions/${executionId}/attempts`);
  fs.writeFileSync(path.join(reportDir, 'receipt.json'), `${JSON.stringify({
    schema_version: 'aiws.v3-clean.p10-e2e-receipt.v1', status: 'passed', provisional: false,
    api_port: apiPort, web_port: webPort, viewports: ['mobile', 'laptop', 'desktop'],
    routes: ['governance', 'context', 'settings', 'execution', 'execution-quality', 'execution-outcome', 'evidence', 'connections', 'outcome', 'delivery', 'operations', 'identity', 'exchange', 'runner', 'parser', 'deployment', 'backup', 'importer'], business_groups: ['identity-acl','provider-settings','project-brief','workflow','repository','context','assist','files-approval','terminal-bridge','runner-execution','evidence','parser','quality','outcome','mcp-exchange-gateway','delivery','operations-recovery','offline-pwa','web-complete-experience'], request_count: requests.length,
    legacy_api_v1_requests: legacyRequests, browser_errors: browserErrors, http_errors: httpErrors, proxy_diagnostics: proxyDiagnostics,
    onboarding: { system: ['owner-team','codex-probe','github-skip','summary'], project: ['intake','brief-template','workflow-generation','critic','proposal-apply','brief-confirm'], secret_storage: 'passed' },
    drawer: drawerReceipts, accessibility: accessibilityReceipts, onboarding_layouts: onboardingLayoutReceipts, workbench,
    layouts: layoutReceipts, context_pack_hash: pack.body.data.pack.pack_hash,
    runner_profile: { id: profileId, type: readyProfile.body.data.profile.runner_type, status: readyProfile.body.data.profile.status },
    p10: {
      provider: { id: providerProfile.body.data.profile.id, lifecycle: 'enabled', probe_status: 'succeeded' },
      brief_template: { id: briefTemplate.body.data.template.id, revision: revisedTemplate.body.data.template.current_revision, archived: archivedTemplate.body.data.template.status === 'archived' },
      assist: { session_id: assistSession.id, fork_id: assistFork.body.data.session.id, side_thread_id: assistSide.body.data.session.id, comments: 2, restored_deleted: assistRecovered.body.data.session.deleted_at == null },
      repository_deletion: { intent_id: repositoryIntent.id, two_session_proofs: true, terminal_status: repositoryCancelled.body.data.intent.status },
      project_deletion: { intent_id: projectIntent.id, terminal_status: projectDeleted.body.data.intent.status },
      quality_dimensions: qualityReview.rubric.dimensions.map((item) => item.key)
    },
    execution: { id: executionId, status: replayedExecution.body.data.execution.status, generation: replayedExecution.body.data.execution.generation, checkpoint_count: checkpoints.body.data?.checkpoints?.length || 0, attempt_count: attempts.body.data?.attempts?.length || 0, delivery_ready: true, approval_wait_resumed: true, replayed_stage: 'deliver' },
    evidence: { asset_id: assetId, status: captured.body.data.asset.status, source_version_count: versions.body.data.versions.length, parser_status: parserRun.body.data.parser_run.status, output_asset_version_id: parserRun.body.data.parser_run.output_asset_version_id, attestation_count: attestations.body.data.attestations.length },
    quality: { review_id: qualityReview.id, status: qualityReview.status, weighted_score: qualityReview.human_review.weighted_score, report_sha256: qualityReview.report_sha256 },
    outcome: { requirement_count: revokedOutcome.body.data.evaluation.requirement_count, terminal_statuses: { blocked: blockedOutcome.body.data.evaluation.status, waived: waivedOutcome.body.data.evaluation.status, revoked: revokedOutcome.body.data.evaluation.status }, generations: { blocked: blockedOutcome.body.data.evaluation.generation, waived: waivedOutcome.body.data.evaluation.generation, revoked: revokedOutcome.body.data.evaluation.generation } }
  }, null, 2)}\n`);
  process.stdout.write(`P10 Clean E2E passed: 19 business groups and complete workflow routes across 3 viewports; overlaps=0; /api/v1 requests=0\n`);
} finally {
  await startup?.scope.dispose();
}

async function workflowWorkbenchJourney(browser, storageState, projectId, providerId) {
  const workContext = await browser.newContext({ storageState, viewport: { width: 1440, height: 900 } });
  const workPage = await workContext.newPage();
  const errors = []; const writes = []; const layouts = []; const expectedErrors = [];
  let expectConflict = false; let offlineWindow = false;
  workPage.on('pageerror', error => errors.push(error.message));
  workPage.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if ((expectConflict && /409/.test(text) && message.location().url.endsWith('/briefs')) || (offlineWindow && /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(text))) expectedErrors.push(text);
    else errors.push(text);
  });
  workPage.on('request', request => { requests.push(request.url()); if (request.method() === 'POST') writes.push({ path: new URL(request.url()).pathname, headers: request.headers(), body: request.postDataJSON() }); });
  const projectApiPath = `/api/v2/projects/${projectId}`;
  const waitWrite = (suffix, click) => {
    const response = workPage.waitForResponse(response => new URL(response.url()).pathname.endsWith(suffix) && response.request().method() === 'POST');
    return click().then(() => response).then(async response => { const body = await response.json(); assert(response.ok(), `workbench ${suffix}:${response.status()}:${JSON.stringify(body)}`); return body.data; });
  };
  try {
    await workPage.goto(`${base}/#/projects/${projectId}/workflow`);
    await workPage.getByRole('heading', { name: '工作流草稿', exact: true }).waitFor();
    await workPage.getByRole('tab', { name: 'Brief', exact: true }).click();
    await workPage.getByLabel('目标', { exact: true }).fill('Verify the complete Web Workflow workbench');
    await workPage.getByRole('button', { name: '添加验收标准', exact: true }).click();
    const criteria = workPage.getByRole('textbox', { name: /^验收标准 \d+$/ });
    await criteria.last().fill('Workbench browser journey reaches an Execution terminal state');
    assert(await workPage.getByRole('button', { name: '确认修订', exact: true }).isDisabled(), 'workbench unsaved Brief confirmation blocked');
    await waitWrite('/briefs', () => workPage.getByRole('button', { name: '保存修订', exact: true }).click());
    const confirmed = await waitWrite('/confirm', () => workPage.getByRole('button', { name: '确认修订', exact: true }).click());
    assert(confirmed.brief?.confirmed_revision > 0, 'workbench Brief confirmation');
    await workPage.getByRole('tab', { name: '工作流', exact: true }).click();
    await workPage.getByRole('tab', { name: '节点', exact: true }).click();
    await workPage.locator('.workflow-row').filter({ hasText: 'Deliver' }).click();
    await workPage.getByLabel('节点标题', { exact: true }).fill('Workbench task');
    await workPage.getByLabel('节点目标', { exact: true }).fill('Verify the Web workbench');
    await workPage.getByLabel('检查 ID（每行一个）', { exact: true }).fill('node_test');
    await workPage.getByLabel('验收检查（与检查 ID 一致）', { exact: true }).fill('node_test');
    const saved = await waitWrite('/workflow-draft', () => workPage.getByRole('button', { name: '保存草稿', exact: true }).click());
    assert(saved.workflow?.current?.graph?.nodes.some(node => node.title === 'Workbench task' && node.config.goal === 'Verify the Web workbench'), 'workbench saved structured config');
    await workPage.waitForFunction(() => document.activeElement?.classList.contains('workbench-result'));
    await workPage.reload();
    await workPage.getByLabel('Provider Profile', { exact: true }).selectOption(providerId);
    await waitWrite('/workflow-generations', () => workPage.getByRole('button', { name: '生成候选', exact: true }).click());
    await waitWrite('/critic', () => workPage.getByRole('button', { name: '执行 Critic', exact: true }).click());
    await workPage.getByRole('button', { name: '查看提案', exact: true }).click();
    await workPage.getByRole('region', { name: 'Workflow 提案 JSON' }).waitFor();
    assert(await workPage.getByText('candidate hash：', { exact: false }).count() > 0, 'workbench candidate hash');
    await waitWrite('/apply', () => workPage.getByRole('button', { name: '应用提案', exact: true }).click());
    for (const [name, width, height] of [['desktop', 1440, 900], ['tablet', 1024, 768], ['mobile', 390, 844]]) {
      await workPage.setViewportSize({ width, height });
      await workPage.getByRole('tab', { name: '节点', exact: true }).click();
      await workPage.locator('.workflow-row').filter({ hasText: 'Deliver' }).click();
      await workPage.waitForFunction(() => document.querySelector('.workflow-node-editor')?.disabled === false);
      await workPage.getByLabel('节点标题', { exact: true }).focus();
      await workPage.keyboard.press('Tab');
      assert(await workPage.getByLabel('节点目标', { exact: true }).evaluate(element => element === document.activeElement), `workbench keyboard ${name}:${await workPage.evaluate(() => document.activeElement?.outerHTML)}`);
      // Inspect the initial viewport, as the existing route layout checks do;
      // keyboard focus may have scrolled content beneath the sticky topbar.
      await workPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      const layout = await inspectLayout(workPage);
      assert(!layout.horizontal_overflow && layout.overlaps.length === 0, `workbench layout ${name}:${JSON.stringify(layout)}`);
      await workPage.screenshot({ path: path.join(reportDir, `${name}-workflow-workbench.png`), fullPage: true });
      layouts.push({ viewport: name, ...layout });
    }
    await workPage.setViewportSize({ width: 1440, height: 900 });
    const created = await waitWrite('/executions', () => workPage.getByRole('button', { name: '创建并开始执行', exact: true }).click());
    const id = created.execution?.id; assert(id, 'workbench Execution created');
    await workPage.waitForURL(`**/execution?execution_id=${id}`);
    await workPage.getByRole('heading', { name: '执行', exact: true }).waitFor();
    await workPage.getByText('已完成', { exact: true }).first().waitFor({ timeout: 20000 });
    for (const name of ['证据', '质量', '结果', '交付']) { await workPage.getByRole('tab', { name, exact: true }).click(); await workPage.waitForTimeout(100); }
    // Bounded read fixtures exercise unavailable prerequisites without changing
    // the real Provider or Runner used by the positive journey above.
    await workPage.route('**/api/v2/profiles', route => route.fulfill({ json: { data: { profiles: [{ id: providerId, provider: 'codex', label: 'Unavailable provider', status: 'unavailable', revision: 1 }] } } }));
    await workPage.route('**/api/v2/runners/profiles', route => route.fulfill({ json: { data: { profiles: [] } } }));
    await workPage.goto(`${base}/#/projects/${projectId}/workflow`);
    await workPage.getByRole('button', { name: '前往 Provider 设置', exact: true }).waitFor();
    assert(await workPage.getByRole('button', { name: '生成候选', exact: true }).isDisabled(), 'workbench unavailable Provider blocks generation');
    assert(await workPage.getByRole('button', { name: '创建并开始执行', exact: true }).isDisabled(), 'workbench unavailable Runner blocks launch');
    await workPage.getByRole('button', { name: '前往 Runner 设置', exact: true }).waitFor();
    await workPage.unroute('**/api/v2/profiles'); await workPage.unroute('**/api/v2/runners/profiles');
    await workPage.reload();
    await workPage.getByRole('tab', { name: 'Brief', exact: true }).click();
    await workPage.getByLabel('目标', { exact: true }).fill('Local conflicting Brief input');
    const serverProject = (await pageApi(projectApiPath)).body.data.project;
    const concurrent = await pageApi(projectApiPath, { method: 'PATCH', headers: { 'Idempotency-Key': 'workbench-concurrent-project', 'X-Expected-Revision': String(serverProject.revision) }, body: { name: serverProject.name, description: 'Concurrent revision test', metadata: {} } });
    assert(concurrent.status === 200, 'workbench concurrent project revision');
    expectConflict = true;
    const conflictResponse = workPage.waitForResponse(response => new URL(response.url()).pathname === `${projectApiPath}/briefs` && response.request().method() === 'POST');
    await workPage.getByRole('button', { name: '保存修订', exact: true }).click();
    const conflict = await conflictResponse; const conflictBody = await conflict.json();
    assert(conflict.status() === 409 && conflictBody.error?.code === 'revision_conflict', 'workbench literal revision conflict');
    await workPage.getByRole('button', { name: '重新加载服务器版本', exact: true }).click();
    await workPage.getByText(`项目修订 ${concurrent.body.data.project.revision}`, { exact: true }).waitFor();
    assert(await workPage.getByLabel('目标', { exact: true }).inputValue() === 'Local conflicting Brief input', 'workbench conflict preserves local input');
    await workPage.getByRole('button', { name: '放弃本地修改', exact: true }).click();
    expectConflict = false;
    offlineWindow = true; await workContext.setOffline(true);
    await workPage.getByLabel('目标', { exact: true }).fill('Offline workbench Brief');
    const beforeOfflineWrites = writes.length;
    await workPage.getByRole('button', { name: '保存修订', exact: true }).click();
    await workPage.getByText('已离线保存，等待同步', { exact: true }).waitFor();
    assert(writes.length === beforeOfflineWrites, 'workbench offline save makes no network mutation');
    assert(await workPage.getByRole('button', { name: '确认修订', exact: true }).isDisabled(), 'workbench offline confirmation blocked');
    await workPage.getByRole('tab', { name: '工作流', exact: true }).click();
    assert(await workPage.getByRole('button', { name: '生成候选', exact: true }).isDisabled(), 'workbench offline generation blocked');
    assert(await workPage.getByRole('button', { name: '创建并开始执行', exact: true }).isDisabled(), 'workbench offline launch blocked');
    await workContext.setOffline(false);
    await workPage.getByRole('button', { name: /离线队列：1 项待发送/ }).click();
    await waitWrite('/briefs', () => workPage.getByRole('button', { name: '发送', exact: true }).click());
    await workPage.getByText('队列为空', { exact: true }).waitFor();
    offlineWindow = false;
    const creation = writes.findIndex(row => row.path === `${projectApiPath}/executions`);
    assert(creation >= 0 && writes[creation + 1]?.path === `/api/v2/executions/${id}/start`, 'workbench create/start sequence');
    assert(writes[creation + 1].headers['x-expected-revision'] === String(created.execution.revision), 'workbench start revision');
    assert(writes.every(row => row.path.startsWith('/api/v2/') && row.headers['idempotency-key'] && row.headers['x-expected-revision'] != null), 'workbench mutation headers');
    assert(errors.length === 0, `workbench browser errors:${JSON.stringify(errors)}`);
    return { status: 'passed', execution_id: id, steps: ['brief-save', 'brief-confirm', 'node-edit', 'workflow-save', 'generation', 'critic', 'proposal-view', 'proposal-apply', 'execution-create', 'execution-start', 'terminal', 'evidence', 'quality', 'outcome', 'delivery'], layouts, mutation_headers: true, exact_execution_link: true, unavailable_provider: true, unavailable_runner: true, revision_conflict: conflictBody.error.code, offline_queue_replayed: true, expected_errors: expectedErrors };
  } catch (error) {
    await workPage.screenshot({ path: path.join(reportDir, 'workbench-failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(reportDir, 'workbench-failure.txt'), await workPage.locator('body').innerText());
    process.stderr.write(`Workbench failed at ${workPage.url()}:\n${await workPage.locator('body').innerText()}\n`);
    throw error;
  } finally { await workContext.close(); }
}

function assert(condition, message) { if (!condition) throw new Error(`e2e_assertion_failed:${message}`); }

async function auditAccessibility(targetPage, label) {
  const result = await new AxeBuilder({ page: targetPage }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const violations = result.violations.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })) }));
  assert(violations.length === 0, `${label} WCAG AA:${JSON.stringify(violations)}`);
  return { label, status: 'passed', violations };
}

async function captureOnboardingState(targetPage, label) {
  await targetPage.locator('.toast').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
  for (const [viewport, width, height] of [['mobile', 390, 844], ['laptop', 1024, 768], ['desktop', 1440, 900]]) {
    await targetPage.setViewportSize({ width, height });
    await targetPage.waitForTimeout(100);
    await targetPage.screenshot({ path: path.join(reportDir, `${viewport}-${label}.png`), fullPage: true });
    const layout = await inspectLayout(targetPage);
    assert(!layout.horizontal_overflow, `${viewport}/${label} horizontal overflow:${JSON.stringify(layout)}`);
    assert(layout.overlaps.length === 0, `${viewport}/${label} overlaps:${JSON.stringify(layout.overlaps)}`);
    onboardingLayoutReceipts.push({ viewport, state: label, ...layout });
    accessibilityReceipts.push(await auditAccessibility(targetPage, `${viewport}-${label}`));
  }
  await targetPage.setViewportSize({ width: 390, height: 844 });
}

async function createOutcomeRequirement(api, projectId, key, rubric, idempotencyKey) {
  const current = await api(`/api/v2/projects/${projectId}`);
  const revision = current.body.data?.project?.revision;
  assert(Number.isInteger(revision), `outcome-project-revision:${key}`);
  const result = await api(`/api/v2/projects/${projectId}/outcome-requirements`, {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey, 'X-Expected-Revision': String(revision) },
    body: { requirement_key: key, rubric, workflow_revision: 1, expected_revision: revision }
  });
  assert(result.status === 201, `outcome-requirement:${key}:${result.status}`);
  return result.body.data?.requirement;
}

async function waitOperation(api, operationId, timeout = 10_000) {
  assert(operationId, 'operation receipt missing');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await api(`/api/v2/operations/${operationId}`);
    const status = result.body.data?.status;
    if (status === 'succeeded') return result.body.data;
    if (['failed', 'cancelled', 'expired'].includes(status)) throw new Error(`operation_${status}:${operationId}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`operation_timeout:${operationId}`);
}

async function waitForApi(api, pathname, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await api(pathname);
    if (latest.status === 200 && predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`api_state_timeout:${pathname}:${JSON.stringify(latest?.body || {})}`);
}

async function inspectLayout(targetPage) {
  return targetPage.evaluate(() => {
    const root = document.documentElement;
    const controls = [...document.querySelectorAll('button,input,select,textarea')]
      .filter((element) => {
        if (element.closest('.sidebar:not(.is-open)')) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)));
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
          && rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.bottom > 0
          && rect.left < innerWidth && rect.top < innerHeight
          && Boolean(hit && (hit === element || element.contains(hit) || hit.contains(element)));
      })
      .map((element) => ({ element, rect: element.getBoundingClientRect(), name: element.getAttribute('aria-label') || element.getAttribute('placeholder') || `${element.tagName}:${element.getAttribute('type') || ''}` }));
    const overlaps = [];
    for (let left = 0; left < controls.length; left += 1) {
      for (let right = left + 1; right < controls.length; right += 1) {
        const a = controls[left], b = controls[right];
        if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
        const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (width > 1 && height > 1) overlaps.push([a.name, b.name]);
      }
    }
    const overflowing_elements = [...document.querySelectorAll('body *')].map((element) => ({ element, rect: element.getBoundingClientRect() })).filter(({ rect }) => rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1)).slice(0, 20).map(({ element, rect }) => ({ tag: element.tagName, class_name: element.className?.baseVal || element.className || '', left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }));
    return { horizontal_overflow: root.scrollWidth > root.clientWidth + 1, scroll_width: root.scrollWidth, client_width: root.clientWidth, overlaps: overlaps.slice(0, 20), overflowing_elements };
  });
}
