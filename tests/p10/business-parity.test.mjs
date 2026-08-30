import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createFakeProviderAdapters } from '../../apps/api/src/clean/provider-adapters.mjs';
import { createAssistPrerequisites, createWorkspace } from '../p5/helpers.mjs';
import { close, open, secondPrincipal, waitOperation } from './helpers.mjs';

test('Provider lifecycle and Brief templates preserve revision CAS and immutable snapshots', async () => {
  const state = await open();
  try {
    const credential = await state.runtime.identity.createCredential({ provider: 'codex', external_ref: 'p10-provider', idempotency_key: 'p10-provider-credential' }, state.principal);
    await state.runtime.identity.rebindCredential(credential.credential.id, { proof: 'p10-provider-proof-123456789', expected_revision: 1, idempotency_key: 'p10-provider-rebind' }, state.principal);
    const created = await state.runtime.identity.createProfile({ provider: 'codex', label: 'Primary', credential_ref_id: credential.credential.id, config: { model: 'fixture' }, idempotency_key: 'p10-profile-create' }, state.principal);
    assert.equal(created.profile.lifecycle_status, 'enabled');
    const updated = await state.runtime.identity.updateProfile(created.profile.id, { label: 'Review profile', config: { model: 'fixture-2' }, expected_revision: 1, idempotency_key: 'p10-profile-update' }, state.principal);
    assert.equal(updated.profile.revision, 2);
    const disabled = await state.runtime.identity.disableProfile(created.profile.id, { expected_revision: 2, idempotency_key: 'p10-profile-disable' }, state.principal);
    assert.equal(disabled.profile.lifecycle_status, 'disabled');
    await assert.rejects(state.runtime.identity.probeProfile(created.profile.id, { expected_revision: 3, idempotency_key: 'p10-profile-disabled-probe' }, state.principal), (error) => error.code === 'profile_disabled');
    const enabled = await state.runtime.identity.enableProfile(created.profile.id, { expected_revision: 3, idempotency_key: 'p10-profile-enable' }, state.principal);
    assert.equal(enabled.profile.lifecycle_status, 'enabled');

    const project = await state.runtime.project.createProject({ name: 'Template Project', idempotency_key: 'p10-template-project' }, state.principal);
    const template = await state.runtime.p10Service.createBriefTemplate({ team_id: project.team_id, name: 'Delivery Brief', content: { sections: ['objective','acceptance'] }, expected_revision: 0, idempotency_key: 'p10-template-create' }, state.principal);
    const revised = await state.runtime.p10Service.updateBriefTemplate(template.template.id, { content: { sections: ['objective','constraints','acceptance'] }, expected_revision: 1, idempotency_key: 'p10-template-update' }, state.principal);
    assert.equal(revised.template.current_revision, 2);
    const parallel = await state.runtime.p10Service.createBriefTemplate({ team_id: project.team_id, name: 'Parallel Brief', content: revised.template.content, expected_revision: 0, idempotency_key: 'p10-template-parallel' }, state.principal);
    assert.notEqual(parallel.template.id, template.template.id);
    assert.equal(parallel.template.content_sha256, revised.template.content_sha256);
    const brief = await state.runtime.project.createBrief(project.id, { objective: 'Ship parity', acceptance: ['verified'], template_id: template.template.id, template_revision: 2, expected_revision: 1, idempotency_key: 'p10-template-brief' }, state.principal);
    assert.deepEqual({ id: brief.revision_record.template_id, revision: brief.revision_record.template_revision, sha256: brief.revision_record.template_sha256 }, { id: template.template.id, revision: 2, sha256: revised.template.content_sha256 });
    assert.throws(() => state.runtime.p10Service.updateBriefTemplate(template.template.id, { content: {}, expected_revision: 1, idempotency_key: 'p10-template-stale' }, state.principal), (error) => error.code === 'revision_conflict');
    const archived = await state.runtime.p10Service.archiveBriefTemplate(template.template.id, { expected_revision: 2, idempotency_key: 'p10-template-archive' }, state.principal);
    assert.equal(archived.template.status, 'archived');
  } finally { await close(state); }
});

