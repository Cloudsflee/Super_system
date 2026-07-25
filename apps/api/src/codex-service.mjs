import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CODEX_HOME_DIR, AIWS_HOME, PROBE_DIR, ROOT } from './config.mjs';
import { readSecret } from './vault.mjs';
import { materializeDeviceAuth } from './codex-device-auth.mjs';
import {
  classifyCodexExecution,
  completeCodexProbe,
  createCodexPreflight,
  probeCheck,
  probeFailure
} from './codex-probe.mjs';
import { codexContainerProxyEnv, containerizeLoopbackUrl } from './codex-container-network.mjs';
import { assertProfileAllowed, isContainerized } from './container-runtime-config.mjs';
import { spawnContainerProcess } from './container-runtime.mjs';
import { buildCodexExecInvocation } from './codex-exec-invocation.mjs';
import { isCodexStateRuntimeFailure, recoverCodexRuntimeState } from './codex-home-recovery.mjs';
import { issueCodexMcpAccess, withCodexMcpEnvironment } from './codex-mcp-runtime.mjs';
import {
  DEFAULT_CODEX_TIMEOUT_MS,
  codexTimeoutTtlSeconds,
  isValidCodexTimeoutMs,
  resolveCodexTimeoutMs
} from './codex-timeout.mjs';
export { DEFAULT_CODEX_TIMEOUT_MS, isValidCodexTimeoutMs, resolveCodexTimeoutMs };
export const OFFICIAL_CODEX_PROVIDERS = Object.freeze(['openai', 'chatgpt']);
// Codex rejects `wire_api = "chat"`; cc-switch can translate Chat Completions only while its local proxy runs.
// this profile-scoped bridge does not pretend that lifecycle exists.
export const CODEX_WIRE_APIS = Object.freeze(['responses']);
export function isThirdPartyProvider(provider) {
  return !OFFICIAL_CODEX_PROVIDERS.includes(
    String(provider || 'openai')
      .trim()
      .toLowerCase()
  );
}
export function normalizeProviderBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048 || /[\r\n\0]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}
export function codexProviderKey(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key || 'custom';
}
export function codexAuthProviderMatchesProfile(auth, profile) {
  if (!auth || auth.status !== 'authenticated') return false;
  const authProvider = String(auth.provider || '')
    .trim()
    .toLowerCase();
  const profileProvider = String(profile?.provider || '')
    .trim()
    .toLowerCase();
  if (!authProvider || !profileProvider) return false;
  if (OFFICIAL_CODEX_PROVIDERS.includes(authProvider) && OFFICIAL_CODEX_PROVIDERS.includes(profileProvider))
    return true;
  return authProvider === profileProvider;
}
export function codexAuthMatchesProfile(auth, profile) {
  if (!codexAuthProviderMatchesProfile(auth, profile)) return false;
  if (!isThirdPartyProvider(profile?.provider)) return true;
  return Boolean(
    normalizeProviderBaseUrl(auth.base_url) &&
    normalizeProviderBaseUrl(auth.base_url) === normalizeProviderBaseUrl(profile.base_url)
  );
}

export function validateProfileInput(state, input) {
  const errors = [];
  validateProfileIdentity(input, errors);
  validateProfileProvider(input, errors);
  validateProfileRuntimeOptions(input, errors);
  validateProfileMounts(state, input, errors);
  if (!Array.isArray(input.mcp_servers || [])) errors.push('invalid_mcp_servers');
  else validateMcpServers(input.mcp_servers || [], errors);
  return { ok: errors.length === 0, errors };
}

function validateProfileIdentity(input, errors) {
  if (isContainerized() && input.kind && input.kind !== 'docker') errors.push('host_profile_disabled_in_container');
  if (!input.name?.trim()) errors.push('name_required');
  else if (input.name.trim().length > 100) errors.push('invalid_name');
  if (!input.provider?.trim()) errors.push('provider_required');
  else if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.provider)) errors.push('invalid_provider');
  if (!input.model?.trim()) errors.push('model_required');
  else if (!/^[a-zA-Z0-9][a-zA-Z0-9._/+:@-]{0,199}$/.test(input.model)) errors.push('invalid_model');
}

function validateProfileProvider(input, errors) {
  const thirdParty = isThirdPartyProvider(input.provider);
  const rawBaseUrl = input.base_url ?? input.api_url ?? input.provider_url ?? '';
  const baseUrl = normalizeProviderBaseUrl(rawBaseUrl);
  if (thirdParty && !String(rawBaseUrl).trim()) errors.push('base_url_required');
  else if (String(rawBaseUrl).trim() && !baseUrl) errors.push('invalid_base_url');
  if (!CODEX_WIRE_APIS.includes(input.wire_api || 'responses')) errors.push('unsupported_wire_api');
}

