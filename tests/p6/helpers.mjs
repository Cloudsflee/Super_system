import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCleanRuntime } from '../../apps/api/src/clean/runtime.mjs';
import { createCleanHttpHandler } from '../../apps/api/src/clean/http.mjs';
import { DeterministicAppServerAdapter } from '../../apps/api/src/clean/app-server-adapter.mjs';
import { DeterministicRunnerAdapter } from '../../apps/api/src/clean/runner-adapters.mjs';

export function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p6-'));
  return { root, config: { runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: root, workspaceRoot: path.join(root, 'workspaces'), databaseFile: path.join(root, 'data', 'state.sqlite'), casRoot: path.join(root, 'cas'), receiptRoot: path.join(root, 'receipts'), vaultRoot: path.join(root, 'vault'), runnerHomeRoot: path.join(root, 'runner-homes'), cursorSecret: 'p6-test-cursor-secret', sessionSecret: 'p6-test-session-secret', vaultMasterKey: 'p6-test-vault-master-secret', mcpPepper: 'p6-test-mcp-pepper', gatewaySecret: 'p6-test-gateway-secret', runnerBrokerSecret: 'p6-test-broker-secret', runnerPollIntervalMs: 1, runtimeBuild: 'p6-test', maxBodyBytes: 12 * 1024 * 1024, ...overrides } };
}

export async function open(options = {}) {
  const { adapter = new DeterministicRunnerAdapter(), config: configOverrides = {}, ...runtimeOptions } = options;
  const state = fixture(configOverrides); const runtime = createCleanRuntime({ config: state.config, targetVersion: 6, providerAdapter: new DeterministicAppServerAdapter(), runnerAdapters: { host: adapter, docker: adapter, windows_bridge: adapter }, runnerRetryDelays: [0, 0], ...runtimeOptions });
  await runtime.recovery; const setup = await runtime.identity.setupComplete({ display_name: 'P6 Owner', team_name: 'P6 Team', idempotency_key: 'p6-setup-key' }); const principal = runtime.identity.authenticateProof(setup.session.proof);
  return { ...state, runtime, principal, proof: setup.session.proof, adapter };
}

export async function prepare(state, suffix = 'flow', tasks = null) {
  const { runtime, principal } = state; const project = await runtime.project.createProject({ name: `P6 ${suffix}`, idempotency_key: `p6-${suffix}-project` }, principal);
  const intake = await runtime.project.submitIntake(project.id, { mode: 'brainstorm', content: { objective: 'bounded execution fixture' }, expected_revision: 1, idempotency_key: `p6-${suffix}-intake` }, principal); await waitOperation(runtime, intake.operation.operation_id, principal.actorId);
  await runtime.project.createBrief(project.id, { objective: 'execute the approved plan', acceptance: ['receipts'], expected_revision: 1, idempotency_key: `p6-${suffix}-brief` }, principal);
  await runtime.project.confirmBrief(project.id, { brief_revision: 1, expected_revision: 2, idempotency_key: `p6-${suffix}-confirm` }, principal);
  await runtime.project.createRepositoryConnection(project.id, { provider: 'fixture', source_kind: 'git', source_locator: `fixture/${suffix}`, idempotency_key: `p6-${suffix}-connection` }, principal);
  const line = runtime.project.listRepositoryLines(project.id, principal)[0]; await runtime.project.reconcileRepositoryLine(line.id, { source_revision: 'r1', source_hash: 'a'.repeat(64), expected_revision: 1, idempotency_key: `p6-${suffix}-line` }, principal);
  const workspaceResult = await runtime.project.createRepositoryWorkspace(project.id, { line_id: line.id, expected_revision: 0, idempotency_key: `p6-${suffix}-workspace` }, principal); const workspace = runtime.db.get('SELECT * FROM repository_workspaces WHERE id=?', [workspaceResult.workspace.id]); const directory = runtime.files.workspaceDirectory(workspace); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(directory, 'README.md'), '# fixture\n');
  await runtime.project.reviseWorkflow(project.id, { graph: { nodes: [{ id: 'stream', kind: 'workstream', title: 'Stream' }, { id: 'inspect', parent_id: 'stream', kind: 'task', title: 'Inspect', contract: { acceptance: ['done'] } }] }, expected_revision: 1, idempotency_key: `p6-${suffix}-workflow` }, principal);
  await runtime.context.createSource(project.id, { kind: 'note', title: 'Execution context', uri: `notes/${suffix}`, content: 'bounded execution context', idempotency_key: `p6-${suffix}-source` }, principal); await runtime.context.rebuild(project.id, { idempotency_key: `p6-${suffix}-rebuild` }, principal);
  const selection = await runtime.context.createSelection(project.id, { query: 'execution', token_budget: 256, idempotency_key: `p6-${suffix}-selection` }, principal); const pack = await runtime.context.createPack(project.id, { selection_id: selection.selection.id, require_authoritative: false, idempotency_key: `p6-${suffix}-pack` }, principal);
  const createdProfile = await runtime.runner.createProfile({ label: `Host ${suffix}`, runner_type: 'host', expected_revision: 0, idempotency_key: `p6-${suffix}-profile` }, principal); const probe = await runtime.runner.probeProfile(createdProfile.profile.id, { expected_revision: createdProfile.profile.revision, idempotency_key: `p6-${suffix}-probe` }, principal); await waitOperation(runtime, probe.operation.operation_id, principal.actorId); const profile = runtime.db.get('SELECT * FROM runner_profiles WHERE id=?', [createdProfile.profile.id]);
  const projectRow = runtime.db.get('SELECT * FROM projects WHERE id=?', [project.id]); const planTasks = tasks || [{ id: 'inspect', mode: 'read', depends_on: [], input_paths: ['README.md'], output_paths: [], check_ids: ['node_test'] }];
  const created = await runtime.execution.create(project.id, { repository_workspace_id: workspace.id, context_pack_id: pack.pack.id, runner_profile_id: profile.id, tasks: planTasks, expected_revision: projectRow.revision, idempotency_key: `p6-${suffix}-execution` }, principal);
  return { project, workspace, directory, pack: pack.pack, profile, execution: created.execution };
}

export async function waitOperation(runtime, id, actorId, timeout = 5000) { const started = Date.now(); while (Date.now() - started < timeout) { const value = runtime.operations.get(id, { actorId }); if (['succeeded', 'failed', 'cancelled', 'expired'].includes(value.status)) return value; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error(`operation_timeout:${id}`); }
export async function listen(runtime) { const handler = createCleanHttpHandler({ runtime, registry: runtime.registry, maxBodyBytes: runtime.config.maxBodyBytes }); const server = http.createServer((request, response) => void Promise.resolve(handler(request, response))); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return { server, base: `http://127.0.0.1:${server.address().port}` }; }
export async function closeServer(server) { if (server?.listening) await new Promise((resolve) => server.close(resolve)); }
export async function close(state) { try { await state.runtime?.close?.(); } finally { fs.rmSync(state.root, { recursive: true, force: true }); } }
