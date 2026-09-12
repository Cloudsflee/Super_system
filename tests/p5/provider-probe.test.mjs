import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stringify as stringifyToml } from 'smol-toml';
import {
  DeterministicAppServerAdapter, ProcessAppServerAdapter,
  isolateProviderConfiguration, removeIsolatedProviderTree, writeIsolatedProviderConfiguration, providerRequestFailure
} from '../../apps/api/src/clean/app-server-adapter.mjs';
import {
  acquireProviderCredentialLease, loadCodexProviderConfiguration,
  validateCompletedProviderTurn
} from '../../scripts/v3-clean-p5-assist-probe.mjs';
import { validateP5AssistProbeReceipt } from '../../scripts/catalog-loader.mjs';
import { close, createAssistPrerequisites, createProject, open } from './helpers.mjs';

test('isolated provider configuration uses an environment lease and rejects inline credentials', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-provider-config-'));
  try {
    const input = {
      model_provider: 'fixture', model: 'fixture-model', model_reasoning_effort: 'low',
      model_providers: { fixture: { name: 'Fixture', base_url: 'https://example.invalid/v1', wire_api: 'responses', requires_openai_auth: false } }
    };
    const isolated = isolateProviderConfiguration(input);
    assert.equal(isolated.disable_response_storage, true);
    assert.equal(isolated.model_providers.fixture.env_key, 'OPENAI_API_KEY');
    const written = writeIsolatedProviderConfiguration(home, input);
    const contents = fs.readFileSync(path.join(home, written.file), 'utf8');
    assert.match(contents, /env_key\s*=\s*"OPENAI_API_KEY"/);
    assert.doesNotMatch(contents, /(?:token|secret|authorization)/i);
    assert.throws(() => isolateProviderConfiguration({
      model_provider: 'fixture',
      model_providers: { fixture: { base_url: 'https://example.invalid/v1', experimental_bearer_token: 'fixture-provider-proof-value-12345' } }
    }), (error) => error.code === 'provider_config_invalid');
    assert.throws(() => isolateProviderConfiguration({
      model_provider: 'fixture', model_providers: { fixture: { base_url: 'https://user:proof@example.invalid/v1' } }
    }), (error) => error.code === 'provider_config_invalid');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isolated provider configuration supplies a name for discovered providers that omit one', () => {
  const isolated = isolateProviderConfiguration({
    model_provider: 'custom',
    model: 'gpt-5.6-sol',
    model_providers: { custom: { base_url: 'https://example.invalid/v1', wire_api: 'responses', requires_openai_auth: true } }
  });
  assert.equal(isolated.model_providers.custom.name, 'custom');
});

test('process adapter does not inherit parent session or provider credentials', () => {
  const adapter = new ProcessAppServerAdapter({
    command: 'fixture-provider-command',
    env: {
      PATH: 'fixture-path', SYSTEMROOT: 'fixture-system-root', JAVA_HOME: 'fixture-java-home',
      OPENAI_API_KEY: 'fixture-provider-proof-value-12345',
      AIWS_P5_PROVIDER_CREDENTIAL: 'fixture-explicit-proof-value-12345',
      RELAYTERM_TOKEN: 'fixture-session-proof-value-12345',
      UNCLASSIFIED_PARENT_VALUE: 'must-not-pass'
    }
  });
  assert.deepEqual(adapter.env, { PATH: 'fixture-path', SYSTEMROOT: 'fixture-system-root', JAVA_HOME: 'fixture-java-home' });
  assert.deepEqual(adapter.args, ['--disable', 'plugins', '--disable', 'remote_plugin', 'app-server', '--stdio']);
});

test('process provider request failures preserve diagnostic RPC fields without credentials', () => {
  const error = providerRequestFailure({ code: 'invalid_request', type: 'protocol_error', message: 'bad request with sk_live_fixture_12345678' }, 'turn/start');
  assert.equal(error.code, 'provider_request_failed');
  assert.equal(error.details.provider_code, 'invalid_request');
  assert.equal(error.details.provider_error_type, 'protocol_error');
  assert.equal(error.details.rpc_method, 'turn/start');
  assert.doesNotMatch(JSON.stringify(error.details), /sk_live_fixture/);
  assert.doesNotMatch(error.message, /sk_live_fixture/);
});

test('redaction failures expose only bounded field reasons', async () => {
  const { open, close } = await import('./helpers.mjs');
  const state = await open();
  try {
    const error = new Error('payload contains a restricted value');
    error.code = 'redaction_blocked';
    error.details = { redactions: [{ path: '$.candidate.prompt', reason: 'restricted_field', value: 'secret-value' }] };
    const failed = await state.runtime.operations.create({ actorId: state.principal.actorId, commandId: 'p5.redaction-diagnostics', resourceType: 'fixture', resourceId: 'fixture', requestHash: 'a'.repeat(64), idempotencyKey: 'p5-redaction-diagnostics', status: 'accepted' });
    await state.runtime.operations.run(failed.operation_id, async () => { throw error; });
    const operation = state.runtime.operations.get(failed.operation_id, { actorId: state.principal.actorId });
    assert.equal(operation.error_code, 'redaction_blocked');
    assert.deepEqual(operation.error_details.redaction_reasons, [{ path: '$.candidate.prompt', reason: 'restricted_field' }]);
    assert.equal(Object.hasOwn(operation.error_details.redaction_reasons[0], 'value'), false);
  } finally { await close(state); }
});

