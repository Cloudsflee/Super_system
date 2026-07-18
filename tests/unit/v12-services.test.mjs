import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v12-services-'));
process.env.AIWS_HOME = home;
const repo = path.join(home, 'repo');
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v12-outside-'));
fs.mkdirSync(repo);
let latestProcess;

try {
  const { codexAuthMatchesProfile, profileConfigToml, runCodexJson, validateProfileInput, writeProfileConfig } = await import('../../apps/api/src/codex-service.mjs');
  const { codexProbeEvidenceMatches, createCodexProbeEvidence } = await import('../../apps/api/src/codex-probe-evidence.mjs');
  const { codexContainerProxyEnv, containerizeLoopbackUrl } = await import('../../apps/api/src/codex-container-network.mjs');
  const { ccSwitchBinding, ccSwitchProfileReady, resolveCodexParserInvocation, validateBridgeConformance } = await import('../../apps/api/src/cc-switch-service.mjs');
  const { extractDeviceAuthPublicState } = await import('../../apps/api/src/codex-device-auth.mjs');
  const { createAppJwt, createInstallationToken, fetchInstallationRepositories, fetchUserInstallations, githubGitAuthEnv, verifyApp } = await import('../../apps/api/src/github-service.mjs');
  const { parseWindowsProxy, resolveProxyForUrl } = await import('../../apps/api/src/outbound-proxy.mjs');
  const { putSecret } = await import('../../apps/api/src/vault.mjs');
  const state = { projects: [{ repo_path: repo }], integration_statuses: [{ key: 'codex_auth', status: 'authenticated', provider: 'openai', refs: {} }] };
  const valid = { name: 'OpenAI', provider: 'openai', model: 'gpt-5.1', reasoning: 'high', web_search: true, timeout_ms: 1000, mounts: [repo], mcp_servers: [{ name: 'docs', command: 'node', args: ['server.mjs'] }] };
  assert.deepEqual(validateProfileInput(state, valid), { ok: true, errors: [] });
  assert.deepEqual(validateProfileInput(state, { ...valid, reasoning: 'ultra' }), { ok: true, errors: [] });
  for (const [patch, error] of [
    [{ reasoning: 'not valid' }, 'invalid_reasoning'], [{ web_search: 'yes' }, 'invalid_web_search'],
    [{ timeout_ms: 10 }, 'invalid_timeout'], [{ model: '--danger' }, 'invalid_model'],
    [{ mounts: [outside] }, `mount_not_allowed:${outside}`],
    [{ mcp_servers: [{ name: 'bad', command: 'powershell', args: [] }] }, 'mcp_command_not_allowed:powershell'],
    [{ mcp_servers: [{ name: 'bad', command: 'node', args: [], env: { TOKEN: 'raw' } }] }, 'mcp_env_not_allowed:bad']
  ]) assert.ok(validateProfileInput(state, { ...valid, ...patch }).errors.includes(error), error);
  const thirdParty = { ...valid, name: 'OpenRouter', provider: 'openrouter', provider_name: 'OpenRouter', model: 'openai/gpt-test', base_url: 'https://openrouter.ai/api/v1', wire_api: 'responses', requires_openai_auth: false };
  assert.deepEqual(validateProfileInput(state, thirdParty), { ok: true, errors: [] });
  assert.ok(validateProfileInput(state, { ...thirdParty, base_url: '' }).errors.includes('base_url_required'));
  assert.ok(validateProfileInput(state, { ...thirdParty, base_url: 'file:///etc/passwd' }).errors.includes('invalid_base_url'));
  assert.ok(validateProfileInput(state, { ...thirdParty, wire_api: 'chat' }).errors.includes('unsupported_wire_api'));
  assert.equal(codexAuthMatchesProfile({ status: 'authenticated', provider: 'chatgpt' }, valid), true);
  assert.equal(codexAuthMatchesProfile({ status: 'authenticated', provider: 'openrouter' }, valid), false);

  const one = { id: 'profile-one', kind: 'docker', ...valid };
  const two = { ...one, id: 'profile-two' };
  const firstConfig = await writeProfileConfig(one);
  const secondConfig = await writeProfileConfig(two);
  Object.assign(one, firstConfig);
  assert.notEqual(firstConfig.codex_home, secondConfig.codex_home);
  const toml = fs.readFileSync(firstConfig.config_file, 'utf8');
  for (const expected of ['model = "gpt-5.1"', 'model_reasoning_effort = "high"', 'web_search = "live"', '[mcp_servers.docs]']) assert.ok(toml.includes(expected));
  const thirdToml = profileConfigToml(thirdParty);
  for (const expected of ['model_provider = "openrouter"', '[model_providers.openrouter]', 'name = "OpenRouter"', 'base_url = "https://openrouter.ai/api/v1"', 'wire_api = "responses"', 'requires_openai_auth = false', 'env_key = "OPENAI_API_KEY"']) assert.ok(thirdToml.includes(expected), expected);
  assert.doesNotMatch(thirdToml, /experimental_bearer_token|sk-unit/);
  const importedBearerToml = profileConfigToml({ ...thirdParty, requires_openai_auth: true });
  assert.match(importedBearerToml, /requires_openai_auth = true[\s\S]*env_key = "OPENAI_API_KEY"/);
  assert.doesNotMatch(importedBearerToml, /experimental_bearer_token|sk-unit/);
  assert.equal(containerizeLoopbackUrl('http://localhost:4318/v1'), 'http://host.docker.internal:4318/v1');
  assert.equal(containerizeLoopbackUrl('http://127.4.3.2:4318/v1'), 'http://host.docker.internal:4318/v1');
  assert.equal(containerizeLoopbackUrl('http://[::1]:4318/v1'), 'http://host.docker.internal:4318/v1');
  assert.equal(containerizeLoopbackUrl('https://api.example.test/v1'), 'https://api.example.test/v1');
  assert.match(profileConfigToml({ ...thirdParty, kind: 'docker', base_url: 'http://localhost:4318/v1' }), /base_url = "http:\/\/host\.docker\.internal:4318\/v1"/);
  const proxyEnv = codexContainerProxyEnv({ HTTP_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost' });
  assert.equal(proxyEnv.HTTP_PROXY, 'http://host.docker.internal:7890');
  assert.equal(proxyEnv.NO_PROXY, 'localhost,host.docker.internal');
  assert.equal(resolveProxyForUrl('https://github.com/login/device/code', { env: { HTTPS_PROXY: 'http://127.0.0.1:7890' }, platform: 'linux' }), 'http://127.0.0.1:7890/');
  assert.equal(parseWindowsProxy('HTTP=127.0.0.1:8080;HTTPS=127.0.0.1:7890', 'https:'), '127.0.0.1:7890');
  assert.equal(resolveProxyForUrl('https://api.github.com/app', { env: {}, platform: 'win32', windowsProxy: '127.0.0.1:7890' }), 'http://127.0.0.1:7890/');
  assert.equal(resolveProxyForUrl('https://github.com/login/device', { env: { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'github.com' }, platform: 'linux' }), null);
  const initialEvidence = createCodexProbeEvidence({ profile: one, auth: state.integration_statuses[0], runtime: { image: { id: 'sha256:unit-image' } } });
  assert.equal(codexProbeEvidenceMatches(initialEvidence, createCodexProbeEvidence({ profile: one, auth: state.integration_statuses[0], runtime: { image: { id: 'sha256:unit-image' } } })), true);
  assert.equal(codexProbeEvidenceMatches(initialEvidence, createCodexProbeEvidence({ profile: { ...one, model: 'gpt-changed' }, auth: state.integration_statuses[0], runtime: { image: { id: 'sha256:unit-image' } } })), false);
  fs.appendFileSync(firstConfig.config_file, '# evidence change\n');
  assert.equal(codexProbeEvidenceMatches(initialEvidence, createCodexProbeEvidence({ profile: one, auth: state.integration_statuses[0], runtime: { image: { id: 'sha256:unit-image' } } })), false);
  fs.writeFileSync(firstConfig.config_file, toml, 'utf8');
  const parsed = spawnSync('codex', ['features', 'list'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: firstConfig.codex_home } });
  if (!parsed.error || parsed.error.code !== 'ENOENT') assert.equal(parsed.status, 0, `Codex rejected generated config.toml: ${parsed.stderr}`);
  const ccStatus = { status: 'synced', synced_at: '2026-01-01T00:00:00.000Z', bridge: { ready: true, revision: 2, conformance: { ok: true } }, sources: [{ name: 'cc-switch-cli', commit: 'abc' }] };
  const bound = { id: 'third', ...thirdParty, ...ccSwitchBinding(thirdParty, ccStatus) };
  assert.equal(bound.cc_switch_status, 'not_required');
  assert.equal(ccSwitchProfileReady({ integration_statuses: [{ key: 'cc_switch', ...ccStatus }] }, bound), true);
  const managed = { id: 'managed', ...thirdParty, cc_switch_mode: 'managed' }, managedBound = { ...managed, ...ccSwitchBinding(managed, ccStatus) };
  assert.equal(managedBound.cc_switch_status, 'synced');
  assert.equal(ccSwitchProfileReady({ integration_statuses: [{ key: 'cc_switch', ...ccStatus, sources: [{ name: 'cc-switch-cli', commit: 'changed' }] }] }, managedBound), false);
  const windowsWrapper = 'C:\\npm\\codex.cmd';
  const expectedScript = path.win32.join(path.win32.dirname(windowsWrapper), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const fakeCommand = (name) => name === 'where.exe' ? { ok: true, stdout: `${windowsWrapper}\r\n`, stderr: '', error: null } : { ok: true, stdout: 'features', stderr: '', error: null };
  assert.deepEqual(resolveCodexParserInvocation({ commandRunner: fakeCommand, platform: 'win32', exists: (file) => file === expectedScript, nodeExecutable: 'C:\\node.exe' }), { command: 'C:\\node.exe', args: [expectedScript], source: `node:${expectedScript}` });
  const conformance = await validateBridgeConformance({ commandRunner: fakeCommand, platform: 'win32', exists: (file) => file === expectedScript, nodeExecutable: 'C:\\node.exe' });
  assert.equal(conformance.ok, true);
  assert.equal(conformance.parser, `node:${expectedScript}`);
  const devicePublic = extractDeviceAuthPublicState('unknown secret raw-value\nOpen https://auth.openai.com/codex/device and enter this code: ABCD-EFGH');
  assert.deepEqual(devicePublic, { status: 'running', verification_uri: 'https://auth.openai.com/codex/device', user_code: 'ABCD-EFGH' });
  assert.equal(JSON.stringify(devicePublic).includes('raw-value'), false);
  assert.equal(extractDeviceAuthPublicState('https://evil.example/device enter code: ABCD-EFGH').verification_uri, undefined);
  assert.equal(extractDeviceAuthPublicState('https://auth.openai.com/device?token=query-sentinel').verification_uri, undefined);
  assert.equal(extractDeviceAuthPublicState('https://user:pass@auth.openai.com/device').verification_uri, undefined);
  const actualParser = resolveCodexParserInvocation();
  if (actualParser) {
    const thirdConfig = await writeProfileConfig({ id: 'profile-third-parser', kind: 'docker', ...thirdParty });
    const actualParse = spawnSync(actualParser.command, [...actualParser.args, 'features', 'list'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: thirdConfig.codex_home, OPENAI_API_KEY: 'parser-placeholder' } });
    if (!actualParse.error || actualParse.error.code !== 'ENOENT') assert.equal(actualParse.status, 0, `Codex rejected third-party config.toml: ${actualParse.stderr}`);
  }

  const events = [];
  const deviceAuthHome = path.join(home, 'codex-homes', 'auth-test');
  fs.mkdirSync(deviceAuthHome, { recursive: true });
  fs.writeFileSync(path.join(deviceAuthHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'device-unit-token' } }), 'utf8');
  state.integration_statuses[0].home = deviceAuthHome;
  const completed = await runCodexJson({ state, profile: one, prompt: 'test', cwd: repo, sandbox: 'read-only', spawnProcess: immediateProcess, onEvent: (event) => events.push(event.type) });
  assert.equal(completed.ok, true);
  assert.equal(latestProcess.stdin.writableEnded, true);
  assert.equal(fs.existsSync(path.join(firstConfig.codex_home, 'auth.json')), true);
  assert.deepEqual(events, ['thread.started', 'item.completed']);
  assert.ok(completed.invocation.args.includes('host.docker.internal:host-gateway'));
  assert.ok(completed.invocation.args.some((arg) => arg.includes('/aiws-mounts/0:ro')));

  const timed = await runCodexJson({ state, profile: { ...one, kind: 'host', mounts: [] }, prompt: 'timeout', cwd: repo, spawnProcess: hangingProcess });
  assert.equal(timed.ok, false);
  assert.equal(timed.timed_out, true);
  assert.equal(timed.timeout_ms, 1000);
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const config = { app_id: '1234', client_id: 'Iv1.unit', refs: { private_key: await putSecret('unit_private', privateKey) } };
  const jwt = createAppJwt('1234', privateKey, 1000);
  assert.equal(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).iss, '1234');
  const requests = [];
  const request = async (url, options = {}) => { requests.push({ url, options }); return url.includes('access_tokens') ? { token: 'installation-token', permissions: { contents: 'write', pull_requests: 'write' } } : url.includes('repositories') ? { total_count: 1, repositories: [{ id: 1, permissions: { pull: false, push: false, admin: false } }] } : { id: 1234 }; };
  await verifyApp(config, request);
  await createInstallationToken(config, '42', request);
  const repositories = await fetchInstallationRepositories(config, '42', request);
  assert.equal(repositories.repositories.length, 1);
  assert.deepEqual(repositories.repositories[0].permissions, { pull: true, push: true, admin: false });
  const gitAuth = githubGitAuthEnv('installation-token');
  assert.equal(Buffer.from(gitAuth.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', ''), 'base64').toString('utf8'), 'x-access-token:installation-token');
  assert.equal(requests.some((item) => item.url.endsWith('/app') && item.options.headers.authorization.startsWith('Bearer ')), true);
  assert.equal(requests.some((item) => item.url.includes('/installations/42/access_tokens') && item.options.method === 'POST'), true);
  assert.equal(requests.some((item) => item.url.includes('/installation/repositories?per_page=100&page=1') && item.options.headers.authorization === 'Bearer installation-token'), true);
  const account = { credential_ref: await putSecret('unit_oauth', 'unit-oauth-token') };
  await fetchUserInstallations(account, async (url, options) => { assert.match(url, /user\/installations/); assert.equal(options.headers.authorization, 'Bearer unit-oauth-token'); return { installations: [] }; });
  console.log('V1.2 service unit tests passed');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

function processFixture(onStart) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
  latestProcess = child;
  queueMicrotask(() => onStart(child));
  return child;
}
function immediateProcess() { return processFixture((child) => { child.stdout.write('{"type":"thread.started"}\n{"type":"item.completed"}\n'); child.stdout.end(); child.stderr.end(); child.emit('close', 0); }); }
function hangingProcess() { return processFixture(() => {}); }
