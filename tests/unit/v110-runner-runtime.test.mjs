import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  const pullRequestIntents = await import('../../apps/api/src/pull-request-intent-service.mjs');
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
    AIWS_RUNNER_PIDS: '128',
    AIWS_RUNNER_TMPFS: '768m'
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
  assert.equal(invocation.args[tmpfsIndex + 1], '/tmp:rw,nosuid,nodev,size=768m');
  assert.ok(mounts.some((item) => item.includes('dst=/workspace') && item.endsWith(',readonly')));
  assert.ok(mounts.some((item) => item.includes('dst=/aiws-run') && !item.endsWith(',readonly')));
  assert.ok(
    mounts.some(
      (item) => item.includes('dst=/var/lib/aiws/workspaces/project-one/repo/.git') && item.endsWith(',readonly')
    )
  );

  const context = {
    schema_version: 'aiws.task_execution_context.v3',
    task: { task_kind: 'deploy' },
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
  assert.match(prompt, /\/usr\/bin\/chromium-browser/);
  assert.match(prompt, /不得下载浏览器二进制/);
  assert.match(prompt, /host\.docker\.internal/);
  assert.match(prompt, /不得用 Runner 内临时进程替代/);
  assert.match(prompt, /无模型的独立浏览器容器重跑/);
  assert.match(prompt, /payload\.content 必须是 JSON 字符串/);
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
  const workingDirectory = nodeRunInvocation.args.indexOf('--cd');
  const networkAccess = nodeRunInvocation.args.indexOf('sandbox_workspace_write.network_access=true');
  assert.ok(sandbox > 0);
  assert.equal(nodeRunInvocation.args[sandbox + 1], 'workspace-write');
  assert.ok(networkAccess > 0);
  assert.equal(nodeRunInvocation.args[networkAccess - 1], '-c');
  assert.ok(networkAccess < nodeRunInvocation.args.indexOf('exec'));
  assert.ok(addDirectory > 0);
  assert.equal(nodeRunInvocation.args[addDirectory + 1], '/tmp');
  assert.ok(workingDirectory > 0);
  assert.equal(nodeRunInvocation.args[workingDirectory + 1], '/tmp');
  assert.ok(nodeRunInvocation.args.includes('AIWS_BROWSER_EXECUTABLE=/usr/bin/chromium-browser'));
  assert.ok(nodeRunInvocation.args.includes('AIWS_HOST_GATEWAY=http://host.docker.internal'));
  assert.ok(nodeRunInvocation.args.includes('HOME=/tmp/aiws-browser-home'));
  assert.ok(nodeRunInvocation.args.includes('XDG_CONFIG_HOME=/tmp/aiws-browser-home/.config'));
  assert.ok(nodeRunInvocation.args.includes('XDG_CACHE_HOME=/tmp/aiws-browser-home/.cache'));
  assert.ok(nodeRunInvocation.args.includes('NODE_PATH=/usr/local/lib/node_modules'));
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
  recoveryRun.result_json._codex_process.code = 0;
  recoveryRun.result_json.status = 'succeeded';
  const strandedRetry = {
    ...recoveryExecution,
    id: 'tex-stranded-retry',
    supersedes_id: recoveryExecution.id,
    context_snapshot: null
  };
  recoveryExecution.status = 'superseded';
  recoveryState.task_executions = [recoveryExecution, strandedRetry];
  assert.equal(taskExecutions.recoverablePartialRepositoryChangeRun(recoveryState, strandedRetry), recoveryRun);
  strandedRetry.task_id = 'different-task';
  assert.equal(taskExecutions.recoverablePartialRepositoryChangeRun(recoveryState, strandedRetry), null);
  const recoveryRepository = path.join(root, 'committed-recovery');
  fs.mkdirSync(recoveryRepository, { recursive: true });
  git(recoveryRepository, ['init']);
  fs.writeFileSync(path.join(recoveryRepository, 'change.mjs'), 'export const value = 1;\n');
  git(recoveryRepository, ['add', 'change.mjs']);
  git(recoveryRepository, [
    '-c',
    'user.name=Initial Author',
    '-c',
    'user.email=initial@example.test',
    'commit',
    '-m',
    'initial'
  ]);
  const recoveryPreviousSha = git(recoveryRepository, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(recoveryRepository, 'change.mjs'), 'export const value = 2;\n');
  git(recoveryRepository, ['add', 'change.mjs']);
  git(recoveryRepository, [
    '-c',
    'user.name=AI Workspace',
    '-c',
    'user.email=aiws@local.invalid',
    'commit',
    '-m',
    'feat(aiws): 恢复仓库变更'
  ]);
  const recoveryCommitSha = git(recoveryRepository, ['rev-parse', 'HEAD']).trim(),
    recoveryLine = {
      id: 'line-recovery',
      workstream_id: 'workstream-recovery',
      connection_id: 'connection-recovery',
      checkout_path: recoveryRepository,
      head_sha: recoveryPreviousSha,
      branch: 'aiws/recovery'
    },
    recoveryTaskExecution = {
      id: 'execution-recovery',
      task_id: 'task-recovery',
      workstream_id: recoveryLine.workstream_id,
      workflow_execution_id: 'workflow-execution-recovery',
      recovery_source_task_execution_id: 'execution-source',
      recovery_source_node_run_id: 'run-source'
    },
    committedRecoveryState = {
      delivery_policies: [
        {
          workstream_id: recoveryLine.workstream_id,
          connection_id: recoveryLine.connection_id,
          status: 'approved',
          approved_at: '2026-07-28T00:00:00.000Z',
          path_prefixes: ['.'],
          automation_permissions: ['commit']
        }
      ],
      workflow_nodes: [{ id: recoveryTaskExecution.task_id, title: '恢复仓库变更' }],
      node_runs: [
        {
          id: 'run-source',
          task_execution_id: 'execution-source',
          status: 'failed',
          result_json: {
            _codex_process: { code: 0 },
            outputs: [{ payload: { files: [{ path: 'change.mjs' }] } }]
          }
        }
      ]
    };
  const recoveredCommit = await repositoryChanges.finalizeRepositoryChangeInState(
    committedRecoveryState,
    recoveryTaskExecution,
    recoveryLine
  );
  assert.equal(recoveredCommit.commit_sha, recoveryCommitSha);
  assert.equal(recoveryLine.head_sha, recoveryCommitSha);
  assert.deepEqual(recoveredCommit.changed_files, [{ path: 'change.mjs', status: 'modified' }]);
  const localCheckState = {
      asset_blobs: [],
      pull_request_intents: [
        {
          id: 'intent-local-check',
          project_id: 'project-local-check',
          repository_line_id: recoveryLine.id,
          workstream_id: recoveryLine.workstream_id,
          head_sha: recoveryCommitSha,
          status: 'draft_open',
          checks_status: 'passed',
          checks: []
        }
      ],
      repository_lines: [recoveryLine],
      delivery_policies: [
        {
          workstream_id: recoveryLine.workstream_id,
          connection_id: recoveryLine.connection_id,
          status: 'approved',
          approved_at: '2026-07-28T00:00:00.000Z',
          test_commands: ['node --version']
        }
      ]
    },
    localChecks = await pullRequestIntents.ensurePullRequestIntentChecksInState(localCheckState, 'intent-local-check');
  assert.equal(localChecks.executed, true);
  assert.equal(localChecks.intent.checks_status, 'passed');
  assert.equal(localChecks.checks.length, 1);
  assert.equal(localChecks.checks[0].source, 'aiws_delivery_policy');
  assert.equal(localChecks.checks[0].repository_sha, recoveryCommitSha);
  assert.ok(localCheckState.asset_blobs.some((item) => item.sha256 === localChecks.checks[0].log_sha256));
  assert.doesNotThrow(() =>
    shared.makeTrace('pull_request.intent.local_checks_completed', {
      target_type: 'pull_request_intent',
      target_id: localChecks.intent.id
    })
  );
  localChecks.intent.checks = [];
  localChecks.intent.checks_status = 'failed';
  await assert.rejects(
    () => pullRequestIntents.ensurePullRequestIntentChecksInState(localCheckState, 'intent-local-check'),
    (error) => error?.payload?.error === 'pull_request_remote_checks_not_passed'
  );
  localChecks.intent.status = 'merged';
  localChecks.intent.checks_status = 'passed';
  const recoveredChecks = await pullRequestIntents.ensurePullRequestIntentChecksInState(
    localCheckState,
    'intent-local-check',
    { allowMergedRecovery: true }
  );
  assert.equal(recoveredChecks.checks.length, 1);
  assert.ok(localChecks.intent.local_checks_recovered_at);
  assert.equal(
    repositoryChanges.addedDiffText(
      'diff --git a/test.mjs b/test.mjs\n--- a/test.mjs\n+++ b/test.mjs\n@@ -1 +1 @@\n-const token = "old-fixture";\n+const value = "new";\n context'
    ),
    'const value = "new";'
  );
  assert.equal(repositoryChanges.containsRepositorySecret("apiKey: 'sk-test-redacted'"), false);
  assert.equal(repositoryChanges.containsRepositorySecret("token: 'fixture-placeholder-token'"), false);
  assert.equal(repositoryChanges.containsRepositorySecret("apiKey: 'sk-proj-realisticvalue1234567890'"), true);
  assert.equal(repositoryChanges.containsRepositorySecret("token: 'fixture-live-1234567890'"), true);
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

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}
