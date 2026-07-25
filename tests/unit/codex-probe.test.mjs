import assert from 'node:assert/strict';
import {
  CODEX_PROBE_PHASES,
  classifyCodexExecution,
  completeCodexProbe,
  createCodexPreflight,
  inspectCodexBinding,
  inspectCodexConfig,
  inspectCodexRuntime,
  probeFailure
} from '../../apps/api/src/codex-probe.mjs';

const profile = {
  id: 'profile-unit',
  kind: 'docker',
  provider: 'custom',
  provider_name: 'Unit Provider',
  base_url: 'https://unit.invalid/v1',
  wire_api: 'responses',
  requires_openai_auth: false,
  model: 'unit/model'
};
const auth = {
  status: 'authenticated',
  provider: 'custom',
  base_url: 'https://unit.invalid/v1',
  wire_api: 'responses',
  auth_mode: 'api_key',
  refs: { credential: 'vault-unit' }
};
const config = `model = "unit/model"
model_provider = "custom"

[model_providers.custom]
name = "Unit Provider"
base_url = "https://unit.invalid/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "OPENAI_API_KEY"
`;

assert.deepEqual(CODEX_PROBE_PHASES, [
  'configuration',
  'runtime',
  'binding',
  'transport',
  'protocol',
  'model',
  'inference'
]);
assert.equal(inspectCodexConfig(profile, config).ok, true);
assert.equal(inspectCodexConfig(profile, 'not = [toml').error_code, 'codex_probe_config_invalid');
assert.equal(
  inspectCodexConfig(profile, config.replace('unit/model', 'wrong/model')).error_code,
  'codex_probe_config_profile_mismatch'
);
assert.equal(
  inspectCodexConfig(profile, config.replace('requires_openai_auth = false', 'requires_openai_auth = true')).error_code,
  'codex_probe_config_profile_mismatch'
);
assert.equal(
  inspectCodexConfig(
    { ...profile, requires_openai_auth: true },
    config.replace('requires_openai_auth = false', 'requires_openai_auth = true')
  ).ok,
  true
);
assert.equal(
  inspectCodexConfig(
    { ...profile, requires_openai_auth: true },
    config.replace('requires_openai_auth = false\nenv_key = "OPENAI_API_KEY"', 'requires_openai_auth = true')
  ).error_code,
  'codex_probe_config_profile_mismatch'
);
assert.equal(
  inspectCodexConfig({ provider: 'openai', model: 'unit/model' }, config).error_code,
  'codex_probe_config_profile_mismatch'
);
assert.equal(inspectCodexRuntime(profile, { ok: false }, { ok: true }).error_code, 'codex_probe_docker_unavailable');
assert.equal(inspectCodexRuntime(profile, { ok: true }, { ok: false }).error_code, 'codex_probe_image_missing');
assert.equal(
  inspectCodexBinding(profile, { ...auth, base_url: 'https://other.invalid/v1' }).error_code,
  'codex_probe_auth_endpoint_mismatch'
);
assert.equal(inspectCodexBinding(profile, { ...auth, refs: {} }).error_code, 'codex_probe_credential_unavailable');
const officialProfile = { id: 'official-profile', kind: 'docker', provider: 'openai', model: 'gpt-test' };
assert.equal(
  inspectCodexBinding(officialProfile, {
    status: 'authenticated',
    provider: 'chatgpt',
    auth_mode: 'local_codex',
    home: '/managed/auth-home',
    refs: { auth_bundle: 'vault:bundle' }
  }).ok,
  true
);
assert.equal(
  inspectCodexBinding(officialProfile, {
    status: 'authenticated',
    provider: 'openai',
    auth_mode: 'local_codex',
    refs: {}
  }).error_code,
  'codex_probe_credential_unavailable'
);