test('real Provider probing passes the bound credential only as a zeroable lease', async () => {
  const proof = 'p10-bound-provider-credential-123456789';
  const observed = [];
  const providers = {
    ...createFakeProviderAdapters(),
    codex: {
      requiresCredentialLease: true,
      async probe({ credential }) {
        assert.ok(Buffer.isBuffer(credential));
        observed.push(createHash('sha256').update(credential).digest('hex'));
        return { available: true, provider: 'codex', adapter: 'credential-lease-probe' };
      }
    }
  };
  const state = await open({ runtime: { providerAdapters: providers } });
  try {
    const credential = await state.runtime.identity.createCredential({ provider: 'codex', external_ref: 'p10-bound-provider', idempotency_key: 'p10-bound-provider-create' }, state.principal);
    await state.runtime.identity.rebindCredential(credential.credential.id, { proof, expected_revision: 1, idempotency_key: 'p10-bound-provider-rebind' }, state.principal);
    const profile = await state.runtime.identity.createProfile({ provider: 'codex', label: 'Bound provider', credential_ref_id: credential.credential.id, idempotency_key: 'p10-bound-provider-profile' }, state.principal);
    const operation = await state.runtime.identity.probeProfile(profile.profile.id, { expected_revision: profile.profile.revision, idempotency_key: 'p10-bound-provider-probe' }, state.principal);
    assert.equal(operation.status, 'succeeded');
    assert.deepEqual(observed, [createHash('sha256').update(proof).digest('hex')]);
  } finally { await close(state); }
});

test('draft onboarding pins Brief before generation and activates only after proposal apply and confirmation', async () => {
  const state = await open();
  try {
    const project = await state.runtime.project.createProject({ name: 'Ordered onboarding', idempotency_key: 'p10-onboarding-project' }, state.principal);
    const intake = await state.runtime.project.submitIntake(project.id, { mode: 'brainstorm', content: { idea: 'ordered flow' }, expected_revision: 1, idempotency_key: 'p10-onboarding-intake' }, state.principal);
    await waitOperation(state.runtime, intake.operation.operation_id, state.principal.actorId);
    const brief = await state.runtime.project.createBrief(project.id, { content: { objective: 'Ship ordered onboarding', users: ['Owner'], scope: { in: ['Web'] }, constraints: ['CAS'], milestones: ['Ready'], acceptance: ['verified'], risks: ['drift'], open_questions: ['none'] }, expected_revision: 1, idempotency_key: 'p10-onboarding-brief' }, state.principal);
    const workflow = await state.runtime.project.reviseWorkflow(project.id, { graph: { nodes: [{ id: 'review', kind: 'workstream', title: 'Review' }] }, expected_revision: 1, idempotency_key: 'p10-onboarding-workflow' }, state.principal);
    let current = state.runtime.project.getProject(project.id, state.principal);
    assert.equal(current.status, 'draft');
    const started = await state.runtime.project.startGeneration(project.id, { candidate: { nodes: [{ id: 'deliver', kind: 'workstream', title: 'Deliver' }] }, expected_revision: current.revision, idempotency_key: 'p10-onboarding-generation' }, state.principal);
    await waitOperation(state.runtime, started.operation.operation_id, state.principal.actorId);
    const pending = state.runtime.project.listGenerations(project.id, state.principal)[0];
    assert.deepEqual({ revision: pending.source_brief_revision, hash: pending.source_brief_hash }, { revision: brief.revision_record.revision, hash: brief.revision_record.content_sha256 });
    const evaluated = await state.runtime.project.evaluateCritic(pending.id, { status: 'passed', issues: [], expected_revision: pending.revision, idempotency_key: 'p10-onboarding-critic' }, state.principal);
    const applied = await state.runtime.project.applyProposal(evaluated.proposal.id, { expected_revision: workflow.workflow.revision, idempotency_key: 'p10-onboarding-apply' }, state.principal);
    assert.equal(applied.proposal.status, 'applied');
    const appliedRevision = state.runtime.db.get('SELECT source_brief_revision,source_brief_hash FROM workflow_revisions WHERE proposal_id=?', [evaluated.proposal.id]);
    assert.deepEqual({ revision: appliedRevision.source_brief_revision, hash: appliedRevision.source_brief_hash }, { revision: brief.revision_record.revision, hash: brief.revision_record.content_sha256 });
    current = state.runtime.project.getProject(project.id, state.principal);
    assert.equal(current.status, 'draft');
    const confirmed = await state.runtime.project.confirmBrief(project.id, { brief_revision: brief.revision_record.revision, expected_revision: current.revision, idempotency_key: 'p10-onboarding-confirm' }, state.principal);
    assert.equal(confirmed.project.status, 'active');
    assert.equal(confirmed.project.onboarding_state, 'confirmed');
  } finally { await close(state); }
});

