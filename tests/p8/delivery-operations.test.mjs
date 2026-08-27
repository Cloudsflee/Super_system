import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../../apps/api/src/clean/canonical.mjs';
import { DeterministicGitHubAdapter } from '../../apps/api/src/clean/p8/github-adapter.mjs';
import { approved, close, githubProfile, open, prepare } from './helpers.mjs';

test('Delivery executes immutable Draft, ready and merge intents and synchronizes Repository baseline', async () => {
  const state = await open();
  try {
    const fixture = await deliveryFixture(state, 'delivery');
    const draftInput = {
      patch_cas_sha256: fixture.patch.hash, patch_sha256: fixture.patch.hash, base_sha: fixture.baseSha, head_sha: fixture.headSha,
      required_checks: ['ci'], expected_revision: fixture.delivery.revision, idempotency_key: 'p8-draft-intent'
    };
    const draft = await state.runtime.p8Service.createIntent(fixture.delivery.id, 'create_draft', draftInput, state.principal);
    assert.equal(draft.delivery.status, 'draft_pr');
    assert.equal(state.runtime.operations.get(draft.operation.operation_id, { actorId: state.principal.actorId }).status, 'succeeded');
    const callsAfterDraft = state.githubAdapter.calls.length;
    const replayedDraft = await state.runtime.p8Service.createIntent(fixture.delivery.id, 'create_draft', draftInput, state.principal);
    assert.equal(replayedDraft.replayed, true);
    assert.equal(replayedDraft.delivery.status, 'draft_pr');
    assert.equal(state.githubAdapter.calls.length, callsAfterDraft);

    const readyApproval = await approved(state, fixture.base.project.id, 'delivery.ready', { delivery_id: fixture.delivery.id }, 'ready');
    const ready = await state.runtime.p8Service.createIntent(fixture.delivery.id, 'mark_ready', {
      approval_id: readyApproval.id, required_checks: ['ci'], expected_revision: draft.delivery.revision, idempotency_key: 'p8-ready-intent'
    }, state.principal);
    assert.equal(ready.delivery.status, 'ready');

    const mergeApproval = await approved(state, fixture.base.project.id, 'delivery.merge', { delivery_id: fixture.delivery.id }, 'merge');
    const merged = await state.runtime.p8Service.createIntent(fixture.delivery.id, 'merge', {
      approval_id: mergeApproval.id, expected_base_sha: fixture.baseSha, expected_head_sha: fixture.headSha,
      expected_revision: ready.delivery.revision, idempotency_key: 'p8-merge-intent'
    }, state.principal);
    assert.equal(merged.delivery.status, 'merged');
    assert.equal(state.runtime.operations.get(fixture.delivery.operation_id, { actorId: state.principal.actorId }).status, 'succeeded');
    const target = state.runtime.db.get('SELECT expected_head_sha FROM repository_targets WHERE id=?', [fixture.target.id]);
    assert.equal(target.expected_head_sha, state.githubAdapter.pullRequests.get(1).merge_sha);
    assert.equal(state.runtime.db.get('SELECT COUNT(*) AS count FROM delivery_events WHERE delivery_id=?', [fixture.delivery.id]).count, state.runtime.db.get("SELECT COUNT(*) AS count FROM events WHERE aggregate_type IN ('delivery','pull_request_intent') AND project_id=? AND occurred_at>=?", [fixture.base.project.id, fixture.delivery.created_at]).count);
    await assert.rejects(() => state.runtime.p8Service.createIntent(fixture.delivery.id, 'merge', { approval_id: mergeApproval.id, expected_base_sha: fixture.baseSha, expected_head_sha: fixture.headSha, expected_revision: merged.delivery.revision, idempotency_key: 'p8-repeat-merge' }, state.principal), (error) => error.code === 'state_conflict');
  } finally { await close(state); }
});

