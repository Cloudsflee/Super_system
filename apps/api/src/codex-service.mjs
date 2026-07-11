import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CODEX_HOME_DIR, AIWS_HOME, ROOT } from './config.mjs';
import { readSecret } from './vault.mjs';
import { materializeDeviceAuth } from './codex-device-auth.mjs';
import { classifyCodexExecution, completeCodexProbe, createCodexPreflight, probeCheck, probeFailure } from './codex-probe.mjs';
import { codexContainerProxyEnv, containerizeLoopbackUrl } from './codex-container-network.mjs';
import { prepareCodexInvocation } from '../../../packages/runner-adapters/src/codex-command.mjs';
export const OFFICIAL_CODEX_PROVIDERS = Object.freeze(['openai', 'chatgpt']);
// Codex rejects `wire_api = "chat"`; cc-switch can translate Chat Completions only while its local proxy runs.
// this profile-scoped bridge does not pretend that lifecycle exists.
export const CODEX_WIRE_APIS = Object.freeze(['responses']);
export function isThirdPartyProvider(provider) {
  return !OFFICIAL_CODEX_PROVIDERS.includes(String(provider || 'openai').trim().toLowerCase());
}
export function normalizeProviderBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048 || /[\r\n\0]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}
export function codexProviderKey(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return key || 'custom';
}
export function codexAuthProviderMatchesProfile(auth, profile) {
  if (!auth || auth.status !== 'authenticated') return false;
  const authProvider = String(auth.provider || '').trim().toLowerCase();
  const profileProvider = String(profile?.provider || '').trim().toLowerCase();
  if (!authProvider || !profileProvider) return false;
  if (OFFICIAL_CODEX_PROVIDERS.includes(authProvider) && OFFICIAL_CODEX_PROVIDERS.includes(profileProvider)) return true;
  return authProvider === profileProvider;
}
export function codexAuthMatchesProfile(auth, profile) {
  if (!codexAuthProviderMatchesProfile(auth, profile)) return false;
  if (!isThirdPartyProvider(profile?.provider)) return true;
  return Boolean(normalizeProviderBaseUrl(auth.base_url) && normalizeProviderBaseUrl(auth.base_url) === normalizeProviderBaseUrl(profile.base_url));
}

export function validateProfileInput(state, input) {
  const errors = [];
  if (!input.name?.trim()) errors.push('name_required');
  else if (input.name.trim().length > 100) errors.push('invalid_name');
  if (!input.provider?.trim()) errors.push('provider_required');
  else if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.provider)) errors.push('invalid_provider');
  if (!input.model?.trim()) errors.push('model_required');
  else if (!/^[a-zA-Z0-9][a-zA-Z0-9._/+:@-]{0,199}$/.test(input.model)) errors.push('invalid_model');
  const thirdParty = isThirdPartyProvider(input.provider);
  const baseUrl = normalizeProviderBaseUrl(input.base_url ?? input.api_url ?? input.provider_url);
  if (thirdParty && !String(input.base_url ?? input.api_url ?? input.provider_url ?? '').trim()) errors.push('base_url_required');
  else if (String(input.base_url ?? input.api_url ?? input.provider_url ?? '').trim() && !baseUrl) errors.push('invalid_base_url');
  if (!CODEX_WIRE_APIS.includes(input.wire_api || 'responses')) errors.push('unsupported_wire_api');
  if (input.requires_openai_auth !== undefined && typeof input.requires_openai_auth !== 'boolean') errors.push('invalid_requires_openai_auth');
  if (!['low', 'medium', 'high', 'xhigh'].includes(input.reasoning || 'high')) errors.push('invalid_reasoning');
  if (input.web_search !== undefined && typeof input.web_search !== 'boolean') errors.push('invalid_web_search');
  const timeout = Number(input.timeout_ms || 120000);
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 1800000) errors.push('invalid_timeout');
  const roots = [AIWS_HOME, ...state.projects.flatMap((project) => [project.repo_path, project.workspace_root]).filter(Boolean)].map((item) => path.resolve(item));
  if (!Array.isArray(input.mounts || [])) errors.push('invalid_mounts');
  else for (const mount of input.mounts || []) {
    if (typeof mount !== 'string' || !mount || !fs.existsSync(mount)) { errors.push(`mount_not_found:${mount}`); continue; }
    const real = fs.realpathSync(path.resolve(mount));
    if (!roots.some((root) => within(realRoot(root), real))) errors.push(`mount_not_allowed:${mount}`);
  }
  if (!Array.isArray(input.mcp_servers || [])) errors.push('invalid_mcp_servers');
  else validateMcpServers(input.mcp_servers || [], errors);
  return { ok: errors.length === 0, errors };
}

