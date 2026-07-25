import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http.mjs';
import { mutate, readState } from './state.mjs';
import { extractMessage } from './codex-service.mjs';
import { runCodexAppServer } from './codex-app-server.mjs';
import { probeCodexCapabilities } from './codex-capabilities.mjs';
import { assistReviewSnapshot } from './assist-v3-worktree.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { persistV3CodexEvent, persistV3TypedEvent, pushV3Event } from './assist-v3-events.mjs';
import { appServerUserInput, applicationAdditionalContext, turnPrompt } from './assist-v3-context.mjs';
import {
  activeTurn,
  cancelPendingTurnApprovals,
  cleanText,
  hasActiveTurn,
  publicErrorCode,
  publicProfile,
  readableProjectCwd,
  requireProject,
  requireSession,
  requireTurn,
  safeRelativePath,
  TERMINAL_TURN_STATES
} from './assist-v3-domain.mjs';
import {
  acquireBatchWriteLock,
  createBatchCheckpoint,
  ensureSessionChangeBatch,
  getSessionChangeBatch
} from './assist-change-batches.mjs';
import { coordinateAssistSession } from './assist-session-coordinator.mjs';
import { dynamicPageToolSpec, handleDynamicPageTool } from './assist-operations.mjs';
import { cancelTurnUserInputs, waitForAssistUserInput } from './assist-user-input.mjs';
import { nativeAttachmentBindings, verifyTurnAttachmentManifest } from './assist-attachments.mjs';
import { currentActorId, runAsActor } from './actor-context.mjs';
import { assertProjectWrite } from './project-governance-v19.mjs';

const controllers = new Map();
const pumps = new Map();
const ADAPTED_TYPED_EVENTS = new Set([
  'text',
  'plan',
  'command',
  'file_change',
  'diff',
  'test',
  'mcp',
  'search',
  'usage',
  'approval',
  'reasoning_summary',
  'status',
  'terminal',
  'request_user_input',
  'operation'
]);

