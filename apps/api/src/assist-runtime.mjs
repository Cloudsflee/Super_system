import { createChangeProposal, createSubSubmission, id, now } from '../../../packages/shared/index.mjs';
import { extractMessage, runCodexJson } from './codex-service.mjs';
import { saveProjectFile, runTestPreset } from './file-service.mjs';
import { HttpError } from './http.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { git, isGitRepo } from './git-utils.mjs';
import { authorizeRepositoryAction, roleAllows } from './authorization.mjs';
import { createInstallationToken, githubGitAuthEnv, resolveGithubAppConfig } from './github-service.mjs';
import { AIWS_HOME } from './config.mjs';
import { assertManagedProjectWritable } from './project-lifecycle.mjs';
import { assertProjectLifecycleIdle, withProjectLifecycleLock } from './project-lifecycle-operations.mjs';

const controllers = new Map();
const reversible = new Set([
  'navigate',
  'select_node',
  'switch_workspace_tab',
  'focus_field',
  'set_filter',
  'fill_field'
]);
const confirmed = new Set(['save_file', 'run_test', 'git_commit', 'git_push', 'submit_to_parent']);
const proposals = new Set([
  'add_node',
  'remove_node',
  'connect_nodes',
  'update_node',
  'update_contract',
  'apply_profile',
  'run_node'
]);

export async function startAssistRun(sessionId, adapterResponse) {
  const controller = new AbortController();
  controllers.set(sessionId, controller);
  try {
    await appendEvent(sessionId, 'started', { status: 'running' });
    const state = await readState(),
      session = findSession(state, sessionId);
    const project = assertProjectLifecycleIdle(state.projects.find((item) => item.id === session.project_id));
    const userMessage = state.assist_messages
      .filter((item) => item.session_id === sessionId && item.role === 'user')
      .at(-1);
    let result;
    if (adapterResponse) {
      await delay(Math.max(0, Math.min(Number(adapterResponse.delay_ms) || 20, 5000)));
      if (controller.signal.aborted) throw new Error('assist_cancelled');
      result = adapterResponse;
    } else {
      const profile = state.codex_profiles.find((item) => item.is_active && item.status === 'validated');
      if (!profile) throw new Error('active_codex_profile_required');
      let output = '',
        chain = Promise.resolve(),
        threadId = session.codex_thread_id;
      const prompt = assistPrompt(session, userMessage?.content || '', hierarchyContext(state, session));
      const runResult = await runCodexJson({
        state,
        profile,
        prompt,
        cwd: project?.repo_path || project?.workspace_root || AIWS_HOME,
        resumeId: threadId,
        sandbox: 'read-only',
        projectId: project.id,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'thread.started' && event.thread_id) threadId = event.thread_id;
          const text = extractMessage(event);
          if (text) output += text;
          const safe = { kind: event.type, item_type: event.item?.type || null, text: text || undefined };
          chain = chain.then(() => appendEvent(sessionId, text ? 'delta' : 'status', safe));
        }
      });
      await chain;
      if (!runResult.ok) throw new Error(runResult.stderr || `codex_exit_${runResult.code}`);
      if (threadId)
        await mutate((data) => {
          findSession(data, sessionId).codex_thread_id = threadId;
        });
      result = parseResult(output || runResult.stdout);
    }
    if (!controller.signal.aborted) await completeRun(sessionId, result);
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const currentController = controllers.get(sessionId) === controller;
    // cancelAssistRun persists cancellation; a stale controller must not overwrite a restarted run.
    if (currentController && !cancelled) await markTerminal(sessionId, 'failed', error.message);
  } finally {
    if (controllers.get(sessionId) === controller) controllers.delete(sessionId);
  }
}

export async function cancelAssistRun(sessionId) {
  const state = await readState(),
    session = findSession(state, sessionId);
  controllers.get(sessionId)?.abort();
  await markTerminal(sessionId, 'cancelled', null);
  return { ...session, status: 'cancelled' };
}

export async function appendEvent(sessionId, type, data = {}) {
  return mutate((state) => {
    findSession(state, sessionId);
    const sequence =
      Math.max(
        0,
        ...state.assist_events.filter((item) => item.session_id === sessionId).map((item) => item.sequence || 0)
      ) + 1;
    const event = { id: sequence, sequence, session_id: sessionId, type, data, created_at: now() };
    state.assist_events.push(event);
    return event;
  });
}

