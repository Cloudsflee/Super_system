import { HttpError } from './http.mjs';
import { mutate, owner, readState } from './state.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { applyAssistWorktree, assistReviewSnapshot, publicWorktree, rollbackAssistWorktree } from './assist-v3-worktree.mjs';
import { boundedInt, cleanText, persistedWorktreeFields, requireProject, requireTurn, safeRelativePath, TERMINAL_TURN_STATES } from './assist-v3-domain.mjs';

const locks = new Map();

export async function getV3Review(turnId) {
  const snapshot = await readState(), turn = requireTurn(snapshot, turnId), project = requireProject(snapshot, turn.project_id);
  if (turn.mode !== 'agent') throw new HttpError(409, { error: 'assist_turn_has_no_review' });
  const worktree = snapshot.worktrees.find((item) => item.id === turn.worktree_id);
  if (!worktree) throw new HttpError(409, { error: 'assist_turn_worktree_not_ready' });
  const review = await assistReviewSnapshot(project, worktree);
  await mutate((state) => {
    const current = state.worktrees.find((item) => item.id === worktree.id);
    if (current && !['applied', 'rolled_back'].includes(current.status)) Object.assign(current, { target_hash: review.target_hash, head_commit: review.head_commit, status: review.changed_files.length ? 'review_ready' : 'active', updated_at: now() });
  });
  const state = await readState(), currentTurn = requireTurn(state, turn.id), currentWorktree = state.worktrees.find((item) => item.id === worktree.id);
  return reviewResponse(state, currentTurn, currentWorktree, review);
}
export async function markV3ReviewViewed(turnId, input = {}) {
  const review = await getV3Review(turnId), filePath = safeRelativePath(input.path);
  if (!review.changed_files.some((item) => item.path === filePath)) throw new HttpError(404, { error: 'review_file_not_found' });
  return mutate((state) => {
    const turn = requireTurn(state, turnId), viewed = { ...(turn.review?.viewed_files || {}) };
    if (input.viewed === false) delete viewed[filePath]; else viewed[filePath] = now();
    turn.review = { ...(turn.review || {}), viewed_files: viewed }; turn.updated_at = now();
    return { turn_id: turn.id, path: filePath, viewed: input.viewed !== false, viewed_files: viewed };
  });
}
export async function addV3ReviewComment(turnId, input = {}) {
  const review = await getV3Review(turnId), filePath = safeRelativePath(input.path), body = cleanText(input.body || input.comment, 10_000);
  if (!review.changed_files.some((item) => item.path === filePath)) throw new HttpError(404, { error: 'review_file_not_found' });
  if (!body) throw new HttpError(400, { error: 'review_comment_required' });
  return mutate((state) => {
    const actor = owner(state), turn = requireTurn(state, turnId);
    const item = { id: id('hrv'), target_type: 'assist_turn', target_id: turn.id, action: 'line_comment', reviewer_id: actor.id, patch: { path: filePath, line: boundedInt(input.line, 1, 10_000_000, 1), side: input.side === 'old' ? 'old' : 'new', body }, created_at: now() };
    state.human_reviews.push(item); turn.review = { ...(turn.review || {}), comment_count: Number(turn.review?.comment_count || 0) + 1 }; turn.updated_at = now(); return item;
  });
}
export async function requestV3ReviewChanges(turnId, input = {}) {
  const review = await getV3Review(turnId);
  const snapshot = await readState(), currentTurn = requireTurn(snapshot, turnId);
  if (!TERMINAL_TURN_STATES.has(currentTurn.status)) throw new HttpError(409, { error: 'assist_turn_not_terminal' });
  if (['applied', 'rolled_back'].includes(review.worktree?.status)) throw new HttpError(409, { error: 'review_already_resolved' });
  if (!input.target_hash || input.target_hash !== review.target_hash) throw new HttpError(409, { error: 'review_stale', target_hash: review.target_hash });
  return mutate((state) => {
    const actor = owner(state), turn = requireTurn(state, turnId), worktree = state.worktrees.find((item) => item.id === turn.worktree_id);
    const item = { id: id('hrv'), target_type: 'assist_turn', target_id: turn.id, action: 'request_changes', reviewer_id: actor.id, patch: { summary: cleanText(input.summary || input.reason, 10_000), target_hash: review.target_hash }, created_at: now() };
    state.human_reviews.push(item); turn.review = { ...(turn.review || {}), status: 'changes_requested', requested_changes: item.patch.summary, target_hash: review.target_hash }; turn.review_status = 'changes_requested'; turn.updated_at = now();
    if (worktree && worktree.status === 'review_ready') Object.assign(worktree, { status: 'changes_requested', updated_at: now() });
    return { review: item, turn_id: turn.id, status: 'changes_requested', target_hash: review.target_hash };
  });
}
export async function applyV3Review(turnId, input = {}) {
  return withLock(turnId, async () => {
    const snapshot = await readState(), turn = requireTurn(snapshot, turnId), project = requireProject(snapshot, turn.project_id);
    if (!TERMINAL_TURN_STATES.has(turn.status)) throw new HttpError(409, { error: 'assist_turn_not_terminal' });
    const worktree = snapshot.worktrees.find((item) => item.id === turn.worktree_id);
    if (!worktree) throw new HttpError(409, { error: 'assist_turn_worktree_not_ready' });
    const result = await applyAssistWorktree(project, worktree, input.target_hash);
    return mutate((state) => persistDecision(state, turn.id, worktree, 'applied', result));
  });
}
export async function rollbackV3Review(turnId, input = {}) {
  return withLock(turnId, async () => {
    const snapshot = await readState(), turn = requireTurn(snapshot, turnId), project = requireProject(snapshot, turn.project_id), worktree = snapshot.worktrees.find((item) => item.id === turn.worktree_id);
    if (!TERMINAL_TURN_STATES.has(turn.status)) throw new HttpError(409, { error: 'assist_turn_not_terminal' });
    if (!worktree) throw new HttpError(409, { error: 'assist_turn_worktree_not_ready' });
    const result = await rollbackAssistWorktree(project, worktree, input.target_hash || null);
    return mutate((state) => persistDecision(state, turn.id, worktree, 'rolled_back', result));
  });
}

function persistDecision(state, turnId, worktree, status, result) {
  const turn = requireTurn(state, turnId), current = state.worktrees.find((item) => item.id === worktree.id);
  if (!current) throw new HttpError(409, { error: 'worktree_not_found' });
  Object.assign(current, persistedWorktreeFields(worktree)); turn.review_status = status;
  turn.review = { ...(turn.review || {}), status, target_hash: worktree.target_hash, applied_at: worktree.applied_at, rolled_back_at: worktree.rolled_back_at }; turn.updated_at = now();
  return { idempotent: result.idempotent, turn_id: turn.id, worktree: publicWorktree(current), changed_files: result.changed_files || [], target_hash: current.target_hash };
}
function reviewResponse(state, turn, worktree, review) {
  return { turn_id: turn.id, status: turn.review_status, worktree: publicWorktree(worktree), changed_files: review.changed_files, diff: review.diff, target_hash: review.target_hash, base_commit: review.base_commit, head_commit: review.head_commit, viewed_files: turn.review?.viewed_files || {}, comments: state.human_reviews.filter((item) => item.target_type === 'assist_turn' && item.target_id === turn.id) };
}
function withLock(key, operation) {
  const prior = locks.get(key) || Promise.resolve(), current = prior.catch(() => undefined).then(operation); locks.set(key, current);
  return current.finally(() => { if (locks.get(key) === current) locks.delete(key); });
}
