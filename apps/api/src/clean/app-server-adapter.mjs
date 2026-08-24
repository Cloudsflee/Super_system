import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { stringify as stringifyToml } from 'smol-toml';
import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';

export const APP_SERVER_PROTOCOL_VERSION = '2';
export const APP_SERVER_METHODS = Object.freeze([
  'initialize', 'thread/start', 'thread/resume', 'turn/start', 'turn/steer',
  'turn/interrupt', 'thread/started', 'turn/started', 'turn/completed',
  'item/started', 'item/completed', 'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval', 'item/tool/requestUserInput'
]);
export const APP_SERVER_SCHEMA = Object.freeze({
  protocol: 'codex-app-server',
  version: APP_SERVER_PROTOCOL_VERSION,
  methods: APP_SERVER_METHODS,
  sequence: { type: 'integer', minimum: 1 },
  opaque_ids: ['thread_id', 'turn_id', 'item_id']
});
export const APP_SERVER_SCHEMA_SHA256 = sha256Hex(canonicalJson(APP_SERVER_SCHEMA));

const INLINE_CREDENTIAL_KEY = /(?:token|secret|password|authorization|api[_-]?key|bearer)/i;
const PROVIDER_DEFINITION_FIELDS = Object.freeze([
  'name', 'base_url', 'wire_api', 'requires_openai_auth', 'request_max_retries',
  'stream_max_retries', 'stream_idle_timeout_ms'
]);
const PROVIDER_ENVIRONMENT_KEYS = new Set([
  'ALLUSERSPROFILE', 'APPDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LANG',
  'LOCALAPPDATA', 'NODE_PATH', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'PUBLIC', 'SHELL', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP',
  'TMPDIR', 'TZ', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
  'CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_PACKAGE_ROOT', 'GO111MODULE', 'GOPATH',
  'GOPROXY', 'PYTHONPATH', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'
]);

export function isolateProviderConfiguration(input = {}) {
  if (input == null) return null;
  if (!isRecord(input)) throw providerConfigError('provider configuration must be an object');
  assertNoInlineCredential(input);

  const modelProvider = optionalIdentifier(input.model_provider ?? input.modelProvider, 'model_provider', 80);
  const model = optionalIdentifier(input.model, 'model', 160);
  const effort = optionalIdentifier(input.model_reasoning_effort ?? input.reasoning_effort, 'model_reasoning_effort', 32);
  const serviceTier = optionalIdentifier(input.service_tier, 'service_tier', 32);
  const output = { disable_response_storage: input.disable_response_storage !== false };
  if (modelProvider) output.model_provider = modelProvider;
  if (model) output.model = model;
  if (effort) output.model_reasoning_effort = effort;
  if (serviceTier) output.service_tier = serviceTier;

  const definitions = isRecord(input.model_providers) ? input.model_providers : {};
  const source = modelProvider && isRecord(definitions[modelProvider])
    ? definitions[modelProvider]
    : isRecord(input.provider_definition) ? input.provider_definition : null;
  if (source) {
    const definition = {};
    for (const field of PROVIDER_DEFINITION_FIELDS) {
      if (source[field] == null) continue;
      if (field === 'base_url') definition[field] = safeProviderUrl(source[field]);
      else if (field === 'requires_openai_auth') definition[field] = Boolean(source[field]);
      else if (field.endsWith('_retries') || field.endsWith('_timeout_ms')) definition[field] = boundedInteger(source[field], field);
      else definition[field] = optionalIdentifier(source[field], field, 160);
    }
    // The provider credential is always supplied through the child process
    // lease. It is never serialized into the isolated CODEX_HOME.
    definition.env_key = 'OPENAI_API_KEY';
    output.model_providers = { [modelProvider || 'custom']: definition };
  }
  return output;
}