export async function decideAction(sessionId, actionId, decision) {
  const snapshot = await readState(),
    action = snapshot.ui_action_intents.find((item) => item.id === actionId && item.session_id === sessionId);
  if (!action) throw new HttpError(404, { error: 'assist_action_not_found' });
  const project = assertActionProjectIdle(snapshot, action);
  return withProjectLifecycleLock(project.id, () => decideActionLocked(sessionId, actionId, decision));
}

async function decideActionLocked(sessionId, actionId, decision) {
  if (decision === 'reject') {
    const action = await reserveAction(sessionId, actionId, 'rejected');
    return finishAction(action, 'rejected', null);
  }
  const action = await reserveAction(sessionId, actionId, 'executing');
  let result;
  try {
    if (action.risk === 'proposal') result = await createActionProposal(action);
    else if (action.name === 'save_file')
      result = await saveProjectFile({
        projectId: action.project_id,
        nodeId: action.node_id,
        relative: action.args.path,
        content: action.args.content,
        source: 'assist_confirmed'
      });
    else if (action.name === 'run_test')
      result = await runTestPreset({
        projectId: action.project_id,
        nodeId: action.node_id,
        preset: action.args.preset
      });
    else if (action.name === 'submit_to_parent') result = await createParentSubmission(action);
    else if (action.name === 'git_commit' || action.name === 'git_push') result = await executeGitAction(action);
    else throw new HttpError(400, { error: 'unsupported_assist_confirmed_action', action: action.name });
  } catch (error) {
    await finishAction(action, 'failed', { error: error.message });
    throw error;
  }
  return finishAction(action, 'confirmed', result);
}

export async function recordActionResult(sessionId, actionId, body) {
  const result = await mutate((state) => {
    const action = state.ui_action_intents.find((item) => item.id === actionId && item.session_id === sessionId);
    if (!action) throw new HttpError(404, { error: 'assist_action_not_found' });
    assertActionProjectIdle(state, action);
    if (action.risk !== 'reversible' || action.status !== 'ready')
      throw new HttpError(409, { error: 'assist_action_result_not_allowed' });
    action.status = body.ok === false ? 'failed' : 'completed';
    action.result = body.result || {};
    action.updated_at = now();
    return action;
  });
  await appendEvent(sessionId, 'action_result', { action: result });
  return result;
}

function completeRun(sessionId, result) {
  return mutate((state) => {
    const session = findSession(state, sessionId),
      actor = owner(state);
    if (session.status === 'cancelled') return { cancelled: true };
    const message = {
      id: id('amsg'),
      session_id: sessionId,
      role: 'assistant',
      content: String(result.message || '已完成。'),
      status: 'completed',
      created_at: now()
    };
    state.assist_messages.push(message);
    const actions = (result.actions || [])
      .map((input) => normalizeAction(state, session, message, input))
      .filter(Boolean);
    state.ui_action_intents.push(...actions);
    Object.assign(session, { status: 'completed', updated_at: now() });
    pushEvent(state, sessionId, 'message', { message });
    for (const action of actions) pushEvent(state, sessionId, 'action', { action });
    pushEvent(state, sessionId, 'completed', { message_id: message.id });
    addTrace(
      state,
      'assist.message.created',
      {
        project_id: session.project_id,
        workspace_id: session.workspace_id,
        node_id: session.node_id,
        target_id: message.id,
        summary: 'Codex Assist 返回结构化结果。'
      },
      actor.id
    );
    return { message, actions };
  });
}

function normalizeAction(state, session, message, input) {
  const name = String(input?.name || '');
  const risk = reversible.has(name)
    ? 'reversible'
    : confirmed.has(name)
      ? 'confirm'
      : proposals.has(name)
        ? 'proposal'
        : null;
  if (!risk || forbiddenArgs(input.args || {})) return null;
  if (name === 'navigate' && !allowedPath(input.args?.path)) return null;
  if (reversible.has(name) && !semanticActionAllowed(state, session, name, input.args || {})) return null;
  if (name === 'save_file' && (typeof input.args?.path !== 'string' || typeof input.args?.content !== 'string'))
    return null;
  if (name === 'run_test' && !['test', 'typecheck', 'lint', 'build'].includes(input.args?.preset)) return null;
  if (['run_node', 'submit_to_parent'].includes(name) && !session.node_id) return null;
  return {
    id: id('uia'),
    session_id: session.id,
    source_message_id: message.id,
    project_id: session.project_id,
    workspace_id: session.workspace_id,
    node_id: session.node_id,
    name,
    label: String(input.label || name).slice(0, 100),
    args: input.args || {},
    risk,
    status: risk === 'reversible' ? 'ready' : 'pending',
    created_at: now(),
    updated_at: now()
  };
}

