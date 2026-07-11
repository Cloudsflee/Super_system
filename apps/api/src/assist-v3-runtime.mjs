import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http.mjs';
import { mutate, readState } from './state.mjs';
import { extractMessage, runCodexJson } from './codex-service.mjs';
import { runCodexAppServer } from './codex-app-server.mjs';
import { probeCodexCapabilities } from './codex-capabilities.mjs';
import { assistReviewSnapshot, createAssistWorktree, removeAssistWorktree } from './assist-v3-worktree.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { persistV3CodexEvent, persistV3TypedEvent, pushV3Event } from './assist-v3-events.mjs';
import { appServerUserInput, turnPrompt } from './assist-v3-context.mjs';
import {
  activeTurn, cleanText, hasActiveTurn, publicErrorCode, publicProfile, readableProjectCwd,
  requireProject, requireSession, requireTurn, safeRelativePath, TERMINAL_TURN_STATES
} from './assist-v3-domain.mjs';

const controllers = new Map();
const pumps = new Map();

export function abortV3Turn(turnId) { controllers.get(turnId)?.abort(); }
export function scheduleV3Session(sessionId) {
  if (pumps.has(sessionId)) return;
  const pump = (async () => {
    while (true) {
      const state = await readState();
      if (activeTurn(state, sessionId)) return;
      const next = state.assist_turns.filter((item) => item.session_id === sessionId && item.status === 'queued').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
      if (!next) return;
      await runV3Turn(next.id);
    }
  })().catch(() => undefined).finally(() => {
    if (pumps.get(sessionId) === pump) pumps.delete(sessionId);
    setImmediate(async () => { const state = await readState().catch(() => null); if (state?.assist_turns.some((item) => item.session_id === sessionId && item.status === 'queued')) scheduleV3Session(sessionId); });
  });
  pumps.set(sessionId, pump);
}