test('proposal apply marks a draft-Brief generation stale when the source revision drifts', async () => {
  const state = await open();
  try {
    const project = await state.runtime.project.createProject({ name: 'Brief drift', idempotency_key: 'p10-drift-project' }, state.principal);
    const intake = await state.runtime.project.submitIntake(project.id, { mode: 'brainstorm', expected_revision: 1, idempotency_key: 'p10-drift-intake' }, state.principal);
    await waitOperation(state.runtime, intake.operation.operation_id, state.principal.actorId);
    await state.runtime.project.createBrief(project.id, { objective: 'Original', acceptance: ['one'], expected_revision: 1, idempotency_key: 'p10-drift-brief-one' }, state.principal);
    const workflow = await state.runtime.project.reviseWorkflow(project.id, { graph: { nodes: [{ id: 'one', kind: 'workstream', title: 'One' }] }, expected_revision: 1, idempotency_key: 'p10-drift-workflow' }, state.principal);
    let current = state.runtime.project.getProject(project.id, state.principal);
    const started = await state.runtime.project.startGeneration(project.id, { candidate: { nodes: [{ id: 'two', kind: 'workstream', title: 'Two' }] }, expected_revision: current.revision, idempotency_key: 'p10-drift-generation' }, state.principal);
    await waitOperation(state.runtime, started.operation.operation_id, state.principal.actorId);
    const pending = state.runtime.project.listGenerations(project.id, state.principal)[0];
    const evaluated = await state.runtime.project.evaluateCritic(pending.id, { status: 'passed', issues: [], expected_revision: pending.revision, idempotency_key: 'p10-drift-critic' }, state.principal);
    current = state.runtime.project.getProject(project.id, state.principal);
    await state.runtime.project.createBrief(project.id, { objective: 'Changed', acceptance: ['two'], expected_revision: current.revision, idempotency_key: 'p10-drift-brief-two' }, state.principal);
    await assert.rejects(state.runtime.project.applyProposal(evaluated.proposal.id, { expected_revision: workflow.workflow.revision, idempotency_key: 'p10-drift-apply' }, state.principal), (error) => error.code === 'workflow_proposal_stale' && error.details.source_brief_revision === 1 && error.details.brief_revision === 2);
    assert.equal(state.runtime.project.getProposal(evaluated.proposal.id, state.principal).status, 'stale');
  } finally { await close(state); }
});

