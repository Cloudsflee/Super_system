import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXECUTION_DIR } from './config.mjs';
import { buildCodexContainerInvocation } from './container-runtime-config.mjs';
import { runContainerProcess } from './container-runtime.mjs';
import { HttpError } from './http.mjs';
import {
  DEPLOYMENT_EVIDENCE_SCHEMA,
  parseDeploymentEvidenceV2
} from '../../../packages/execution-protocol/src/index.mjs';

export const DEPLOYMENT_RUNTIME_VERIFIER = 'deployment_runtime_verifier';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_PATH = /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]+\/?)*$/;
const SAFE_COMPOSE_FILE = /^(?:(?:[A-Za-z0-9._-]+)\/)*(?:compose|docker-compose)\.ya?ml$/i;
const IMAGE_PATH = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASELINE_SECURITY_HEADERS = Object.freeze([
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy'
]);
const COOP_HOST_GATEWAY_MESSAGE =
  "The Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was untrustworthy. It was defined either in the final response or a redirect. Please deliver the response using the HTTPS protocol. You can also use the 'localhost' origin instead. See https://www.w3.org/TR/powerful-features/#potentially-trustworthy-origin and https://html.spec.whatwg.org/#the-cross-origin-opener-policy-header.";
const RUNTIME_SOURCE = fileURLToPath(new URL('./deployment-browser-runtime.mjs', import.meta.url));

