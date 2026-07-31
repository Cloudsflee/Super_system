import { protocolHash } from '../../../packages/execution-protocol/src/index.mjs';
import { HttpError } from './http.mjs';

export function runnerPreflightInState(
  state,
  { taskExecution, node, contract, runner = 'codex_docker', testAdapter = false, env = process.env } = {}
) {
  if (!taskExecution || !node || !contract) throw new HttpError(409, { error: 'runner_preflight_scope_missing' });
  const image = env.AIWS_CODEX_DOCKER_IMAGE || activeProfile(state)?.image || 'aiws-codex-runner:2.2.0-codex-0.144.0',
    proxy = proxyCaseStatus(env),
    checks = [
      check('runner_image', Boolean(image), { image }),
      check('executor', ['assist', 'repository_change'].includes(taskExecution.executor), {
        executor: taskExecution.executor
      }),
      check('tools', requiredToolsAvailable(state, contract), {
        required: contract.allowed_tools || []
      }),
      check('git', gitReady(taskExecution), {
        repository_sha: taskExecution.context_snapshot?.repository_snapshot?.fixed_sha || null
      }),
      check('dns', testAdapter || networkCapability(state, 'dns') !== false, { configured: true }),
      check('https', testAdapter || networkCapability(state, 'https') !== false, { configured: true }),
      check('proxy_case', proxy.consistent, proxy),
      check('verifier', verifierAvailable(state, node), { required: deploymentLike(node) }),
      check('browser', !deploymentLike(node) || browserAvailable(state) || testAdapter, {
        required: deploymentLike(node)
      })
    ],
    failures = checks.filter((item) => !item.passed),
    result = {
      schema_version: 'aiws.runner_preflight.v1',
      runner,
      image,
      image_digest: image,
      checks,
      proxy: {
        http_proxy_set: proxy.http_proxy_set,
        https_proxy_set: proxy.https_proxy_set,
        all_proxy_set: proxy.all_proxy_set,
        no_proxy_set: proxy.no_proxy_set,
        consistent: proxy.consistent
      },
      sanitized: true,
      fingerprint: null,
      passed: failures.length === 0
    };
  result.fingerprint = protocolHash(result);
  if (failures.length)
    throw new HttpError(409, {
      error: 'runner_preflight_failed',
      phase: 'preflight',
      retryable: failures.some((item) => ['dns', 'https'].includes(item.name)),
      failed_checks: failures.map((item) => item.name),
      preflight: result
    });
  return result;
}

function check(name, passed, details = {}) {
  return { name, passed: Boolean(passed), details: sanitizeDetails(details) };
}

function requiredToolsAvailable(state, contract) {
  return (contract.allowed_tools || []).every((required) =>
    (state.tools || []).some(
      (tool) =>
        tool.enabled !== false &&
        tool.health_status !== 'unavailable' &&
        (tool.id === required || tool.name === required || (tool.capabilities || []).includes(required))
    )
  );
}

function gitReady(execution) {
  const snapshot = execution.context_snapshot?.repository_snapshot;
  return !snapshot || /^[a-f0-9]{40,64}$/.test(String(snapshot.fixed_sha || snapshot.head_sha || ''));
}

function networkCapability(state, capability) {
  const status = (state.integration_statuses || []).find((item) => item.key === 'codex_probe');
  return status?.capabilities?.network?.[capability];
}

function verifierAvailable(state, node) {
  if (!deploymentLike(node)) return true;
  const status = (state.integration_statuses || []).find((item) => item.key === 'deployment_runtime_verifier');
  return status ? !['failed', 'unavailable'].includes(status.status) : true;
}

function browserAvailable(state) {
  const status = (state.integration_statuses || []).find((item) =>
    ['browser', 'chromium', 'deployment_runtime_verifier'].includes(item.key)
  );
  return status ? !['failed', 'unavailable'].includes(status.status) : true;
}

function deploymentLike(node) {
  return /deploy|web|frontend|release/i.test(`${node.task_kind || ''} ${node.title || ''}`);
}

function activeProfile(state) {
  return (state.codex_profiles || []).find((item) => item.is_active) || (state.codex_profiles || [])[0] || null;
}

function proxyCaseStatus(env) {
  const pairs = [
    ['HTTP_PROXY', 'http_proxy'],
    ['HTTPS_PROXY', 'https_proxy'],
    ['ALL_PROXY', 'all_proxy'],
    ['NO_PROXY', 'no_proxy']
  ];
  const presence = Object.fromEntries(
    pairs.map(([upper, lower]) => [`${lower}_set`, Boolean(env[upper] || env[lower])])
  );
  return {
    ...presence,
    consistent: pairs.every(([upper, lower]) => !env[upper] || !env[lower] || env[upper] === env[lower])
  };
}

function sanitizeDetails(value) {
  return JSON.parse(
    JSON.stringify(value, (key, item) =>
      /proxy|token|secret|password|cookie|authorization/i.test(key) && typeof item === 'string' ? '[REDACTED]' : item
    )
  );
}