export function writeIsolatedProviderConfiguration(home, input = {}) {
  const config = isolateProviderConfiguration(input);
  if (!config) return null;
  const target = path.join(String(home), 'config.toml');
  fs.writeFileSync(target, stringifyToml(config), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { file: 'config.toml', sha256: sha256Hex(fs.readFileSync(target)) };
}

export class DeterministicAppServerAdapter {
  constructor(options = {}) {
    this.available = options.available !== false;
    this.schema = options.schema || APP_SERVER_SCHEMA;
    this.calls = [];
    this.threads = new Map();
  }

  async probe() {
    if (!this.available) throw new PlatformError('provider_unavailable', 'app-server provider is unavailable', {}, 503);
    return {
      available: true,
      protocol_version: APP_SERVER_PROTOCOL_VERSION,
      schema_sha256: sha256Hex(canonicalJson(this.schema)),
      methods: [...this.schema.methods],
      adapter: 'deterministic-app-server'
    };
  }

  async startThread(input = {}) {
    await this.probe();
    const threadId = String(input.thread_id || opaqueId('provider_thread'));
    this.threads.set(threadId, { id: threadId, turns: 0 });
    this.calls.push({ method: 'thread/start', thread_id: threadId, profile_revision: Number(input.profile_revision || 0) });
    return { thread_id: threadId };
  }

  async resumeThread(input = {}) {
    await this.probe();
    const threadId = String(input.thread_id || '');
    if (!threadId) throw new PlatformError('external_result_unknown', 'provider thread id is missing', {}, 409);
    if (!this.threads.has(threadId)) this.threads.set(threadId, { id: threadId, turns: 0, resumed: true });
    this.calls.push({ method: 'thread/resume', thread_id: threadId });
    return { thread_id: threadId, resumed: true };
  }

  async startTurn(input = {}) {
    await this.probe();
    const fixture = input.fixture && typeof input.fixture === 'object' ? input.fixture : {};
    if (fixture.protocol_schema_sha256 && fixture.protocol_schema_sha256 !== APP_SERVER_SCHEMA_SHA256) {
      throw new PlatformError('provider_protocol_drift', 'app-server protocol schema changed', {
        expected_schema_sha256: APP_SERVER_SCHEMA_SHA256,
        actual_schema_sha256: String(fixture.protocol_schema_sha256)
      }, 503);
    }
    const threadId = String(input.thread_id || '');
    const turnId = String(fixture.turn_id || input.turn_id || opaqueId('provider_turn'));
    const calls = Array.isArray(fixture.tool_calls) ? fixture.tool_calls : [];
    const events = Array.isArray(fixture.events)
      ? fixture.events.map((event) => ({ ...event }))
      : defaultEvents({ turnId, message: input.message, calls, assistant: fixture.assistant });
    if (fixture.duplicate_sequence && events.length) events.splice(1, 0, { ...events[0] });
    if (fixture.out_of_order && events.length > 2) [events[0], events[1]] = [events[1], events[0]];
    if (fixture.missing_terminal) {
      const index = events.findIndex((event) => event.method === 'turn/completed');
      if (index >= 0) events.splice(index, 1);
    }
    if (fixture.missing_assistant) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].method === 'item/completed' && events[index].params?.role === 'assistant') events.splice(index, 1);
      }
    }
    if (fixture.pending_approval) {
      events.splice(Math.max(1, events.length - 1), 0, {
        sequence: Math.max(1, events.length), method: 'item/commandExecution/requestApproval',
        params: { action: fixture.pending_approval.action || 'command.execute', request: fixture.pending_approval.request || {} }
      });
      resequence(events);
    }
    if (fixture.pending_input) {
      events.splice(Math.max(1, events.length - 1), 0, {
        sequence: Math.max(1, events.length), method: 'item/tool/requestUserInput',
        params: { prompt_summary: fixture.pending_input.prompt_summary || 'Input required', input_schema: fixture.pending_input.input_schema || {} }
      });
      resequence(events);
    }
    this.calls.push({ method: 'turn/start', thread_id: threadId, turn_id: turnId, input_sha256: String(input.input_hash || '') });
    return { thread_id: threadId, turn_id: turnId, events };
  }

  async steerTurn(input = {}) {
    this.calls.push({ method: 'turn/steer', thread_id: input.thread_id, turn_id: input.turn_id, message_sha256: sha256Hex(String(input.message || '')) });
    return { accepted: true };
  }

  async interruptTurn(input = {}) {
    this.calls.push({ method: 'turn/interrupt', thread_id: input.thread_id, turn_id: input.turn_id });
    return { interrupted: true };
  }
}

