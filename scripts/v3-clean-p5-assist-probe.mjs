import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import {
  ProcessAppServerAdapter, APP_SERVER_METHODS, APP_SERVER_SCHEMA_SHA256,
  isolateProviderConfiguration
} from '../apps/api/src/clean/app-server-adapter.mjs';
import { createCleanRuntime } from '../apps/api/src/clean/runtime.mjs';

const PROBE_PROMPT = 'Reply with exactly P5_PROBE_OK. Do not use tools.';
const PROBE_RESPONSE = 'P5_PROBE_OK';

export function acquireProviderCredentialLease({ env = process.env, codexHome = path.join(os.homedir(), '.codex') } = {}) {
  const candidates = [
    ['explicit_env', env.AIWS_P5_PROVIDER_CREDENTIAL],
    ['openai_env', env.OPENAI_API_KEY]
  ];
  for (const [source, value] of candidates) if (value) return createCredentialLease(value, source);

  const authFile = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(authFile)) return null;
  const raw = fs.readFileSync(authFile);
  try {
    const auth = JSON.parse(raw.toString('utf8'));
    const lease = auth?.OPENAI_API_KEY ? createCredentialLease(auth.OPENAI_API_KEY, 'codex_login') : null;
    if (auth && typeof auth === 'object') auth.OPENAI_API_KEY = null;
    return lease;
  } finally {
    raw.fill(0);
  }
}

