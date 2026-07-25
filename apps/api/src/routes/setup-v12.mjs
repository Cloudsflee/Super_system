import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { computeSetupStatus, setupRecord } from '../setup-status.mjs';
import { now } from '../../../../packages/shared/index.mjs';
import { removeSecret } from '../vault.mjs';
import { inspectCodexRuntimeCached } from '../codex-runtime-status.mjs';
import { actorForRequest, requireInstanceOwner } from '../project-governance-v19.mjs';
import { revokeRepositoryInstallationBindingsInState } from '../repository-lifecycle-v19.mjs';

export const setupV12Routes = [
  makeRoute('GET', '/setup/status', async ({ res }) => {
    const state = await readState();
    return send(res, 200, computeSetupStatus(state, await setupRuntime(state)));
  }),
  makeRoute('PUT', '/setup/mode', async ({ req, res, body }) => {
    const authState = await readState();
    requireInstanceOwner(authState, actorForRequest(authState, req, { strict: Boolean(req.auth?.clientId) })?.id);
    if (!['hosted', 'byo'].includes(body.mode)) throw new HttpError(400, { error: 'invalid_setup_mode' });
    const runtime = await setupRuntime(await readState());
    const changed = await mutate((state) => {
      const actor = owner(state),
        record = setupRecord(state);
      if (record.completed_at && body.confirmed !== true)
        throw new HttpError(409, { error: 'configuration_confirmation_required' });
      const modeChanged = Boolean(record.mode && record.mode !== body.mode);
      const refs = modeChanged
        ? state.connected_accounts
            .filter((item) => item.provider === 'github')
            .map((item) => item.credential_ref)
            .filter(Boolean)
        : [];
      if (modeChanged) {
        state.connected_accounts = state.connected_accounts.filter((item) => item.provider !== 'github');
        revokeRepositoryInstallationBindingsInState(state, null, null, { reason: 'setup_mode_changed' });
        state.github_installations = [];
        state.repository_bindings = [];
      }
      Object.assign(record, { mode: body.mode, completed_at: null, updated_at: now() });
      addTrace(
        state,
        'setup.mode.updated',
        { summary: `Setup mode: ${body.mode}${modeChanged ? '（GitHub 授权已失效）' : ''}` },
        actor.id
      );
      return { status: computeSetupStatus(state, runtime), refs };
    });
    await Promise.all(changed.refs.map(removeSecret));
    return send(res, 200, changed.status);
  }),
  makeRoute('POST', '/setup/complete', async ({ req, res }) => {
    const authState = await readState();
    requireInstanceOwner(authState, actorForRequest(authState, req, { strict: Boolean(req.auth?.clientId) })?.id);
    const runtime = await setupRuntime(await readState());
    const result = await mutate((state) => {
      const status = computeSetupStatus(state, runtime);
      if (!status.can_complete) throw new HttpError(409, { error: 'setup_incomplete', reasons: status.reasons });
      const actor = owner(state),
        record = setupRecord(state);
      Object.assign(record, { completed_at: now(), updated_at: now() });
      addTrace(state, 'setup.completed', { summary: 'GitHub 与 Codex 首次配置完成。' }, actor.id);
      return computeSetupStatus(state, runtime);
    });
    return send(res, 200, result);
  })
];

async function setupRuntime(state) {
  if (process.env.NODE_ENV === 'test') return null;
  const profile =
    state?.codex_profiles?.find((item) => item.is_active) ||
    state?.codex_profiles?.find((item) => item.status === 'validated');
  return inspectCodexRuntimeCached({ image: profile?.image || undefined });
}