export async function writeProfileConfig(profile, authHome = '') {
  const home = path.join(CODEX_HOME_DIR, profile.id);
  await fsp.mkdir(home, { recursive: true });
  const config = toToml(profile);
  await fsp.writeFile(path.join(home, 'config.toml'), config, 'utf8');
  if (authHome && !isThirdPartyProvider(profile.provider)) await materializeDeviceAuth(authHome, home);
  else await fsp.rm(path.join(home, 'auth.json'), { force: true });
  return { codex_home: home, config_file: path.join(home, 'config.toml') };
}

export async function runCodexJson({ state, profile, prompt, cwd = ROOT, resumeId, sandbox = 'workspace-write', onEvent, signal, spawnProcess = spawn }) {
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, profile)) throw new Error('codex_auth_profile_mismatch');
  const fileAuth = Boolean(auth.home && !isThirdPartyProvider(profile.provider));
  if (fileAuth) await materializeDeviceAuth(auth.home, profile.codex_home);
  const credential = await readSecret(auth?.refs?.credential);
  const proxyEnv = profile.kind === 'docker' ? codexContainerProxyEnv(process.env) : {};
  const invocation = buildInvocation({ profile, prompt, cwd, resumeId, sandbox, exposeApiKey: Boolean(credential), proxyKeys: Object.keys(proxyEnv) });
  const env = { ...process.env, ...proxyEnv, CODEX_HOME: profile.codex_home };
  if (credential) env.OPENAI_API_KEY = credential;
  else delete env.OPENAI_API_KEY;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(invocation.command, invocation.args, { cwd, env, shell: false, windowsHide: true });
    let stdout = '', stderr = '', buffer = '', timedOut = false, settled = false;
    const timeoutMs = Math.max(1000, Math.min(1800000, Number(profile.timeout_ms || 120000)));
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString(); stdout += text; buffer += text;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) onEvent?.(parseJsonLine(line));
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (!settled) { settled = true; reject(error); } });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (buffer.trim()) onEvent?.(parseJsonLine(buffer));
      if (!settled) { settled = true; resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timed_out: timedOut, timeout_ms: timeoutMs, invocation: { command: invocation.command, args: invocation.safeArgs } }); }
    });
    child.stdin?.end();
  });
}

export async function probeCodex(state, profile, runtime = {}) {
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  const configText = await readMaterializedProfileConfig(profile);
  const preflight = createCodexPreflight({ profile, auth, configText, dockerInfo: runtime.docker, imageInspect: runtime.image });
  if (!preflight.ok) return preflight;
  if (!(auth?.home && !isThirdPartyProvider(profile.provider))) {
    let credential = '';
    try { credential = await readSecret(auth?.refs?.credential); }
    catch { return completeCodexProbe(preflight, withPendingChecks(probeFailure('codex_probe_credential_unavailable'))); }
    if (!credential) return completeCodexProbe(preflight, withPendingChecks(probeFailure('codex_probe_credential_unavailable')));
  }
  const agentMessages = [];
  try {
    const result = await runCodexJson({ state, profile, sandbox: 'read-only', prompt: 'Reply with exactly AIWS_PROBE_OK. Do not read or write files.', cwd: ROOT, onEvent: (event) => {
      if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') agentMessages.push(event.item.text);
    } });
    const markerFound = agentMessages.some((item) => item.trim() === 'AIWS_PROBE_OK');
    const execution = classifyCodexExecution(result, { markerFound, diagnostic: `${result.stderr}\n${result.stdout}` });
    return completeCodexProbe(preflight, execution);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error || '');
    const credentialFailure = /vault|auth.*(?:file|materialize|missing|invalid)/i.test(diagnostic);
    const execution = credentialFailure ? withPendingChecks(probeFailure('codex_probe_credential_unavailable')) : classifyCodexExecution({ ok: false, code: null }, { diagnostic });
    return completeCodexProbe(preflight, execution);
  }
}

export function extractMessage(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'item.completed' && event.item?.type === 'agent_message') return event.item.text || '';
  if (event.type === 'message' && typeof event.message === 'string') return event.message;
  if (typeof event.output_text === 'string') return event.output_text;
  return '';
}