test('unknown GitHub result enters needs_reconcile and a later reconcile resolves without replaying merge', async () => {
  class LostResponseGitHub extends DeterministicGitHubAdapter {
    async createDraft(auth, input) { await super.createDraft(auth, input); const error = new Error('response lost'); error.code = 'external_result_unknown'; error.status = 503; throw error; }
  }
  const adapter = new LostResponseGitHub();
  const state = await open({ githubAdapter: adapter });
  try {
    const fixture = await deliveryFixture(state, 'reconcile');
    await assert.rejects(() => state.runtime.p8Service.createIntent(fixture.delivery.id, 'create_draft', {
      patch_cas_sha256: fixture.patch.hash, patch_sha256: fixture.patch.hash, base_sha: fixture.baseSha, head_sha: fixture.headSha,
      required_checks: ['ci'], expected_revision: fixture.delivery.revision, idempotency_key: 'p8-lost-draft'
    }, state.principal), (error) => error.code === 'external_result_unknown');
    const unknown = state.runtime.db.get('SELECT * FROM deliveries WHERE id=?', [fixture.delivery.id]);
    assert.equal(unknown.status, 'needs_reconcile');
    const reconciled = await state.runtime.p8Service.createIntent(fixture.delivery.id, 'reconcile', {
      expected_revision: unknown.revision, idempotency_key: 'p8-reconcile-draft'
    }, state.principal);
    assert.equal(reconciled.delivery.status, 'draft_pr');
    assert.deepEqual(adapter.calls.map((call) => call.action), ['create_branch', 'create_draft', 'reconcile']);
  } finally { await close(state); }
});

test('raw GitHub webhook HMAC is deduplicated by provider delivery id', async () => {
  const state = await open();
  try {
    const fixture = await deliveryFixture(state, 'webhook');
    const payload = Buffer.from(JSON.stringify({ action: 'opened', repository: { full_name: 'fixture/delivery-target' }, pull_request: { number: 9, state: 'open', draft: true, merged: false, head: { ref: `aiws/deliveries/${fixture.delivery.id}`, sha: fixture.headSha }, base: { sha: fixture.baseSha }, updated_at: '2026-08-26T00:00:00.000Z' } }));
    const headers = { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'fixture-webhook-secret').update(payload).digest('hex')}`, 'x-github-event': 'pull_request', 'x-github-delivery': 'fixture-delivery-guid' };
    const first = await state.runtime.p8Service.receiveGithubWebhook(payload, headers);
    const second = await state.runtime.p8Service.receiveGithubWebhook(payload, headers);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.event_id, second.event_id);
    assert.equal(state.runtime.db.get("SELECT COUNT(*) AS count FROM events WHERE type='delivery.webhook.received' AND aggregate_id=?", [fixture.delivery.id]).count, 1);
  } finally { await close(state); }
});

test('physical CAS GC revalidates protection, moves bytes to recoverable trash and rolls back', async () => {
  const state = await open();
  try {
    const base = await prepare(state, 'gc');
    const object = state.runtime.cas.put(Buffer.from('unreferenced-p8-gc-object'));
    state.runtime.db.run("UPDATE cas_objects SET created_at='2000-01-01T00:00:00.000Z' WHERE sha256=?", [object.hash]);
    const plan = state.runtime.p8Service.gcPlan({ cutoff: '2026-01-01T00:00:00.000Z', limit: 100, expected_revision: 0, idempotency_key: 'p8-gc-plan-key' }, state.principal).plan;
    assert.ok(plan.candidates.includes(object.hash));
    const approval = await approved(state, base.project.id, 'cas.gc.apply', {}, 'gc-apply');
    const applied = await state.runtime.p8Service.gcApply({ plan, approval_id: approval.id, expected_revision: 0, idempotency_key: 'p8-gc-apply-key' }, state.principal);
    assert.equal(applied.receipt.status, 'applied');
    assert.equal(state.runtime.cas.has(object.hash), false);
    assert.equal(state.runtime.db.get('SELECT status FROM cas_objects WHERE sha256=?', [object.hash]).status, 'tombstoned');
    const rolledBack = state.runtime.p8Service.rollbackGc(plan.plan_sha256);
    assert.deepEqual(rolledBack, { restored: [object.hash], missing: [] });
    assert.equal(state.runtime.cas.has(object.hash), true);
    assert.equal(state.runtime.db.get('SELECT status FROM cas_objects WHERE sha256=?', [object.hash]).status, 'active');
  } finally { await close(state); }
});

async function deliveryFixture(state, suffix) {
  const base = await prepare(state, suffix);
  const profile = await githubProfile(state, suffix);
  const connection = state.runtime.db.get('SELECT * FROM repository_connections WHERE project_id=?', [base.project.id]);
  const metadata = { github_profile_id: profile.id, repository_full_name: 'fixture/delivery-target' };
  const metadataJson = canonicalJson(metadata);
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
