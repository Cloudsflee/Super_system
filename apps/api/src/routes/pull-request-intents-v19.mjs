import { addTrace, mutate, readState } from '../state.mjs';
import { makeRoute, send } from '../http.mjs';
import { actorForRequest, assertProjectRead, assertProjectWrite } from '../project-governance-v19.mjs';
import {
  approvePullRequestIntentInState,
  createPullRequestIntentInState,
  requireIntent,
  revokePullRequestIntentInState
} from '../pull-request-intent-domain.mjs';
import {
  ensurePullRequestIntentChecks,
  executePullRequestIntent,
  reconcilePullRequestIntent
} from '../pull-request-intent-service.mjs';
import { assertControlledProjectWrite } from '../execution-governance.mjs';

export const pullRequestIntentV19Routes = [
  makeRoute('GET', '/projects/:id/pull-requests', listProjectPullRequests),
  makeRoute('GET', '/projects/:id/pull-requests/:pullRequestId', getProjectPullRequest),
  makeRoute('POST', '/projects/:id/pull-request-intents', createIntent),
  makeRoute('GET', '/pull-request-intents/:id', getIntent),
  makeRoute('POST', '/pull-request-intents/:id/approve', approveIntent),
  makeRoute('POST', '/pull-request-intents/:id/execute', executeIntent),
  makeRoute('POST', '/pull-request-intents/:id/revoke', revokeIntent),
  makeRoute('POST', '/pull-request-intents/:id/reconcile', reconcileIntent)
];

async function listProjectPullRequests({ req, res, params, query }) {
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  assertProjectRead(state, params.id, actor.id);
  const items = state.pull_request_intents
    .filter((item) => item.project_id === params.id && (!query.status || item.status === query.status))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(publicIntent);
  return send(res, 200, { items });
}
async function getProjectPullRequest({ req, res, params }) {
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  assertProjectRead(state, params.id, actor.id);
  const intent = state.pull_request_intents.find(
    (item) =>
      item.project_id === params.id &&
      (item.id === params.pullRequestId || String(item.pr_number) === params.pullRequestId)
  );
  return intent ? send(res, 200, publicIntent(intent)) : send(res, 404, { error: 'pull_request_not_found' });
}
async function createIntent({ req, res, params, body }) {
  const result = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    assertProjectWrite(state, params.id, actor.id);
    assertControlledProjectWrite(state, {
      projectId: params.id,
      taskExecutionId: body.task_execution_id,
      leaseToken: body.lease_token,
      operation: 'pull_request_intent'
    });
    const created = createPullRequestIntentInState(state, params.id, body, actor.id);
    if (!created.idempotent)
      addTrace(
        state,
        'pull_request.intent.proposed',
        {
          project_id: params.id,
          target_type: 'pull_request_intent',
          target_id: created.intent.id,
          summary: `${created.intent.head_ref} -> ${created.intent.base_ref}`,
          data: { revision: created.intent.revision, snapshot_hash: created.intent.snapshot_hash }
        },
        actor.id
      );
    return { ...created, intent: publicIntent(created.intent) };
  });
  return send(res, result.idempotent ? 200 : 201, result);
}
async function getIntent({ req, res, params }) {
  const state = await readState(),
    intent = requireIntent(state, params.id),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  assertProjectRead(state, intent.project_id, actor.id);
  return send(res, 200, publicIntent(intent));
}
async function approveIntent({ req, res, params, body }) {
  if (body.action === 'merge_pr') {
    const snapshot = await readState(),
      intent = requireIntent(snapshot, params.id),
      actor = actorForRequest(snapshot, req, { strict: Boolean(req.auth?.clientId) });
    await ensurePullRequestIntentChecks(intent.id, actor.id);
  }
  const result = await mutate((state) => {
    const intent = requireIntent(state, params.id),
      actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    const approved = approvePullRequestIntentInState(state, intent.id, body, actor.id);
    addTrace(
      state,
      'pull_request.intent.approved',
      {
        project_id: intent.project_id,
        target_type: 'pull_request_intent',
        target_id: intent.id,
        summary: `Approved ${body.action}`,
        data: { revision: intent.revision, snapshot_hash: intent.snapshot_hash }
      },
      actor.id
    );
    return { intent: publicIntent(approved.intent), approval: approved.approval };
  });
  return send(res, 200, result);
}
async function executeIntent({ req, res, params, body }) {
  const state = await readState(),
    intent = requireIntent(state, params.id),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  return send(res, 200, publicIntent(await executePullRequestIntent(intent.id, body, actor.id)));
}
async function revokeIntent({ req, res, params, body }) {
  const result = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    return revokePullRequestIntentInState(state, params.id, body, actor.id);
  });
  return send(res, 200, publicIntent(result));
}
async function reconcileIntent({ req, res, params, body }) {
  const state = await readState(),
    intent = requireIntent(state, params.id),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  return send(res, 200, publicIntent(await reconcilePullRequestIntent(intent.id, actor.id, {}, body)));
}

function publicIntent(intent) {
  return structuredClone(intent);
}