async function runV3Turn(turnId) {
  const controller = new AbortController(); controllers.set(turnId, controller);
  let worktree = null, worktreeProject = null, worktreePersisted = false;
  try {
    let start = await mutate((state) => {
      const turn = requireTurn(state, turnId), session = requireSession(state, turn.session_id), project = requireProject(state, turn.project_id);
      if (turn.status !== 'queued') return null;
      Object.assign(turn, { status: 'preparing', started_at: now(), updated_at: now() });
      Object.assign(session, { status: 'running', updated_at: now() }); return { turn, session, project };
    });
    if (!start) return;
    if (start.turn.mode === 'agent') {
      worktreeProject = start.project; worktree = await createAssistWorktree(start.project, start.turn);
      const attached = await mutate((state) => {
        const turn = requireTurn(state, turnId); if (turn.status !== 'preparing') return false;
        state.worktrees.push(worktree); turn.worktree_id = worktree.id; turn.updated_at = now(); return true;
      });
      if (!attached) { await removeAssistWorktree(start.project, worktree).catch(() => undefined); worktree = null; return; }
      worktreePersisted = true;
    }
    start = await mutate((state) => {
      const turn = requireTurn(state, turnId), session = requireSession(state, turn.session_id), project = requireProject(state, turn.project_id);
      if (turn.status !== 'preparing') return null;
      const profile = turn.test_adapter ? { id: 'test_adapter', name: 'Test Adapter', kind: 'host', model: 'test', reasoning: 'none' } : turn.profile_id ? state.codex_profiles.find((item) => item.id === turn.profile_id && item.status === 'validated') : state.codex_profiles.find((item) => item.is_active && item.status === 'validated');
      if (!profile) throw new HttpError(409, { error: 'active_codex_profile_required' });
      turn.profile_id = profile.id; turn.status = 'running'; turn.updated_at = now();
      pushV3Event(state, session.id, turn.id, 'started', { mode: turn.mode, profile: publicProfile(profile), worktree_id: turn.worktree_id });
      return { turn, session, project, profile, attachments: turn.attachment_ids.map((key) => state.attachments.find((item) => item.id === key)).filter(Boolean), contextPack: state.context_packs.find((item) => item.id === turn.context_pack_id) };
    });
    if (!start) return;
    const cwd = start.turn.mode === 'agent' ? worktree.path : readableProjectCwd(start.project);
    let output = '', threadId = start.session.codex_thread_id || null, eventChain = Promise.resolve();
    if (start.turn.test_adapter) {
      const adapted = start.turn.test_response || {};
      await abortableDelay(adapted.delay_ms || 0, controller.signal); if (controller.signal.aborted) return;
      if ((adapted.files || []).length && !worktree) throw new HttpError(409, { error: 'test_adapter_read_only_violation' });
      const changed = worktree ? await writeAdapterFiles(worktree.path, adapted.files || []) : [];
      if (changed.length) await mutate((state) => pushV3Event(state, start.session.id, start.turn.id, 'file_change', { changes: changed }));
      const typed = new Set(['text', 'plan', 'command', 'file_change', 'test', 'mcp', 'search', 'usage', 'approval', 'reasoning_summary', 'status', 'terminal']);
      for (const event of adapted.events || []) {
        const saved = typed.has(event.type) && event.data ? await persistV3TypedEvent(start.session.id, start.turn.id, event.type, event.data) : await persistV3CodexEvent(start.session.id, start.turn.id, event);
        if (saved?.type === 'approval' && !await waitForRuntimeApproval(saved.data.approval_id, start.turn.id, controller.signal)) throw new HttpError(409, { error: 'runtime_approval_rejected' });
      }
      output = cleanText(adapted.message, 200_000) || '测试 Assist V3 Turn 已完成。';
      const review = worktree ? await assistReviewSnapshot(start.project, worktree) : null;
      await mutate((state) => completeTurn(state, { turnId, output, threadId: null, review, worktree })); return;
    }
    const runtimeState = await readState(), sandbox = start.turn.mode === 'agent' ? 'workspace-write' : 'read-only';
    const eventHandler = (event) => {
      if (event?.type === 'thread.started' && event.thread_id) threadId = cleanText(event.thread_id, 300);
      const message = extractMessage(event); if (message) output += message;
      eventChain = eventChain.then(() => persistV3CodexEvent(start.session.id, start.turn.id, event));
    };
    let result;
    if (appServerAvailable(runtimeState, start.profile)) {
      try {
        const prompt = turnPrompt(start), userInput = await appServerUserInput(prompt, start.attachments, runtimeState);
        result = await runCodexAppServer({ state: runtimeState, profile: start.profile, prompt, userInput, cwd, resumeId: threadId, sandbox, signal: controller.signal, onEvent: eventHandler, onApproval: async (request) => { const saved = await persistV3TypedEvent(start.session.id, start.turn.id, 'approval', request); return saved ? await waitForRuntimeApproval(saved.data.approval_id, start.turn.id, controller.signal) : false; } });
      } catch (error) {
        if (error.code !== 'app_server_start_failed') throw error;
        await persistV3TypedEvent(start.session.id, start.turn.id, 'status', { status: 'transport_fallback', from: 'app-server', to: 'exec-json' });
        result = await runCodexJson({ state: runtimeState, profile: start.profile, prompt: turnPrompt(start), cwd, resumeId: threadId, sandbox, signal: controller.signal, onEvent: eventHandler });
      }
    } else result = await runCodexJson({ state: runtimeState, profile: start.profile, prompt: turnPrompt(start), cwd, resumeId: threadId, sandbox, signal: controller.signal, onEvent: eventHandler });
    await eventChain;
    if (controller.signal.aborted) return;
    if (!result.ok) throw new Error(result.stderr || `codex_exit_${result.code}`);
    const review = worktree ? await assistReviewSnapshot(start.project, worktree) : null;
    await mutate((state) => completeTurn(state, { turnId, output, threadId, review, worktree }));
  } catch (error) {
    await mutate((state) => failTurn(state, turnId, error, controllers.get(turnId)?.signal.aborted)).catch(() => undefined);
  } finally {
    if (worktree && !worktreePersisted && worktreeProject) await removeAssistWorktree(worktreeProject, worktree).catch(() => undefined);
    if (controllers.get(turnId) === controller) controllers.delete(turnId);
  }
}