function validateProfileRuntimeOptions(input, errors) {
  if (input.requires_openai_auth !== undefined && typeof input.requires_openai_auth !== 'boolean')
    errors.push('invalid_requires_openai_auth');
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(String(input.reasoning || 'high'))) errors.push('invalid_reasoning');
  if (input.web_search !== undefined && typeof input.web_search !== 'boolean') errors.push('invalid_web_search');
  if (!isValidCodexTimeoutMs(input.timeout_ms)) errors.push('invalid_timeout');
}

function validateProfileMounts(state, input, errors) {
  const roots = [
    AIWS_HOME,
    ...state.projects.flatMap((project) => [project.repo_path, project.workspace_root]).filter(Boolean)
  ].map((item) => path.resolve(item));
  if (!Array.isArray(input.mounts || [])) errors.push('invalid_mounts');
  else
    for (const mount of input.mounts || []) {
      if (typeof mount !== 'string' || !mount || !fs.existsSync(mount)) {
        errors.push(`mount_not_found:${mount}`);
        continue;
      }
      const real = fs.realpathSync(path.resolve(mount));
      if (!roots.some((root) => within(realRoot(root), real))) errors.push(`mount_not_allowed:${mount}`);
    }
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

export async function runCodexJson(options) {
  let result;
  try {
    result = await runCodexJsonOnce(options);
  } catch (error) {
    if (await recoverCodexRuntimeState(options.profile, error)) return runCodexJsonOnce(options);
    throw error;
  }
  if (!isCodexStateRuntimeFailure(result?.stderr)) return result;
  return (await recoverCodexRuntimeState(options.profile, new Error(result.stderr)))
    ? runCodexJsonOnce(options)
    : result;
}

async function runCodexJsonOnce({
  state,
  profile,
  prompt,
  cwd = ROOT,
  resumeId,
  sandbox = 'workspace-write',
  runtimeKind = 'assist-exec',
  projectId = null,
  onEvent,
  signal,
  spawnProcess = spawn
}) {
  assertProfileAllowed(profile);
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, profile)) throw new Error('codex_auth_profile_mismatch');
  const fileAuth = Boolean(auth.home && !isThirdPartyProvider(profile.provider));
  if (fileAuth) await materializeDeviceAuth(auth.home, profile.codex_home);
  const credential = await readSecret(auth?.refs?.credential);
  const proxyEnv = profile.kind === 'docker' ? codexContainerProxyEnv(process.env) : {};
  const mcpAccess = await issueCodexMcpAccess(projectId, profile, {
    ttlSeconds: codexTimeoutTtlSeconds(profile.timeout_ms)
  });
  const invocation = buildCodexExecInvocation({
    profile,
    prompt,
    cwd,
    resumeId,
    sandbox,
    runtimeKind,
    exposeApiKey: Boolean(credential),
    proxyKeys: Object.keys(proxyEnv),
    mcpAccess
  });
  const env = withCodexMcpEnvironment({ ...process.env, ...proxyEnv, CODEX_HOME: profile.codex_home }, mcpAccess);
  if (credential) env.OPENAI_API_KEY = credential;
  else delete env.OPENAI_API_KEY;
  try {
    return await new Promise((resolve, reject) => {
      const child =
        invocation.runtime === 'docker'
          ? spawnContainerProcess(invocation, { cwd, env, spawnProcess })
          : spawnProcess(invocation.command, invocation.args, { cwd, env, shell: false, windowsHide: true });
      let stdout = '',
        stderr = '',
        buffer = '',
        timedOut = false,
        settled = false;
      const timeoutMs = resolveCodexTimeoutMs(profile.timeout_ms);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      const abort = () => child.kill();
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) if (line.trim()) onEvent?.(parseJsonLine(line));
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (buffer.trim()) onEvent?.(parseJsonLine(buffer));
        if (!settled) {
          settled = true;
          resolve({
            ok: code === 0 && !timedOut,
            code,
            stdout,
            stderr,
            timed_out: timedOut,
            timeout_ms: timeoutMs,
            invocation: { command: invocation.command, args: invocation.safeArgs }
          });
        }
      });
      child.stdin?.end();
    });
  } finally {
    await mcpAccess?.release();
  }
}