export function loadCodexProviderConfiguration({ env = process.env, codexHome = path.join(os.homedir(), '.codex') } = {}) {
  const configFile = path.join(codexHome, 'config.toml');
  let parsed = {};
  if (fs.existsSync(configFile)) {
    const raw = fs.readFileSync(configFile);
    try { parsed = parseToml(raw.toString('utf8')); }
    finally { raw.fill(0); }
  }

  const modelProvider = String(env.AIWS_P5_PROVIDER_NAME || parsed.model_provider || '').trim();
  const model = String(env.AIWS_P5_PROVIDER_MODEL || parsed.model || '').trim();
  const source = modelProvider && parsed.model_providers && typeof parsed.model_providers[modelProvider] === 'object'
    ? parsed.model_providers[modelProvider]
    : {};
  const definition = {};
  for (const field of ['name', 'base_url', 'wire_api', 'requires_openai_auth', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms']) {
    if (source[field] != null) definition[field] = source[field];
  }
  if (source && typeof source === 'object' && 'experimental_bearer_token' in source) source.experimental_bearer_token = null;
  if (env.AIWS_P5_PROVIDER_BASE_URL) definition.base_url = env.AIWS_P5_PROVIDER_BASE_URL;
  if (env.AIWS_P5_PROVIDER_WIRE_API) definition.wire_api = env.AIWS_P5_PROVIDER_WIRE_API;

  const input = {
    model_provider: modelProvider || undefined,
    model: model || undefined,
    model_reasoning_effort: String(env.AIWS_P5_PROVIDER_REASONING_EFFORT || 'low'),
    disable_response_storage: true,
    ...(modelProvider && Object.keys(definition).length ? { model_providers: { [modelProvider]: definition } } : {})
  };
  return isolateProviderConfiguration(input);
}

export function validateCompletedProviderTurn(result) {
  const events = Array.isArray(result?.events) ? result.events : [];
  const failures = [];
  for (let index = 0; index < events.length; index += 1) {
    if (Number(events[index]?.sequence) !== index + 1) failures.push('event_sequence_not_contiguous');
  }
  if (!result?.turn_id) failures.push('turn_id_missing');
  if (!events.some((event) => event.method === 'turn/started')) failures.push('turn_started_missing');
  if (events.some((event) => event.method === 'turn/failed')) failures.push('turn_failed');
  if (!events.some((event) => event.method === 'turn/completed')) failures.push('terminal_notification_missing');

  const assistant = events.find((event) => event.method === 'item/completed' && event.params?.role === 'assistant');
  if (!assistant || assistant.params?.terminal !== true) failures.push('assistant_item_missing');
  const responseContractMatched = String(assistant?.params?.content || '').trim() === PROBE_RESPONSE;
  if (!responseContractMatched) failures.push('assistant_response_contract');

  const toolStarts = events.filter((event) => event.method === 'item/started' && event.params?.kind === 'tool_call');
  const terminalTools = new Set(events.filter((event) => event.method === 'item/completed' && event.params?.role === 'tool' && event.params?.terminal === true).map((event) => String(event.params?.item_id || '')));
  if (toolStarts.some((event) => !terminalTools.has(String(event.params?.item_id || '')))) failures.push('tool_call_not_terminal');
  return {
    valid: failures.length === 0,
    failures: [...new Set(failures)].sort(),
    event_count: events.length,
    sequence_contiguous: !failures.includes('event_sequence_not_contiguous'),
    terminal_notification: !failures.includes('terminal_notification_missing') && !failures.includes('turn_failed'),
    assistant_item: !failures.includes('assistant_item_missing'),
    assistant_response_contract: responseContractMatched,
    tool_calls_terminal: !failures.includes('tool_call_not_terminal'),
    tool_call_count: toolStarts.length
  };
}

export async function runAssistProbe({ env = process.env, codexHome = path.join(os.homedir(), '.codex') } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p5-assist-probe-'));
  const provider = new ProcessAppServerAdapter({
    command: env.AIWS_CLEAN_PROVIDER_COMMAND || 'codex',
    timeoutMs: Number(env.AIWS_CLEAN_PROVIDER_TIMEOUT_MS || 30_000),
    env,
    homeRoot: path.join(root, 'provider-homes')
  });
  const config = {
    runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: root,
    databaseFile: path.join(root, 'data', 'state.sqlite'), casRoot: path.join(root, 'cas'),
    receiptRoot: path.join(root, 'receipts'), vaultRoot: path.join(root, 'vault'),
    cursorSecret: 'p5-assist-probe-cursor-secret', sessionSecret: 'p5-assist-probe-session-secret',
    vaultMasterKey: 'p5-assist-probe-vault-master-secret', mcpPepper: 'p5-assist-probe-mcp-pepper',
    gatewaySecret: 'p5-assist-probe-gateway-secret', gatewayId: 'p5-assist-probe-gateway',
    runtimeBuild: 'v3-clean-p5-assist-probe', maxBodyBytes: 2_000_000
  };
  let runtime;
  let lease;
  let stage = 'protocol';
  let protocol = null;
  let receipt = null;
  let exitCode = 1;
  try {
    runtime = createCleanRuntime({ config, targetVersion: 5, providerAdapter: provider });
    await runtime.recovery;
    protocol = await runtime.assist.probeProvider();
    if (protocol.protocol_version !== '2' || protocol.schema_sha256 !== APP_SERVER_SCHEMA_SHA256) throw probeError('assist_probe_schema_mismatch');
    const requiredMethods = APP_SERVER_METHODS.filter((method) => method !== 'initialize');
    const availableMethods = new Set((protocol.methods || []).map(String));
    for (const method of requiredMethods) if (!availableMethods.has(method)) throw probeError('assist_probe_method_missing');

    stage = 'credential';
    lease = acquireProviderCredentialLease({ env, codexHome });
    if (!lease) throw probeError('provider_credential_not_configured');
    const providerConfig = loadCodexProviderConfiguration({ env, codexHome });

    stage = 'thread';
    const startedAt = performance.now();
    const thread = await provider.startThread({
      credential: lease.bytes,
      provider_config: providerConfig,
      model: providerConfig?.model,
      model_provider: providerConfig?.model_provider,
      cwd: root,
      sandbox: 'read-only',
      runtime_workspace_roots: [root]
    });
    stage = 'turn';
    const turn = await provider.startTurn({ thread_id: thread.thread_id, message: PROBE_PROMPT, cwd: root, runtime_workspace_roots: [root] });
    stage = 'validation';
    const validation = validateCompletedProviderTurn(turn);
    if (!validation.valid) throw probeError('provider_turn_incomplete', { validation });
    receipt = {
      ...baseReceipt(protocol), status: 'passed', provisional: false,
      thread_started: Boolean(thread.thread_id), thread_resume_probe: 'schema_negotiated', model_turn: 'completed',
      real_turn: validation, provider_latency_ms: Math.round((performance.now() - startedAt) * 100) / 100,
      adapter: protocol.adapter, isolated_codex_home: true, credential_lease: 'memory_only_zeroed',
      credential_source: lease.source,
      redactions: ['credential', 'assembled_prompt', 'assistant_content', 'host_absolute_path']
    };
    exitCode = 0;
  } catch (error) {
    receipt = {
      ...baseReceipt(protocol), status: 'candidate', provisional: true, stage,
      reason: safeErrorCode(error), model_turn: 'not_completed',
      real_turn: error?.probeDetails?.validation || null,
      adapter: protocol?.adapter || 'process-app-server', isolated_codex_home: true,
      credential_lease: 'memory_only_zeroed',
      redactions: ['credential', 'assembled_prompt', 'assistant_content', 'host_absolute_path']
    };
  } finally {
    lease?.release();
    try { await runtime?.close?.(); } catch { exitCode = 1; }
    try { await provider.close(); } catch { exitCode = 1; }
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { receipt, exitCode };
}

function createCredentialLease(value, source) {
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length < 16 || bytes.length > 4096) {
    bytes.fill(0);
    throw probeError('provider_credential_invalid');
  }
  let released = false;
  return {
    bytes, source,
    release() { if (!released) bytes.fill(0); released = true; },
    get released() { return released; }
  };
}

function baseReceipt(protocol) {
  return {
    schema_version: 'aiws.v3-clean.p5-assist-probe.v1',
    protocol_version: protocol?.protocol_version || null,
    schema_sha256: protocol?.schema_sha256 || APP_SERVER_SCHEMA_SHA256,
    generated_schema_sha256: protocol?.generated_schema_sha256 || null,
    methods: APP_SERVER_METHODS
  };
}

function probeError(code, probeDetails = null) {
  const error = new Error(String(code));
  error.code = String(code);
  error.probeDetails = probeDetails;
  return error;
}

function safeErrorCode(error) {
  const code = String(error?.code || error?.message || 'provider_probe_failed');
  return /^[a-z0-9_.-]{1,80}$/i.test(code) ? code : 'provider_probe_failed';
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const result = await runAssistProbe();
  process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
  process.exitCode = result.exitCode;
}