export async function verifyDeploymentNodeRun(
  state,
  { run, taskExecution, resultJson },
  { processRunner = runContainerProcess, env = process.env } = {}
) {
  const request = deploymentVerificationRequest(state, { run, taskExecution, resultJson });
  if (!request) return null;
  request.compose_authorization = await authorizeComposeTarget(request, taskExecution, processRunner);
  if (!SAFE_RUN_ID.test(String(run.id || '')))
    throw new HttpError(409, { error: 'deployment_runtime_verifier_run_id_invalid' });
  const root = path.join(EXECUTION_DIR, 'deployment-verifiers');
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fsp.mkdtemp(path.join(root, `${run.id}-`));
  try {
    await fsp.mkdir(path.join(directory, 'screenshots'), { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(directory, 'request.json'), `${JSON.stringify(request, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await fsp.copyFile(RUNTIME_SOURCE, path.join(directory, 'runtime.mjs'));
    const invocation = buildCodexContainerInvocation({
      env,
      kind: 'deployment-verify',
      sessionId: run.id,
      image: env.AIWS_CODEX_DOCKER_IMAGE,
      entrypoint: 'node',
      internalMounts: [{ source: directory, target: '/aiws-verify', mode: 'rw' }],
      containerEnv: {
        AIWS_BROWSER_EXECUTABLE: '/usr/bin/chromium-browser',
        HOME: '/tmp/aiws-browser-home',
        XDG_CONFIG_HOME: '/tmp/aiws-browser-home/.config',
        XDG_CACHE_HOME: '/tmp/aiws-browser-home/.cache'
      },
      commandArgs: ['/aiws-verify/runtime.mjs']
    });
    const execution = await runRequiredProcess(
      processRunner,
      invocation,
      { timeoutMs: 180_000, env: {} },
      'deployment_runtime_verification_unavailable'
    );
    let report;
    try {
      report = await readReport(directory);
    } catch (error) {
      if (Number(execution?.code) === 0) throw error;
      throw unavailableError('deployment_runtime_verification_unavailable');
    }
    assertDeploymentVerificationReport(report, request);
    if (Number(execution?.code) !== 0)
      throw new HttpError(409, {
        error: 'deployment_runtime_verification_failed',
        failures: report.failures,
        verifier_exit_code: execution?.code ?? null
      });
    const files = await verificationFiles(directory, report);
    const entries = files.map((file) => ({
      path: file.path,
      role: file.role,
      media_type: file.media_type,
      sha256: digest(file.content),
      size_bytes: file.content.length
    }));
    const reportEntry = entries.find((item) => item.path === 'deployment-verification.json');
    const receipt = {
      schema_version: 'aiws.deployment_runtime_receipt.v1',
      verifier: DEPLOYMENT_RUNTIME_VERIFIER,
      node_run_id: run.id,
      raw_output_file_ref_id: run.raw_output_file_ref_id,
      task_execution_id: taskExecution.id,
      repository_sha: request.repository_sha,
      target: request.base_url,
      compose_authorization: request.compose_authorization,
      required_viewports: request.viewports,
      report_sha256: reportEntry.sha256,
      entries,
      verified_at: report.completed_at
    };
    const deploymentEvidence = parseDeploymentEvidenceV2({
      schema_version: DEPLOYMENT_EVIDENCE_SCHEMA,
      target: {
        kind: 'compose',
        origin: request.base_url,
        repository_sha: request.repository_sha
      },
      http_checks: report.endpoints.map((endpoint) => ({
        method: 'GET',
        url: new URL(endpoint.path, request.base_url).toString(),
        status: endpoint.status,
        passed: endpoint.status === endpoint.expected_status,
        content_type: endpoint.headers?.['content-type'] || null,
        body_sha256: endpoint.sha256 || null
      })),
      compose_services: [
        {
          name: request.compose_authorization.service,
          image: `compose-config:${request.compose_authorization.compose_config_sha256}`,
          digest: request.compose_authorization.compose_config_sha256,
          published_ports: [
            `127.0.0.1:${request.compose_authorization.published_port}:${request.compose_authorization.target_port}`
          ]
        }
      ],
      static_assets: report.images.map((asset) => ({
        path: asset.path,
        media_type: asset.media_type,
        sha256: asset.sha256,
        size_bytes: asset.size_bytes
      })),
      security_headers: Object.fromEntries(
        request.security_headers
          .map((header) => [header, report.endpoints.find((endpoint) => endpoint.headers?.[header])?.headers?.[header]])
          .filter(([, value]) => typeof value === 'string' && value)
      ),
      evidence_refs: [`node-run:${run.id}`, `file-ref:${run.raw_output_file_ref_id}`, `sha256:${reportEntry.sha256}`],
      collected_at: report.completed_at,
      collector_version: 'deployment_runtime_verifier.v2'
    });
    const v21 = Number(state.schema_version || 0) >= 21;
    return {
      verifierId: DEPLOYMENT_RUNTIME_VERIFIER,
      evidence: {
        deployment_evidence: deploymentEvidence,
        deployment_verification: receipt,
        deployment_payload: {
          payload_kind: 'file_set',
          media_type: 'application/vnd.aiws.deployment-evidence+json',
          metadata: {
            schema_version: v21 ? deploymentEvidence.schema_version : receipt.schema_version,
            verifier: receipt.verifier
          },
          files
        },
        evidence_refs: [
          `node-run:${run.id}`,
          `file-ref:${run.raw_output_file_ref_id}`,
          `sha256:${receipt.report_sha256}`
        ]
      }
    };
  } finally {
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function deploymentVerificationRequest(state, { run, taskExecution, resultJson }) {
  const task = state.workflow_nodes.find((item) => item.id === taskExecution?.task_id && item.role === 'task'),
    contract = state.node_contracts.find((item) => item.id === taskExecution?.contract_id),
    slots = (contract?.expected_outputs || []).filter((item) => item.confirmation_policy === 'system_evidence');
  if (taskExecution?.executor !== 'assist' || task?.task_kind !== 'deploy' || !slots.length) return null;
  if (slots.length !== 1 || slots.some((item) => !/DeliveryEvidence/i.test(item.asset_type)))
    throw new HttpError(409, { error: 'deployment_runtime_verifier_output_unsupported' });
  if (run?.runner !== 'codex_docker' || !run.raw_output_file_ref_id)
    throw new HttpError(409, { error: 'deployment_runtime_verifier_runner_required' });
  if (
    resultJson?.status !== 'succeeded' ||
    Number(resultJson?._codex_process?.code) !== 0 ||
    resultJson?._codex_process?.failure_code
  )
    throw new HttpError(409, { error: 'deployment_runtime_verifier_process_invalid' });
  const snapshot = taskExecution.context_snapshot?.repository_snapshot,
    repositorySha = snapshot?.fixed_sha;
  if (!SHA40.test(String(repositorySha || '')))
    throw new HttpError(409, { error: 'deployment_runtime_verifier_repository_sha_required' });
  const candidates = slots.map((slot) => {
    const output = (resultJson.outputs || []).find((item) => item.output_key === slot.key);
    if (!output || output.asset_type !== slot.asset_type)
      throw new HttpError(409, { error: 'deployment_runtime_verifier_output_missing', output_key: slot.key });
    return parseCandidate(output.payload?.content);
  });
  const candidate = candidates[0];
  if (candidate.run_id !== run.id || candidate.repository_sha !== repositorySha)
    throw new HttpError(409, { error: 'deployment_runtime_verifier_candidate_binding_invalid' });
  const baseUrl = deploymentBaseUrl(candidate),
    viewports = requiredViewports(contract);
  if (!viewports.length) throw new HttpError(409, { error: 'deployment_runtime_verifier_viewports_required' });
  if (!Array.isArray(candidate.browser?.viewports))
    throw new HttpError(409, { error: 'deployment_runtime_verifier_viewport_claim_invalid' });
  const claimedViewports = new Set(candidate.browser.viewports.map((item) => Number(item.width)));
  if (viewports.some((width) => !claimedViewports.has(width)))
    throw new HttpError(409, { error: 'deployment_runtime_verifier_viewport_claim_missing' });
  const endpoints = deploymentEndpoints(candidate);
  if (!endpoints.some((item) => item.path === '/healthz'))
    throw new HttpError(409, { error: 'deployment_runtime_verifier_health_endpoint_required' });
  const securityHeaders = deploymentSecurityHeaders(candidate);
  const images = deploymentImages(candidate);
  if (/图像|images?/i.test(criteriaText(contract)) && !images.length)
    throw new HttpError(409, { error: 'deployment_runtime_verifier_image_claim_required' });
  return {
    schema_version: 'aiws.deployment_runtime_request.v1',
    node_run_id: run.id,
    repository_sha: repositorySha,
    base_url: baseUrl,
    compose_file: deploymentComposeFile(candidate),
    health_path: '/healthz',
    health_status: 200,
    endpoints,
    security_headers: securityHeaders,
    images,
    viewports,
    schedule_time: requiredScheduleTime(contract),
    time_zone: 'Asia/Shanghai',
    request_timeout_ms: 15_000,
    maximum_endpoint_ms: 5_000,
    maximum_page_load_ms: 5_000
  };
}

export function assertDeploymentVerificationReport(report, request) {
  if (!report || report.schema_version !== 'aiws.deployment_runtime_verification.v1')
    throw new HttpError(409, { error: 'deployment_runtime_verification_report_invalid' });
  if (
    report.verifier !== DEPLOYMENT_RUNTIME_VERIFIER ||
    report.node_run_id !== request.node_run_id ||
    report.repository_sha !== request.repository_sha ||
    report.target !== request.base_url
  )
    throw new HttpError(409, { error: 'deployment_runtime_verification_report_binding_invalid' });
  if (!Array.isArray(report.failures) || report.failures.some((item) => typeof item !== 'string'))
    throw new HttpError(409, { error: 'deployment_runtime_verification_report_invalid' });
  const failures = [...report.failures];
  appendReportTimingFailures(report, failures);
  appendHealthFailures(report, request, failures);
  appendEndpointFailures(report, request, failures);
  appendSecurityFailures(report, request, failures);
  appendImageFailures(report, request, failures);
  appendScheduleFailures(report, request, failures);
  appendViewportFailures(report, request, failures);
  if (report.ok !== true || failures.length)
    throw new HttpError(409, { error: 'deployment_runtime_verification_failed', failures: [...new Set(failures)] });
  return true;
}

function appendReportTimingFailures(report, failures) {
  const startedAt = Date.parse(report.started_at),
    completedAt = Date.parse(report.completed_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt)
    failures.push('report:timestamps');
}

function appendHealthFailures(report, request, failures) {
  const health = report.health;
  if (
    health?.path !== request.health_path ||
    health.status !== request.health_status ||
    health.json?.status !== 'ok' ||
    health.json?.storageWritable !== true
  )
    failures.push('health:invalid');
}

function appendEndpointFailures(report, request, failures) {
  const endpoints = uniqueBy(report.endpoints, (item) => item?.path, failures, 'endpoints');
  if (endpoints.size !== request.endpoints.length) failures.push('endpoints:unexpected_count');
  for (const expected of request.endpoints) {
    const actual = endpoints.get(expected.path);
    if (
      !actual ||
      actual.expected_status !== expected.expected_status ||
      actual.status !== expected.expected_status ||
      !withinBudget(actual.elapsed_ms, request.maximum_endpoint_ms)
    )
      failures.push(`endpoint:${expected.path}:invalid`);
  }
}

function appendSecurityFailures(report, request, failures) {
  const security = uniqueBy(report.security, (item) => item?.path, failures, 'security');
  if (security.size !== request.endpoints.length) failures.push('security:unexpected_count');
  for (const endpoint of request.endpoints) {
    const actual = security.get(endpoint.path);
    if (!actual || !Array.isArray(actual.missing) || actual.missing.length)
      failures.push(`security:${endpoint.path}:invalid`);
  }
}

function appendImageFailures(report, request, failures) {
  const images = uniqueBy(report.images, (item) => item?.path, failures, 'images');
  if (images.size !== request.images.length) failures.push('images:unexpected_count');
  for (const image of request.images) {
    const actual = images.get(image.path);
    if (!validVerifiedImage(actual)) failures.push(`image:${image.path}:invalid`);
  }
}

function validVerifiedImage(image) {
  return Boolean(
    image &&
    image.ok === true &&
    image.status === 200 &&
    image.media_type === image.detected_type &&
    SHA256.test(String(image.sha256 || '')) &&
    Number.isInteger(image.size_bytes) &&
    image.size_bytes > 0
  );
}

function appendScheduleFailures(report, request, failures) {
  if (
    request.schedule_time &&
    (report.schedule?.ok !== true ||
      report.schedule.local_time !== request.schedule_time ||
      report.schedule.expected_local_time !== request.schedule_time ||
      report.schedule.time_zone !== request.time_zone)
  )
    failures.push('schedule:invalid');
}

function appendViewportFailures(report, request, failures) {
  const viewportSource = report.browser?.viewports;
  const actual = uniqueBy(viewportSource, (item) => Number(item?.width), failures, 'viewports');
  if (actual.size !== request.viewports.length) failures.push('viewports:unexpected_count');
  for (const width of request.viewports) {
    const viewport = actual.get(width);
    if (!viewport) failures.push(`viewport:${width}:missing`);
    else if (!validVerifiedViewport(viewport, width, request)) failures.push(`viewport:${width}:invalid`);
  }
}

function validVerifiedViewport(viewport, width, request) {
  return (
    viewport.screenshot_path === `screenshots/${width}.png` &&
    SHA256.test(String(viewport.screenshot_sha256 || '')) &&
    Number.isInteger(viewport.screenshot_size_bytes) &&
    viewport.screenshot_size_bytes > 8 &&
    withinBudget(viewport.elapsed_ms, request.maximum_page_load_ms) &&
    Number(viewport.document_overflow) === 0 &&
    emptyArray(viewport.horizontal_violations) &&
    emptyArray(viewport.overlap_violations) &&
    emptyArray(viewport.console_errors) &&
    validIgnoredConsoleMessages(viewport.ignored_console_messages, request.base_url) &&
    emptyArray(viewport.page_errors) &&
    emptyArray(viewport.failed_responses) &&
    validBrowserImages(viewport.images)
  );
}

function validIgnoredConsoleMessages(messages, baseUrl) {
  return Array.isArray(messages) && messages.every((item) => allowedIgnoredConsoleMessage(item, baseUrl));
}

function validBrowserImages(images) {
  return (
    Array.isArray(images) &&
    images.every((item) => item?.complete === true && Number(item.natural_width) > 0 && Number(item.natural_height) > 0)
  );
}

function parseCandidate(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new HttpError(409, { error: 'deployment_runtime_verifier_candidate_json_invalid' });
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new HttpError(409, { error: 'deployment_runtime_verifier_candidate_invalid' });
  return parsed;
}

function deploymentBaseUrl(candidate) {
  const value = candidate.target?.base_url || candidate.compose?.host_url;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(409, { error: 'deployment_runtime_verifier_target_invalid' });
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.hostname !== 'host.docker.internal' ||
    !parsed.port ||
    Number(parsed.port) < 1 ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !['', '/'].includes(parsed.pathname)
  )
    throw new HttpError(409, { error: 'deployment_runtime_verifier_target_invalid' });
  return `${parsed.protocol}//${parsed.host}`;
}

function deploymentComposeFile(candidate) {
  const declared = String(candidate.compose?.file || candidate.compose?.derived_from || ''),
    value = declared.startsWith('/workspace/') ? declared.slice('/workspace/'.length) : declared;
  if (!SAFE_COMPOSE_FILE.test(value) || value.split('/').some((segment) => segment === '.' || segment === '..'))
    throw new HttpError(409, { error: 'deployment_runtime_verifier_compose_file_invalid' });
  return value;
}

function deploymentEndpoints(candidate) {
  const source =
    [
      candidate.checks?.endpoints,
      candidate.api?.GET,
      candidate.api?.get,
      candidate.api?.checks,
      candidate.api?.passed
    ].find((value) => Array.isArray(value)) || [];
  const endpoints = [];
  for (const item of source) {
    const method = String(item?.method || 'GET').toUpperCase(),
      path = String(item?.path || '');
    if (method !== 'GET' || !safePath(path)) continue;
    const expected = Number(item.expected_status ?? item.status ?? 200);
    if (!Number.isInteger(expected) || expected < 100 || expected > 599) continue;
    if (!endpoints.some((candidate) => candidate.path === path)) endpoints.push({ path, expected_status: expected });
  }
  return endpoints.slice(0, 50);
}

function deploymentSecurityHeaders(candidate) {
  const source = candidate.checks?.security_headers?.required || candidate.security_headers?.required || [];
  if (!Array.isArray(source) && (!source || typeof source !== 'object'))
    throw new HttpError(409, { error: 'deployment_runtime_verifier_security_claim_invalid' });
  const claims = Array.isArray(source)
    ? source
    : Object.entries(source)
        .filter(([, claim]) => claim !== false && claim?.present !== false && claim?.passed !== false)
        .map(([header]) => header);
  const claimed = new Set(
    claims.map((item) => String(item).trim().toLowerCase()).filter((value) => /^[a-z0-9][a-z0-9-]{0,100}$/.test(value))
  );
  for (const header of BASELINE_SECURITY_HEADERS)
    if (!claimed.has(header))
      throw new HttpError(409, { error: 'deployment_runtime_verifier_security_claim_incomplete', header });
  return [...claimed].sort();
}

function deploymentImages(candidate) {
  const source = candidate.checks?.images || candidate.images?.static_assets || [];
  if (!Array.isArray(source)) throw new HttpError(409, { error: 'deployment_runtime_verifier_image_claim_invalid' });
  return source
    .map((item) => ({
      path: String(typeof item === 'string' ? item : item?.path || ''),
      media_type: String(typeof item === 'string' ? '' : item?.media_type || item?.detected_type || '').toLowerCase()
    }))
    .filter((item) => safePath(item.path))
    .filter((item) => IMAGE_PATH.test(item.path) || item.media_type.startsWith('image/'))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.path === item.path) === index)
    .map((item) => ({ path: item.path }))
    .slice(0, 20);
}

async function authorizeComposeTarget(request, taskExecution, processRunner) {
  const checkout = taskExecution.context_snapshot?.repository_checkout,
    snapshot = taskExecution.context_snapshot?.repository_snapshot;
  if (
    !checkout?.path ||
    checkout.access !== 'read_only' ||
    checkout.expected_head_sha !== request.repository_sha ||
    snapshot?.fixed_sha !== request.repository_sha ||
    snapshot.managed_path !== checkout.path
  )
    throw new HttpError(409, { error: 'deployment_runtime_verifier_checkout_invalid' });
  let checkoutRoot, composePath;
  try {
    checkoutRoot = await fsp.realpath(checkout.path);
    composePath = await fsp.realpath(path.resolve(checkoutRoot, ...request.compose_file.split('/')));
  } catch {
    throw new HttpError(409, { error: 'deployment_runtime_verifier_compose_file_unavailable' });
  }
  const relative = path.relative(checkoutRoot, composePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new HttpError(409, { error: 'deployment_runtime_verifier_compose_file_invalid' });
  const execution = await runRequiredProcess(
    processRunner,
    {
      command: 'docker',
      args: ['compose', '--project-directory', checkoutRoot, '-f', composePath, 'config', '--format', 'json']
    },
    { timeoutMs: 30_000, env: {} },
    'deployment_runtime_verifier_compose_config_unavailable'
  );
  if (Number(execution?.code) !== 0)
    throw new HttpError(409, { error: 'deployment_runtime_verifier_compose_config_unavailable' });
  const raw = String(execution.stdout || '');
  if (!raw || Buffer.byteLength(raw) > 5 * 1024 * 1024)
    throw new HttpError(409, { error: 'deployment_runtime_verifier_compose_config_invalid' });
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new HttpError(409, { error: 'deployment_runtime_verifier_compose_config_invalid' });
  }
  const port = Number(new URL(request.base_url).port),
    matches = [];
  for (const [service, definition] of Object.entries(config?.services || {})) {
    for (const published of definition?.ports || []) {
      if (
        Number(published?.published) === port &&
        String(published?.protocol || 'tcp').toLowerCase() === 'tcp' &&
        String(published?.host_ip || '') === '127.0.0.1'
      )
        matches.push({ service, target_port: Number(published.target) });
    }
  }
  if (matches.length !== 1 || !Number.isInteger(matches[0].target_port) || matches[0].target_port < 1)
    throw new HttpError(409, { error: 'deployment_runtime_verifier_target_not_published' });
  return {
    schema_version: 'aiws.compose_target_authorization.v1',
    compose_file: request.compose_file,
    compose_config_sha256: digest(Buffer.from(raw)),
    project: String(config.name || ''),
    service: matches[0].service,
    published_port: port,
    target_port: matches[0].target_port,
    host_ip: '127.0.0.1'
  };
}

function requiredViewports(contract) {
  const result = [];
  for (const criterion of contract?.acceptance_criteria || []) {
    const match = String(criterion).match(/((?:\d{3,4}\s*[\/、,]\s*)+\d{3,4})\s*(?:视口|viewports?)/i);
    if (!match) continue;
    for (const value of match[1].split(/[\/、,]/).map(Number))
      if (Number.isInteger(value) && value >= 320 && value <= 7680 && !result.includes(value)) result.push(value);
  }
  return result;
}

function requiredScheduleTime(contract) {
  const match = criteriaText(contract).match(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:\D|$)/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
}

function criteriaText(contract) {
  return (contract?.acceptance_criteria || []).join('\n');
}

async function readReport(directory) {
  try {
    return JSON.parse(await fsp.readFile(path.join(directory, 'report.json'), 'utf8'));
  } catch {
    throw new HttpError(409, { error: 'deployment_runtime_verification_report_missing' });
  }
}

async function verificationFiles(directory, report) {
  const files = [
    {
      path: 'deployment-verification.json',
      role: 'report',
      media_type: 'application/json',
      content: await fsp.readFile(path.join(directory, 'report.json'))
    }
  ];
  for (const viewport of report.browser?.viewports || []) {
    const relative = String(viewport.screenshot_path || '');
    if (!/^screenshots\/\d{3,4}\.png$/.test(relative))
      throw new HttpError(409, { error: 'deployment_runtime_verification_screenshot_path_invalid' });
    const content = await fsp.readFile(path.join(directory, ...relative.split('/')));
    if (content.length > 20 * 1024 * 1024 || content.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
      throw new HttpError(409, { error: 'deployment_runtime_verification_screenshot_invalid', path: relative });
    if (digest(content) !== viewport.screenshot_sha256)
      throw new HttpError(409, { error: 'deployment_runtime_verification_screenshot_hash_mismatch', path: relative });
    files.push({ path: relative, role: 'screenshot', media_type: 'image/png', content });
  }
  return files;
}

function safePath(value) {
  return SAFE_PATH.test(value) && !value.includes('//') && !value.includes('..') && value.length <= 500;
}

function uniqueBy(source, keyFor, failures, label) {
  if (!Array.isArray(source)) {
    failures.push(`${label}:invalid`);
    return new Map();
  }
  const result = new Map();
  for (const item of source) {
    const key = keyFor(item);
    if (key == null || key === '' || result.has(key)) failures.push(`${label}:duplicate_or_invalid`);
    else result.set(key, item);
  }
  return result;
}

function withinBudget(value, maximum) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= Number(maximum);
}

const emptyArray = (value) => Array.isArray(value) && value.length === 0;

function allowedIgnoredConsoleMessage(message, baseUrl) {
  let location, target;
  try {
    location = new URL(message?.url);
    target = new URL(baseUrl);
  } catch {
    return false;
  }
  if (location.origin !== target.origin) return false;
  if (
    message.reason === 'favicon_not_found' &&
    location.pathname === '/favicon.ico' &&
    Number(message.line_number) === 0 &&
    Number(message.column_number) === 0 &&
    message.text === 'Failed to load resource: the server responded with a status of 404 (Not Found)'
  )
    return true;
  return (
    message.reason === 'coop_untrustworthy_host_gateway' &&
    target.protocol === 'http:' &&
    target.hostname === 'host.docker.internal' &&
    location.pathname === '/' &&
    Number(message.line_number) === 0 &&
    Number(message.column_number) === 0 &&
    message.text === COOP_HOST_GATEWAY_MESSAGE
  );
}

async function runRequiredProcess(processRunner, invocation, options, errorCode) {
  try {
    return await processRunner(invocation, options);
  } catch {
    throw unavailableError(errorCode);
  }
}

function unavailableError(errorCode) {
  const error = new HttpError(503, { error: errorCode, retryable: true });
  error.retryable = true;
  return error;
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
