import fs from 'node:fs';
import { createCleanRuntime } from '../../apps/api/src/clean/runtime.mjs';
import { DeterministicAppServerAdapter } from '../../apps/api/src/clean/app-server-adapter.mjs';
import { DeterministicRunnerAdapter } from '../../apps/api/src/clean/runner-adapters.mjs';
import { DeterministicGitHubAdapter } from '../../apps/api/src/clean/p8/github-adapter.mjs';
import { canonicalJson, sha256Hex } from '../../apps/api/src/clean/canonical.mjs';
import { fixture as p7Fixture, prepare as p7Prepare, listen, closeServer, waitOperation } from '../p7/helpers.mjs';

export function fixture(overrides = {}) {
  return p7Fixture({ runtimeBuild: 'p8-test', ...overrides });
}

export async function open(options = {}) {
  const { config: configOverrides = {}, githubAdapter = new DeterministicGitHubAdapter(), ...runtimeOptions } = options;
  const state = fixture(configOverrides);
  const runner = new DeterministicRunnerAdapter();
  const runtime = createCleanRuntime({
    config: state.config,
    targetVersion: 8,
    providerAdapter: new DeterministicAppServerAdapter(),
    runnerAdapters: { host: runner, docker: runner, windows_bridge: runner },
    runnerRetryDelays: [0, 0], parserRetryDelays: [0, 0], githubAdapter,
    ...runtimeOptions
  });
  await runtime.recovery;
  const setup = await runtime.identity.setupComplete({ display_name: 'P8 Owner', team_name: 'P8 Team', idempotency_key: 'p8-setup-key' });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  return { ...state, runtime, principal, proof: setup.session.proof, githubAdapter };
}

export async function prepare(state, suffix = 'flow') {
  const base = await p7Prepare(state, suffix);
  const started = await state.runtime.execution.start(base.execution.id, { expected_revision: base.execution.revision, idempotency_key: `p8-${suffix}-execution-start` }, state.principal);
  await waitOperation(state.runtime, started.operation.operation_id, state.principal.actorId);
  base.execution = state.runtime.execution.get(base.execution.id, state.principal);
  const captured = await state.runtime.evidence.capture({ project_id: base.project.id, execution_id: base.execution.id, logical_name: 'delivery.json', asset_kind: 'execution_output', source_type: 'manual', source_ref: `fixture:${suffix}`, media_type: 'application/json', content_base64: Buffer.from('{"delivery":true}').toString('base64'), expected_revision: 0, idempotency_key: `p8-${suffix}-asset` }, state.principal);
  await state.runtime.project.createOutcomeRequirement(base.project.id, { requirement_key: `delivery-${suffix}`, rubric: { evaluator: 'evidence_count', minimum: 1 }, workflow_revision: 1, idempotency_key: `p8-${suffix}-requirement` }, state.principal);
  const execution = state.runtime.execution.get(base.execution.id, state.principal);
  const evaluation = await state.runtime.outcomeEvaluation.evaluate(execution.id, { expected_revision: execution.revision, idempotency_key: `p8-${suffix}-outcome` }, state.principal);
  await waitOperation(state.runtime, evaluation.operation.operation_id, state.principal.actorId);
  return { ...base, asset: captured.asset, execution: state.runtime.execution.get(execution.id, state.principal) };
}

export async function approved(state, projectId, action, request = {}, suffix = action.replaceAll('.', '-')) {
  const created = await state.runtime.assist.createApproval({ project_id: projectId, action, request, expected_revision: 0, idempotency_key: `p8-${suffix}-approval` }, state.principal);
  const decided = await state.runtime.assist.decideApproval(created.approval.id, { decision: 'approved', expected_revision: created.approval.revision, idempotency_key: `p8-${suffix}-decision` }, state.principal);
  return decided.approval;
}

export async function githubProfile(state, suffix = 'delivery') {
  const proof = JSON.stringify({ app_id: '1234', installation_id: '5678', private_key: 'fixture-key', webhook_secret: 'fixture-webhook-secret' });
  const credential = await state.runtime.identity.createCredential({ provider: 'github', external_ref: `${suffix}-github`, idempotency_key: `p8-${suffix}-github-credential` }, state.principal);
  await state.runtime.identity.rebindCredential(credential.credential.id, { proof, expected_revision: 1, idempotency_key: `p8-${suffix}-github-rebind` }, state.principal);
  const profile = await state.runtime.identity.createProfile({ provider: 'github', label: `GitHub ${suffix}`, credential_ref_id: credential.credential.id, config: { app_id: '1234', installation_id: '5678', origin_repository: 'fixture/origin', fixture_repository: 'fixture/delivery-target' }, idempotency_key: `p8-${suffix}-github-profile` }, state.principal);
  await state.runtime.db.run("UPDATE provider_profiles SET status='available' WHERE id=?", [profile.profile.id]);
  return state.runtime.db.get('SELECT * FROM provider_profiles WHERE id=?', [profile.profile.id]);
}

export async function prepareDelivery(state, suffix = 'delivery') {
  const base = await prepare(state, suffix);
  const profile = await githubProfile(state, suffix);
  const connection = state.runtime.db.get('SELECT * FROM repository_connections WHERE project_id=?', [base.project.id]);
  const metadataJson = canonicalJson({ github_profile_id: profile.id, repository_full_name: 'fixture/delivery-target' });
  state.runtime.db.run("UPDATE repository_connections SET provider='git',credential_ref_id=?,source_locator='fixture/delivery-target',metadata_json=?,metadata_sha256=? WHERE id=?", [profile.credential_ref_id, metadataJson, sha256Hex(metadataJson), connection.id]);
  const target = state.runtime.db.get('SELECT * FROM repository_targets WHERE connection_id=?', [connection.id]);
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  state.runtime.db.run('UPDATE repository_targets SET remote_ref=?,expected_head_sha=? WHERE id=?', ['fixture/delivery-target', baseSha, target.id]);
  const project = state.runtime.db.get('SELECT * FROM projects WHERE id=?', [base.project.id]);
  const policy = await state.runtime.p8Service.createPolicy(base.project.id, { name: 'Protected main', required_checks: ['ci'], approval_policy: { merge: 'owner' }, expected_revision: project.revision, idempotency_key: `p8-${suffix}-policy` }, state.principal);
  const execution = state.runtime.execution.get(base.execution.id, state.principal);
  const submitted = await state.runtime.p8Service.submit({ execution_id: execution.id, policy_id: policy.policy.id, repository_target_id: target.id, target_head_sha: baseSha, expected_revision: execution.revision, idempotency_key: `p8-${suffix}-submit` }, state.principal);
  const patch = state.runtime.cas.put(Buffer.from(`patch:${suffix}`), { mediaType: 'application/octet-stream' });
  return { base, profile, target, delivery: submitted.delivery, patch, baseSha, headSha };
}

export async function close(state) {
  try { await state.runtime?.close?.(); } finally { fs.rmSync(state.root, { recursive: true, force: true }); }
}

export { closeServer, listen, waitOperation };
