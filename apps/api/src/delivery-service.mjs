import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generatePrBody, hashString, id, now } from '../../../packages/shared/index.mjs';
import { extractMessage, runCodexJson } from './codex-service.mjs';
import { ensureDeliveryCheckout } from './delivery-checkout.mjs';
import { createInstallationToken, githubGitAuthEnv, githubJson, resolveGithubAppConfig } from './github-service.mjs';
import { git, isGitRepo } from './git-utils.mjs';
import { HttpError } from './http.mjs';
import { assertDeliveryPath, requireApprovedDeliveryPolicy } from './repository-delivery-domain.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { reviewSnapshotForPath, safeSegment } from './assist-v3-git.mjs';
import { assertProjectLifecycleIdle } from './project-lifecycle-operations.mjs';
import { assertRepositoryDeletionInactive } from './repository-lifecycle-v19.mjs';
import { redactKnownSecretsSync } from './vault.mjs';
import { evaluateTaskExecutionContextFreshness, prepareTaskExecutionContext } from './task-execution-context.mjs';
import { createExecutionOutputAssets } from './task-output-service.mjs';
import {
  createDeliveryPullRequestIntentInState,
  markDeliveryWorkspaceHeadInState,
  prepareManagedDeliveryCheckout
} from './delivery-pr-intent.mjs';
import { assertControlledTaskWrite } from './execution-governance.mjs';
const controllers = new Map();
const taskLocks = new Set(),
  repositoryPreparationLocks = new Set();
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const REQUIRED_AUTOMATION_PERMISSIONS = ['codex_run', 'commit', 'push', 'draft_pr'];
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/,
  /(?:password|secret|token)\s*[:=]\s*['"][^'"]{8,}['"]/i
];
export async function startTaskDelivery(taskId, input = {}, actorId = null) {
  const result = await mutate((state) => {
    const task = requireTask(state, taskId),
      actor = actorId ? state.users.find((item) => item.id === actorId) : owner(state);
    const workflow = state.workflows.find((item) => item.id === task.workflow_id);
    assertProjectLifecycleIdle(state.projects.find((item) => item.id === workflow?.project_id));
    assertRepositoryDeletionInactive(state, { projectId: workflow?.project_id });
    const controlled = assertControlledTaskWrite(state, task.id, input, 'repository_delivery');
    if (!['code', 'test', 'integration', 'deploy'].includes(task.task_kind))
      throw new HttpError(409, { error: 'task_not_delivery_capable', task_kind: task.task_kind });
    const active = state.deliveries.find((item) => item.task_id === task.id && !TERMINAL.has(item.status));
    if (active) return { delivery: active, idempotent: true, created: false };
    const { target, policy, connection } = requireApprovedDeliveryPolicy(state, task, input.policy_id || null);
    const missingPermissions = REQUIRED_AUTOMATION_PERMISSIONS.filter(
      (permission) => !policy.automation_permissions.includes(permission)
    );
    if (missingPermissions.length)
      throw new HttpError(409, {
        error: 'delivery_policy_permissions_required',
        missing_permissions: missingPermissions
      });
    const previous =
      state.deliveries
        .filter(
          (item) => item.task_id === task.id && item.connection_id === connection.id && item.status === 'completed'
        )
        .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)))[0] || null;
    const project = state.projects.find((item) => item.id === workflow.project_id),
      workspace = state.workspaces.find((item) => item.id === task.workspace_id || item.workflow_node_id === task.id),
      contract = state.node_contracts.find((item) => item.id === task.current_contract_id);
    const prepared = controlled.controlled
      ? {
          context: structuredClone(controlled.task_execution.context_snapshot),
          context_pack: state.context_packs.find(
            (item) => item.id === controlled.task_execution.context_snapshot?.context_pack_id
          )
        }
      : prepareTaskExecutionContext(state, {
          actor,
          project,
          workflow,
          workspace,
          task,
          contract,
          purpose: 'delivery',
          receiverName: 'CodexDelivery',
          repositoryWorkspaceId: input.repository_workspace_id
        });
    if (!prepared.context || !prepared.context_pack)
      throw new HttpError(409, { error: 'task_execution_context_required' });
    if (
      prepared.context.repository_snapshot?.connection_id &&
      prepared.context.repository_snapshot.connection_id !== connection.id
    )
      throw new HttpError(409, {
        error: 'task_context_not_ready',
        reasons: [
          {
            code: 'repository_workspace_connection_mismatch',
            repository_workspace_id: prepared.context.repository_snapshot.repository_workspace_id,
            connection_id: connection.id
          }
        ]
      });
    const delivery = {
      id: id('dlv'),
      operation_id: null,
      project_id: policy.project_id,
      workflow_id: task.workflow_id,
      workstream_id: task.parent_node_id,
      task_id: task.id,
      task_execution_id: controlled.task_execution?.id || null,
      repository_target_id: target.id,
      connection_id: connection.id,
      policy_id: policy.id,
      policy_hash: policy.policy_hash,
      status: 'queued',
      phase: 'queued',
      attempt: Number(input.attempt || 1),
      retry_of_delivery_id: input.retry_of_delivery_id || null,
      branch: previous?.branch || stableBranch(task),
      base_ref: policy.base_ref,
      expected_base_sha: clean(input.expected_base_sha, 64) || null,
      base_sha: null,
      worktree_path: previous?.worktree_path || null,
      commit_sha: null,
      changed_files: [],
      test_results: [],
      pr_number: previous?.pr_number || null,
      pr_url: previous?.pr_url || null,
      pr_state: previous?.pr_state || null,
      adapter: input.adapter === 'test' ? 'test' : null,
      test_input: input.adapter === 'test' ? sanitizeTestInput(input) : null,
      context_pack_id: prepared.context_pack.id,
      task_execution_context: structuredClone(prepared.context),
      input_snapshot_hash: prepared.context.input_snapshot_hash,
      repository_snapshot_hash: prepared.context.repository_snapshot?.snapshot_hash || null,
      contract_snapshot: prepared.context.contract,
      task_snapshot: prepared.context.task,
      dependency_graph: prepared.context.dependency_graph,
      input_assets: prepared.context.inputs.flatMap((item) => item.asset_versions || []),
      repository_workspace_id: prepared.context.repository_snapshot?.repository_workspace_id || null,
      error_code: null,
      error_detail: null,
      retryable: false,
      input_superseded: false,
      cancel_requested_at: null,
      created_by_user_id: actor?.id || null,
      created_at: now(),
      updated_at: now(),
      completed_at: null
    };
    delivery.operation_id = delivery.id;
    state.deliveries.push(delivery);
    appendEvent(state, delivery, 'queued', { attempt: delivery.attempt, branch: delivery.branch });
    target.status = 'active_delivery';
    target.updated_at = now();
    addTrace(
      state,
      'delivery.started',
      {
        project_id: delivery.project_id,
        node_id: task.id,
        target_id: delivery.id,
        summary: `Delivery queued for ${connection.full_name}.`
      },
      actor?.id || null
    );
    return { delivery, idempotent: false, created: true };
  });
  if (result.created)
    queueMicrotask(() => {
      void executeDelivery(result.delivery.id);
    });
  return { delivery: publicDelivery(result.delivery), idempotent: result.idempotent };
}
export async function retryTaskDelivery(deliveryId, input = {}, actorId = null) {
  const state = await readState(),
    source = state.deliveries.find((item) => item.id === deliveryId);
  if (!source) throw new HttpError(404, { error: 'delivery_not_found' });
  if (!TERMINAL.has(source.status)) throw new HttpError(409, { error: 'delivery_not_terminal', status: source.status });
  return startTaskDelivery(
    source.task_id,
    {
      ...input,
      policy_id: input.policy_id || source.policy_id,
      adapter: input.adapter || source.adapter,
      retry_of_delivery_id: source.id,
      attempt: Number(source.attempt || 1) + 1
    },
    actorId
  );
}
export async function cancelTaskDelivery(deliveryId, actorId = null) {
  return mutate((state) => {
    const delivery = state.deliveries.find((item) => item.id === deliveryId);
    if (!delivery) throw new HttpError(404, { error: 'delivery_not_found' });
    if (TERMINAL.has(delivery.status)) return publicDelivery(delivery);
    Object.assign(delivery, {
      status: 'cancelled',
      phase: 'cancelled',
      cancel_requested_at: now(),
      error_code: 'delivery_cancelled',
      retryable: true,
      completed_at: now(),
      updated_at: now()
    });
    appendEvent(state, delivery, 'cancelled', { actor_id: actorId });
    controllers.get(delivery.id)?.abort('cancelled');
    const target = state.repository_targets.find((item) => item.id === delivery.repository_target_id);
    if (target) target.status = 'ready';
    return publicDelivery(delivery);
  });
}
export async function getDelivery(deliveryId) {
  const state = await readState(),
    delivery = state.deliveries.find((item) => item.id === deliveryId);
  if (!delivery) throw new HttpError(404, { error: 'delivery_not_found' });
  return publicDelivery(delivery);
}
export async function listDeliveries(query = {}) {
  const state = await readState(),
    { accessibleProjectIds } = await import('./project-governance-v19.mjs'),
    allowed = accessibleProjectIds(state);
  return state.deliveries
    .filter((item) => allowed.has(item.project_id) && (!query.project_id || item.project_id === query.project_id))
    .filter((item) => !query.task_id || item.task_id === query.task_id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, Math.min(100, Math.max(1, Number(query.limit) || 30)))
    .map(publicDelivery);
}
export async function deliveryEvents(deliveryId, after = 0) {
  const state = await readState(),
    delivery = state.deliveries.find((item) => item.id === deliveryId);
  if (!delivery) throw new HttpError(404, { error: 'delivery_not_found' });
  const events = state.delivery_events
    .filter((item) => item.delivery_id === delivery.id && item.sequence > Number(after || 0))
    .sort((a, b) => a.sequence - b.sequence);
  return {
    delivery: publicDelivery(delivery),
    events,
    terminal: TERMINAL.has(delivery.status),
    next_cursor: events.at(-1)?.sequence || Number(after || 0)
  };
}
async function executeDelivery(deliveryId) {
  const controller = new AbortController();
  controllers.set(deliveryId, controller);
  let releaseTaskLock = null;
  try {
    const initial = await readState(),
      delivery = initial.deliveries.find((item) => item.id === deliveryId);
    if (!delivery || TERMINAL.has(delivery.status)) return;
    releaseTaskLock = await acquireLock(taskLocks, delivery.task_id, controller.signal);
    const context = deliveryContext(initial, delivery);
    assertNotCancelled(controller.signal);
    let base, worktree;
    const releaseRepositoryLock = await acquireLock(
      repositoryPreparationLocks,
      repositoryLockKey(context.repo_path),
      controller.signal
    );
    try {
      await phase(deliveryId, 'fetch_base');
      base = await fetchAndVerifyBase(context, delivery, controller.signal);
      await persistDelivery(deliveryId, { base_sha: base.sha });
      assertNotCancelled(controller.signal);
      await phase(deliveryId, 'worktree');
      worktree =
        prepareManagedDeliveryCheckout(context, delivery, base.sha) ||
        (await ensureDeliveryCheckout(context, delivery, base.sha));
      await persistDelivery(deliveryId, { worktree_path: worktree });
    } finally {
      releaseRepositoryLock();
    }
    const startHead = git(worktree, ['rev-parse', 'HEAD'], 5_000).stdout.trim();
    assertNotCancelled(controller.signal);
    await phase(deliveryId, 'codex_run');
    const codexOutput = await runDeliveryCodex(context, delivery, worktree, controller.signal);
    assertNotCancelled(controller.signal);
    if (git(worktree, ['rev-parse', 'HEAD'], 5_000).stdout.trim() !== startHead)
      throw deliveryError('delivery_codex_commit_forbidden');
    await phase(deliveryId, 'policy_checks');
    let checked = await inspectDeliveryChanges(context.policy, worktree, base.sha);
    if (context.delivery.test_input?.force_path_violation)
      checked.changed_files.push({ path: '../outside-policy', status: 'modified' });
    for (const file of checked.changed_files) assertDeliveryPath(context.policy, file.path);
    const secrets = await scanSecrets(worktree, checked.changed_files);
    if (context.delivery.test_input?.force_secret) secrets.push('forced-secret.txt');
    if (secrets.length) throw deliveryError('delivery_secret_scan_failed', { files: secrets });
    assertNotCancelled(controller.signal);
    await phase(deliveryId, 'tests');
    const testResults = runPolicyTests(context.policy, worktree, context.delivery.test_input);
    await persistDelivery(deliveryId, { test_results: testResults });
    if (testResults.some((item) => item.status !== 'passed'))
      throw deliveryError('delivery_tests_failed', { test_results: testResults });
    assertNotCancelled(controller.signal);
    checked = await inspectDeliveryChanges(context.policy, worktree, base.sha);
    for (const file of checked.changed_files) assertDeliveryPath(context.policy, file.path);
    if (!checked.changed_files.length)
      throw deliveryError('delivery_no_changes', { model_summary: safeOutput(codexOutput) });
    await phase(deliveryId, 'commit');
    assertNotCancelled(controller.signal);
    const commitSha = commitDelivery(context, worktree, checked.changed_files);
    await persistDelivery(deliveryId, { commit_sha: commitSha, changed_files: checked.changed_files });
    if (delivery.repository_workspace_id)
      await mutate((state) => markDeliveryWorkspaceHeadInState(state, deliveryId, commitSha));
    assertNotCancelled(controller.signal);
    await phase(deliveryId, 'push');
    await pushDelivery(context, worktree, delivery.branch);
    assertNotCancelled(controller.signal);
    await phase(deliveryId, delivery.repository_workspace_id ? 'pr_intent' : 'draft_pr');
    const pull = delivery.repository_workspace_id
      ? null
      : await createOrReuseDraftPullRequest(context, delivery, checked.changed_files, testResults);
    const intent = delivery.repository_workspace_id
      ? await mutate((state) =>
          createDeliveryPullRequestIntentInState(
            state,
            deliveryId,
            checked.changed_files,
            testResults,
            delivery.created_by_user_id
          )
        )
      : null;
    const latest = await readState(),
      freshness = evaluateTaskExecutionContextFreshness(
        latest,
        latest.deliveries.find((item) => item.id === deliveryId)?.task_execution_context
      );
    await completeDelivery(deliveryId, commitSha, pull, intent, checked.changed_files, testResults, freshness);
  } catch (error) {
    if (!controller.signal.aborted) await failDelivery(deliveryId, error);
  } finally {
    controllers.delete(deliveryId);
    releaseTaskLock?.();
  }
}
async function acquireLock(locks, key, signal) {
  while (locks.has(key)) {
    assertNotCancelled(signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assertNotCancelled(signal);
  locks.add(key);
  return () => locks.delete(key);
}
function repositoryLockKey(repoPath) {
  const resolved = path.resolve(repoPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function assertNotCancelled(signal) {
  if (signal.aborted) throw deliveryError('delivery_cancelled');
}
function deliveryContext(state, delivery) {
  const task = requireTask(state, delivery.task_id),
    workstream = state.workflow_nodes.find((item) => item.id === task.parent_node_id),
    project = state.projects.find((item) => item.id === delivery.project_id),
    connection = state.repository_connections.find((item) => item.id === delivery.connection_id),
    policy = state.delivery_policies.find((item) => item.id === delivery.policy_id);
  if (!project || !workstream || !connection || !policy) throw deliveryError('delivery_context_missing');
  assertProjectLifecycleIdle(project);
  const approved = requireApprovedDeliveryPolicy(state, task, policy.id);
  if (approved.policy.policy_hash !== delivery.policy_hash) throw deliveryError('delivery_policy_changed');
  const previousCompleted =
    state.deliveries
      .filter((item) => item.task_id === task.id && item.id !== delivery.id && item.status === 'completed')
      .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)))[0] || null;
  const repositorySnapshot = delivery.task_execution_context?.repository_snapshot;
  const repoPath = repositorySnapshot?.repository_workspace_id
    ? repositorySnapshot.managed_path
    : connection.local_path ||
      repositorySnapshot?.managed_path ||
      (state.repository_connections.filter((item) => item.project_id === project.id).length === 1
        ? project.repo_path
        : null);
  if (!repoPath || !isGitRepo(repoPath))
    throw deliveryError('repository_connection_checkout_required', { connection_id: connection.id });
  return {
    state,
    delivery,
    task,
    workstream,
    project,
    connection,
    policy,
    repo_path: path.resolve(repoPath),
    previousCompleted
  };
}
async function fetchAndVerifyBase(context, delivery, signal) {
  if (signal.aborted) throw deliveryError('delivery_cancelled');
  let ref = context.policy.base_ref;
  if (delivery.adapter !== 'test') {
    const auth = await githubAuth(context.state, context.connection),
      fetched = git(
        context.repo_path,
        ['fetch', '--prune', context.connection.remote_name || 'origin', context.policy.base_ref],
        120_000,
        auth.env
      );
    if (!fetched.ok)
      throw deliveryError('delivery_fetch_failed', { detail: safeOutput(fetched.stderr || fetched.error) });
    ref = `${context.connection.remote_name || 'origin'}/${context.policy.base_ref}`;
  }
  let resolved = git(context.repo_path, ['rev-parse', '--verify', ref], 5_000);
  if (!resolved.ok && delivery.adapter === 'test')
    resolved = git(context.repo_path, ['rev-parse', '--verify', 'HEAD'], 5_000);
  const sha = resolved.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw deliveryError('delivery_base_sha_unavailable');
  if (delivery.expected_base_sha && delivery.expected_base_sha !== sha)
    throw deliveryError('delivery_base_sha_mismatch', { expected: delivery.expected_base_sha, actual: sha });
  return { sha, ref };
}
async function runDeliveryCodex(context, delivery, worktree, signal) {
  if (delivery.adapter === 'test') {
    for (const change of delivery.test_input?.changes || [
      { path: 'delivery.txt', content: `delivery ${delivery.id}\n` }
    ]) {
      const file = path.resolve(worktree, change.path),
        relative = path.relative(worktree, file);
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw deliveryError('delivery_test_change_path_invalid');
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, String(change.content ?? ''), 'utf8');
    }
    return;
  }
  const profile = context.state.codex_profiles.find((item) => item.is_active && item.status === 'validated');
  if (!profile) throw deliveryError('active_codex_profile_required');
  let output = '';
  const prompt = [
    'Execute only aiws.task_execution_context.v2 in the isolated checkout. Do not commit, push, access GitHub credentials, or modify pull requests.',
    `Execution context: ${JSON.stringify(delivery.task_execution_context)}`,
    `Approved path prefixes: ${JSON.stringify(context.policy.path_prefixes)}`,
    'Return JSON only: {"summary":"..."}.'
  ].join('\n');
  const run = await runCodexJson({
    state: context.state,
    profile,
    prompt,
    cwd: worktree,
    sandbox: 'workspace-write',
    projectId: context.project.id,
    signal,
    onEvent: (event) => {
      output += extractMessage(event);
    }
  });
  if (!run.ok)
    throw deliveryError('delivery_codex_run_failed', {
      detail: safeOutput(run.stderr),
      stdout_tail: safeOutput(run.stdout),
      exit_code: run.code,
      timed_out: run.timed_out,
      timeout_ms: run.timeout_ms
    });
  return output || run.stdout;
}
async function inspectDeliveryChanges(policy, worktree, baseSha) {
  const snapshot = reviewSnapshotForPath(worktree, baseSha);
  for (const file of snapshot.changedFiles) assertDeliveryPath(policy, file.path);
  return { changed_files: snapshot.changedFiles, diff: snapshot.diff, target_hash: snapshot.targetHash };
}
async function scanSecrets(worktree, files) {
  const findings = [];
  for (const file of files.filter((item) => !['deleted'].includes(item.status))) {
    const target = path.join(worktree, file.path),
      stat = await fsp.stat(target).catch(() => null);
    if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) continue;
    const content = await fsp.readFile(target, 'utf8').catch(() => '');
    if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) findings.push(file.path);
  }
  return findings;
}
function runPolicyTests(policy, worktree, testInput) {
  return policy.test_commands.map((commandText, index) => {
    if (testInput?.force_test_failure && index === 0)
      return { command: commandText, status: 'failed', exit_code: 1, output: 'forced test failure' };
    const shell =
      process.platform === 'win32'
        ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', commandText] }
        : { command: '/bin/sh', args: ['-lc', commandText] };
    const result = spawnSync(shell.command, shell.args, {
      cwd: worktree,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      timeout: 10 * 60_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    return {
      command: commandText,
      status: result.status === 0 && !result.error ? 'passed' : 'failed',
      exit_code: result.status,
      output: safeOutput(`${result.stdout || ''}\n${result.stderr || ''}`),
      error_code: result.error?.code || null
    };
  });
}
function commitDelivery(context, worktree, changedFiles) {
  const prefixes = context.policy.path_prefixes;
  const added = git(worktree, ['add', '--', ...prefixes], 30_000);
  if (!added.ok) throw deliveryError('delivery_git_add_failed', { detail: safeOutput(added.stderr) });
  const staged = git(worktree, ['diff', '--cached', '--name-only', '--'], 10_000);
  if (!staged.stdout.trim()) throw deliveryError('delivery_no_staged_changes');
  const committed = git(
    worktree,
    [
      '-c',
      'user.name=AI Workspace',
      '-c',
      'user.email=aiws@local.invalid',
      'commit',
      '-m',
      `feat(aiws): ${clean(context.task.title, 100)}`
    ],
    60_000
  );
  if (!committed.ok) throw deliveryError('delivery_commit_failed', { detail: safeOutput(committed.stderr) });
  return git(worktree, ['rev-parse', 'HEAD'], 5_000).stdout.trim();
}
async function pushDelivery(context, worktree, branch) {
  if (context.delivery.adapter === 'test') return { pushed: true, adapted: true };
  if (context.connection.permissions?.push !== true) throw deliveryError('repository_push_permission_required');
  const auth = await githubAuth(context.state, context.connection),
    pushed = git(
      worktree,
      ['push', '--set-upstream', context.connection.remote_name || 'origin', `HEAD:refs/heads/${branch}`],
      120_000,
      auth.env
    );
  if (!pushed.ok) throw deliveryError('delivery_push_failed', { detail: safeOutput(pushed.stderr || pushed.error) });
  return { pushed: true };
}
async function createOrReuseDraftPullRequest(context, delivery, changedFiles, tests) {
  if (delivery.pr_url)
    return { html_url: delivery.pr_url, number: delivery.pr_number, state: 'open', draft: true, reused: true };
  if (delivery.adapter === 'test')
    return {
      html_url: `https://github.com/${context.connection.full_name}/pull/${Math.max(1, Number(delivery.attempt || 1))}`,
      number: Math.max(1, Number(delivery.attempt || 1)),
      state: 'open',
      draft: true
    };
  if (context.connection.permissions?.pull_requests !== true)
    throw deliveryError('repository_pull_request_permission_required');
  const auth = await githubAuth(context.state, context.connection),
    run = {
      id: delivery.id,
      summary: `Delivery for ${context.task.title}`,
      changed_files: changedFiles,
      test_results: tests
    };
  const body = generatePrBody({
    project: context.project,
    node: context.task,
    run,
    diff: { summary: run.summary, changed_files: changedFiles },
    tests
  });
  return githubJson(`https://api.github.com/repos/${context.connection.full_name}/pulls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: `${context.task.title}`,
      head: delivery.branch,
      base: context.policy.base_ref,
      body,
      draft: true
    })
  });
}
async function githubAuth(state, connection) {
  const config = resolveGithubAppConfig(state);
  if (!config) throw deliveryError('github_app_config_required');
  const token = await createInstallationToken(config, connection.installation_id);
  return { token: token.token, env: githubGitAuthEnv(token.token) };
}
async function phase(deliveryId, phaseName) {
  return mutate((state) => {
    const item = state.deliveries.find((entry) => entry.id === deliveryId);
    if (!item || TERMINAL.has(item.status)) return item;
    Object.assign(item, { status: 'running', phase: phaseName, updated_at: now() });
    appendEvent(state, item, 'phase', { phase: phaseName });
    return item;
  });
}
async function persistDelivery(deliveryId, patch) {
  return mutate((state) => {
    const item = state.deliveries.find((entry) => entry.id === deliveryId);
    if (!item || TERMINAL.has(item.status)) return item;
    Object.assign(item, structuredClone(patch), { updated_at: now() });
    return item;
  });
}
async function completeDelivery(deliveryId, commitSha, pull, intent, changedFiles, tests, freshness) {
  return mutate((state) => {
    const delivery = state.deliveries.find((item) => item.id === deliveryId);
    if (!delivery || TERMINAL.has(delivery.status)) return delivery;
    const intentMode = Boolean(intent);
    Object.assign(delivery, {
      status: 'completed',
      phase: intentMode ? 'pr_intent_proposed' : 'draft_pr_created',
      commit_sha: commitSha,
      changed_files: changedFiles,
      test_results: tests,
      pr_number: pull?.number || null,
      pr_url: pull?.html_url || null,
      pr_state: intentMode ? 'intent_proposed' : 'draft',
      pull_request_intent_id: intent?.id || delivery.pull_request_intent_id || null,
      input_superseded: !freshness.current,
      input_superseded_reasons: freshness.reasons,
      retryable: false,
      completed_at: now(),
      updated_at: now()
    });
    const target = state.repository_targets.find((item) => item.id === delivery.repository_target_id);
    if (target) Object.assign(target, { status: 'ready', updated_at: now() });
    const task = state.workflow_nodes.find((item) => item.id === delivery.task_id),
      project = state.projects.find((item) => item.id === delivery.project_id),
      workspace = state.workspaces.find((item) => item.id === task?.workspace_id);
    if (task) {
      Object.assign(task, {
        delivery_status: delivery.phase,
        latest_delivery_id: delivery.id,
        input_superseded: !freshness.current,
        updated_at: now()
      });
      createExecutionOutputAssets(state, {
        actorId: delivery.created_by_user_id,
        project,
        task,
        workspace,
        execution: delivery,
        candidates: (delivery.contract_snapshot?.expected_outputs || []).map((slot) => ({
          output_key: slot.key,
          asset_type: slot.asset_type,
          title: `${task.title} ${slot.key}`,
          summary: `Delivery ${delivery.id} produced commit ${commitSha}.`
        }))
      });
    }
    appendEvent(state, delivery, 'completed', {
      pr_url: delivery.pr_url,
      pull_request_intent_id: delivery.pull_request_intent_id,
      commit_sha: commitSha,
      input_superseded: delivery.input_superseded
    });
    addTrace(
      state,
      'delivery.completed',
      {
        project_id: delivery.project_id,
        node_id: delivery.task_id,
        target_id: delivery.id,
        summary: intentMode ? `PR intent proposed: ${intent.id}` : `Draft PR created: ${delivery.pr_url}`
      },
      delivery.created_by_user_id
    );
    return delivery;
  });
}
async function failDelivery(deliveryId, error) {
  return mutate((state) => {
    const delivery = state.deliveries.find((item) => item.id === deliveryId);
    if (!delivery || TERMINAL.has(delivery.status)) return delivery;
    const code = error?.code || error?.payload?.error || 'delivery_failed';
    Object.assign(delivery, {
      status: 'failed',
      phase: 'failed',
      error_code: code,
      error_detail: error?.details || error?.payload || null,
      retryable: true,
      completed_at: now(),
      updated_at: now()
    });
    const target = state.repository_targets.find((item) => item.id === delivery.repository_target_id);
    if (target) Object.assign(target, { status: 'ready', updated_at: now() });
    appendEvent(state, delivery, 'failed', { error_code: code });
    addTrace(
      state,
      'delivery.failed',
      {
        project_id: delivery.project_id,
        node_id: delivery.task_id,
        target_id: delivery.id,
        summary: `Delivery failed: ${code}`
      },
      delivery.created_by_user_id
    );
    return delivery;
  });
}
function appendEvent(state, delivery, type, data) {
  const sequence =
      state.delivery_events
        .filter((item) => item.delivery_id === delivery.id)
        .reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0) + 1,
    event = {
      id: id('dle'),
      delivery_id: delivery.id,
      project_id: delivery.project_id,
      task_id: delivery.task_id,
      sequence,
      type,
      data: structuredClone(data || {}),
      created_at: now()
    };
  state.delivery_events.push(event);
  return event;
}
function requireTask(state, taskId) {
  const task = state.workflow_nodes.find(
    (item) => item.id === taskId && item.role === 'task' && !item.legacy_read_only
  );
  if (!task) throw new HttpError(404, { error: 'task_not_found' });
  return task;
}
function stableBranch(task) {
  return `aiws/${safeSegment(task.id).slice(0, 48)}-${hashString(task.id).slice(0, 8)}`;
}
function sanitizeTestInput(input) {
  return {
    changes: Array.isArray(input.test_changes)
      ? input.test_changes
          .slice(0, 50)
          .map((item) => ({ path: clean(item?.path, 500), content: String(item?.content ?? '').slice(0, 500_000) }))
      : null,
    force_test_failure: input.test_failure === true,
    force_path_violation: input.path_violation === true,
    force_secret: input.secret_violation === true
  };
}
function publicDelivery(item) {
  if (!item) return null;
  const { test_input, ...visible } = item;
  return structuredClone(visible);
}
function deliveryError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
function safeOutput(value) {
  return redactKnownSecretsSync(String(value || '')).slice(-8000);
}
function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
