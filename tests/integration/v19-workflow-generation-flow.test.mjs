import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v19-generation-'));
process.env.AIWS_HOME = path.join(root, 'aiws-home');
process.env.NODE_ENV = 'test';

try {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const { createDraftProjectRecords } = await import('../../apps/api/src/project-lifecycle.mjs');
  const generation = await import('../../apps/api/src/workflow-generation-service.mjs');
  const { resolveWorkflowGenerationCwd } = await import('../../apps/api/src/workflow-generation-workspace.mjs');
  const { createCodexRunError, safeErrorDetail } = await import('../../apps/api/src/codex-run-diagnostics.mjs');
  await stateApi.ensureRuntime();
  const actor = stateApi.owner(await stateApi.readState());

  await assert.rejects(() => resolveWorkflowGenerationCwd(null), (error) => error?.payload?.error === 'workflow_generation_project_required');
  const timeoutError = createCodexRunError({ timed_out: true, timeout_ms: 120000, code: null, stderr: 'Reading input\nsk-0123456789abcdefghijklmnop' }, { failureCode: 'codex_workflow_generation_failed', timeoutCode: 'codex_workflow_generation_timeout' });
  const timeoutDetail = safeErrorDetail(timeoutError);
  assert.equal(timeoutError.code, 'codex_workflow_generation_timeout');
  assert.equal(timeoutDetail.timed_out, true);
  assert.equal(timeoutDetail.timeout_ms, 120000);
  assert.equal(timeoutDetail.exit_code, null);
  assert.equal(timeoutDetail.detail.includes('sk-0123456789abcdefghijklmnop'), false);

  const untouched = await addDraft('Research program', 'Produce an accepted evidence synthesis', actor, false, stateApi, createDraftProjectRecords);
  const draftRoot = await resolveWorkflowGenerationCwd(untouched.project);
  assert.equal(draftRoot, untouched.project.workspace_root);
  assert.equal(fs.statSync(draftRoot).isDirectory(), true, 'brainstorm generation creates its isolated managed root before Codex starts');
  fs.mkdirSync(untouched.project.repo_path, { recursive: true });
  assert.equal(await resolveWorkflowGenerationCwd(untouched.project), untouched.project.repo_path, 'an initialized managed repository remains the preferred generation context');
  const started = await generation.startWorkflowGeneration(untouched.project.id, { adapter: 'test' }, actor.id);
  assert.equal(started.idempotent, false);
  const repeated = await generation.startWorkflowGeneration(untouched.project.id, { adapter: 'test' }, actor.id);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.generation.id, started.generation.id);
  const completed = await waitForGeneration(generation, untouched.project.id, started.generation.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result_mode, 'applied_to_draft');
  assert.equal(completed.candidate.project_classification, 'knowledge_or_manual_delivery');
  assert.equal(completed.candidate.nodes.filter((item) => item.role === 'workstream').length, 1);
  assert.equal(completed.candidate.nodes.some((item) => item.role === 'workstream' && /coding|testing|design/i.test(item.title)), false);
  const untouchedState = await stateApi.readState(), untouchedDraft = untouchedState.workflow_drafts.find((item) => item.project_id === untouched.project.id);
  assert.equal(untouchedDraft.nodes.length, 2);
  assert.equal(untouchedDraft.user_modified_at, null);

  const edited = await addDraft('Editorial program', 'Publish an accepted editorial package', actor, true, stateApi, createDraftProjectRecords);
  const editedStarted = await generation.startWorkflowGeneration(edited.project.id, { adapter: 'test' }, actor.id);
  const diff = await waitForGeneration(generation, edited.project.id, editedStarted.generation.id);
  assert.equal(diff.status, 'completed');
  assert.equal(diff.result_mode, 'diff');
  assert.equal(diff.diff.current_nodes[0].id, 'manual-node');
  let editedState = await stateApi.readState(), editedDraft = editedState.workflow_drafts.find((item) => item.project_id === edited.project.id);
  assert.deepEqual(editedDraft.nodes.map((item) => item.id), ['manual-node'], 'a generated candidate never overwrites a manually edited draft');
  const applied = await generation.applyWorkflowGenerationCandidate(edited.project.id, diff.id, { expected_revision: editedDraft.revision }, actor.id);
  assert.equal(applied.generation.result_mode, 'applied_after_diff_review');
  assert.equal(applied.draft.nodes.some((item) => item.role === 'workstream'), true);

  const failedDraft = await addDraft('Stage rejection', 'Reject generic lifecycle workstreams', actor, false, stateApi, createDraftProjectRecords);
  const invalid = invalidStageCandidate();
  const failedStart = await generation.startWorkflowGeneration(failedDraft.project.id, { adapter: 'test', test_candidate: invalid }, actor.id);
  const failed = await waitForGeneration(generation, failedDraft.project.id, failedStart.generation.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'workflow_workstream_process_stage_forbidden');
  assert.equal(typeof failed.error_detail.message, 'string');
  const failedState = await stateApi.readState(), stillBlank = failedState.workflow_drafts.find((item) => item.project_id === failedDraft.project.id);
  assert.deepEqual(stillBlank.nodes, [], 'generation failure preserves a blank draft instead of installing a fallback chain');
  const eventBatch = await generation.listWorkflowGenerationEvents(failedDraft.project.id, failed.id, 0);
  assert.equal(eventBatch.terminal, true);
  assert.equal(eventBatch.events.at(-1).type, 'failed');

  console.log('V1.9 asynchronous workflow generation integration tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

async function addDraft(title, goal, actor, manuallyEdited, stateApi, createDraftProjectRecords) {
  const created = createDraftProjectRecords({ title, goal, mode: 'brainstorm', answers: { goal } }, actor);
  created.intake.mode = 'brainstorm';
  created.intake.status = 'ready';
  if (manuallyEdited) {
    created.workflowDraft.nodes = [{ id: 'manual-node', type: 'analysis', title: 'Manual outline', goal: 'Preserve this outline', dependency_ids: [], position: { x: 100, y: 100 }, order: 0 }];
    created.workflowDraft.revision = 2;
    created.workflowDraft.user_modified_at = '2026-07-18T01:00:00.000Z';
  }
  await stateApi.mutate((state) => {
    state.projects.push(created.project);
    state.workspaces.push(created.workspace);
    state.project_intakes.push(created.intake);
    state.project_briefs.push(created.brief);
    state.workflow_drafts.push(created.workflowDraft);
    state.assist_sessions.push(created.session);
  });
  return created;
}

async function waitForGeneration(service, projectId, generationId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await service.getWorkflowGeneration(projectId, generationId);
    if (['completed', 'failed', 'cancelled', 'superseded'].includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`generation_timeout:${generationId}`);
}

function invalidStageCandidate() {
  return {
    project_classification: 'software', decomposition_basis: 'Invalid generic stage.', evidence_refs: [{ section_id: 'brief-goal', quote: 'stage' }], confidence: 0.9, repository_intent: [],
    workstreams: [{
      id: 'ws-stage', role: 'workstream', title: '\u7f16\u7801\u9636\u6bb5', outcome: 'Code exists.', category: 'deliverable', boundary: { deliverable: 'code' }, acceptance_criteria: ['Code exists.'], dependency_ids: [],
      tasks: [{ id: 'task-code', role: 'task', title: 'Write code', goal: 'Write code', task_kind: 'code', execution_mode: 'codex', dependency_ids: [] }]
    }]
  };
}