export class ProcessAppServerAdapter {
  constructor({ command = 'codex', args = ['app-server', '--stdio'], timeoutMs = 30_000, env = process.env, homeRoot = null } = {}) {
    this.command = resolveCodexCommand(command);
    this.args = [...args];
    this.timeoutMs = timeoutMs;
    this.env = providerProcessEnvironment(env);
    this.homeRoot = homeRoot || path.join(os.tmpdir(), 'aiws-codex-home');
    this.connections = new Map();
    this.schemaInfo = null;
  }

  async probe() {
    const schema = await this.generatedSchema();
    const home = this.createIsolatedHome('probe');
    let connection;
    try {
      connection = await this.openConnection({ home });
      const result = connection.initializeResult;
      const missing = APP_SERVER_METHODS.filter((method) => method !== 'initialize' && !schema.methods.has(method));
      if (missing.length) throw new PlatformError('provider_protocol_drift', 'app-server method inventory changed', { missing_methods: missing }, 503);
      if (!result?.userAgent || !result?.platformFamily) throw new PlatformError('provider_protocol_drift', 'app-server initialize response is incomplete', {}, 503);
      return {
        available: true,
        protocol_version: APP_SERVER_PROTOCOL_VERSION,
        schema_sha256: APP_SERVER_SCHEMA_SHA256,
        generated_schema_sha256: schema.sha256,
        methods: [...schema.methods].sort(),
        adapter: 'process-app-server'
      };
    } finally {
      await connection?.close();
      await removeTree(home);
    }
  }

  createIsolatedHome(label = 'session') {
    fs.mkdirSync(this.homeRoot, { recursive: true, mode: 0o700 });
    return fs.mkdtempSync(path.join(this.homeRoot, `${String(label).replace(/[^a-z0-9_-]/gi, '_')}-`));
  }

  async request(payload, { home, credential = null } = {}) {
    const ownedHome = home || this.createIsolatedHome('request');
    let connection;
    try {
      connection = await this.openConnection({ home: ownedHome, credential });
      return await connection.request(payload.method, payload.params || {});
    } finally {
      await connection?.close();
      if (!home) await removeTree(ownedHome);
    }
  }

  async startThread(input = {}) {
    const home = this.createIsolatedHome('session');
    let connection;
    try {
      writeIsolatedProviderConfiguration(home, input.provider_config || {});
      const providerConfig = isolateProviderConfiguration(input.provider_config || {});
      connection = await this.openConnection({ home, credential: input.credential });
      const result = await connection.request('thread/start', {
        approvalPolicy: 'on-request',
        cwd: input.cwd || undefined,
        sandbox: input.sandbox || 'workspace-write',
        model: input.model || providerConfig?.model || undefined,
        modelProvider: input.model_provider || providerConfig?.model_provider || undefined,
        runtimeWorkspaceRoots: input.runtime_workspace_roots || undefined
      });
      const threadId = String(result?.thread?.id || '');
      if (!threadId) throw new PlatformError('provider_protocol_drift', 'app-server thread id is missing', {}, 503);
      this.connections.set(threadId, { connection, home, threadId, pending: null, resumeResolutions: null, collector: null });
      return { thread_id: threadId };
    } catch (error) {
      await connection?.close();
      await removeTree(home);
      throw error;
    }
  }

