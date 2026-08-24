import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCleanRuntime } from '../../apps/api/src/clean/runtime.mjs';
import { createCleanHttpHandler } from '../../apps/api/src/clean/http.mjs';
import { DeterministicAppServerAdapter } from '../../apps/api/src/clean/app-server-adapter.mjs';

export function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p5-'));
  return {
    root,
    config: {
      runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: root,
      workspaceRoot: path.join(root, 'workspaces'), databaseFile: path.join(root, 'data', 'state.sqlite'),
      casRoot: path.join(root, 'cas'), receiptRoot: path.join(root, 'receipts'), vaultRoot: path.join(root, 'vault'),
      cursorSecret: 'p5-cursor-fixture-secret', sessionSecret: 'p5-session-fixture-secret',
      vaultMasterKey: 'p5-vault-master-fixture-secret', mcpPepper: 'p5-mcp-pepper-fixture-secret',
      gatewaySecret: 'p5-gateway-fixture-secret', gatewayId: 'gateway-p5-test',
      runtimeBuild: 'p5-test', maxBodyBytes: 12 * 1024 * 1024, ...overrides
    }
  };
}

export async function open(overrides = {}) {
  const { config: configOverrides = {}, ...runtimeOverrides } = overrides;
  const state = fixture(configOverrides);
  const runtime = createCleanRuntime({ config: state.config, targetVersion: 5, providerAdapter: new DeterministicAppServerAdapter(), ...runtimeOverrides });
  await runtime.recovery;
  const setup = await runtime.identity.setupComplete({ display_name: 'P5 Owner', team_name: 'P5 Team', idempotency_key: 'p5-setup-key' });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  return { ...state, runtime, principal, proof: setup.session.proof };
}

export async function createProject(state, suffix = 'fixture') {
  return state.runtime.project.createProject({ name: `P5 ${suffix}`, idempotency_key: `p5-${suffix}-project-key` }, state.principal);
}

export async function createWorkspace(state, project, suffix = 'workspace') {
  await state.runtime.project.createRepositoryConnection(project.id, {
    provider: 'fixture', source_kind: 'git', source_locator: `fixture/${suffix}`,
    source_revision: 'r1', source_hash: 'a'.repeat(64), idempotency_key: `p5-${suffix}-connection-key`
  }, state.principal);
  const line = state.runtime.project.listRepositoryLines(project.id, state.principal)[0];
  await state.runtime.project.reconcileRepositoryLine(line.id, {
    source_revision: 'r1', source_hash: 'a'.repeat(64), expected_revision: 1,
    idempotency_key: `p5-${suffix}-line-key`
  }, state.principal);
  const created = await state.runtime.project.createRepositoryWorkspace(project.id, {
    line_id: line.id, expected_revision: 0, idempotency_key: `p5-${suffix}-workspace-key`
  }, state.principal);
  const workspace = state.runtime.db.get('SELECT * FROM repository_workspaces WHERE id=?', [created.workspace.id]);
  const directory = state.runtime.files.workspaceDirectory(workspace);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { workspace, directory };
}

export async function createAssistPrerequisites(state, project, suffix = 'assist', profileConfig = {}) {
  await state.runtime.context.createSource(project.id, {
    kind: 'note', title: 'P5 context', uri: `notes/${suffix}`, content: 'bounded assist context',
    idempotency_key: `p5-${suffix}-source-key`
  }, state.principal);
  await state.runtime.context.rebuild(project.id, { idempotency_key: `p5-${suffix}-rebuild-key` }, state.principal);
  const selection = await state.runtime.context.createSelection(project.id, {
    query: 'assist', token_budget: 256, idempotency_key: `p5-${suffix}-selection-key`
  }, state.principal);
  const pack = await state.runtime.context.createPack(project.id, {
    selection_id: selection.selection.id, require_authoritative: false,
    idempotency_key: `p5-${suffix}-pack-key`
  }, state.principal);
  const credential = await state.runtime.identity.createCredential({
    provider: 'codex', external_ref: `${suffix}-fixture-ref`, idempotency_key: `p5-${suffix}-credential-key`
  }, state.principal);
  await state.runtime.identity.rebindCredential(credential.credential.id, {
    proof: `${suffix}-provider-proof-value-12345`, expected_revision: 1,
    idempotency_key: `p5-${suffix}-rebind-key`
  }, state.principal);
  const profile = await state.runtime.identity.createProfile({
    provider: 'codex', label: 'Default', credential_ref_id: credential.credential.id,
    config: profileConfig,
    idempotency_key: `p5-${suffix}-profile-key`
  }, state.principal);
  await state.runtime.identity.probeProfile(profile.profile.id, {
    expected_revision: 1, idempotency_key: `p5-${suffix}-probe-key`
  }, state.principal);
  return { pack: pack.pack, profile: state.runtime.db.get('SELECT * FROM provider_profiles WHERE id=?', [profile.profile.id]), credential: credential.credential };
}

export async function waitForOperation(runtime, operationId, actorId, timeout = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const operation = runtime.operations.get(operationId, { actorId });
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(operation.status)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`operation_timeout:${operationId}`);
}

export async function listen(runtime) {
  const handler = createCleanHttpHandler({ runtime, registry: runtime.registry, maxBodyBytes: runtime.config.maxBodyBytes });
  const server = http.createServer((request, response) => void Promise.resolve(handler(request, response)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export async function close(state) {
  try { await state.runtime?.close?.(); } finally { fs.rmSync(state.root, { recursive: true, force: true }); }
}

export async function closeServer(server) {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
}