function createActionProposal(action) {
  return mutate((state) => {
    assertActionProjectIdle(state, action);
    const actor = owner(state),
      node = state.workflow_nodes.find(
        (item) =>
          item.id === action.node_id &&
          state.workflows.some(
            (workflow) => workflow.id === item.workflow_id && workflow.project_id === action.project_id
          )
      ),
      workflow =
        state.workflows.find((item) => item.id === action.args.workflow_id && item.project_id === action.project_id) ||
        state.workflows.find((item) => item.id === node?.workflow_id && item.project_id === action.project_id) ||
        state.workflows.find((item) => item.project_id === action.project_id);
    if (!workflow && ['add_node', 'remove_node', 'connect_nodes', 'update_node'].includes(action.name))
      throw new HttpError(409, { error: 'assist_workflow_scope_invalid' });
    const mapped = proposalAction(action, workflow, node);
    const proposal = createChangeProposal({
      projectId: action.project_id,
      workspaceId: action.workspace_id,
      nodeId: action.node_id,
      changeType: mapped.changeType,
      title: action.label,
      summary: '由 Codex Assist 提议的本质变更',
      before: mapped.before,
      after: mapped.after,
      impact: ['当前工作流或节点'],
      risks: ['需要人工确认'],
      applyAction: mapped.applyAction,
      actorId: actor.id
    });
    state.change_proposals.push(proposal);
    addTrace(
      state,
      'change_proposal.created',
      {
        project_id: action.project_id,
        workspace_id: action.workspace_id,
        node_id: action.node_id,
        target_id: proposal.id,
        summary: proposal.title
      },
      actor.id
    );
    return proposal;
  });
}

function proposalAction(action, workflow, node) {
  if (action.name === 'update_contract')
    return {
      changeType: 'node_contract_patch',
      before: {},
      after: action.args,
      applyAction: { type: 'node_contract_patch' }
    };
  if (action.name === 'add_node')
    return {
      changeType: 'workflow_graph',
      before: workflow?.graph_json || {},
      after: { nodes: [action.args.node || action.args] },
      applyAction: { type: 'workflow_nodes_create', workflow_id: workflow?.id }
    };
  if (action.name === 'remove_node')
    return {
      changeType: 'workflow_graph',
      before: workflow?.graph_json || {},
      after: { node_id: action.args.node_id || node?.id },
      applyAction: { type: 'workflow_node_remove', workflow_id: workflow?.id, node_id: action.args.node_id || node?.id }
    };
  if (action.name === 'connect_nodes')
    return {
      changeType: 'workflow_graph',
      before: workflow?.graph_json || {},
      after: action.args,
      applyAction: {
        type: 'workflow_nodes_connect',
        workflow_id: workflow?.id,
        source_id: action.args.source_id,
        target_id: action.args.target_id
      }
    };
  if (action.name === 'update_node')
    return {
      changeType: 'workflow_graph',
      before: node || {},
      after: action.args.patch || action.args,
      applyAction: { type: 'workflow_node_update', workflow_id: workflow?.id, node_id: action.args.node_id || node?.id }
    };
  if (action.name === 'apply_profile') {
    const profile = stateProfile(action);
    return {
      changeType: 'codex_profile_apply',
      before: {},
      after: { profile_id: action.args.profile_id, name: profile?.name },
      applyAction: { type: 'codex_profile_apply', profile_id: action.args.profile_id }
    };
  }
  if (action.name === 'run_node') {
    const runner = ['codex', 'codex_docker'].includes(action.args.runner) ? action.args.runner : 'codex_docker';
    return {
      changeType: 'node_run_write',
      before: null,
      after: { runner },
      applyAction: { type: 'node_run_authorization', node_id: action.node_id, runner }
    };
  }
  throw new HttpError(400, { error: 'unsupported_assist_proposal_action', action: action.name });
}

