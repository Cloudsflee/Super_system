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
  const dispatcher = await import('../../apps/api/src/workflow-dispatcher.mjs');
  const proposals = await import('../../apps/api/src/routes/change-proposals.mjs');
  const promptFile = path.join(runtime, 'prompt.md'), schemaFile = path.join(runtime, 'result-schema.json');
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
  const failed = await runner.run({ cwd: workspace, codexHome: profile, promptFile, outputSchemaFile: schemaFile, fallback });
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
    AIWS_CONTAINERIZED: '1', AIWS_DOCKER_DATA_VOLUME: 'aiws-data-v110-test', AIWS_DOCKER_INSTANCE: 'runner-test',
    AIWS_RUNNER_CPUS: '1', AIWS_RUNNER_MEMORY: '512m', AIWS_RUNNER_PIDS: '128'
  };
  const invocation = config.buildCodexContainerInvocation({
    env, kind: 'node-run', sessionId: 'run-one', codexHome: profile,
    workspace, workspaceMode: 'ro', internalMounts: [
      { source: runtime, target: '/aiws-run', mode: 'rw' },
      { source: gitCommon, target: '/var/lib/aiws/workspaces/project-one/repo/.git', mode: 'ro' }
    ], commandArgs: ['exec', '--sandbox', 'read-only', '-']
  });
  const mounts = invocation.args.filter((item) => item.startsWith('type=volume'));
  assert.ok(mounts.some((item) => item.includes('dst=/workspace') && item.endsWith(',readonly')));
  assert.ok(mounts.some((item) => item.includes('dst=/aiws-run') && !item.endsWith(',readonly')));
  assert.ok(mounts.some((item) => item.includes('dst=/var/lib/aiws/workspaces/project-one/repo/.git') && item.endsWith(',readonly')));

  const context = {
    schema_version: 'aiws.task_execution_context.v3',
    contract: { expected_outputs: [{ key: 'result', asset_type: 'ResearchEvidenceAsset' }] }, inputs: []
  };
  const prepared = await runners.prepareCodexFiles(workspace, { id: 'run-external-files' }, {
    id: 'ctx-one', purpose: 'assist', receiver_name: 'AssistExecutor', token_estimate: 10,
    task_execution_context: context,
    content_json: {
      project: { title: 'Project', goal: 'Goal' }, workflow_node: { title: 'Task' },
      node_contract: { node_goal: 'Inspect repository', acceptance_criteria: [] }, task_execution_context: context,
      memory_manifest: { included: [], excluded: [], warnings: [] }, runner_instruction: 'Return JSON only.'
    }
  });
  assert.equal(path.dirname(prepared.promptFile), path.join(home, 'executions', 'node-runs', 'run-external-files'));
  assert.deepEqual(fs.readdirSync(workspace), []);
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
  const instruction = shared.buildRunnerInstruction({ project: { title: 'Project', goal: 'Goal' }, node: { title: 'Task' }, contract: context.contract, executionContext: context });
  assert.match(instruction, /AssetVersion ID.*\[\]/);
  assert.match(instruction, /Repository Line\/branch\/SHA.*禁止填入/);
  const versionedSchema = shared.taskRunnerResultSchema({ ...context, inputs: [{ key: 'evidence', asset_versions: [{ version_id: 'av_exact_input' }] }] });
  assert.deepEqual(versionedSchema.properties.consumed_input_versions.items.enum, ['av_exact_input']);
  assert.deepEqual(versionedSchema.properties.outputs.items.properties.consumed_input_versions.items.enum, ['av_exact_input']);
  const malformedAggregate = shared.normalizeRunnerOutput({ ...taskResult('succeeded'), consumed_input_versions: 'not-an-array' });
  assert.equal(malformedAggregate.parse_error, 'slot_aware_output_malformed');

  const state = { file_refs: [], traces: [] }, run = { id: 'run-persisted', status: 'running' }, node = { id: 'task-one', status: 'running' };
  await runners.persistRunnerResult(state, {
    actor: { id: 'user-one' }, run, node, project: { id: 'project-one' }, workspace: { id: 'workspace-one' },
    raw: failed._codex_process.stderr, resultJson: failed
  });
  assert.equal(run.status, 'failed');
  assert.equal(run.result_json._codex_process.failure_code, 'runner_upstream_unavailable');
  assert.ok(run.raw_output_file_ref_id);
  assert.equal(fs.existsSync(state.file_refs[0].absolute_path), true);
  assert.match(fs.readFileSync(state.file_refs[0].absolute_path, 'utf8'), /Upstream request failed/);
  const originalError = console.error;
  try { console.error = () => {}; assert.equal(await dispatcher.scheduleWorkflowExecution('missing-workflow-execution'), null); }
  finally { console.error = originalError; }
  const profileState = {
    codex_profiles: [
      { id: 'old', status: 'validated', is_active: true },
      { id: 'native', status: 'validated', is_active: false, provider: 'custom', base_url: 'https://provider.test/v1', wire_api: 'responses', cc_switch_mode: 'native' }
    ],
    integration_statuses: [
      { key: 'codex_auth', status: 'authenticated', provider: 'custom', base_url: 'https://provider.test/v1', wire_api: 'responses' },
      { key: 'codex_probe', profile_id: 'native', status: 'ready' }
    ]
  };
  assert.deepEqual(proposals.applyAction(profileState, { apply_action: { type: 'codex_profile_apply', profile_id: 'native' } }), { type: 'codex_profile_apply', profile_id: 'native' });
  assert.equal(profileState.codex_profiles.find((item) => item.id === 'native').is_active, true);

  console.log('V1.10 runner isolation, transient failure, and diagnostic persistence unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function taskResult(status) {
  return {
    schema_version: 'aiws.task_runner_result.v2', status, summary: 'runner result', consumed_input_versions: [],
    outputs: [{ output_key: 'result', asset_type: 'ResearchEvidenceAsset', title: 'Result', summary: 'Result', payload: { payload_kind: 'text', media_type: 'text/plain', content: 'result', files: [] }, evidence_refs: [], consumed_input_versions: [] }], warnings: []
  };
}
