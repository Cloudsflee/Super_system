import { createHmac } from 'node:crypto';
import { GitHubAppAdapter } from '../apps/api/src/clean/p8/github-adapter.mjs';
import { approved, close, open, prepareDelivery } from '../tests/p8/helpers.mjs';
import { emitProbe } from './lib/v3-clean-p6-runner-probe.mjs';

await emitProbe('aiws.v3-clean.p8-github-delivery-probe.v2', async () => {
  const state = await open({ config: { runtimeBuild: 'v3-clean-p8-github-delivery-probe' } });
  try {
    const fixture = await prepareDelivery(state, 'github-probe');
    const draft = await state.runtime.p8Service.createIntent(fixture.delivery.id, 'create_draft', {
      patch_cas_sha256: fixture.patch.hash, patch_sha256: fixture.patch.hash, base_sha: fixture.baseSha, head_sha: fixture.headSha,
      required_checks: ['ci'], expected_revision: fixture.delivery.revision, idempotency_key: 'p8-github-probe-draft'
    }, state.principal);
    const readyApproval = await approved(state, fixture.base.project.id, 'delivery.ready', { delivery_id: fixture.delivery.id }, 'github-probe-ready');
    const ready = await state.runtime.p8Service.createIntent(fixture.delivery.id, 'mark_ready', { approval_id: readyApproval.id, required_checks: ['ci'], expected_revision: draft.delivery.revision, idempotency_key: 'p8-github-probe-ready' }, state.principal);
    const mergeApproval = await approved(state, fixture.base.project.id, 'delivery.merge', { delivery_id: fixture.delivery.id }, 'github-probe-merge');
    const merged = await state.runtime.p8Service.createIntent(fixture.delivery.id, 'merge', { approval_id: mergeApproval.id, expected_base_sha: fixture.baseSha, expected_head_sha: fixture.headSha, expected_revision: ready.delivery.revision, idempotency_key: 'p8-github-probe-merge' }, state.principal);

    const payload = Buffer.from(JSON.stringify({ action: 'closed', repository: { full_name: 'fixture/delivery-target' }, pull_request: { number: 1, state: 'closed', draft: false, merged: true, head: { ref: `aiws/deliveries/${fixture.delivery.id}`, sha: fixture.headSha }, base: { sha: fixture.baseSha }, merge_commit_sha: state.githubAdapter.pullRequests.get(1).merge_sha } }));
    const headers = { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'fixture-webhook-secret').update(payload).digest('hex')}`, 'x-github-event': 'pull_request', 'x-github-delivery': 'p8-probe-webhook' };
    const webhook = await state.runtime.p8Service.receiveGithubWebhook(payload, headers);
    const duplicate = await state.runtime.p8Service.receiveGithubWebhook(payload, headers);
    payload.fill(0);

    const external = await externalProbe();
    return {
      local: {
        branch_created: state.githubAdapter.calls.some((call) => call.action === 'create_branch'), draft_status: draft.delivery.status,
        ready_status: ready.delivery.status, merge_status: merged.delivery.status, webhook_accepted: webhook.accepted,
        webhook_deduplicated: duplicate.duplicate, baseline_sha: state.runtime.db.get('SELECT expected_head_sha FROM repository_targets WHERE id=?', [fixture.target.id]).expected_head_sha
      },
      external,
      provisional: external.status !== 'verified'
    };
  } finally { await close(state); }
});

async function externalProbe() {
  if (!process.env.AIWS_P8_GITHUB_APP_BUNDLE) return { status: 'missing', provisional: true };
  const bundle = JSON.parse(process.env.AIWS_P8_GITHUB_APP_BUNDLE);
  const privateKey = Buffer.from(String(bundle.private_key || ''), 'utf8');
  const adapter = new GitHubAppAdapter();
  const auth = { appId: bundle.app_id, installationId: bundle.installation_id, privateKey };
  try {
    const discovered = await adapter.listRepositories(auth, { limit: 100 });
    const repository = String(bundle.repository || '');
    if (!repository || repository.toLowerCase() === String(bundle.origin_repository || '').toLowerCase()) throw new Error('github_fixture_not_isolated');
    if (!discovered.repositories.some((item) => item.full_name.toLowerCase() === repository.toLowerCase())) throw new Error('github_fixture_not_discovered');
    if (!bundle.allow_merge) return { status: 'identity_verified', repository, discovery_count: discovered.repositories.length, provisional: true };
    const branch = String(bundle.branch || `aiws/p8-probe-${Date.now()}`);
    await adapter.createBranch(auth, { repository, branch, headSha: bundle.head_sha });
    const pull = await adapter.createDraft(auth, { repository, title: 'AIWS P8 delivery probe', body: 'P8 fixed-identity delivery verification', head: branch, base: bundle.base || 'main' });
    const checks = await adapter.checks(auth, { repository, ref: bundle.head_sha });
    const required = Array.isArray(bundle.required_checks) ? bundle.required_checks.map(String) : [];
    if (required.some((name) => !checks.some((check) => check.name === name && check.status === 'completed' && ['success', 'neutral', 'skipped'].includes(check.conclusion)))) throw new Error('github_required_checks_failed');
    await adapter.markReady(auth, { repository, pullNumber: pull.number });
    const merge = await adapter.merge(auth, { repository, pullNumber: pull.number, headSha: bundle.head_sha, method: 'squash' });
    const reconciled = await adapter.reconcile(auth, { repository, pullNumber: pull.number });
    if (!merge.merged || !reconciled.merged) throw new Error('github_merge_reconcile_failed');
    return { status: 'verified', repository, discovery_count: discovered.repositories.length, pull_number: pull.number, merge_sha: merge.sha, checks: required, provisional: false };
  } finally { privateKey.fill(0); }
}
