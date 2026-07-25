import { hashString, id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { assertProjectMembership } from './project-governance-v19.mjs';
import {
  ensureRepositoryWorkspaceReviewRef,
  inspectRepositoryWorkspace,
  repositoryBranches,
  requireRepositoryWorkspace,
  validateRepositoryRef
} from './repository-workspace-service.mjs';

const SHA_PATTERN = /^[a-f0-9]{40,64}$/i;
const TERMINAL = new Set(['merged', 'closed', 'revoked', 'expired']);

export function recoverPullRequestIntentsInState(state, timestamp = now()) {
  let changed = 0,
    at = new Date(timestamp).getTime();
  for (const intent of state.pull_request_intents || []) {
    if (['creating_pr', 'merging_pr'].includes(intent.status)) {
      Object.assign(intent, {
        status: 'reconciliation_required',
        reconciliation: {
          status: 'required',
          action: intent.executing_action || null,
          error: 'service_restarted',
          updated_at: timestamp
        },
        executing_action: null,
        updated_at: timestamp
      });
      changed += 1;
      continue;
    }
    if (!TERMINAL.has(intent.status) && new Date(intent.expires_at).getTime() <= at) {
      Object.assign(intent, { status: 'expired', expired_at: timestamp, updated_at: timestamp });
      changed += 1;
    }
  }
  return changed;
}

export function createPullRequestIntentInState(state, projectId, input, actorId) {
  assertProjectMembership(state, projectId, actorId, 'write');
  const workspace = requireRepositoryWorkspace(state, input.repository_workspace_id, projectId);
  const inspected = inspectRepositoryWorkspace(state, workspace.id);
  if (inspected.dirty) throw new HttpError(409, { error: 'repository_workspace_uncommitted_changes' });
  const catalog = repositoryBranches(state, projectId, workspace.connection_id);
  const baseRef = validateRepositoryRef(input.base_ref || catalog.default_branch);
  const base = catalog.branches.find((item) => item.name === baseRef);
  if (!base) throw new HttpError(404, { error: 'repository_branch_not_found', ref: baseRef });
  const headRef = validateRepositoryRef(input.head_ref || ensureRepositoryWorkspaceReviewRef(state, workspace.id));
  const head = catalog.branches.find((item) => item.name === headRef);
  const workspaceHeadAllowed = headRef === workspace.review_ref || headRef === workspace.ref;
  if (!head && !workspaceHeadAllowed) throw new HttpError(404, { error: 'repository_branch_not_found', ref: headRef });
  const headSha = normalizedSha(
    input.head_sha ||
      (headRef === workspace.ref || headRef === workspace.review_ref ? inspected.current_sha : head?.sha),
    'pull_request_head_sha_invalid'
  );
  const baseSha = normalizedSha(input.base_sha || base.sha, 'pull_request_base_sha_invalid');
  if (
    (head && head.sha !== headSha) ||
    (headRef === workspace.ref && inspected.current_sha === workspace.fixed_sha && workspace.fixed_sha !== headSha)
  )
    throw new HttpError(409, {
      error: 'pull_request_intent_head_changed',
      expected_head_sha: headSha,
      actual_head_sha: head?.sha || inspected.current_sha
    });
  if (base.sha !== baseSha)
    throw new HttpError(409, {
      error: 'pull_request_intent_base_changed',
      expected_base_sha: baseSha,
      actual_base_sha: base.sha
    });
  if (headRef === baseRef && headSha === baseSha) throw new HttpError(409, { error: 'pull_request_intent_no_changes' });
  const operationKey = clean(input.operation_key, 128) || null;
  if (operationKey) {
    const prior = state.pull_request_intents.find(
      (item) =>
        item.project_id === projectId && item.operation_key === operationKey && item.created_by_user_id === actorId
    );
    if (prior) return { intent: prior, idempotent: true };
  }
  const expiresAt = expiry(input.expires_at, input.ttl_seconds),
    timestamp = now();
  const snapshot = {
    project_id: projectId,
    repository_workspace_id: workspace.id,
    connection_id: workspace.connection_id,
    head_ref: headRef,
    head_sha: headSha,
    base_ref: baseRef,
    base_sha: baseSha
  };
  const intent = {
    id: id('pri'),
    ...snapshot,
    canonical_repository_id: workspace.canonical_repository_id || null,
    revision: 1,
    snapshot_hash: hashString(JSON.stringify(snapshot)),
    status: 'proposed',
    approvals: [],
    checks_status: 'unknown',
    title: clean(input.title, 200) || `Review ${headRef}`,
    body: clean(input.body, 20_000),
    operation_key: operationKey,
    pr_number: null,
    pr_url: null,
    pr_node_id: null,
    pr_state: null,
    pr_draft: null,
    merge_commit_sha: null,
    expires_at: expiresAt,
    reconciliation: null,
    created_by_user_id: actorId,
    created_at: timestamp,
    updated_at: timestamp
  };
  state.pull_request_intents.push(intent);
  return { intent, idempotent: false };
}

export function createRepositoryLinePullRequestIntentInState(state, repositoryLineId, input, actorId) {
  const line = state.repository_lines.find((item) => item.id === repositoryLineId);
  if (!line) throw new HttpError(404, { error: 'repository_line_not_found' });
  assertProjectMembership(state, line.project_id, actorId, 'write');
  if (line.status !== 'active' || !line.checkout_path || !line.base_sha || !line.head_sha)
    throw new HttpError(409, { error: 'repository_line_not_ready', status: line.status });
  if (line.head_sha === line.base_sha) throw new HttpError(409, { error: 'pull_request_intent_no_changes' });
  const existing = state.pull_request_intents.find(
    (item) => item.repository_line_id === line.id && !['closed', 'revoked', 'expired'].includes(item.status)
  );
  if (existing) return { intent: existing, idempotent: true };
  const snapshot = {
    project_id: line.project_id,
    repository_line_id: line.id,
    connection_id: line.connection_id,
    head_ref: line.branch,
    head_sha: normalizedSha(line.head_sha, 'pull_request_head_sha_invalid'),
    base_ref: line.base_ref,
    base_sha: normalizedSha(line.base_sha, 'pull_request_base_sha_invalid')
  };
  const timestamp = now(),
    intent = {
      id: id('pri'),
      ...snapshot,
      repository_workspace_id: null,
      canonical_repository_id: line.canonical_repository_id || null,
      workflow_execution_id: line.workflow_execution_id,
      workstream_id: line.workstream_id,
      revision: 1,
      snapshot_hash: hashString(JSON.stringify(snapshot)),
      status: 'proposed',
      approvals: [],
      checks_status: 'unknown',
      checks: [],
      title: clean(input.title, 200) || `Review ${line.branch}`,
      body: clean(input.body, 20_000),
      operation_key: `repository-line:${line.id}`,
      pr_number: null,
      pr_url: null,
      pr_node_id: null,
      pr_state: null,
      pr_draft: null,
      merge_commit_sha: null,
      expires_at: expiry(input.expires_at, input.ttl_seconds),
      reconciliation: null,
      created_by_user_id: actorId,
      created_at: timestamp,
      updated_at: timestamp
    };
  state.pull_request_intents.push(intent);
  line.pull_request_intent_id = intent.id;
  line.updated_at = timestamp;
  return { intent, idempotent: false };
}

export function approvePullRequestIntentInState(state, intentId, input, actorId) {
  const intent = activeIntent(state, intentId);
  assertProjectMembership(state, intent.project_id, actorId, 'approve');
  assertRevision(intent, input.expected_revision);
  assertSnapshot(intent, input.expected_snapshot_hash);
  const action = String(input.action || '');
  if (action === 'create_pr') {
    if (intent.status !== 'proposed') throw stateError(intent, 'pull_request_create_approval_not_available');
  } else if (action === 'merge_pr') {
    if (!['draft_open', 'ready'].includes(intent.status))
      throw stateError(intent, 'pull_request_merge_approval_not_available');
    if (!pullRequestChecksSatisfied(state, intent))
      throw new HttpError(409, {
        error: 'pull_request_checks_not_passed',
        checks_status: intent.checks_status,
        checks_count: intent.checks?.length || 0
      });
  } else
    throw new HttpError(400, { error: 'pull_request_approval_action_invalid', allowed: ['create_pr', 'merge_pr'] });
  if (intent.approvals.some((item) => item.action === action && item.revision === intent.revision))
    throw new HttpError(409, { error: 'pull_request_approval_replayed' });
  const approval = {
    id: id('pra'),
    action,
    revision: intent.revision,
    snapshot_hash: intent.snapshot_hash,
    actor_id: actorId,
    approved_at: now()
  };
  intent.approvals.push(approval);
  intent.status = action === 'create_pr' ? 'create_approved' : 'merge_approved';
  intent.revision += 1;
  intent.updated_at = now();
  return { intent, approval };
}

export function preparePullRequestIntentExecutionInState(state, intentId, input, actorId) {
  const intent = activeIntent(state, intentId);
  assertProjectMembership(state, intent.project_id, actorId, 'approve');
  assertRevision(intent, input.expected_revision);
  assertSnapshot(intent, input.expected_snapshot_hash);
  const action = String(input.action || '');
  const requiredStatus = action === 'create_pr' ? 'create_approved' : action === 'merge_pr' ? 'merge_approved' : null;
  if (!requiredStatus) throw new HttpError(400, { error: 'pull_request_execution_action_invalid' });
  if (intent.status !== requiredStatus) throw stateError(intent, 'pull_request_intent_not_approved');
  const approval = intent.approvals.findLast((item) => item.action === action);
  if (!approval || approval.revision !== intent.revision - 1 || approval.snapshot_hash !== intent.snapshot_hash)
    throw new HttpError(409, { error: 'pull_request_approval_stale' });
  const line = intent.repository_line_id
    ? state.repository_lines.find((item) => item.id === intent.repository_line_id)
    : null;
  const workspace = line ? null : requireRepositoryWorkspace(state, intent.repository_workspace_id, intent.project_id);
  const inspected = workspace ? inspectRepositoryWorkspace(state, workspace.id) : null;
  const catalog = workspace ? repositoryBranches(state, intent.project_id, workspace.connection_id) : null;
  const remoteHead = catalog?.branches.find((item) => item.name === intent.head_ref);
  const actualHeadSha =
    line?.head_sha ||
    remoteHead?.sha ||
    (intent.head_ref === workspace?.review_ref
      ? workspace.review_sha || inspected.current_sha
      : inspected?.current_sha);
  if (actualHeadSha !== intent.head_sha)
    throw new HttpError(409, {
      error: 'pull_request_intent_head_changed',
      expected_head_sha: intent.head_sha,
      actual_head_sha: actualHeadSha
    });
  if (action === 'merge_pr' && !pullRequestChecksSatisfied(state, intent))
    throw new HttpError(409, { error: 'pull_request_checks_not_passed', checks_status: intent.checks_status });
  Object.assign(intent, {
    status: action === 'create_pr' ? 'creating_pr' : 'merging_pr',
    executing_action: action,
    execution_started_at: now(),
    updated_at: now()
  });
  return { intent, workspace, repository_line: line };
}

export function completePullRequestIntentExecutionInState(state, intentId, action, result, actorId) {
  const intent = requireIntent(state, intentId);
  if (intent.executing_action !== action || !['creating_pr', 'merging_pr'].includes(intent.status))
    throw stateError(intent, 'pull_request_execution_state_changed');
  if (action === 'create_pr')
    Object.assign(intent, {
      status: result.draft === false ? 'ready' : 'draft_open',
      pr_number: Number(result.number),
      pr_url: result.html_url || null,
      pr_node_id: result.node_id || null,
      pr_state: result.state || 'open',
      pr_draft: result.draft !== false,
      remote_head_sha: result.head_sha || intent.head_sha,
      remote_base_sha: result.base_sha || intent.base_sha,
      checks_status: result.checks_status || 'pending',
      checks: structuredClone(result.checks || []),
      created_pr_by_user_id: actorId
    });
  else
    Object.assign(intent, {
      status: 'merged',
      pr_state: 'closed',
      pr_draft: false,
      merge_commit_sha: result.merge_commit_sha,
      merged_by_user_id: actorId,
      merged_at: now(),
      checks_status: 'passed',
      checks: structuredClone(result.checks || intent.checks || [])
    });
  Object.assign(intent, {
    executing_action: null,
    execution_started_at: null,
    revision: intent.revision + 1,
    reconciliation: { status: 'confirmed', action, reconciled_at: now() },
    updated_at: now()
  });
  return intent;
}

export function failPullRequestIntentExecutionInState(state, intentId, action, error, { uncertain = false } = {}) {
  const intent = requireIntent(state, intentId);
  Object.assign(intent, {
    status: uncertain ? 'reconciliation_required' : action === 'create_pr' ? 'create_approved' : 'merge_approved',
    executing_action: null,
    execution_started_at: null,
    reconciliation: {
      status: uncertain ? 'required' : 'failed',
      action,
      error: String(error || 'github_request_failed').slice(0, 500),
      updated_at: now()
    },
    updated_at: now()
  });
  return intent;
}

export function revokePullRequestIntentInState(state, intentId, input, actorId) {
  const intent = requireIntent(state, intentId);
  assertProjectMembership(state, intent.project_id, actorId, 'write');
  if (TERMINAL.has(intent.status)) return intent;
  assertRevision(intent, input.expected_revision);
  Object.assign(intent, {
    status: 'revoked',
    revoked_by_user_id: actorId,
    revoked_at: now(),
    revision: intent.revision + 1,
    updated_at: now()
  });
  return intent;
}

export function reconcilePullRequestIntentWebhookInState(state, event, payload, deliveryId = null) {
  const repositoryId = String(payload.repository?.id || ''),
    fullName = String(payload.repository?.full_name || '');
  const connectionIds = new Set(
    state.repository_connections
      .filter(
        (item) =>
          (repositoryId && String(item.repository_id) === repositoryId) || (fullName && item.full_name === fullName)
      )
      .map((item) => item.id)
  );
  if (!connectionIds.size) return [];
  const pr = payload.pull_request,
    number = Number(pr?.number || 0),
    branch = String(
      pr?.head?.ref || payload.check_run?.check_suite?.head_branch || payload.check_suite?.head_branch || ''
    ).replace(/^refs\/heads\//, ''),
    sha = String(
      payload.check_run?.head_sha || payload.check_suite?.head_sha || payload.sha || payload.after || ''
    ).toLowerCase();
  const intents = state.pull_request_intents.filter(
    (item) =>
      connectionIds.has(item.connection_id) &&
      (number
        ? Number(item.pr_number) === number || (!item.pr_number && item.head_ref === branch)
        : branch
          ? item.head_ref === branch
          : sha
            ? item.head_sha === sha
            : false)
  );
  for (const intent of intents) {
    if (event === 'pull_request')
      Object.assign(intent, {
        pr_number: number,
        pr_url: pr.html_url || intent.pr_url,
        pr_node_id: pr.node_id || intent.pr_node_id,
        pr_state: pr.merged ? 'closed' : pr.state,
        pr_draft: Boolean(pr.draft),
        status: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft_open' : 'ready',
        merge_commit_sha: pr.merge_commit_sha || intent.merge_commit_sha,
        remote_head_sha: pr.head?.sha || intent.remote_head_sha,
        remote_base_sha: pr.base?.sha || intent.remote_base_sha
      });
    if (event === 'check_run') {
      intent.checks_status = checkConclusion(payload.check_run?.status, payload.check_run?.conclusion);
      intent.checks = mergeCheck(intent.checks, payload.check_run);
    }
    if (event === 'check_suite')
      intent.checks_status = checkConclusion(payload.check_suite?.status, payload.check_suite?.conclusion);
    if (event === 'status')
      intent.checks_status =
        payload.state === 'success' ? 'passed' : ['failure', 'error'].includes(payload.state) ? 'failed' : 'pending';
    Object.assign(intent, {
      reconciliation: { status: 'webhook', event, delivery_id: deliveryId, reconciled_at: now() },
      updated_at: now()
    });
  }
  return intents;
}

export function reconcilePullRequestIntentSnapshotInState(state, intentId, snapshot) {
  const intent = requireIntent(state, intentId),
    before = JSON.stringify([
      intent.status,
      intent.pr_state,
      intent.pr_draft,
      intent.checks_status,
      intent.remote_head_sha,
      intent.remote_base_sha
    ]);
  if (snapshot.number) intent.pr_number = Number(snapshot.number);
  if (snapshot.html_url) intent.pr_url = snapshot.html_url;
  if (snapshot.node_id) intent.pr_node_id = snapshot.node_id;
  if (snapshot.state) intent.pr_state = snapshot.state;
  if (typeof snapshot.draft === 'boolean') intent.pr_draft = snapshot.draft;
  if (snapshot.head_sha) intent.remote_head_sha = snapshot.head_sha;
  if (snapshot.base_sha) intent.remote_base_sha = snapshot.base_sha;
  if (snapshot.checks_status) intent.checks_status = snapshot.checks_status;
  if (snapshot.merged)
    Object.assign(intent, {
      status: 'merged',
      pr_state: 'closed',
      pr_draft: false,
      merge_commit_sha: snapshot.merge_commit_sha || intent.merge_commit_sha,
      merged_at: snapshot.merged_at || now()
    });
  else if (snapshot.state === 'closed') intent.status = 'closed';
  else if (snapshot.state === 'open') intent.status = snapshot.draft ? 'draft_open' : 'ready';
  const after = JSON.stringify([
    intent.status,
    intent.pr_state,
    intent.pr_draft,
    intent.checks_status,
    intent.remote_head_sha,
    intent.remote_base_sha
  ]);
  if (before !== after) intent.revision += 1;
  Object.assign(intent, {
    reconciliation: { status: 'confirmed', action: 'read', reconciled_at: now() },
    updated_at: now()
  });
  return intent;
}

export function requireIntent(state, intentId) {
  const intent = state.pull_request_intents.find((item) => item.id === intentId);
  if (!intent) throw new HttpError(404, { error: 'pull_request_intent_not_found' });
  return intent;
}
function activeIntent(state, intentId) {
  const intent = requireIntent(state, intentId);
  if (!TERMINAL.has(intent.status) && new Date(intent.expires_at).getTime() <= Date.now()) {
    Object.assign(intent, { status: 'expired', expired_at: now(), updated_at: now() });
  }
  if (TERMINAL.has(intent.status))
    throw stateError(
      intent,
      intent.status === 'expired' ? 'pull_request_intent_expired' : 'pull_request_intent_terminal'
    );
  return intent;
}
function assertRevision(intent, expected) {
  if (!Number.isInteger(Number(expected)))
    throw new HttpError(400, { error: 'pull_request_expected_revision_required' });
  if (Number(expected) !== intent.revision)
    throw new HttpError(409, {
      error: 'pull_request_intent_revision_changed',
      expected_revision: Number(expected),
      actual_revision: intent.revision
    });
}
function assertSnapshot(intent, expected) {
  if (expected && expected !== intent.snapshot_hash)
    throw new HttpError(409, { error: 'pull_request_intent_snapshot_changed' });
}
function normalizedSha(value, error) {
  const sha = String(value || '')
    .trim()
    .toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw new HttpError(400, { error });
  return sha;
}
function expiry(value, ttl) {
  const timestamp = value
    ? new Date(value).getTime()
    : Date.now() + Math.min(7 * 24 * 60 * 60_000, Math.max(60_000, Number(ttl || 24 * 60 * 60) * 1000));
  if (!Number.isFinite(timestamp) || timestamp <= Date.now() || timestamp > Date.now() + 7 * 24 * 60 * 60_000)
    throw new HttpError(400, { error: 'pull_request_intent_expiry_invalid' });
  return new Date(timestamp).toISOString();
}
function checkConclusion(status, conclusion) {
  if (status !== 'completed') return 'pending';
  return ['success', 'neutral', 'skipped'].includes(String(conclusion || '')) ? 'passed' : 'failed';
}
function pullRequestChecksSatisfied(state, intent) {
  if (intent.checks_status !== 'passed') return false;
  if ((intent.checks || []).length) return true;
  if (!intent.repository_line_id) return true;
  const line = state.repository_lines.find((item) => item.id === intent.repository_line_id);
  const executions = state.task_executions.filter(
    (item) => item.workflow_execution_id === line?.workflow_execution_id && item.workstream_id === line?.workstream_id
  );
  return executions
    .flatMap((item) => item.output_bindings || [])
    .some((binding) => {
      const asset = state.assets.find(
          (item) =>
            item.id === binding.asset_id &&
            item.status === 'confirmed' &&
            /TestReport|TestEvidence/i.test(item.asset_type)
        ),
        version = state.asset_versions.find(
          (item) =>
            item.id === binding.version_id &&
            item.asset_id === asset?.id &&
            item.repository_sha === intent.head_sha &&
            item.verification_status === 'verified'
        );
      return Boolean(asset && version);
    });
}
function mergeCheck(current, value) {
  const item = {
    id: value?.id || null,
    name: value?.name || '',
    status: value?.status || '',
    conclusion: value?.conclusion || null
  };
  return [...(current || []).filter((entry) => (item.id ? entry.id !== item.id : entry.name !== item.name)), item];
}
function stateError(intent, error) {
  return new HttpError(409, { error, status: intent.status, revision: intent.revision });
}
function clean(value, max) {
  return String(value || '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