export async function probeCodex(state, profile, runtime = {}) {
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  const configText = await readMaterializedProfileConfig(profile);
  const preflight = createCodexPreflight({
    profile,
    auth,
    configText,
    dockerInfo: runtime.docker,
    imageInspect: runtime.image
  });
  if (!preflight.ok) return preflight;
  if (!(auth?.home && !isThirdPartyProvider(profile.provider))) {
    let credential = '';
    try {
      credential = await readSecret(auth?.refs?.credential);
    } catch {
      return completeCodexProbe(preflight, withPendingChecks(probeFailure('codex_probe_credential_unavailable')));
    }
    if (!credential)
      return completeCodexProbe(preflight, withPendingChecks(probeFailure('codex_probe_credential_unavailable')));
  }
  const agentMessages = [];
  try {
    const result = await runCodexJson({
      state,
      profile,
      sandbox: 'read-only',
      prompt: 'Reply with exactly AIWS_PROBE_OK. Do not read or write files.',
      cwd: isContainerized() ? PROBE_DIR : ROOT,
      runtimeKind: 'probe',
      onEvent: (event) => {
        if (
          event?.type === 'item.completed' &&
          event.item?.type === 'agent_message' &&
          typeof event.item.text === 'string'
        )
          agentMessages.push(event.item.text);
      }
    });
    const markerFound = agentMessages.some((item) => item.trim() === 'AIWS_PROBE_OK');
    const execution = classifyCodexExecution(result, { markerFound, diagnostic: `${result.stderr}\n${result.stdout}` });
    return completeCodexProbe(preflight, execution);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error || '');
    const credentialFailure = /vault|auth.*(?:file|materialize|missing|invalid)/i.test(diagnostic);
    const execution = credentialFailure
      ? withPendingChecks(probeFailure('codex_probe_credential_unavailable'))
      : classifyCodexExecution({ ok: false, code: null }, { diagnostic });
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

export function profileConfigToml(profile) {
  const lines = [
    `model = ${quote(profile.model)}`,
    `model_reasoning_effort = ${quote(profile.reasoning || 'high')}`,
    `web_search = ${quote(profile.web_search ? 'live' : 'disabled')}`,
    `sandbox_mode = "workspace-write"`
  ];
  if (isThirdPartyProvider(profile.provider)) {
    const providerKey = codexProviderKey(profile.cc_switch_provider_id || profile.provider);
    const baseUrl = normalizeProviderBaseUrl(profile.base_url) || profile.base_url;
    const runtimeBaseUrl = profile.kind === 'docker' ? containerizeLoopbackUrl(baseUrl) : baseUrl;
    lines.push(
      `model_provider = ${quote(providerKey)}`,
      '',
      `[model_providers.${providerKey}]`,
      `name = ${quote(profile.provider_name || profile.provider)}`,
      `base_url = ${quote(runtimeBaseUrl)}`,
      `wire_api = ${quote(profile.wire_api || 'responses')}`,
      `requires_openai_auth = ${Boolean(profile.requires_openai_auth)}`,
      'env_key = "OPENAI_API_KEY"'
    );
  }
  for (const server of profile.mcp_servers || []) {
    if (!server?.name || !server?.command) continue;
    lines.push(
      '',
      `[mcp_servers.${safeKey(server.name)}]`,
      `command = ${quote(server.command)}`,
      `args = [${(server.args || []).map(quote).join(', ')}]`
    );
  }
  return `${lines.join('\n')}\n`;
}
const toToml = profileConfigToml;
function quote(value) {
  return JSON.stringify(String(value || ''));
}
function safeKey(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}
function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { type: 'raw', text: line };
  }
}
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function realRoot(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
async function readMaterializedProfileConfig(profile) {
  const expectedHome = path.resolve(CODEX_HOME_DIR, String(profile?.id || ''));
  if (
    path.dirname(expectedHome) !== path.resolve(CODEX_HOME_DIR) ||
    path.resolve(String(profile?.codex_home || '')) !== expectedHome
  )
    return '';
  const file = path.join(expectedHome, 'config.toml');
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return '';
    if (stat.size > 1024 * 1024) return 'x'.repeat(1024 * 1024 + 1);
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}
function withPendingChecks(failure) {
  return {
    ...failure,
    checks: ['transport', 'protocol', 'model', 'inference'].map((phase) =>
      probeCheck(phase, phase === failure.phase ? 'failed' : 'pending', phase === failure.phase ? failure : null)
    )
  };
}
function validateMcpServers(servers, errors) {
  const allowed = new Set(
    String(process.env.AIWS_MCP_COMMAND_ALLOWLIST || 'node,npx,npx.cmd,python,python3,uv,uvx,docker')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
  const names = new Set();
  if (servers.length > 32) errors.push('too_many_mcp_servers');
  for (const server of servers.slice(0, 33)) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      errors.push('invalid_mcp_server');
      continue;
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(server.name || '') || names.has(server.name))
      errors.push(`invalid_mcp_name:${server.name || ''}`);
    if (server.name === 'aiws-built-in') errors.push('mcp_reserved_name_conflict:aiws-built-in');
    names.add(server.name);
    if (!allowed.has(String(server.command || ''))) errors.push(`mcp_command_not_allowed:${server.command || ''}`);
    if (
      !Array.isArray(server.args || []) ||
      (server.args || []).some((arg) => typeof arg !== 'string' || arg.length > 2000 || /[\r\n\0]/.test(arg))
    )
      errors.push(`invalid_mcp_args:${server.name || ''}`);
    if (server.env && Object.keys(server.env).length) errors.push(`mcp_env_not_allowed:${server.name || ''}`);
  }
}