  async resumeThread(input = {}) {
    const threadId = String(input.thread_id || '');
    if (!threadId) throw new PlatformError('external_result_unknown', 'provider thread id is missing', {}, 409);
    let state = this.connections.get(threadId);
    if (!state) {
      const home = this.createIsolatedHome('resume');
      let connection;
      try {
        writeIsolatedProviderConfiguration(home, input.provider_config || {});
        connection = await this.openConnection({ home, credential: input.credential });
        await connection.request('thread/resume', { threadId });
        state = { connection, home, threadId, pending: null, resumeResolutions: null, collector: null };
        this.connections.set(threadId, state);
      } catch (error) {
        await connection?.close();
        await removeTree(home);
        throw error;
      }
    } else if (!state.pending) {
      await state.connection.request('thread/resume', { threadId });
    }
    state.resumeResolutions = Array.isArray(input.resolutions) ? input.resolutions : [];
    return { thread_id: threadId, resumed: true };
  }

  async startTurn(input = {}) {
    const threadId = String(input.thread_id || '');
    const state = this.connections.get(threadId);
    if (!state) throw new PlatformError('external_result_unknown', 'provider thread connection is unavailable', {}, 503);
    if (input.resume && state.pending) {
      const collector = this.createCollector(state);
      const pending = state.pending;
      state.pending = null;
      await this.respondPending(state, pending, state.resumeResolutions || []);
      state.resumeResolutions = null;
      const resumed = await collector.wait();
      return { thread_id: threadId, turn_id: pending.turnId || input.turn_id || '', events: resumed.events };
    }
    const collector = this.createCollector(state);
    const result = await state.connection.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: String(input.message || '') }],
      cwd: input.cwd || undefined,
      approvalPolicy: 'on-request',
      sandboxPolicy: input.sandbox || undefined
    });
    const turnId = String(result?.turn?.id || input.turn_id || '');
    collector.turnId = turnId;
    const completed = await collector.wait();
    return { thread_id: threadId, turn_id: turnId, events: completed.events };
  }

  async steerTurn(input = {}) {
    const state = this.connections.get(String(input.thread_id || ''));
    if (!state) throw new PlatformError('external_result_unknown', 'provider thread connection is unavailable', {}, 503);
    const result = await state.connection.request('turn/steer', { threadId: String(input.thread_id), expectedTurnId: String(input.turn_id), input: [{ type: 'text', text: String(input.message || '') }] });
    return { accepted: true, turn_id: result?.turnId || input.turn_id };
  }

  async interruptTurn(input = {}) {
    const state = this.connections.get(String(input.thread_id || ''));
    if (!state) throw new PlatformError('external_result_unknown', 'provider thread connection is unavailable', {}, 503);
    await state.connection.request('turn/interrupt', { threadId: String(input.thread_id), turnId: String(input.turn_id) });
    return { interrupted: true };
  }

  async close() {
    const states = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(states.map(async (state) => {
      await state.connection.close();
      await removeTree(state.home);
    }));
  }

  async generatedSchema() {
    if (this.schemaInfo) return this.schemaInfo;
    const output = this.createIsolatedHome('schema');
    try {
      await runChild(this.command, ['app-server', 'generate-json-schema', '--out', output, '--experimental'], this.env, this.timeoutMs);
      const files = listFiles(output).filter((file) => file.endsWith('.json')).sort();
      const chunks = files.map((file) => `${path.relative(output, file).replaceAll('\\', '/')}\0${fs.readFileSync(file, 'utf8')}`);
      const methods = new Set();
      for (const file of files) collectProtocolMethods(JSON.parse(fs.readFileSync(file, 'utf8')), methods);
      this.schemaInfo = { methods, sha256: sha256Hex(chunks.join('\n')) };
      return this.schemaInfo;
    } finally {
      await removeTree(output);
    }
  }

  async openConnection({ home, credential = null }) {
    const connection = new JsonRpcConnection({ command: this.command, args: this.args, env: this.env, home, credential, timeoutMs: this.timeoutMs });
    try {
      await connection.ready;
      await connection.initialize();
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  createCollector(state) {
    const collector = new TurnCollector(state);
    state.collector = collector;
    return collector;
  }

  async respondPending(state, pending, resolutions) {
    const resolution = resolutions.find((item) => String(item.kind || '') === pending.kind) || resolutions[0] || {};
    if (pending.method === 'item/tool/requestUserInput') {
      const answers = {};
      const questions = Array.isArray(pending.params?.questions) ? pending.params.questions : [];
      const response = resolution.response && typeof resolution.response === 'object' ? resolution.response : {};
      const value = response.value == null ? JSON.stringify(response) : String(response.value);
      const questionId = String(questions[0]?.id || 'answer');
      answers[questionId] = { answers: [value] };
      await state.connection.respond(pending.id, { answers });
      return;
    }
    await state.connection.respond(pending.id, { decision: ['approved', 'applied'].includes(String(resolution.status)) ? 'accept' : 'decline' });
  }
}

class JsonRpcConnection {
  constructor({ command, args, env, home, credential, timeoutMs }) {
    const childEnv = { ...env, CODEX_HOME: home };
    if (credential != null) childEnv.OPENAI_API_KEY = Buffer.isBuffer(credential) ? credential.toString('utf8') : String(credential);
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = '';
    this.closed = false;
    this.closePromise = null;
    this.child = spawn(command, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' && /\.cmd$/i.test(command) });
    this.ready = new Promise((resolve, reject) => {
      this.child.once('error', (error) => reject(new PlatformError('provider_unavailable', 'app-server process did not start', { reason: String(error?.code || 'spawn_failed') }, 503)));
      this.child.once('spawn', resolve);
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(String(chunk)));
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.child.once('close', (code) => {
      this.closed = true;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new PlatformError('provider_unavailable', 'app-server process exited', { exit_status: Number(code) }, 503)); }
      this.pending.clear();
      this.resolveExit?.({ code: Number(code), signal: null });
    });
    this.child.once('error', (error) => { this.childError = error; });
  }

  initialize() { return this.request('initialize', { clientInfo: { name: 'aiws-v3-clean', version: '5' }, capabilities: { experimentalApi: true } }).then((result) => { this.initializeResult = result; this.notify('initialized', {}); return result; }); }

  request(method, params = {}) {
    const id = opaqueId('rpc');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new PlatformError('provider_timeout', 'app-server request timed out', {}, 503)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) { this.write({ jsonrpc: '2.0', method, params }); }
  respond(id, result) { this.write({ jsonrpc: '2.0', id, result }); }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  write(value) { if (!this.closed) this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (!this.closed) {
        this.closed = true;
        try { this.child.stdin.end(); } catch {}
        try { this.child.kill(); } catch {}
      }
      await waitFor(this.exitPromise, Math.min(Math.max(this.timeoutMs, 1000), 5000));
      if (this.child.exitCode == null && !this.child.signalCode) {
        try { this.child.kill('SIGKILL'); } catch {}
        await waitFor(this.exitPromise, 2000);
      }
    })();
    return this.closePromise;
  }

  consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id != null && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new PlatformError('provider_request_failed', String(message.error.message || 'app-server request failed'), { provider_code: message.error.code || null }, 503));
        else entry.resolve(message.result);
      } else {
        for (const listener of this.listeners) { try { listener(message); } catch {} }
      }
    }
  }
}

