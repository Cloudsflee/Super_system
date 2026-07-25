import { HttpError, makeRoute, send } from '../http.mjs';
import {
  installManagedCcSwitch,
  managedCcSwitchStatus,
  parseProviderList,
  runManagedCcSwitch
} from '../cc-switch-managed-cli.mjs';
import { applyConfigRevision, proposeConfigRevision } from '../config-revision-service.mjs';
import { readState } from '../state.mjs';
import { testAdapter } from '../test-adapter.mjs';

export const configGovernanceV13Routes = [
  makeRoute('GET', '/codex/cc-switch/managed/status', async ({ res }) => send(res, 200, await managedCcSwitchStatus())),
  makeRoute('POST', '/codex/cc-switch/managed/install', async ({ res, body, query }) =>
    send(res, 200, await installManagedCcSwitch({ adapted: testAdapter(body, query) }))
  ),
  makeRoute('GET', '/codex/cc-switch/managed/catalog', catalog),
  makeRoute('POST', '/codex/config-revisions', async ({ res, body }) =>
    send(res, 201, await proposeConfigRevision(body))
  ),
  makeRoute('POST', '/codex/config-revisions/:id/reconcile', reconcile)
];

async function catalog({ res, query }) {
  const state = await readState(),
    profile = state.codex_profiles.find((item) => item.is_active);
  const adapted = process.env.NODE_ENV === 'test' && query.adapter === 'test',
    result = await runManagedCcSwitch(['--app', 'codex', 'provider', 'list'], {
      codexHome: profile?.codex_home,
      adapted,
      adaptedOutput: '*  test-provider  Test Provider'
    });
  if (!result.ok)
    throw new HttpError(409, { error: 'cc_switch_catalog_failed', detail: result.stderr || result.error });
  return send(res, 200, { providers: parseProviderList(result.stdout), source: 'managed-cc-switch-cli' });
}
async function reconcile({ res, params, body }) {
  const state = await readState(),
    revision = state.config_revisions.find((item) => item.id === params.id);
  if (!revision) throw new HttpError(404, { error: 'config_revision_not_found' });
  return send(res, 200, await applyConfigRevision(revision.proposal_id, body));
}
