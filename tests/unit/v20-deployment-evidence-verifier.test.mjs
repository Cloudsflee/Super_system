import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v20-deployment-verifier-'));
const home = path.join(root, 'data-volume');
const checkout = path.join(home, 'executions', 'repository-lines', 'line-deploy');
fs.mkdirSync(checkout, { recursive: true });
fs.writeFileSync(path.join(checkout, 'compose.yml'), 'name: deployment-unit\nservices: {}\n', 'utf8');
process.env.AIWS_HOME = home;

try {
  const verifier = await import('../../apps/api/src/deployment-evidence-verifier.mjs');
  const containerConfig = await import('../../apps/api/src/container-runtime-config.mjs');
  const { attestAssetVersionInState } = await import('../../apps/api/src/asset-attestation-service.mjs');
  const { createAssetRecord, createImmutableAssetVersion } = await import('../../apps/api/src/asset-cas.mjs');
  const { emptyState } = await import('../../apps/api/src/state.mjs');

  const repositorySha = 'a'.repeat(40);
  const state = emptyState();
  state.projects.push({ id: 'project-deploy' });
  state.workspaces.push({ id: 'workspace-deploy', project_id: 'project-deploy' });
  state.workflow_nodes.push({
    id: 'task-deploy',
    role: 'task',
    workspace_id: 'workspace-deploy',
    task_kind: 'deploy',
    title: 'Verify deployment'
  });
  state.node_contracts.push({
    id: 'contract-deploy',
    node_id: 'task-deploy',
    acceptance_criteria: [
      'Dashboard 在 2560/1920/1440/1024/768/390 视口无重叠或横向溢出，API、安全头、图像和 23:50 计算均通过验证。'
    ],
    expected_outputs: [
      {
        key: 'deployment_evidence',
        asset_type: 'DeliveryEvidenceAsset',
        required: true,
        confirmation_policy: 'system_evidence',
        acceptance_criteria: ['Runtime checks pass'],
        handoff: true
      }
    ]
  });
  const taskExecution = {
    id: 'tex-deploy',
    project_id: 'project-deploy',
    workflow_execution_id: 'wex-deploy',
    task_id: 'task-deploy',
    contract_id: 'contract-deploy',
    executor: 'assist',
    status: 'running',
    context_snapshot: {
      repository_checkout: {
        path: checkout,
        expected_head_sha: repositorySha,
        access: 'read_only'
      },
      repository_snapshot: {
        fixed_sha: repositorySha,
        managed_path: checkout
      },
      inputs: []
    },
    output_bindings: [],
    acceptance_results: []
  };
  const run = {
    id: 'run_deployment_test',
    node_id: 'task-deploy',
    task_execution_id: taskExecution.id,
    runner: 'codex_docker',
    status: 'succeeded',
    raw_output_file_ref_id: 'fil-deployment-raw'
  };
  state.task_executions.push(taskExecution);
  state.node_runs.push(run);
  state.file_refs.push({ id: run.raw_output_file_ref_id });

  const candidate = deploymentCandidate(run.id, repositorySha);
  const resultJson = runnerResult(candidate);
  const request = verifier.deploymentVerificationRequest(state, { run, taskExecution, resultJson });
  assert.equal(request.base_url, 'http://host.docker.internal:3385');
  assert.equal(request.compose_file, 'compose.yml');
  assert.deepEqual(request.viewports, [2560, 1920, 1440, 1024, 768, 390]);
  assert.equal(request.schedule_time, '23:50');
  assert.deepEqual(
    request.endpoints.map((item) => item.path),
    ['/healthz', '/api/reports/latest', '/api/syllabus']
  );

  const nonDeployState = structuredClone(state);
  nonDeployState.workflow_nodes.find((item) => item.id === 'task-deploy').task_kind = 'review';
  assert.equal(verifier.deploymentVerificationRequest(nonDeployState, { run, taskExecution, resultJson }), null);
  assert.equal(
    verifier.deploymentVerificationRequest(state, {
      run,
      taskExecution: { ...taskExecution, executor: 'repository_verify' },
      resultJson
    }),
    null
  );
  for (const target of [
    'http://127.0.0.1:3385',
    'http://host.docker.internal:3385/dashboard',
    'http://host.docker.internal:3385?probe=1',
    'http://user@host.docker.internal:3385'
  ])
    assert.throws(
      () =>
        verifier.deploymentVerificationRequest(state, {
          run,
          taskExecution,
          resultJson: runnerResult({ ...candidate, compose: { ...candidate.compose, host_url: target } })
        }),
      (error) => error.payload?.error === 'deployment_runtime_verifier_target_invalid'
    );
  assert.throws(
    () =>
      verifier.deploymentVerificationRequest(state, {
        run,
        taskExecution,
        resultJson: runnerResult({ ...candidate, run_id: 'run_other' })
      }),
    (error) => error.payload?.error === 'deployment_runtime_verifier_candidate_binding_invalid'
  );
  assert.throws(
    () =>
      verifier.deploymentVerificationRequest(state, {
        run,
        taskExecution,
        resultJson: runnerResult({
          ...candidate,
          browser: { viewports: candidate.browser.viewports.filter((item) => item.width !== 390) }
        })
      }),
    (error) => error.payload?.error === 'deployment_runtime_verifier_viewport_claim_missing'
  );
  assert.throws(
    () =>
      verifier.deploymentVerificationRequest(state, {
        run,
        taskExecution,
        resultJson: runnerResult({ ...candidate, browser: { viewports: null } })
      }),
    (error) => error.payload?.error === 'deployment_runtime_verifier_viewport_claim_invalid'
  );
  assert.throws(
    () =>
      verifier.deploymentVerificationRequest(state, {
        run,
        taskExecution,
        resultJson: runnerResult({
          ...candidate,
          api: { passed: candidate.api.passed.filter((item) => item.path !== '/healthz') }
        })
      }),
    (error) => error.payload?.error === 'deployment_runtime_verifier_health_endpoint_required'
  );

  let verifierDirectory = null;
  const verified = await verifier.verifyDeploymentNodeRun(
    state,
    { run, taskExecution, resultJson },
    {
      env: { AIWS_CODEX_DOCKER_IMAGE: 'runner:test', AIWS_RUNNER_TMPFS: '128m' },
      processRunner: async (invocation) => {
        if (invocation.args[0] === 'compose') return composeResult(3385);
        const entrypoint = invocation.args.indexOf('--entrypoint');
        assert.ok(entrypoint > 0);
        assert.equal(invocation.args[entrypoint + 1], 'node');
        assert.ok(entrypoint < invocation.args.indexOf('runner:test'));
        assert.equal(invocation.args.includes('seccomp=unconfined'), false);
        assert.ok(invocation.args.includes('HOME=/tmp/aiws-browser-home'));
        verifierDirectory = mountedVerifierDirectory(invocation.args);
        const runtimeRequest = JSON.parse(fs.readFileSync(path.join(verifierDirectory, 'request.json'), 'utf8'));
        writeRuntimeEvidence(verifierDirectory, runtimeRequest);
        return { code: 0, stdout: '{"ok":true}\n', stderr: '' };
      }
    }
  );
  assert.equal(fs.existsSync(verifierDirectory), false);
  assert.equal(verified.verifierId, verifier.DEPLOYMENT_RUNTIME_VERIFIER);
  const receipt = verified.evidence.deployment_verification;
  assert.equal(receipt.repository_sha, repositorySha);
  assert.equal(receipt.compose_authorization.published_port, 3385);
  assert.equal(receipt.compose_authorization.service, 'dashboard');
  assert.equal(receipt.entries.length, 7);
  assert.equal(receipt.entries[0].role, 'report');
  assert.equal(receipt.entries.filter((item) => item.role === 'screenshot').length, 6);
  assert.equal(receipt.report_sha256, receipt.entries.find((item) => item.role === 'report').sha256);

  let browserInvoked = false;
  await assert.rejects(
    () =>
      verifier.verifyDeploymentNodeRun(
        state,
        { run, taskExecution, resultJson },
        {
          env: { AIWS_CODEX_DOCKER_IMAGE: 'runner:test' },
          processRunner: async (invocation) => {
            if (invocation.args[0] === 'compose') return composeResult(4317);
            browserInvoked = true;
            throw new Error('browser must not run');
          }
        }
      ),
    (error) => error.payload?.error === 'deployment_runtime_verifier_target_not_published'
  );
  assert.equal(browserInvoked, false);
  await assert.rejects(
    () =>
      verifier.verifyDeploymentNodeRun(
        state,
        { run, taskExecution, resultJson },
        {
          env: { AIWS_CODEX_DOCKER_IMAGE: 'runner:test' },
          processRunner: async () => {
            throw new Error('docker unavailable');
          }
        }
      ),
    (error) =>
      error.status === 503 &&
      error.retryable === true &&
      error.payload?.error === 'deployment_runtime_verifier_compose_config_unavailable'
  );

  const report = runtimeReport(request, new Map(request.viewports.map((width) => [width, pngBytes()])));
  assert.equal(verifier.assertDeploymentVerificationReport(report, request), true);
  const badEndpoint = structuredClone(report);
  badEndpoint.endpoints.find((item) => item.path === '/api/syllabus').status = 503;
  assert.throws(
    () => verifier.assertDeploymentVerificationReport(badEndpoint, request),
    (error) =>
      error.payload?.error === 'deployment_runtime_verification_failed' &&
      error.payload.failures.includes('endpoint:/api/syllabus:invalid')
  );
  const badViewport = structuredClone(report);
  badViewport.browser.viewports.find((item) => item.width === 390).overlap_violations.push({ left: 'main' });
  assert.throws(
    () => verifier.assertDeploymentVerificationReport(badViewport, request),
    (error) => error.payload?.failures?.includes('viewport:390:invalid')
  );

  const asset = createAssetRecord({
    projectId: 'project-deploy',
    workspaceId: 'workspace-deploy',
    taskId: 'task-deploy',
    taskExecutionId: taskExecution.id,
    assetType: 'DeliveryEvidenceAsset',
    title: 'Deployment evidence',
    outputKey: 'deployment_evidence',
    actorId: 'owner'
  });
  Object.assign(asset, { confirmation_policy: 'system_evidence' });
  state.assets.push(asset);
  const version = await createImmutableAssetVersion(state, {
    asset,
    payload: verified.evidence.deployment_payload,
    evidenceRefs: verified.evidence.evidence_refs,
    repositorySha,
    actorId: 'owner'
  });
  const forged = structuredClone(receipt);
  forged.entries.pop();
  await assert.rejects(
    () =>
      attestAssetVersionInState(state, {
        assetId: asset.id,
        versionId: version.id,
        expectedSha256: version.content_sha256,
        taskExecutionId: taskExecution.id,
        outputKey: 'deployment_evidence',
        decision: 'accepted',
        attestorType: 'trusted_verifier',
        attestorId: verifier.DEPLOYMENT_RUNTIME_VERIFIER,
        evidence: { deployment_verification: forged }
      }),
    (error) => error.payload?.error === 'deployment_runtime_payload_invalid'
  );
  const accepted = await attestAssetVersionInState(state, {
    assetId: asset.id,
    versionId: version.id,
    expectedSha256: version.content_sha256,
    taskExecutionId: taskExecution.id,
    outputKey: 'deployment_evidence',
    decision: 'accepted',
    attestorType: 'trusted_verifier',
    attestorId: verifier.DEPLOYMENT_RUNTIME_VERIFIER,
    evidence: { deployment_verification: receipt }
  });
  assert.equal(accepted.asset.status, 'confirmed');
  assert.equal(accepted.attestation.attestor_id, verifier.DEPLOYMENT_RUNTIME_VERIFIER);
  assert.equal(taskExecution.output_bindings[0].version_id, version.id);

  const entrypointInvocation = containerConfig.buildCodexContainerInvocation({
    env: { AIWS_CODEX_DOCKER_IMAGE: 'runner:test', AIWS_RUNNER_TMPFS: '128m' },
    kind: 'entrypoint-unit',
    sessionId: 'entrypoint-unit',
    entrypoint: '/usr/local/bin/node',
    commandArgs: ['--version']
  });
  const entrypointIndex = entrypointInvocation.args.indexOf('--entrypoint');
  assert.equal(entrypointInvocation.args[entrypointIndex + 1], '/usr/local/bin/node');
  assert.ok(entrypointIndex < entrypointInvocation.args.indexOf('runner:test'));
  assert.throws(
    () =>
      containerConfig.buildCodexContainerInvocation({
        env: { AIWS_CODEX_DOCKER_IMAGE: 'runner:test' },
        entrypoint: 'node;whoami'
      }),
    /invalid_runner_entrypoint/
  );
  assert.throws(
    () =>
      containerConfig.buildCodexContainerInvocation({
        env: { AIWS_CODEX_DOCKER_IMAGE: 'runner:test' },
        entrypoint: '/usr/bin/../bin/node'
      }),
    /invalid_runner_entrypoint/
  );
  const lowercaseEnvironment = containerConfig.buildCodexContainerInvocation({
    env: { AIWS_CODEX_DOCKER_IMAGE: 'runner:test' },
    kind: 'lowercase-environment-unit',
    sessionId: 'lowercase-environment-unit',
    containerEnv: {
      http_proxy: 'http://127.0.0.1:7890',
      api_token: 'unit-sensitive-value'
    }
  });
  assert.ok(lowercaseEnvironment.args.includes('http_proxy=http://127.0.0.1:7890'));
  assert.ok(lowercaseEnvironment.args.includes('api_token'));
  assert.equal(
    lowercaseEnvironment.args.some((item) => item.includes('unit-sensitive-value')),
    false
  );

  console.log('V2.0 deployment evidence verifier tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function deploymentCandidate(runId, repositorySha) {
  return {
    run_id: runId,
    repository_sha: repositorySha,
    compose: { file: 'compose.yml', host_url: 'http://host.docker.internal:3385' },
    api: {
      passed: [
        { path: '/healthz', status: 200 },
        { path: '/api/reports/latest', status: 200 },
        { path: '/api/syllabus', status: 200 }
      ]
    },
    security_headers: {
      required: [
        'content-security-policy',
        'x-content-type-options',
        'x-frame-options',
        'referrer-policy',
        'permissions-policy',
        'cross-origin-opener-policy'
      ]
    },
    images: { static_assets: [{ path: '/assets/product.png' }, { path: '/assets/ui.png' }] },
    browser: { viewports: [2560, 1920, 1440, 1024, 768, 390].map((width) => ({ width })) }
  };
}

function runnerResult(candidate) {
  return {
    schema_version: 'aiws.task_runner_result.v4',
    status: 'succeeded',
    outputs: [
      {
        output_key: 'deployment_evidence',
        asset_type: 'DeliveryEvidenceAsset',
        payload: { payload_kind: 'json', media_type: 'application/json', content: JSON.stringify(candidate) }
      }
    ],
    _codex_process: { code: 0 }
  };
}

function composeResult(port) {
  return {
    code: 0,
    stderr: '',
    stdout: JSON.stringify({
      name: 'deployment-unit',
      services: {
        dashboard: {
          ports: [{ host_ip: '127.0.0.1', target: 3379, published: String(port), protocol: 'tcp' }]
        }
      }
    })
  };
}

function mountedVerifierDirectory(args) {
  const mount = args.find((item) => String(item).endsWith(':/aiws-verify:rw'));
  assert.ok(mount, 'deployment verifier bind mount is required');
  return mount.slice(0, -':/aiws-verify:rw'.length);
}

function writeRuntimeEvidence(directory, request) {
  const screenshots = new Map();
  for (const width of request.viewports) {
    const bytes = pngBytes();
    screenshots.set(width, bytes);
    fs.writeFileSync(path.join(directory, 'screenshots', `${width}.png`), bytes);
  }
  fs.writeFileSync(
    path.join(directory, 'report.json'),
    `${JSON.stringify(runtimeReport(request, screenshots), null, 2)}\n`
  );
}

function runtimeReport(request, screenshots) {
  const started = '2026-07-29T12:00:00.000Z';
  return {
    schema_version: 'aiws.deployment_runtime_verification.v1',
    verifier: 'deployment_runtime_verifier',
    target: request.base_url,
    repository_sha: request.repository_sha,
    node_run_id: request.node_run_id,
    started_at: started,
    completed_at: '2026-07-29T12:00:01.000Z',
    health: endpointResult(
      request.endpoints.find((item) => item.path === '/healthz'),
      request,
      {
        status: 'ok',
        storageWritable: true,
        nextRunAt: '2026-07-29T15:50:00.000Z'
      }
    ),
    endpoints: request.endpoints.map((item) =>
      endpointResult(item, request, item.path === '/healthz' ? { status: 'ok', storageWritable: true } : null)
    ),
    security: request.endpoints.map((item) => ({ path: item.path, missing: [] })),
    images: request.images.map((item) => ({
      path: item.path,
      status: 200,
      media_type: 'image/png',
      detected_type: 'image/png',
      size_bytes: 68,
      sha256: sha256(pngBytes()),
      ok: true
    })),
    schedule: {
      required: true,
      ok: true,
      next_run_at: '2026-07-29T15:50:00.000Z',
      local_time: '23:50',
      expected_local_time: '23:50',
      time_zone: 'Asia/Shanghai'
    },
    browser: {
      executable: '/usr/bin/chromium-browser',
      viewports: request.viewports.map((width) => {
        const bytes = screenshots.get(width);
        return {
          width,
          height: width <= 480 ? 844 : width <= 768 ? 1024 : 900,
          elapsed_ms: 25,
          screenshot_path: `screenshots/${width}.png`,
          screenshot_sha256: sha256(bytes),
          screenshot_size_bytes: bytes.length,
          console_errors: [],
          ignored_console_messages: [],
          page_errors: [],
          failed_responses: [],
          document_overflow: 0,
          horizontal_violations: [],
          overlap_violations: [],
          images: request.images.map((item) => ({
            src: item.path,
            complete: true,
            natural_width: 960,
            natural_height: 600
          }))
        };
      })
    },
    failures: [],
    ok: true
  };
}

function endpointResult(endpoint, request, json) {
  return {
    path: endpoint.path,
    expected_status: endpoint.expected_status,
    status: endpoint.expected_status,
    elapsed_ms: 5,
    size_bytes: 100,
    sha256: 'b'.repeat(64),
    headers: Object.fromEntries(request.security_headers.map((name) => [name, 'present'])),
    json
  };
}

function pngBytes() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZsAAAAASUVORK5CYII=',
    'base64'
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
