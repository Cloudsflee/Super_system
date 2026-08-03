import net from 'node:net';

export async function waitForV23Readiness(
  config,
  {
    compose,
    inspectContainer,
    assertVolumeMount,
    isUpgradeError,
    upgradeError,
    sleep,
    readyWaitMs,
    requestTimeoutMs,
    pollMs,
    version,
    schema
  }
) {
  let last = null;
  const deadline = Date.now() + readyWaitMs;
  while (Date.now() < deadline) {
    try {
      const readiness = await readReadiness(config, {
        compose,
        inspectContainer,
        assertVolumeMount,
        requestTimeoutMs,
        deadline,
        version,
        schema
      });
      if (readiness) return readiness;
    } catch (error) {
      if (isUpgradeError(error)) throw error;
      last = { error: error.message };
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  throw upgradeError('v23_readiness_check_failed', { last });
}

async function readReadiness(
  config,
  { compose, inspectContainer, assertVolumeMount, requestTimeoutMs, deadline, version, schema }
) {
  const id = compose(config, ['ps', '-q', 'app'], { capture: true, allowFailure: true }).trim();
  if (!id) return null;
  const detail = inspectContainer(id);
  if (detail.image !== config.appImage) throw configError('v23_app_image_mismatch', config.appImage, detail.image);
  if (detail.project !== config.projectName)
    throw configError('v23_compose_project_mismatch', config.projectName, detail.project);
  assertVolumeMount(id, config.targetVolume);
  const response = await fetch(`http://127.0.0.1:${config.port}/api/readyz`, {
      signal: AbortSignal.timeout(Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())))
    }),
    readiness = await response.json();
  if (!readinessIsAccepted(response, readiness, version, schema)) return null;
  return { ...readiness, container_id: id, compose_project: detail.project, data_volume: config.targetVolume };
}

function configError(code, expected, actual) {
  const error = new Error(code);
  error.code = code;
  error.details = { expected, actual };
  return error;
}

function readinessIsAccepted(response, readiness, version, schema) {
  return [
    response.ok,
    readiness.status === 'ready',
    readiness.ready === true,
    readiness.version === version,
    readiness.schema_version === schema,
    readiness.checks?.sqlite?.ready === true,
    readiness.checks?.projector?.ready === true,
    readiness.checks?.index?.ready === true
  ].every(Boolean);
}

export async function waitForV23PortDisposition(config, { sleep, upgradeError }) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await portListening(config.port))) return;
    await sleep(200);
  }
  throw upgradeError(`v23_port_${config.port}_in_use`);
}

function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
