import { HttpError } from './http.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { codexAuthMatchesProfile, validateProfileInput, writeProfileConfig } from './codex-service.mjs';
import { publishCcSwitchCatalog } from './cc-switch-service.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { cleanText, normalizeAssistModel, normalizeAssistReasoning } from './assist-v3-domain.mjs';

const ALLOWED_FIELDS = new Set(['base_profile_id', 'name', 'model', 'reasoning']);
const INHERITED_FIELDS = [
  'kind', 'image', 'provider', 'provider_name', 'base_url', 'wire_api', 'requires_openai_auth',
  'web_search', 'mcp_servers', 'timeout_ms', 'mounts', 'cc_switch_mode', 'cc_switch_required',
  'cc_switch_provider_id', 'cc_switch_status', 'cc_switch_synced_at', 'cc_switch_bridge_revision', 'cc_switch_source_commit'
];

export async function saveAssistConfiguration(input = {}) {
  const unsupported = Object.keys(input).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unsupported.length) throw new HttpError(400, { error: 'unsupported_assist_configuration_field', fields: unsupported });
  const snapshot = await readState();
  const source = snapshot.codex_profiles.find((item) => item.id === input.base_profile_id && item.status === 'validated');
  if (!source) throw new HttpError(404, { error: 'validated_profile_not_found' });
  const name = cleanText(input.name, 100);
  if (!name) throw new HttpError(400, { error: 'assist_configuration_name_required' });
  const model = normalizeAssistModel(input.model ?? source.model), reasoning = normalizeAssistReasoning(input.reasoning ?? source.reasoning);
  const auth = snapshot.integration_statuses.find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, source)) throw new HttpError(409, { error: 'codex_auth_profile_mismatch' });
  const inherited = Object.fromEntries(INHERITED_FIELDS.filter((key) => source[key] !== undefined).map((key) => [key, cloneValue(source[key])]));
  const profile = {
    id: id('cdxp'), ...inherited, name, model, reasoning, status: 'validated', is_active: false,
    assist_configuration: true, base_profile_id: source.id, created_at: now(), updated_at: now()
  };
  const validation = validateProfileInput(snapshot, profile);
  if (!validation.ok) throw new HttpError(400, { error: 'invalid_codex_profile', details: validation.errors });
  Object.assign(profile, await writeProfileConfig(profile, auth?.home));
  return mutate(async (state) => {
    const currentSource = state.codex_profiles.find((item) => item.id === source.id && item.status === 'validated');
    if (!currentSource) throw new HttpError(409, { error: 'assist_configuration_source_changed' });
    const actor = owner(state); profile.created_by_user_id = actor.id; state.codex_profiles.push(profile);
    await publishCcSwitchCatalog(state);
    addTrace(state, 'codex.profile.created', { summary: `Assist configuration: ${profile.name}` }, actor.id);
    return profile;
  });
}

function cloneValue(value) { return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value; }