function buildInvocation({ profile, prompt, cwd, resumeId, sandbox, exposeApiKey = false, proxyKeys = [] }) {
  const execArgs = resumeId ? ['exec', 'resume', '--json', resumeId] : ['exec', '--json'];
  execArgs.push('--sandbox', sandbox, '--skip-git-repo-check');
  if (profile.model) execArgs.push('--model', profile.model);
  execArgs.push(prompt);
  if (profile.kind !== 'docker') { const invocation = prepareCodexInvocation(process.env.AIWS_CODEX_BIN || 'codex'); return { command: invocation.command, args: [...invocation.args, ...execArgs], safeArgs: [...invocation.args, ...execArgs.slice(0, -1), '[PROMPT]'] }; }
  const mountMode = sandbox === 'read-only' ? 'ro' : 'rw';
  const args = ['run', '--rm', '-i', '--add-host', 'host.docker.internal:host-gateway', '--env', 'CODEX_HOME=/codex-home'];
  if (exposeApiKey) args.push('--env', 'OPENAI_API_KEY');
  for (const key of proxyKeys) args.push('--env', key);
  args.push('-v', `${profile.codex_home}:/codex-home:rw`, '-v', `${path.resolve(cwd)}:/workspace:${mountMode}`, '-w', '/workspace');
  for (const [index, mount] of (profile.mounts || []).entries()) args.push('-v', `${path.resolve(mount)}:/aiws-mounts/${index}:ro`);
  args.push(profile.image || 'aiws-codex-runner:local', ...execArgs);
  return { command: 'docker', args, safeArgs: args.slice(0, -1).concat('[PROMPT]') };
}

export function profileConfigToml(profile) {
  const lines = [`model = ${quote(profile.model)}`, `model_reasoning_effort = ${quote(profile.reasoning || 'high')}`, `web_search = ${quote(profile.web_search ? 'live' : 'disabled')}`, `sandbox_mode = "workspace-write"`];
  if (isThirdPartyProvider(profile.provider)) {
    const providerKey = codexProviderKey(profile.cc_switch_provider_id || profile.provider);
    const baseUrl = normalizeProviderBaseUrl(profile.base_url) || profile.base_url;
    const runtimeBaseUrl = profile.kind === 'docker' ? containerizeLoopbackUrl(baseUrl) : baseUrl;
    lines.push(`model_provider = ${quote(providerKey)}`, '', `[model_providers.${providerKey}]`, `name = ${quote(profile.provider_name || profile.provider)}`, `base_url = ${quote(runtimeBaseUrl)}`, `wire_api = ${quote(profile.wire_api || 'responses')}`, `requires_openai_auth = ${Boolean(profile.requires_openai_auth)}`);
    if (!profile.requires_openai_auth) lines.push('env_key = "OPENAI_API_KEY"');
  }
  for (const server of profile.mcp_servers || []) {
    if (!server?.name || !server?.command) continue;
    lines.push('', `[mcp_servers.${safeKey(server.name)}]`, `command = ${quote(server.command)}`, `args = [${(server.args || []).map(quote).join(', ')}]`);
  }
  return `${lines.join('\n')}\n`;
}
const toToml = profileConfigToml;
function quote(value) { return JSON.stringify(String(value || '')); }
function safeKey(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, '_'); }
function parseJsonLine(line) { try { return JSON.parse(line); } catch { return { type: 'raw', text: line }; } }
function within(root, target) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function realRoot(value) { try { return fs.realpathSync(value); } catch { return path.resolve(value); } }
async function readMaterializedProfileConfig(profile) {
  const expectedHome = path.resolve(CODEX_HOME_DIR, String(profile?.id || ''));
  if (path.dirname(expectedHome) !== path.resolve(CODEX_HOME_DIR) || path.resolve(String(profile?.codex_home || '')) !== expectedHome) return '';
  const file = path.join(expectedHome, 'config.toml');
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return '';
    if (stat.size > 1024 * 1024) return 'x'.repeat(1024 * 1024 + 1);
    return await fsp.readFile(file, 'utf8');
  } catch { return ''; }
}
function withPendingChecks(failure) {
  return { ...failure, checks: ['transport', 'protocol', 'model', 'inference'].map((phase) => probeCheck(phase, phase === failure.phase ? 'failed' : 'pending', phase === failure.phase ? failure : null)) };
}
function validateMcpServers(servers, errors) {
  const allowed = new Set(String(process.env.AIWS_MCP_COMMAND_ALLOWLIST || 'node,npx,npx.cmd,python,python3,uv,uvx,docker').split(',').map((item) => item.trim()).filter(Boolean));
  const names = new Set();
  if (servers.length > 32) errors.push('too_many_mcp_servers');
  for (const server of servers.slice(0, 33)) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) { errors.push('invalid_mcp_server'); continue; }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(server.name || '') || names.has(server.name)) errors.push(`invalid_mcp_name:${server.name || ''}`);
    names.add(server.name);
    if (!allowed.has(String(server.command || ''))) errors.push(`mcp_command_not_allowed:${server.command || ''}`);
    if (!Array.isArray(server.args || []) || (server.args || []).some((arg) => typeof arg !== 'string' || arg.length > 2000 || /[\r\n\0]/.test(arg))) errors.push(`invalid_mcp_args:${server.name || ''}`);
    if (server.env && Object.keys(server.env).length) errors.push(`mcp_env_not_allowed:${server.name || ''}`);
  }
}