class TurnCollector {
  constructor(state) {
    this.state = state;
    this.events = [];
    this.sequence = 1;
    this.turnId = '';
    this.done = false;
    this.unsubscribe = state.connection.on((message) => this.receive(message));
    this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.timer = setTimeout(() => this.finish({ events: this.events }), 120_000);
  }
  receive(message) {
    const method = String(message.method || '');
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    if (!method) return;
    if (message.id != null && method.startsWith('item/')) {
      const pending = { id: message.id, method, kind: requestKind(method), params, turnId: String(params.turnId || this.turnId) };
      this.state.pending = pending;
      this.push(normalizeServerRequest(method, params));
      this.finish({ events: this.events });
      return;
    }
    if (this.turnId && params.turnId && String(params.turnId) !== this.turnId) return;
    if (method === 'item/started' || method === 'item/completed') this.push(normalizeItemEvent(method, params));
    if (method === 'turn/started') this.push({ method: 'turn/started', params: { turn_id: params.turnId } });
    if (method === 'turn/completed') {
      const status = String(params.turn?.status || 'completed');
      this.push({ method: status === 'completed' ? 'turn/completed' : 'turn/failed', params: { turn_id: params.turn?.id || params.turnId, error: params.turn?.error || null } });
      this.finish({ events: this.events });
    }
    if (method === 'error' || method === 'turn/failed') {
      this.push({ method: 'turn/failed', params: { turn_id: params.turnId || this.turnId, error: sanitizeText(params.message || params.error || 'provider turn failed') } });
      this.finish({ events: this.events });
    }
  }
  push(event) { this.events.push({ sequence: this.sequence++, ...event }); }
  wait() { return this.promise; }
  finish(value) { if (this.done) return; this.done = true; clearTimeout(this.timer); this.unsubscribe(); this.resolve(value); }
}