test('Project deletion rechecks blockers and tombstones only after confirmation', async () => {
  const state = await open();
  try {
    const clean = await state.runtime.project.createProject({ name: 'Disposable Project', idempotency_key: 'p10-delete-project' }, state.principal);
    const prepared = await state.runtime.p10Service.prepareProjectDeletion(clean.id, { target_name: clean.name, expected_revision: clean.revision, idempotency_key: 'p10-project-delete-prepare' }, state.principal);
    const confirmed = await state.runtime.p10Service.confirmProjectDeletion(prepared.intent.id, { target_name: clean.name, expected_revision: 1, idempotency_key: 'p10-project-delete-confirm' }, state.principal);
    assert.equal(confirmed.intent.status, 'ready');
    const completed = await state.runtime.p10Service.executeProjectDeletion(prepared.intent.id, { expected_revision: 2, idempotency_key: 'p10-project-delete-execute' }, state.principal);
    assert.equal(completed.intent.status, 'completed');
    const row = state.runtime.db.get('SELECT status,deleted_at FROM projects WHERE id=?', [clean.id]);
    assert.equal(row.status, 'archived');
    assert.ok(row.deleted_at);

    const blockedProject = await state.runtime.project.createProject({ name: 'Busy Project', idempotency_key: 'p10-busy-project' }, state.principal);
    const workspace = await createWorkspace(state, blockedProject, 'p10-busy');
    const prerequisites = await createAssistPrerequisites(state, blockedProject, 'p10-busy');
    await state.runtime.assist.createSession({ project_id: blockedProject.id, scope: 'project', scope_id: blockedProject.id, context_pack_id: prerequisites.pack.id, profile_id: prerequisites.profile.id, repository_workspace_id: workspace.workspace.id, idempotency_key: 'p10-busy-assist' }, state.principal);
    const latestProject = state.runtime.db.get('SELECT * FROM projects WHERE id=?', [blockedProject.id]);
    const blockedPrepare = await state.runtime.p10Service.prepareProjectDeletion(blockedProject.id, { target_name: blockedProject.name, expected_revision: latestProject.revision, idempotency_key: 'p10-busy-delete-prepare' }, state.principal);
    const blocked = await state.runtime.p10Service.confirmProjectDeletion(blockedPrepare.intent.id, { target_name: blockedProject.name, expected_revision: 1, idempotency_key: 'p10-busy-delete-confirm' }, state.principal);
    assert.equal(blocked.intent.status, 'blocked');
    assert.deepEqual(blocked.intent.blockers.map((item) => item.domain), ['assist']);
  } finally { await close(state); }
});

test('Repository deletion requires name, HEAD, revision, and two independent session proofs', async () => {
  const state = await open();
  try {
    const project = await state.runtime.project.createProject({ name: 'Repository Delete', idempotency_key: 'p10-repo-project' }, state.principal);
    await state.runtime.project.createRepositoryConnection(project.id, { provider: 'fixture', source_kind: 'git', source_locator: 'fixture/delete-target', source_revision: 'a'.repeat(40), source_hash: 'b'.repeat(64), idempotency_key: 'p10-repo-connection' }, state.principal);
    const target = state.runtime.db.get('SELECT t.* FROM repository_targets t JOIN repository_connections c ON c.id=t.connection_id WHERE c.project_id=?', [project.id]);
    const prepared = await state.runtime.p10Service.prepareRepositoryDeletion(target.id, { target_full_name: 'fixture/delete-target', expected_head_sha: 'a'.repeat(40), expected_revision: target.revision, idempotency_key: 'p10-repo-delete-prepare' }, state.principal);
    const creator = await state.runtime.p10Service.confirmRepositoryDeletion(prepared.intent.id, 'creator', { target_full_name: 'fixture/delete-target', expected_head_sha: 'a'.repeat(40), expected_revision: 1, idempotency_key: 'p10-repo-delete-creator' }, state.principal);
    assert.equal(creator.intent.status, 'creator_confirmed');
    assert.throws(() => state.runtime.p10Service.confirmRepositoryDeletion(prepared.intent.id, 'owner', { target_full_name: 'fixture/delete-target', expected_head_sha: 'a'.repeat(40), expected_revision: 2, idempotency_key: 'p10-repo-delete-same-session' }, state.principal), (error) => error.code === 'independent_session_required');
    const second = await secondPrincipal(state);
    const ready = await state.runtime.p10Service.confirmRepositoryDeletion(prepared.intent.id, 'owner', { target_full_name: 'fixture/delete-target', expected_head_sha: 'a'.repeat(40), expected_revision: 2, idempotency_key: 'p10-repo-delete-owner' }, second);
    assert.equal(ready.intent.status, 'ready');
    const completed = await state.runtime.p10Service.executeRepositoryDeletion(prepared.intent.id, { expected_revision: 3, idempotency_key: 'p10-repo-delete-execute' }, second);
    assert.equal(completed.intent.status, 'completed');
    assert.equal(state.repositoryDeletionAdapter.calls.at(-1).action, 'delete');
    const line = state.runtime.db.get('SELECT status FROM repository_lines WHERE target_id=?', [target.id]);
    assert.equal(line.status, 'removed');
  } finally { await close(state); }
});