test('isolated provider cleanup removes read-only Git pack files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-provider-cleanup-'));
  const pack = path.join(home, '.tmp', 'plugins-clone-fixture', '.git', 'objects', 'pack', 'fixture.pack');
  fs.mkdirSync(path.dirname(pack), { recursive: true });
  fs.writeFileSync(pack, 'fixture');
  fs.chmodSync(pack, 0o400);
  await removeIsolatedProviderTree(home);
  assert.equal(fs.existsSync(home), false);
});

test('Codex login credential is leased into a zeroable Buffer and host inline auth is not copied', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-provider-lease-'));
  try {
    const proof = 'fixture-provider-proof-value-12345';
    fs.writeFileSync(path.join(home, 'auth.json'), `${JSON.stringify({ OPENAI_API_KEY: proof })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'config.toml'), stringifyToml({
      model_provider: 'fixture', model: 'fixture-model',
      model_providers: { fixture: { name: 'Fixture', base_url: 'https://example.invalid/v1', wire_api: 'responses', requires_openai_auth: false, experimental_bearer_token: proof } }
    }), { mode: 0o600 });
    const lease = acquireProviderCredentialLease({ env: {}, codexHome: home });
    const bytes = lease.bytes;
    assert.equal(lease.source, 'codex_login');
    assert.equal(bytes.toString('utf8'), proof);
    const config = loadCodexProviderConfiguration({ env: {}, codexHome: home });
    assert.equal(config.model_providers.fixture.env_key, 'OPENAI_API_KEY');
    assert.doesNotMatch(JSON.stringify(config), /fixture-provider-proof-value/);
    lease.release();
    assert.equal(lease.released, true);
    assert.ok(bytes.every((value) => value === 0));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('real turn validation requires contiguous events, an assistant response and terminal tools', () => {
  const valid = validateCompletedProviderTurn({ turn_id: 'turn_fixture', events: [
    { sequence: 1, method: 'turn/started', params: { turn_id: 'turn_fixture' } },
    { sequence: 2, method: 'item/started', params: { item_id: 'tool_fixture', kind: 'tool_call' } },
    { sequence: 3, method: 'item/completed', params: { item_id: 'tool_fixture', role: 'tool', terminal: true } },
    { sequence: 4, method: 'item/completed', params: { item_id: 'assistant_fixture', role: 'assistant', terminal: true, content: 'P5_PROBE_OK' } },
    { sequence: 5, method: 'turn/completed', params: { turn_id: 'turn_fixture' } }
  ] });
  assert.equal(valid.valid, true);
  assert.equal(valid.tool_calls_terminal, true);

  const incomplete = validateCompletedProviderTurn({ turn_id: 'turn_fixture', events: [
    { sequence: 2, method: 'turn/started', params: {} },
    { sequence: 3, method: 'item/started', params: { item_id: 'tool_fixture', kind: 'tool_call' } }
  ] });
  assert.equal(incomplete.valid, false);
  assert.ok(incomplete.failures.includes('event_sequence_not_contiguous'));
  assert.ok(incomplete.failures.includes('assistant_item_missing'));
  assert.ok(incomplete.failures.includes('terminal_notification_missing'));
  assert.ok(incomplete.failures.includes('tool_call_not_terminal'));
});

test('P5 receipt validation rejects a skipped or provisional provider turn', () => {
  const finalReceipt = {
    schema_version: 'aiws.v3-clean.p5-assist-probe-record.v1', status: 'passed',
    receipt: {
      schema_version: 'aiws.v3-clean.p5-assist-probe.v1', status: 'passed', provisional: false,
      adapter: 'process-app-server', isolated_codex_home: true, thread_started: true,
      model_turn: 'completed', credential_lease: 'memory_only_zeroed', provider_latency_ms: 1,
      real_turn: { valid: true, sequence_contiguous: true, terminal_notification: true, assistant_item: true, assistant_response_contract: true, tool_calls_terminal: true }
    }
  };
  assert.deepEqual(validateP5AssistProbeReceipt(finalReceipt), []);
  const skipped = structuredClone(finalReceipt);
  skipped.receipt.status = 'candidate';
  skipped.receipt.provisional = true;
  skipped.receipt.model_turn = 'not_completed';
  skipped.receipt.real_turn = null;
  const failures = validateP5AssistProbeReceipt(skipped);
  assert.ok(failures.includes('receipt_not_final'));
  assert.ok(failures.includes('real_turn_missing'));
  assert.ok(failures.includes('turn_invariants'));
});

test('Assist passes the bound profile configuration without retaining credential bytes', async () => {
  class CapturingAdapter extends DeterministicAppServerAdapter {
    async startThread(input) {
      this.providerConfig = structuredClone(input.provider_config);
      this.credentialWasBuffer = Buffer.isBuffer(input.credential);
      return super.startThread(input);
    }
  }
  const adapter = new CapturingAdapter();
  const state = await open({ providerAdapter: adapter });
  try {
    const project = await createProject(state, 'provider-config');
    const config = {
      model_provider: 'fixture', model: 'fixture-model',
      model_providers: { fixture: { name: 'Fixture', base_url: 'https://example.invalid/v1', wire_api: 'responses', requires_openai_auth: false } }
    };
    const { pack, profile } = await createAssistPrerequisites(state, project, 'provider-config', config);
    await state.runtime.assist.createSession({
      project_id: project.id, scope: 'project', scope_id: project.id,
      context_pack_id: pack.id, profile_id: profile.id,
      idempotency_key: 'p5-provider-config-session-key'
    }, state.principal);
    assert.deepEqual(adapter.providerConfig, config);
    assert.equal(adapter.credentialWasBuffer, true);
    assert.equal(Object.hasOwn(adapter, 'credential'), false);
  } finally {
    await close(state);
  }
});