function normalizeItemEvent(method, params) {
  const item = params.item && typeof params.item === 'object' ? params.item : params;
  const id = String(item.id || item.itemId || params.itemId || opaqueId('provider_item'));
  const type = String(item.type || item.kind || 'unknown');
  const tool = !['agentMessage', 'reasoning', 'userMessage'].includes(type);
  if (method === 'item/started') return { method, params: { item_id: id, kind: tool ? 'tool_call' : type, name: item.command || item.name || type } };
  const content = item.type === 'agentMessage' ? String(item.text || '')
    : item.type === 'reasoning' ? String(item.summary || item.text || '')
      : String(item.aggregatedOutput || item.output || item.summary || item.status || '');
  return { method, params: { item_id: id, role: tool ? 'tool' : item.type === 'agentMessage' ? 'assistant' : 'reasoning_summary', kind: tool ? 'tool_result' : item.type === 'agentMessage' ? 'message' : 'reasoning_summary', content, summary: content, terminal: ['completed', 'failed', 'declined'].includes(String(item.status || 'completed')), status: String(item.status || 'completed') } };
}

function normalizeServerRequest(method, params) {
  if (method === 'item/tool/requestUserInput') return { method, params: { prompt_summary: sanitizeText(params.message || params.prompt || 'Input required'), input_schema: { questions: Array.isArray(params.questions) ? params.questions.map((question) => ({ id: String(question.id || ''), text: sanitizeText(question.text || question.prompt || '') })) : [] } } };
  if (method === 'item/fileChange/requestApproval') return { method, params: { action: 'file.change', request: { summary: sanitizeText(params.reason || params.message || 'File changes requested') } } };
  if (method === 'item/permissions/requestApproval') return { method, params: { action: 'permissions.request', request: { summary: sanitizeText(params.reason || params.message || 'Permission approval requested') } } };
  return { method, params: { action: 'command.execute', request: { summary: sanitizeText(params.command || params.reason || 'Command approval requested') } } };
}
function requestKind(method) { return method === 'item/tool/requestUserInput' ? 'input' : 'approval'; }

