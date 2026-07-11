import { makeRoute, send } from '../http.mjs';
import { mutate, readState } from '../state.mjs';
import { probeCodexCapabilities } from '../codex-capabilities.mjs';
import { testAdapter } from '../test-adapter.mjs';
import { now } from '../../../../packages/shared/index.mjs';

export const codexCapabilitiesV13Routes = [
  makeRoute('GET', '/codex/capabilities', probe),
  makeRoute('POST', '/codex/capabilities/probe', probe)
];

async function probe({ res, body = {}, query }) {
  const state = await readState(), profile = body.profile_id ? state.codex_profiles.find((item) => item.id === body.profile_id) : state.codex_profiles.find((item) => item.is_active) || null;
  const result = probeCodexCapabilities({ adapted: testAdapter(body, query), profile });
  if (body.persist === true) await mutate((data) => { let item = data.integration_statuses.find((entry) => entry.key === 'codex_capabilities'); if (!item) { item = { key: 'codex_capabilities', created_at: now() }; data.integration_statuses.push(item); } Object.assign(item, { status: result.compatible ? 'ready' : result.guided_transport === 'unavailable' ? 'unavailable' : 'degraded', result, updated_at: now() }); });
  return send(res, 200, result);
}