async function executeGitAction(action) {
  const state = await readState(),
    actor = owner(state),
    project = state.projects.find((item) => item.id === action.project_id),
    repo = project?.repo_path || project?.workspace_root;
  if (!project || !isGitRepo(repo)) throw new HttpError(409, { error: 'git_repository_required' });
  assertManagedProjectWritable(project);
  let result;
  if (action.name === 'git_commit') {
    if (!roleAllows(actor.role, 'git_commit')) throw new HttpError(403, { error: 'role_permission_denied' });
    const requested = Array.isArray(action.args.files) ? action.args.files : [];
    const files = requested.filter((item) => typeof item === 'string' && !item.includes('..') && !/^[/\\]/.test(item));
    if (files.length !== requested.length) throw new HttpError(400, { error: 'invalid_commit_file_path' });
    result = git(repo, files.length ? ['add', '--', ...files] : ['add', '-A'], 10000);
    if (result.ok)
      result = git(
        repo,
        ['commit', '-m', String(action.args.message || 'chore(aiws): apply confirmed Assist change').slice(0, 500)],
        20000
      );
  } else {
    const binding = state.repository_bindings.find(
        (item) => item.project_id === project.id && item.status !== 'removed'
      ),
      authorization = authorizeRepositoryAction({
        role: actor.role,
        permissions: binding?.permissions || {},
        operation: 'git_push'
      });
    if (!authorization.allowed) throw new HttpError(403, { error: 'repository_permission_denied', authorization });
    const remote = String(action.args.remote || binding?.remote_name || 'origin'),
      refspec = String(action.args.refspec || 'HEAD');
    if (
      !/^[a-zA-Z0-9._-]+$/.test(remote) ||
      !/^(HEAD|refs\/heads\/[a-zA-Z0-9._\/-]+)(:refs\/heads\/[a-zA-Z0-9._\/-]+)?$/.test(refspec)
    )
      throw new HttpError(400, { error: 'invalid_git_push_target' });
    const config = resolveGithubAppConfig(state);
    if (!config || !binding?.installation_id) throw new HttpError(409, { error: 'github_installation_token_required' });
    const access = await createInstallationToken(config, binding.installation_id);
    result = git(repo, ['push', remote, refspec], 60000, githubGitAuthEnv(access.token));
  }
  await mutate((data) => {
    addTrace(
      data,
      action.name === 'git_commit' ? 'git.commit.created' : 'git.push.created',
      {
        project_id: project.id,
        node_id: action.node_id,
        summary: result.ok ? `Assist 确认后执行 ${action.name}。` : `Assist ${action.name} 执行失败。`,
        data: result
      },
      actor.id
    );
  });
  if (!result.ok) throw new HttpError(409, { error: `${action.name}_failed`, detail: result.stderr || result.error });
  return result;
}

function stateProfile(action) {
  return { id: action.args.profile_id, name: action.args.profile_name || '' };
}

function createParentSubmission(action) {
  return mutate((state) => {
    assertActionProjectIdle(state, action);
    if (!String(action.args.summary || '').trim()) throw new HttpError(400, { error: 'submission_summary_required' });
    const actor = owner(state),
      session = findSession(state, action.session_id);
    const from = state.agent_sessions.find((item) => item.id === session.agent_session_id);
    const to = state.agent_sessions.find((item) => item.id === from?.parent_session_id);
    if (!from || !to) throw new HttpError(409, { error: 'parent_agent_session_required' });
    const submission = createSubSubmission({
      projectId: action.project_id,
      workspaceId: action.workspace_id,
      nodeId: action.node_id,
      fromSessionId: from.id,
      toSessionId: to.id,
      title: action.args.title || action.label,
      summary: action.args.summary || '',
      changes: action.args.changes || [],
      evidenceRefs: action.args.evidence_refs || [],
      risks: action.args.risks || [],
      actorId: actor.id
    });
    state.submissions.push(submission);
    addTrace(
      state,
      'agent_session.submission.created',
      {
        project_id: action.project_id,
        workspace_id: action.workspace_id,
        node_id: action.node_id,
        target_type: 'submission',
        target_id: submission.id,
        summary: `SubSubmission：${submission.title}`,
        data: submission
      },
      actor.id
    );
    return submission;
  });
}