function sanitizeText(value) { return String(value || '').replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s"']+[\\/])+[^\s"']*/g, '[path]').replace(/(?:sk-|ghp_|Bearer\s+)[A-Za-z0-9._~-]{8,}/gi, '[redacted]').slice(0, 500); }
function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function providerConfigError(message) { return new PlatformError('provider_config_invalid', message, {}, 422); }
function assertNoInlineCredential(value, depth = 0) {
  if (depth > 12) throw providerConfigError('provider configuration is too deeply nested');
  if (Array.isArray(value)) { for (const item of value) assertNoInlineCredential(item, depth + 1); return; }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (INLINE_CREDENTIAL_KEY.test(String(key))) throw providerConfigError('provider configuration contains an inline credential');
    assertNoInlineCredential(item, depth + 1);
  }
}
function optionalIdentifier(value, field, max) {
  if (value == null || value === '') return '';
  const text = String(value);
  if (!text || text.length > max || /[\r\n\0]/.test(text)) throw providerConfigError(`${field} is invalid`);
  return text;
}
function boundedInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 600_000) throw providerConfigError(`${field} is invalid`);
  return number;
}
function safeProviderUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw providerConfigError('provider base_url is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw providerConfigError('provider base_url is invalid');
  return url.toString().replace(/\/$/, '');
}
function providerProcessEnvironment(env) {
  const output = {};
  for (const [key, value] of Object.entries(env || {})) {
    const normalized = String(key).toUpperCase();
    if (PROVIDER_ENVIRONMENT_KEYS.has(normalized) || normalized.startsWith('LC_') || normalized.endsWith('_HOME')) output[key] = String(value);
  }
  return output;
}
function resolveCodexCommand(command) {
  if (process.platform !== 'win32' || command !== 'codex') return command;
  const result = spawnSync('where.exe', ['codex.cmd'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 && result.stdout.trim() ? 'codex.cmd' : command;
}
function runChild(command, args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' && /\.cmd$/i.test(command) });
    let stderr = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new PlatformError('provider_timeout', 'app-server schema generation timed out', {}, 503)); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(new PlatformError('provider_unavailable', 'app-server tooling did not start', { reason: String(error?.code || 'spawn_failed') }, 503)); });
    child.once('close', (code) => { clearTimeout(timer); if (code !== 0) reject(new PlatformError('provider_unavailable', 'app-server tooling failed', { exit_status: Number(code), stderr_sha256: sha256Hex(stderr) }, 503)); else resolve(); });
  });
}
function listFiles(root) { const result = []; for (const entry of fs.readdirSync(root, { withFileTypes: true })) { const file = path.join(root, entry.name); if (entry.isDirectory()) result.push(...listFiles(file)); else result.push(file); } return result; }
function collectProtocolMethods(value, methods) { if (Array.isArray(value)) { for (const item of value) collectProtocolMethods(item, methods); return; } if (!value || typeof value !== 'object') return; for (const [key, item] of Object.entries(value)) { if ((key === 'const' || key === 'enum') && (typeof item === 'string' || Array.isArray(item))) { for (const candidate of Array.isArray(item) ? item : [item]) if (/^(?:initialize|thread\/|turn\/|item\/)/.test(String(candidate))) methods.add(String(candidate)); } else collectProtocolMethods(item, methods); } }
async function waitFor(promise, timeoutMs) { let timer; try { return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]); } finally { clearTimeout(timer); } }
async function removeTree(target) {
  const value = String(target || '');
  if (!value) return;
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await fs.promises.rm(value, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(String(error?.code || '')) || attempt === 11) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  if (lastError) throw lastError;
}

function defaultEvents({ turnId, message, calls, assistant }) {
  const events = [];
  let sequence = 1;
  events.push({ sequence: sequence++, method: 'turn/started', params: { turn_id: turnId } });
  for (const call of calls) {
    const itemId = String(call.id || opaqueId('provider_item'));
    events.push({ sequence: sequence++, method: 'item/started', params: { item_id: itemId, kind: 'tool_call', name: String(call.name || 'tool') } });
    if (call.terminal !== false) events.push({ sequence: sequence++, method: 'item/completed', params: { item_id: itemId, role: 'tool', kind: 'tool_result', summary: String(call.summary || 'completed'), terminal: true } });
  }
  events.push({ sequence: sequence++, method: 'item/completed', params: { item_id: opaqueId('provider_item'), role: 'assistant', kind: 'message', content: String(assistant || `Completed: ${String(message || '').slice(0, 200)}`), terminal: true } });
  events.push({ sequence, method: 'turn/completed', params: { turn_id: turnId } });
  return events;
}

function resequence(events) {
  events.forEach((event, index) => { event.sequence = index + 1; });
}
