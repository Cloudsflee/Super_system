import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v110-runner-'));
const home = path.join(root, 'data-volume');
const workspace = path.join(home, 'executions', 'repository-lines', 'line-one');
const profile = path.join(home, 'codex-homes', 'profile-one');
const runtime = path.join(home, 'executions', 'node-runs', 'run-one');
const gitCommon = path.join(home, 'workspaces', 'project-one', 'repo', '.git');
for (const directory of [workspace, profile, runtime, gitCommon]) fs.mkdirSync(directory, { recursive: true });
process.env.AIWS_HOME = home;

try {
  const { DockerCodexRunner } = await import('../../packages/runner-adapters/src/index.mjs');
  const config = await import('../../apps/api/src/container-runtime-config.mjs');
  const runners = await import('../../apps/api/src/handlers/runners.mjs');
  const shared = await import('../../packages/shared/index.mjs');
  const runRoutes = await import('../../apps/api/src/routes/runs.mjs');
  const taskExecutions = await import('../../apps/api/src/task-execution-service.mjs');
  const repositoryChanges = await import('../../apps/api/src/repository-change-verifier.mjs');
  const dispatcher = await import('../../apps/api/src/workflow-dispatcher.mjs');
  const proposals = await import('../../apps/api/src/routes/change-proposals.mjs');
  const promptFile = path.join(runtime, 'prompt.md'),
    schemaFile = path.join(runtime, 'result-schema.json');
  fs.writeFileSync(promptFile, 'Return the requested JSON.', 'utf8');
  fs.writeFileSync(schemaFile, '{"type":"object"}', 'utf8');
  const fallback = taskResult('partial');
  const runner = new DockerCodexRunner({
    invocationBuilder: () => ({ command: 'docker', args: [] }),
    processRunner: async () => ({
      code: 1,
      stdout: '{"type":"error","message":"Reconnecting after 502 Bad Gateway"}\n{"type":"turn.failed"}\n',
      stderr: 'unexpected status 502: Upstream request failed'
    })
  });
  const failed = await runner.run({
    cwd: workspace,
    codexHome: profile,
    promptFile,
    outputSchemaFile: schemaFile,
    fallback
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed._codex_process.failure_code, 'runner_upstream_unavailable');
  assert.equal(failed._codex_process.retryable, true);
  assert.equal(failed.outputs[0].output_key, 'result');

  const controlledError = runRoutes.controlledRunnerResultError(failed, true);
  assert.equal(controlledError.status, 503);
  assert.equal(controlledError.code, 'runner_upstream_unavailable');
  assert.equal(controlledError.retryable, true);
  assert.equal(runRoutes.controlledRunnerResultError(taskResult('succeeded'), true), null);

  const env = {
    AIWS_CONTAINERIZED: '1',
    AIWS_DOCKER_DATA_VOLUME: 'aiws-data-v110-test',
    AIWS_DOCKER_INSTANCE: 'runner-test',
    AIWS_RUNNER_CPUS: '1',
    AIWS_RUNNER_MEMORY: '512m',
    AIWS_RUNNER_PIDS: '128'
  };
  const invocation = config.buildCodexContainerInvocation({
    env,
    kind: 'node-run',
    sessionId: 'run-one',
    codexHome: profile,
    workspace,
    workspaceMode: 'ro',
    internalMounts: [
      { source: runtime, target: '/aiws-run', mode: 'rw' },
      { source: gitCommon, target: '/var/lib/aiws/workspaces/project-one/repo/.git', mode: 'ro' }
    ],
    commandArgs: ['exec', '--sandbox', 'read-only', '-']
  });
  const mounts = invocation.args.filter((item) => item.startsWith('type=volume'));
  const tmpfsIndex = invocation.args.indexOf('--tmpfs');
  assert.ok(tmpfsIndex > 0);
  assert.equal(invocation.args[tmpfsIndex + 1], '/tmp:rw,nosuid,nodev,size=256m');
  assert.ok(mounts.some((item) => item.includes('dst=/workspace') && item.endsWith(',readonly')));
  assert.ok(mounts.some((item) => item.includes('dst=/aiws-run') && !item.endsWith(',readonly')));
  assert.ok(
    mounts.some(
      (item) => item.includes('dst=/var/lib/aiws/workspaces/project-one/repo/.git') && item.endsWith(',readonly')
    )
  );

  const context = {
    schema_version: 'aiws.task_execution_context.v3',
    contract: { expected_outputs: [{ key: 'result', asset_type: 'ResearchEvidenceAsset' }] },
    inputs: [{ key: 'repository', repository_snapshot: { fixed_sha: 'a'.repeat(40), managed_path: workspace } }],
    repository_snapshot: { fixed_sha: 'a'.repeat(40), managed_path: workspace },
    repository_checkout: { path: workspace, access: 'read_only' },
    system_context: {
      document_versions: [{ document_version_id: 'cdv_required', required: true }]
    }
  };
  const prepared = await runners.prepareCodexFiles(
    workspace,
    { id: 'run-external-files', runner: 'codex_docker' },
    {
      id: 'ctx-one',
      purpose: 'assist',
      receiver_name: 'AssistExecutor',
      token_estimate: 10,
      task_execution_context: context,
      content_json: {
        project: { title: 'Project', goal: 'Goal' },
        workflow_node: { title: 'Task' },
        node_contract: { node_goal: 'Inspect repository', acceptance_criteria: [] },
        task_execution_context: context,
        memory_manifest: { included: [], excluded: [], warnings: [] },
        runner_instruction: 'Return JSON only.'
      }
    }
  );
  assert.equal(path.dirname(prepared.promptFile), path.join(home, 'executions', 'node-runs', 'run-external-files'));
  assert.deepEqual(fs.readdirSync(workspace), []);
  const prompt = fs.readFileSync(prepared.promptFile, 'utf8');
  assert.match(prompt, /运行时仓库根目录固定为 \/workspace/);
  assert.match(prompt, /NodeRun ID run-external-files/);
  assert.match(prompt, /"managed_path": "\/workspace"/);
  assert.match(prompt, /"path": "\/workspace"/);
  assert.equal(prompt.includes(JSON.stringify(workspace).slice(1, -1)), false);
  const writeProjection = runners.runnerVisibleContextPack(
    {
      task_execution_context: { repository_checkout: { access: 'read_write' } },
      content_json: {
        task_execution_context: { repository_checkout: { access: 'read_write' } },
        runner_instruction: 'Return JSON only.'
      }
    },
    { id: 'run-write', runner: 'codex_docker' }
  );
  assert.match(writeProjection.content_json.runner_instruction, /不得执行 git add\/commit 或 MCP commit/);
  assert.match(writeProjection.content_json.runner_instruction, /服务端将执行 secret scan、commit/);
  const nodeRunInvocation = runners.buildNodeRunInvocation(
    { id: 'profile-one', image: 'runner:test' },
    { id: 'run-read-only', task_execution_context: { repository_checkout: { access: 'read_only' } } },
    {
      cwd: workspace,
      codexHome: profile,
      outputSchemaFile: prepared.schemaFile,
      promptFile: prepared.promptFile,
      configArgs: []
    },
    [],
    null
  );
  const addDirectory = nodeRunInvocation.args.indexOf('--add-dir');
  const sandbox = nodeRunInvocation.args.indexOf('--sandbox');
  const networkAccess = nodeRunInvocation.args.indexOf('sandbox_workspace_write.network_access=true');
  assert.ok(sandbox > 0);
  assert.equal(nodeRunInvocation.args[sandbox + 1], 'workspace-write');
  assert.ok(networkAccess > 0);
  assert.equal(nodeRunInvocation.args[networkAccess - 1], '-c');
  assert.ok(networkAccess < nodeRunInvocation.args.indexOf('exec'));
  assert.ok(addDirectory > 0);
  assert.equal(nodeRunInvocation.args[addDirectory + 1], '/tmp');
  const resultSchema = JSON.parse(fs.readFileSync(prepared.schemaFile, 'utf8'));
  assert.deepEqual(resultSchema.properties.schema_version.enum, ['aiws.task_runner_result.v2']);
  assert.deepEqual(resultSchema.required.sort(), Object.keys(resultSchema.properties).sort());
  const outputSchema = resultSchema.properties.outputs.items;
  assert.deepEqual(outputSchema.required.sort(), Object.keys(outputSchema.properties).sort());
  const payloadSchema = outputSchema.properties.payload;
  assert.deepEqual(payloadSchema.required.sort(), Object.keys(payloadSchema.properties).sort());
  const payloadFileSchema = payloadSchema.properties.files.items;
  assert.deepEqual(payloadFileSchema.required.sort(), Object.keys(payloadFileSchema.properties).sort());
  assert.equal(JSON.stringify(resultSchema).includes('"const"'), false);
  assert.equal(JSON.stringify(resultSchema).includes('"uniqueItems"'), false);
  assert.equal(JSON.stringify(resultSchema).includes('"additionalProperties":true'), false);

  const recoveryExecution = {
      id: 'tex-partial',
      contract_id: 'contract-partial',
      executor: 'repository_change',
      status: 'failed'
    },
    recoveryRun = {
      id: 'run-partial',
      task_execution_id: recoveryExecution.id,
      status: 'failed',
      completed_at: '2026-01-01T00:00:00.000Z',
      result_json: {
        ...taskResult('partial'),
        _codex_process: { code: 0 }
      }
    },
    recoveryState = {
      node_contracts: [
        {
          id: recoveryExecution.contract_id,
          expected_outputs: [{ key: 'result', required: true }]
        }
      ],
      node_runs: [recoveryRun]
    };
  assert.equal(taskExecutions.recoverablePartialRepositoryChangeRun(recoveryState, recoveryExecution), recoveryRun);
  recoveryRun.result_json._codex_process.code = 1;
  assert.equal(taskExecutions.recoverablePartialRepositoryChangeRun(recoveryState, recoveryExecution), null);
  assert.equal(
    repositoryChanges.addedDiffText(
      'diff --git a/test.mjs b/test.mjs\n--- a/test.mjs\n+++ b/test.mjs\n@@ -1 +1 @@\n-const token = "old-fixture";\n+const value = "new";\n context'
    ),
    'const value = "new";'
  );
  const instruction = shared.buildRunnerInstruction({
    project: { title: 'Project', goal: 'Goal' },
    node: { title: 'Task' },
    contract: context.contract,
    executionContext: context
  });
  assert.match(instruction, /AssetVersion ID.*\[\]/);
  assert.match(instruction, /system_context\.document_versions.*cdv_required/);
  assert.match(instruction, /aiws_context read.*provenance_claim\.document_version_id/);
  assert.match(instruction, /Repository Line\/branch\/SHA.*禁止填入/);
  const versionedSchema = shared.taskRunnerResultSchema({
    ...context,
    inputs: [{ key: 'evidence', asset_versions: [{ version_id: 'av_exact_input' }] }]
  });
  assert.deepEqual(versionedSchema.properties.consumed_input_versions.items.enum, ['av_exact_input']);
  assert.deepEqual(versionedSchema.properties.outputs.items.properties.consumed_input_versions.items.enum, [
    'av_exact_input'
  ]);
  assert.equal(versionedSchema.properties.consumed_context_document_versions.items.type, 'string');
  assert.equal(
    versionedSchema.properties.outputs.items.properties.consumed_context_document_versions.items.type,
    'string'
  );
  assert.match(versionedSchema.properties.consumed_context_document_versions.description, /cdv_required/);
  const malformedAggregate = shared.normalizeRunnerOutput({
    ...taskResult('succeeded'),
    consumed_input_versions: 'not-an-array'
  });
  assert.equal(malformedAggregate.parse_error, 'slot_aware_output_malformed');

  const state = { file_refs: [], traces: [] },
    run = { id: 'run-persisted', status: 'running' },
    node = { id: 'task-one', status: 'running' };
  await runners.persistRunnerResult(state, {
    actor: { id: 'user-one' },
    run,
    node,
    project: { id: 'project-one' },
    workspace: { id: 'workspace-one' },
    raw: failed._codex_process.stderr,
    resultJson: failed
  });
  assert.equal(run.status, 'failed');
  assert.equal(run.result_json._codex_process.failure_code, 'runner_upstream_unavailable');
  assert.ok(run.raw_output_file_ref_id);
  assert.equal(fs.existsSync(state.file_refs[0].absolute_path), true);
  assert.match(fs.readFileSync(state.file_refs[0].absolute_path, 'utf8'), /Upstream request failed/);
  const originalError = console.error;
  try {
    console.error = () => {};
    assert.equal(await dispatcher.scheduleWorkflowExecution('missing-workflow-execution'), null);
  } finally {
    console.error = originalError;
  }
  const profileState = {
    codex_profiles: [
      { id: 'old', status: 'validated', is_active: true },
      {
        id: 'native',
        status: 'validated',
        is_active: false,
        provider: 'custom',
        base_url: 'https://provider.test/v1',
        wire_api: 'responses',
        cc_switch_mode: 'native'
      }
    ],
    integration_statuses: [
      {
        key: 'codex_auth',
        status: 'authenticated',
        provider: 'custom',
        base_url: 'https://provider.test/v1',
        wire_api: 'responses'
      },
      { key: 'codex_probe', profile_id: 'native', status: 'ready' }
    ]
  };
  assert.deepEqual(
    proposals.applyAction(profileState, { apply_action: { type: 'codex_profile_apply', profile_id: 'native' } }),
    { type: 'codex_profile_apply', profile_id: 'native' }
  );
  assert.equal(profileState.codex_profiles.find((item) => item.id === 'native').is_active, true);

  console.log('V1.10 runner isolation, transient failure, and diagnostic persistence unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function taskResult(status) {
  return {
    schema_version: 'aiws.task_runner_result.v2',
    status,
    summary: 'runner result',
    consumed_input_versions: [],
    consumed_context_document_versions: [],
    outputs: [
      {
        output_key: 'result',
        asset_type: 'ResearchEvidenceAsset',
        title: 'Result',
        summary: 'Result',
        payload: { payload_kind: 'text', media_type: 'text/plain', content: 'result', files: [] },
        evidence_refs: [],
        consumed_input_versions: [],
        consumed_context_document_versions: []
      }
    ],
    warnings: []
  };
}