const preflight = createCodexPreflight({
  profile,
  auth,
  configText: config,
  dockerInfo: { ok: true },
  imageInspect: { ok: true }
});
assert.equal(preflight.ok, true);
assert.deepEqual(
  preflight.checks.map((item) => `${item.phase}:${item.status}`),
  ['configuration:passed', 'runtime:passed', 'binding:passed']
);
const stoppedDocker = createCodexPreflight({
  profile,
  auth,
  configText: config,
  dockerInfo: { ok: false },
  imageInspect: { ok: false }
});
assert.equal(stoppedDocker.error_code, 'codex_probe_docker_unavailable');
assert.match(stoppedDocker.action, /Docker Desktop/);
assert.deepEqual(
  stoppedDocker.checks.map((item) => `${item.phase}:${item.status}`),
  [
    'configuration:passed',
    'runtime:failed',
    'binding:pending',
    'transport:pending',
    'protocol:pending',
    'model:pending',
    'inference:pending'
  ]
);

for (const [diagnostic, expected] of [
  [
    'failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; is the docker daemon running?',
    'codex_probe_docker_unavailable'
  ],
  ['error: ENOTFOUND provider.unit', 'codex_probe_endpoint_dns_failed'],
  ['invalid peer certificate: UnknownIssuer', 'codex_probe_endpoint_tls_failed'],
  ['401 Unauthorized: Incorrect API key sk-secret-sentinel', 'codex_probe_auth_rejected'],
  ['404 Not Found for POST /v1/responses', 'codex_probe_responses_route_not_found'],
  ['model_not_found: unit/model does not exist', 'codex_probe_model_not_found'],
  ['429 Too Many Requests rate_limit_exceeded', 'codex_probe_rate_limited'],
  ['503 Service Unavailable from upstream', 'codex_probe_upstream_unavailable']
]) {
  const result = classifyCodexExecution({ ok: false, code: 1 }, { diagnostic });
  assert.equal(result.error_code, expected, diagnostic);
  assert.doesNotMatch(JSON.stringify(result), /sk-secret-sentinel|provider\.unit|unit\/model/);
}

const markerMissing = classifyCodexExecution({ ok: true, code: 0 }, { markerFound: false });
assert.equal(markerMissing.error_code, 'codex_probe_response_marker_missing');
const timedOut = completeCodexProbe(preflight, classifyCodexExecution({ ok: false, code: null, timed_out: true }));
assert.equal(timedOut.error_code, 'codex_probe_timeout');
assert.deepEqual(
  timedOut.checks.map((item) => `${item.phase}:${item.status}`),
  [
    'configuration:passed',
    'runtime:passed',
    'binding:passed',
    'transport:pending',
    'protocol:pending',
    'model:pending',
    'inference:failed'
  ]
);
assert.equal(
  classifyCodexExecution({ ok: true, code: 0 }, { markerFound: true, diagnostic: 'old retry logged 401 timeout' }).ok,
  true
);
const execution = classifyCodexExecution({ ok: true, code: 0 }, { markerFound: true });
const completed = completeCodexProbe(preflight, execution);
assert.equal(completed.ok, true);
assert.deepEqual(
  completed.checks.map((item) => item.phase),
  CODEX_PROBE_PHASES
);
const modelFailure = completeCodexProbe(
  preflight,
  classifyCodexExecution({ ok: false, code: 1 }, { diagnostic: 'model_not_found' })
);
assert.deepEqual(
  modelFailure.checks.map((item) => `${item.phase}:${item.status}`),
  [
    'configuration:passed',
    'runtime:passed',
    'binding:passed',
    'transport:passed',
    'protocol:passed',
    'model:failed',
    'inference:pending'
  ]
);

const unknown = probeFailure('unknown-with-secret', {
  diagnostic: 'sk-secret-sentinel',
  process: { code: 9, stderr: 'sk-secret-sentinel' }
});
assert.equal(unknown.error_code, 'codex_probe_request_failed');
assert.deepEqual(unknown.process, { exit_code: 9, timed_out: false });
assert.doesNotMatch(JSON.stringify(unknown), /secret-sentinel|stderr|diagnostic/);

console.log('Codex layered probe unit tests passed');