async function reserveAction(sessionId, actionId, status) {
  return mutate((state) => {
    const item = state.ui_action_intents.find((entry) => entry.id === actionId && entry.session_id === sessionId);
    if (!item) throw new HttpError(404, { error: 'assist_action_not_found' });
    assertActionProjectIdle(state, item);
    if (item.status !== 'pending') throw new HttpError(409, { error: 'assist_action_already_decided' });
    item.status = status;
    item.updated_at = now();
    return item;
  });
}
async function finishAction(source, status, result) {
  const action = await mutate((state) => {
    const item = state.ui_action_intents.find((entry) => entry.id === source.id);
    if (!item) throw new HttpError(404, { error: 'assist_action_not_found' });
    assertActionProjectIdle(state, item);
    item.status = status;
    item.result = result;
    item.updated_at = now();
    const actor = owner(state);
    const event =
      status === 'rejected'
        ? 'assist.action.rejected'
        : status === 'failed'
          ? 'assist.action.failed'
          : 'assist.action.confirmed';
    addTrace(
      state,
      event,
      {
        project_id: item.project_id,
        workspace_id: item.workspace_id,
        node_id: item.node_id,
        target_id: item.id,
        summary: `${status}: ${item.label}`
      },
      actor.id
    );
    return item;
  });
  await appendEvent(action.session_id, 'action', { action });
  return action;
}
function pushEvent(state, sessionId, type, data) {
  const sequence =
    Math.max(
      0,
      ...state.assist_events.filter((item) => item.session_id === sessionId).map((item) => item.sequence || 0)
    ) + 1;
  state.assist_events.push({ id: sequence, sequence, session_id: sessionId, type, data, created_at: now() });
}
function markTerminal(sessionId, status, error) {
  return mutate((state) => {
    const session = findSession(state, sessionId);
    const exists = state.assist_events.some((item) => item.session_id === sessionId && item.type === status);
    Object.assign(session, { status, error, updated_at: now() });
    if (!exists) pushEvent(state, sessionId, status, { error });
    return session;
  });
}
function hierarchyContext(state, session) {
  const submissions = state.submissions.filter(
    (item) =>
      item.project_id === session.project_id &&
      item.status === 'submitted' &&
      (session.scope_type === 'project' || item.to_session_id === session.agent_session_id)
  );
  return {
    parent_agent_session_id:
      state.agent_sessions.find((item) => item.id === session.agent_session_id)?.parent_session_id || null,
    submissions: submissions.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      changes: item.changes,
      evidence_refs: item.evidence_refs,
      risks: item.risks
    }))
  };
}
function assistPrompt(session, content, hierarchy) {
  return `You are the AI Workspace assistant. Scope: ${session.scope_type}:${session.scope_id}. ViewContext: ${JSON.stringify(session.view_context || {})}. HierarchyContext: ${JSON.stringify(hierarchy)}. Answer the user, then return ONLY JSON {"message":"...","actions":[{"name":"allowed semantic action","label":"...","args":{}}]}. Allowed actions: ${[...reversible, ...confirmed, ...proposals].join(', ')}. Use only semantic field/filter/tab ids declared in ViewContext. Never return selectors, scripts, credentials, or arbitrary URLs. User: ${content}`;
}
function parseResult(text) {
  const cleaned = String(text || '')
    .replace(/```(?:json)?/g, '')
    .replace(/```/g, '');
  const start = cleaned.indexOf('{'),
    end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(cleaned.slice(start, end + 1));
      return { message: value.message || cleaned, actions: Array.isArray(value.actions) ? value.actions : [] };
    } catch {}
  }
  return { message: cleaned.trim() || 'Codex 未返回文本。', actions: [] };
}
function forbiddenArgs(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, item]) =>
      /selector|script|javascript|html/i.test(key) ||
      (key === 'url' && typeof item === 'string') ||
      (typeof item === 'object' && forbiddenArgs(item))
  );
}
function allowedPath(value) {
  return /^\/(projects(?:\/[^/]+(?:\/workflow|\/nodes\/[^/]+)?)?|assets|audit|settings)$/.test(String(value || ''));
}
function semanticActionAllowed(state, session, name, args) {
  if (name === 'navigate') return allowedPath(args.path);
  if (name === 'select_node')
    return state.workflow_nodes.some(
      (node) =>
        node.id === args.node_id &&
        state.workflows.some(
          (workflow) => workflow.id === node.workflow_id && workflow.project_id === session.project_id
        )
    );
  const surface = session.view_context?.surface || {};
  const idValue =
    name === 'switch_workspace_tab'
      ? args.tab || args.tab_id
      : name === 'set_filter'
        ? args.filter_id || args.filter || args.name
        : args.field_id || args.field || args.name;
  const collection =
    name === 'switch_workspace_tab' ? surface.tabs : name === 'set_filter' ? surface.filters : surface.fields;
  const target = Array.isArray(collection) ? collection.find((item) => item.id === idValue) : null;
  if (!target) return false;
  return name !== 'set_filter' || !Array.isArray(target.values) || target.values.includes(String(args.value));
}
function findSession(state, idValue) {
  const session = state.assist_sessions.find((item) => item.id === idValue && item.version === 2);
  if (!session) throw new HttpError(404, { error: 'assist_session_not_found' });
  return session;
}
function assertActionProjectIdle(state, action) {
  return assertProjectLifecycleIdle(state.projects.find((item) => item.id === action.project_id));
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