test('Assist metadata, fork, side-thread, review comments, and reversible deletion reuse the shared ledger', async () => {
  const state = await open();
  try {
    const project = await state.runtime.project.createProject({ name: 'Assist Lifecycle', idempotency_key: 'p10-assist-project' }, state.principal);
    const workspace = await createWorkspace(state, project, 'p10-assist');
    const prerequisites = await createAssistPrerequisites(state, project, 'p10-assist');
    const created = await state.runtime.assist.createSession({ project_id: project.id, scope: 'project', scope_id: project.id, context_pack_id: prerequisites.pack.id, profile_id: prerequisites.profile.id, repository_workspace_id: workspace.workspace.id, title: 'Primary review', mode: 'guided', idempotency_key: 'p10-assist-create' }, state.principal);
    const metadata = await state.runtime.p10Service.updateAssistSession(created.session.id, { title: 'Pinned review', pinned: true, expected_revision: 1, idempotency_key: 'p10-assist-metadata' }, state.principal);
    assert.equal(metadata.session.title, 'Pinned review');
    assert.ok(metadata.session.pinned_at);
    const archived = await state.runtime.p10Service.archiveAssistSession(created.session.id, { expected_revision: 2, idempotency_key: 'p10-assist-archive' }, state.principal);
    const restored = await state.runtime.p10Service.restoreAssistSession(created.session.id, { expected_revision: archived.session.revision, idempotency_key: 'p10-assist-restore' }, state.principal);
    const fork = await state.runtime.p10Service.forkAssistSession(created.session.id, { title: 'Review fork', expected_revision: restored.session.revision, idempotency_key: 'p10-assist-fork' }, state.principal);
    assert.equal(fork.session.parent_session_id, created.session.id);
    const side = await state.runtime.p10Service.forkAssistSession(created.session.id, { title: 'Side question', expected_revision: restored.session.revision, idempotency_key: 'p10-assist-side' }, state.principal, 'side_thread');
    assert.equal(side.session.mode, 'side_thread');

    const operation = await state.runtime.assist.createTurn({ session_id: created.session.id, message: 'Review this change', expected_revision: restored.session.revision, idempotency_key: 'p10-assist-turn' }, state.principal);
    await waitOperation(state.runtime, operation.operation_id, state.principal.actorId);
    const turn = state.runtime.db.get('SELECT * FROM assist_turns WHERE session_id=? ORDER BY turn_no DESC LIMIT 1', [created.session.id]);
    const comment = await state.runtime.p10Service.createAssistReviewComment(turn.id, { content: 'Please tighten the validation.', relative_path: 'src/index.mjs', line_number: 12, expected_revision: turn.revision, idempotency_key: 'p10-assist-comment' }, state.principal);
    assert.equal(comment.comment.content, 'Please tighten the validation.');
    const request = await state.runtime.p10Service.createAssistReviewComment(turn.id, { content: 'Address the review before apply.', expected_revision: turn.revision, idempotency_key: 'p10-assist-request' }, state.principal, 'request_changes');
    assert.equal(request.comment.kind, 'request_changes');
    assert.equal(state.runtime.p10Service.listAssistReviewComments(turn.id, state.principal).comments.length, 2);

    const current = state.runtime.db.get('SELECT * FROM assist_sessions WHERE id=?', [created.session.id]);
    const deleted = await state.runtime.p10Service.deleteAssistSession(created.session.id, { expected_revision: current.revision, idempotency_key: 'p10-assist-delete' }, state.principal);
    assert.ok(deleted.session.deleted_at);
    const recovered = await state.runtime.p10Service.restoreDeletedAssistSession(created.session.id, { expected_revision: deleted.session.revision, idempotency_key: 'p10-assist-restore-delete' }, state.principal);
    assert.equal(recovered.session.deleted_at, null);
    assert.equal(state.runtime.db.get("SELECT count(*) AS n FROM operations WHERE command_id LIKE 'assist.%'").n > 0, true);
  } finally { await close(state); }
});