export function abortV3Turn(turnId) {
  controllers.get(turnId)?.abort();
}
export function scheduleV3Session(sessionId) {
  if (pumps.has(sessionId)) return;
  const pump = (async () => {
    while (true) {
      const state = await readState();
      if (activeTurn(state, sessionId)) return;
      const next = state.assist_turns
        .filter((item) => item.session_id === sessionId && item.status === 'queued')
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
      if (!next) return;
      await runAsActor(turnActorId(state, next), () => coordinateAssistSession(sessionId, () => runV3Turn(next.id)));
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      if (pumps.get(sessionId) === pump) pumps.delete(sessionId);
      setImmediate(async () => {
        const state = await readState().catch(() => null);
        if (state?.assist_turns.some((item) => item.session_id === sessionId && item.status === 'queued'))
          scheduleV3Session(sessionId);
      });
    });
  pumps.set(sessionId, pump);
}

async function runV3Turn(turnId) {
  const controller = new AbortController();
  controllers.set(turnId, controller);
  const runtime = {
    turnId,
    controller,
    batchInfo: null,
    releaseWriteLock: null,
    checkpointStarted: false
  };
  try {
    const queued = await prepareQueuedTurn(turnId);
    if (!queued || !(await prepareTurnChangeBatch(runtime, queued))) return;
    const start = await beginRunningTurn(turnId);
    if (!start) return;
    const environment = await prepareTurnEnvironment(start, runtime.batchInfo);
    const result = await executePreparedTurn(start, environment, controller);
    const review = await captureTurnReview(runtime, start);
    await mutate((state) =>
      completeTurn(state, {
        turnId,
        output: result.output || result.nativePlanOutput,
        threadId: result.threadId,
        codexTurnId: result.nativeTurnId,
        review,
        worktree: runtime.batchInfo?.worktree || null
      })
    );
  } catch (error) {
    await handleTurnFailure(runtime, error);
  } finally {
    await runtime.releaseWriteLock?.();
    if (controllers.get(turnId) === controller) controllers.delete(turnId);
  }
}

function prepareQueuedTurn(turnId) {
  return mutate((state) => {
    const turn = requireTurn(state, turnId),
      session = requireSession(state, turn.session_id),
      project = requireProject(state, turn.project_id);
    if (turn.status !== 'queued') return null;
    assertProjectWrite(state, turn.project_id, currentActorId());
    Object.assign(turn, { status: 'preparing', started_at: now(), updated_at: now() });
    Object.assign(session, { status: 'running', updated_at: now() });
    return { turn, session, project };
  });
}

async function prepareTurnChangeBatch(runtime, start) {
  if (start.turn.code_access !== 'workspace_write') {
    runtime.batchInfo = await getSessionChangeBatch(start.session.id);
    if (runtime.batchInfo) await attachBatchToTurn(runtime.turnId, runtime.batchInfo);
    return true;
  }
  runtime.batchInfo = await ensureSessionChangeBatch(start.session.id);
  runtime.releaseWriteLock = await acquireBatchWriteLock(runtime.batchInfo.batch.id, {
    kind: 'assist_turn',
    id: runtime.turnId
  });
  const attached = await attachBatchToTurn(runtime.turnId, runtime.batchInfo);
  if (!attached) return false;
  await createBatchCheckpoint(runtime.batchInfo.batch.id, {
    source: 'assist_turn',
    sourceId: runtime.turnId,
    phase: 'before'
  });
  runtime.checkpointStarted = true;
  return true;
}

function beginRunningTurn(turnId) {
  return mutate((state) => {
    const turn = requireTurn(state, turnId),
      session = requireSession(state, turn.session_id),
      project = requireProject(state, turn.project_id);
    if (turn.status !== 'preparing') return null;
    const requestedProfile = resolveRequestedProfile(state, turn);
    const storedProfile = turn.test_adapter ? requestedProfile || testAdapterProfile() : requestedProfile;
    if (!storedProfile) throw new HttpError(409, { error: 'active_codex_profile_required' });
    const profile = {
      ...storedProfile,
      model: turn.model || storedProfile.model,
      reasoning: turn.reasoning || storedProfile.reasoning
    };
    if (storedProfile.id !== 'test_adapter') turn.profile_id = storedProfile.id;
    Object.assign(turn, { model: profile.model, reasoning: profile.reasoning, status: 'running', updated_at: now() });
    pushV3Event(state, session.id, turn.id, 'started', {
      collaboration_mode: turn.collaboration_mode,
      code_access: turn.code_access,
      profile: publicProfile(profile),
      worktree_id: turn.worktree_id,
      change_batch_id: turn.change_batch_id
    });
    return runningTurnContext(state, turn, session, project, profile);
  });
}

function resolveRequestedProfile(state, turn) {
  if (!turn.profile_id) return null;
  return state.codex_profiles.find(
    (item) => item.id === turn.profile_id && item.status === 'validated' && !item.assist_configuration
  );
}

function testAdapterProfile() {
  return { id: 'test_adapter', name: 'Test Adapter', kind: 'host', model: 'test', reasoning: 'high' };
}

function runningTurnContext(state, turn, session, project, profile) {
  return {
    turn,
    session,
    project,
    profile,
    repositoryWorkspace:
      state.repository_workspaces.find(
        (item) => item.id === turn.repository_workspace_id && item.project_id === project.id && item.status === 'active'
      ) || null,
    attachments: turn.attachment_ids.map((key) => state.attachments.find((item) => item.id === key)).filter(Boolean),
    contextPack: state.context_packs.find((item) => item.id === turn.context_pack_id)
  };
}

async function prepareTurnEnvironment(start, batchInfo) {
  const worktree = batchInfo?.worktree || null;
  const cwd = worktree?.path || start.repositoryWorkspace?.managed_path || readableProjectCwd(start.project);
  if (!worktree) await fsp.mkdir(cwd, { recursive: true, mode: 0o700 });
  const sandbox = start.turn.code_access === 'workspace_write' ? 'workspace-write' : 'read-only';
  const verifiedAttachmentPaths = await verifyTurnAttachmentManifest(start.turn, start.attachments, cwd);
  const attachmentBindings = nativeAttachmentBindings(start.attachments, start.profile, verifiedAttachmentPaths);
  await bindNativeAttachmentPaths(start, cwd, verifiedAttachmentPaths, attachmentBindings);
  return { worktree, cwd, sandbox, attachmentBindings };
}

async function bindNativeAttachmentPaths(start, cwd, verifiedAttachmentPaths, attachmentBindings) {
  const realCwd = await fsp.realpath(cwd);
  for (const attachment of start.attachments.filter((item) => !item.managed_path)) {
    const file = verifiedAttachmentPaths.get(attachment.id);
    if (!file) continue;
    const relative = path.relative(realCwd, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new HttpError(409, { error: 'attachment_path_invalid', attachment_id: attachment.id });
    attachmentBindings.nativePaths.set(
      attachment.id,
      start.profile.kind === 'docker' ? `/workspace/${relative.split(path.sep).join('/')}` : file
    );
  }
}

function executePreparedTurn(start, environment, controller) {
  const threadId = start.session.native_thread_generation === 1 ? null : start.session.codex_thread_id || null;
  return start.turn.test_adapter
    ? runAdaptedTurn(start, environment, controller, threadId)
    : runNativeTurn(start, environment, controller, threadId);
}

async function runAdaptedTurn(start, environment, controller, threadId) {
  const adapted = start.turn.test_response || {};
  await abortableDelay(adapted.delay_ms || 0, controller.signal);
  if (controller.signal.aborted) throw new HttpError(409, { error: 'turn_interrupted' });
  if ((adapted.files || []).length && environment.sandbox !== 'workspace-write')
    throw new HttpError(409, { error: 'test_adapter_read_only_violation' });
  const changed = environment.worktree ? await writeAdapterFiles(environment.worktree.path, adapted.files || []) : [];
  if (changed.length)
    await mutate((state) => pushV3Event(state, start.session.id, start.turn.id, 'file_change', { changes: changed }));
  await persistAdaptedEvents(start, adapted.events || [], controller.signal);
  return {
    output: cleanText(adapted.message, 200_000) || '测试 Assist V3 Turn 已完成。',
    nativePlanOutput: '',
    nativeTurnId: null,
    threadId
  };
}

async function persistAdaptedEvents(start, events, signal) {
  for (const event of events) {
    const saved =
      ADAPTED_TYPED_EVENTS.has(event.type) && event.data
        ? await persistV3TypedEvent(start.session.id, start.turn.id, event.type, event.data)
        : await persistV3CodexEvent(start.session.id, start.turn.id, event);
    if (saved?.type === 'approval' && !(await waitForRuntimeApproval(saved.data.approval_id, start.turn.id, signal)))
      throw new HttpError(409, { error: 'runtime_approval_rejected' });
  }
}

async function runNativeTurn(start, environment, controller, threadId) {
  const runtimeState = await readState();
  if (!appServerAvailable(runtimeState, start.profile))
    throw new HttpError(409, { error: 'codex_app_server_required', action: 'update_codex_or_profile' });
  const collector = nativeEventCollector(start, threadId);
  const prompt = turnPrompt(start);
  const userInput = await appServerUserInput(prompt, start.attachments, runtimeState, {
    nativePaths: environment.attachmentBindings.nativePaths,
    containerized: start.profile.kind === 'docker',
    imageCapable: modelSupportsImages(start.profile, runtimeState),
    cwd: environment.cwd
  });
  const result = await runCodexAppServer(
    nativeTurnOptions(start, environment, controller, runtimeState, collector, prompt, userInput)
  );
  await collector.eventChain;
  const nativeTurnId = cleanText(result.turn_id, 300) || null;
  if (controller.signal.aborted) throw new HttpError(409, { error: 'turn_interrupted' });
  if (!result.ok) throw new Error(result.stderr || `codex_exit_${result.code}`);
  return {
    output: collector.output,
    nativePlanOutput: collector.nativePlanOutput,
    nativeTurnId,
    threadId: collector.threadId
  };
}

function nativeEventCollector(start, threadId) {
  const collector = { output: '', nativePlanOutput: '', threadId, eventChain: Promise.resolve() };
  collector.onEvent = (event) => {
    if (event?.type === 'thread.started' && event.thread_id) collector.threadId = cleanText(event.thread_id, 300);
    if (event?.aiws_type === 'plan' && event.data?.text)
      collector.nativePlanOutput =
        event.data.status === 'streaming' ? `${collector.nativePlanOutput}${event.data.text}` : String(event.data.text);
    const message = extractMessage(event);
    if (message) collector.output += message;
    collector.eventChain = collector.eventChain.then(() => persistV3CodexEvent(start.session.id, start.turn.id, event));
  };
  return collector;
}

function nativeTurnOptions(start, environment, controller, runtimeState, collector, prompt, userInput) {
  return {
    state: runtimeState,
    profile: start.profile,
    prompt,
    userInput,
    additionalContext: applicationAdditionalContext(start),
    dynamicTools: dynamicPageToolSpec(start.turn.view_context, start.turn.collaboration_mode, {
      state: runtimeState,
      projectId: start.project.id
    }),
    attachmentMounts: environment.attachmentBindings.mounts,
    cwd: environment.cwd,
    resumeId: collector.threadId,
    sandbox: environment.sandbox,
    mode: start.turn.collaboration_mode,
    projectId: start.project.id,
    signal: controller.signal,
    onEvent: collector.onEvent,
    onApproval: async (request) => {
      const saved = await persistV3TypedEvent(start.session.id, start.turn.id, 'approval', request);
      return saved ? waitForRuntimeApproval(saved.data.approval_id, start.turn.id, controller.signal) : false;
    },
    onUserInput: (request) => waitForAssistUserInput(start.session.id, start.turn.id, request, controller.signal),
    onDynamicTool: (request) => handleDynamicPageTool(start.session.id, start.turn.id, request, controller.signal)
  };
}

async function captureTurnReview(runtime, start) {
  if (!runtime.checkpointStarted || !runtime.batchInfo) return null;
  await createBatchCheckpoint(runtime.batchInfo.batch.id, {
    source: 'assist_turn',
    sourceId: runtime.turnId,
    phase: 'after'
  });
  return assistReviewSnapshot(start.project, runtime.batchInfo.worktree);
}

async function handleTurnFailure(runtime, error) {
  if (runtime.checkpointStarted && runtime.batchInfo)
    await createBatchCheckpoint(runtime.batchInfo.batch.id, {
      source: 'assist_turn',
      sourceId: runtime.turnId,
      phase: 'after',
      status: 'interrupted'
    }).catch(() => undefined);
  await cancelTurnUserInputs(runtime.turnId, 'turn_ended').catch(() => undefined);
  await mutate((state) =>
    failTurn(state, runtime.turnId, error, controllers.get(runtime.turnId)?.signal.aborted)
  ).catch(() => undefined);
}

async function attachBatchToTurn(turnId, batchInfo) {
  return mutate((state) => {
    const turn = requireTurn(state, turnId);
    if (turn.status !== 'preparing') return false;
    turn.worktree_id = batchInfo.worktree.id;
    turn.change_batch_id = batchInfo.batch.id;
    turn.updated_at = now();
    return true;
  });
}

async function writeAdapterFiles(root, files) {
  const changed = [];
  for (const item of Array.isArray(files) ? files.slice(0, 50) : []) {
    const relative = safeRelativePath(item.path),
      target = path.resolve(root, relative),
      boundary = path.relative(path.resolve(root), target);
    if (!boundary || boundary.startsWith('..') || path.isAbsolute(boundary))
      throw new HttpError(403, { error: 'adapter_file_outside_worktree' });
    let cursor = path.resolve(root);
    for (const segment of boundary.split(path.sep).slice(0, -1)) {
      cursor = path.join(cursor, segment);
      if (fs.existsSync(cursor) && (await fsp.lstat(cursor)).isSymbolicLink())
        throw new HttpError(403, { error: 'adapter_file_symlink_path' });
    }
    const content = String(item.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024)
      throw new HttpError(413, { error: 'adapter_file_too_large' });
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
    changed.push({ path: relative, kind: 'modified' });
  }
  return changed;
}

function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(0, Math.min(2_000, Number(ms) || 0)));
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
async function waitForRuntimeApproval(approvalId, turnId, signal) {
  while (!signal.aborted) {
    const state = await readState(),
      approval = state.runtime_approvals.find((item) => item.id === approvalId);
    if (!approval) throw new HttpError(409, { error: 'runtime_approval_missing' });
    if (approval.status === 'rejected') return false;
    if (approval.status === 'approved') {
      await mutate((data) => {
        const turn = data.assist_turns.find((item) => item.id === turnId);
        if (turn && ['queued', 'waiting_approval'].includes(turn.status))
          Object.assign(turn, { status: 'running', waiting_approval_id: null, updated_at: now() });
      });
      return true;
    }
    await abortableDelay(100, signal);
  }
  return false;
}

function completeTurn(state, { turnId, output, threadId, codexTurnId, review, worktree }) {
  const turn = requireTurn(state, turnId),
    session = requireSession(state, turn.session_id, true);
  if (TERMINAL_TURN_STATES.has(turn.status)) return;
  if (threadId) {
    turn.codex_thread_id = threadId;
    session.codex_thread_id = threadId;
    session.native_thread_generation = 2;
  }
  const response = cleanText(output, 200_000) || 'Codex Turn 已完成。';
  Object.assign(turn, {
    status: 'completed',
    output_text: response,
    codex_turn_id: codexTurnId || turn.codex_turn_id || null,
    completed_at: now(),
    updated_at: now(),
    review_status: review?.changed_files.length ? 'ready' : turn.change_batch_id ? 'no_changes' : 'not_applicable'
  });
  cancelPendingTurnApprovals(state, turn.id, 'turn_completed');
  state.assist_messages.push({
    id: id('amsg'),
    session_id: session.id,
    turn_id: turn.id,
    role: 'assistant',
    content: response,
    status: 'completed',
    created_at: now()
  });
  if (review && worktree) {
    const current = state.worktrees.find((item) => item.id === worktree.id);
    if (current)
      Object.assign(current, {
        status: review.changed_files.length ? 'review_ready' : 'active',
        target_hash: review.target_hash,
        head_commit: review.head_commit,
        updated_at: now()
      });
    turn.review = {
      status: review.changed_files.length ? 'ready' : 'no_changes',
      target_hash: review.target_hash,
      changed_file_count: review.changed_files.length,
      viewed_files: {},
      change_batch_id: turn.change_batch_id
    };
  }
  pushV3Event(state, session.id, turn.id, 'completed', {
    output_text: response,
    review_status: turn.review_status,
    target_hash: review?.target_hash || null,
    change_batch_id: turn.change_batch_id
  });
  if (!hasActiveTurn(state, session.id, turn.id)) Object.assign(session, { status: 'idle', updated_at: now() });
}

function failTurn(state, turnId, error, stopped) {
  const turn = state.assist_turns.find((item) => item.id === turnId);
  if (!turn) return;
  const session = state.assist_sessions.find((item) => item.id === turn.session_id && item.version === 3);
  if (TERMINAL_TURN_STATES.has(turn.status)) {
    if (session && !hasActiveTurn(state, session.id, turn.id))
      Object.assign(session, { status: 'idle', updated_at: now() });
    return;
  }
  Object.assign(turn, {
    status: stopped ? 'interrupted' : 'failed',
    error_code: stopped ? 'turn_interrupted' : publicErrorCode(error),
    error: null,
    completed_at: now(),
    updated_at: now()
  });
  cancelPendingTurnApprovals(state, turn.id, stopped ? 'turn_interrupted' : turn.error_code);
  if (session) {
    pushV3Event(state, session.id, turn.id, turn.status, { error: turn.error_code });
    if (!hasActiveTurn(state, session.id, turn.id)) Object.assign(session, { status: 'idle', updated_at: now() });
  }
}

function appServerAvailable(state, profile) {
  const cached = state.integration_statuses.find((item) => item.key === 'codex_capabilities')?.result;
  if (cached?.compatible && cached.selected_runtime === (profile.kind === 'docker' ? 'docker' : 'host'))
    return preferAssistAppServer(profile, cached);
  return preferAssistAppServer(profile, probeCodexCapabilities({ profile }));
}

function turnActorId(state, turn) {
  const session = state.assist_sessions.find((item) => item.id === turn.session_id),
    project = state.projects.find((item) => item.id === turn.project_id);
  return (
    turn.created_by_user_id ||
    session?.created_by_user_id ||
    project?.owner_user_id ||
    project?.created_by_user_id ||
    null
  );
}
export function preferAssistAppServer(_profile, capability) {
  return capability?.guided_transport === 'app-server';
}

function modelSupportsImages(profile, state) {
  const catalog =
    profile.model_catalog ||
    state.integration_statuses.find((item) => item.key === `codex_model_catalog:${profile.id}`)?.result;
  const model = (catalog?.models || catalog?.data || []).find((item) => (item.model || item.id) === profile.model);
  const modalities = model?.inputModalities || model?.input_modalities;
  return !Array.isArray(modalities) || modalities.includes('image');
}