async function writeAdapterFiles(root, files) {
  const changed = [];
  for (const item of Array.isArray(files) ? files.slice(0, 50) : []) {
    const relative = safeRelativePath(item.path), target = path.resolve(root, relative), boundary = path.relative(path.resolve(root), target);
    if (!boundary || boundary.startsWith('..') || path.isAbsolute(boundary)) throw new HttpError(403, { error: 'adapter_file_outside_worktree' });
    let cursor = path.resolve(root);
    for (const segment of boundary.split(path.sep).slice(0, -1)) { cursor = path.join(cursor, segment); if (fs.existsSync(cursor) && (await fsp.lstat(cursor)).isSymbolicLink()) throw new HttpError(403, { error: 'adapter_file_symlink_path' }); }
    const content = String(item.content ?? ''); if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw new HttpError(413, { error: 'adapter_file_too_large' });
    await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.writeFile(target, content, 'utf8');
    changed.push({ path: relative, kind: 'modified' });
  }
  return changed;
}
function abortableDelay(ms, signal) { return new Promise((resolve) => { const timer = setTimeout(done, Math.max(0, Math.min(2_000, Number(ms) || 0))); function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); } signal?.addEventListener('abort', done, { once: true }); }); }
async function waitForRuntimeApproval(approvalId, turnId, signal) {
  while (!signal.aborted) {
    const state = await readState(), approval = state.runtime_approvals.find((item) => item.id === approvalId);
    if (!approval) throw new HttpError(409, { error: 'runtime_approval_missing' });
    if (approval.status === 'rejected') return false;
    if (approval.status === 'approved') {
      await mutate((data) => { const turn = data.assist_turns.find((item) => item.id === turnId); if (turn && ['queued', 'waiting_approval'].includes(turn.status)) Object.assign(turn, { status: 'running', waiting_approval_id: null, updated_at: now() }); });
      return true;
    }
    await abortableDelay(100, signal);
  }
  return false;
}

function completeTurn(state, { turnId, output, threadId, review, worktree }) {
  const turn = requireTurn(state, turnId), session = requireSession(state, turn.session_id, true);
  if (TERMINAL_TURN_STATES.has(turn.status)) return;
  if (threadId) { turn.codex_thread_id = threadId; session.codex_thread_id = threadId; }
  const response = cleanText(output, 200_000) || 'Codex Turn 已完成。';
  Object.assign(turn, { status: 'completed', output_text: response, completed_at: now(), updated_at: now(), review_status: review?.changed_files.length ? 'ready' : 'no_changes' });
  state.assist_messages.push({ id: id('amsg'), session_id: session.id, turn_id: turn.id, role: 'assistant', content: response, status: 'completed', created_at: now() });
  if (review && worktree) {
    const current = state.worktrees.find((item) => item.id === worktree.id);
    if (current) Object.assign(current, { status: review.changed_files.length ? 'review_ready' : 'active', target_hash: review.target_hash, head_commit: review.head_commit, updated_at: now() });
    turn.review = { status: review.changed_files.length ? 'ready' : 'no_changes', target_hash: review.target_hash, changed_file_count: review.changed_files.length, viewed_files: {} };
  }
  pushV3Event(state, session.id, turn.id, 'completed', { output_text: response, review_status: turn.review_status, target_hash: review?.target_hash || null });
  if (!hasActiveTurn(state, session.id, turn.id)) Object.assign(session, { status: 'idle', updated_at: now() });
}
function failTurn(state, turnId, error, stopped) {
  const turn = state.assist_turns.find((item) => item.id === turnId);
  if (!turn) return;
  const session = state.assist_sessions.find((item) => item.id === turn.session_id && item.version === 3);
  if (TERMINAL_TURN_STATES.has(turn.status)) { if (session && !hasActiveTurn(state, session.id, turn.id)) Object.assign(session, { status: 'idle', updated_at: now() }); return; }
  Object.assign(turn, { status: stopped ? 'interrupted' : 'failed', error_code: stopped ? 'turn_interrupted' : publicErrorCode(error), error: null, completed_at: now(), updated_at: now() });
  if (session) { pushV3Event(state, session.id, turn.id, turn.status, { error: turn.error_code }); if (!hasActiveTurn(state, session.id, turn.id)) Object.assign(session, { status: 'idle', updated_at: now() }); }
}
function appServerAvailable(state, profile) { const cached = state.integration_statuses.find((item) => item.key === 'codex_capabilities')?.result; if (cached?.compatible && cached.selected_runtime === (profile.kind === 'docker' ? 'docker' : 'host')) return cached.guided_transport === 'app-server'; return probeCodexCapabilities({ profile }).guided_transport === 'app-server'; }
