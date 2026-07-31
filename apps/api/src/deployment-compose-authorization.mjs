import fsp from 'node:fs/promises';
import path from 'node:path';

import { HttpError } from './http.mjs';
import { digest, runRequiredProcess } from './deployment-verifier-process.mjs';

export async function authorizeComposeTarget(request, taskExecution, processRunner) {
  const checkout = taskExecution.context_snapshot?.repository_checkout,
    snapshot = taskExecution.context_snapshot?.repository_snapshot;
  assertCheckout(request, checkout, snapshot);
  const { checkoutRoot, composePath } = await resolveComposePath(checkout, request.compose_file),
    execution = await readComposeConfig(processRunner, checkoutRoot, composePath),
    raw = composeConfigOutput(execution),
    config = parseComposeConfig(raw),
    port = Number(new URL(request.base_url).port),
    matches = publishedPortMatches(config, port);
  assertPublishedTarget(matches);
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

function assertCheckout(request, checkout, snapshot) {
  if (
    !checkout?.path ||
    checkout.access !== 'read_only' ||
    checkout.expected_head_sha !== request.repository_sha ||
    snapshot?.fixed_sha !== request.repository_sha ||
    snapshot.managed_path !== checkout.path
  )
    throw new HttpError(409, { error: 'deployment_runtime_verifier_checkout_invalid' });
}

async function resolveComposePath(checkout, composeFile) {
  let checkoutRoot, composePath;
  try {
    checkoutRoot = await fsp.realpath(checkout.path);
    composePath = await fsp.realpath(path.resolve(checkoutRoot, ...composeFile.split('/')));
  } catch {
    throw new HttpError(409, { error: 'deployment_runtime_verifier_compose_file_unavailable' });
  }
  const relative = path.relative(checkoutRoot, composePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new HttpError(409, { error: 'deployment_runtime_verifier_compose_file_invalid' });
  return { checkoutRoot, composePath };
}

async function readComposeConfig(processRunner, checkoutRoot, composePath) {
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
  return execution;
}

function composeConfigOutput(execution) {
  const raw = String(execution.stdout || '');
  if (!raw || Buffer.byteLength(raw) > 5 * 1024 * 1024)
    throw new HttpError(409, { error: 'deployment_runtime_verifier_compose_config_invalid' });
  return raw;
}

function parseComposeConfig(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(409, { error: 'deployment_runtime_verifier_compose_config_invalid' });
  }
}

function publishedPortMatches(config, port) {
  const matches = [];
  for (const [service, definition] of Object.entries(config?.services || {}))
    for (const published of definition?.ports || [])
      if (publishedPortMatchesTarget(published, port)) matches.push({ service, target_port: Number(published.target) });
  return matches;
}

function publishedPortMatchesTarget(published, port) {
  return (
    Number(published?.published) === port &&
    String(published?.protocol || 'tcp').toLowerCase() === 'tcp' &&
    String(published?.host_ip || '') === '127.0.0.1'
  );
}

function assertPublishedTarget(matches) {
  if (matches.length !== 1 || !Number.isInteger(matches[0].target_port) || matches[0].target_port < 1)
    throw new HttpError(409, { error: 'deployment_runtime_verifier_target_not_published' });
}
