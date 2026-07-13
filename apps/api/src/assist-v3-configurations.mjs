import { HttpError } from './http.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { cleanText, normalizeAssistModel, normalizeAssistReasoning } from './assist-v3-domain.mjs';

const ALLOWED_FIELDS = new Set(['base_profile_id', 'name', 'model', 'reasoning']);

export async function listAssistConfigurations(query = {}) {
  const state = await readState();
  let items = state.assist_configurations;
  if (query.base_profile_id) items = items.filter((item) => item.base_profile_id === query.base_profile_id);
  return items.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN')).map(publicConfiguration);
}

export async function getAssistConfiguration(configurationId) {
  const state = await readState(), item = state.assist_configurations.find((entry) => entry.id === configurationId);
  if (!item) throw new HttpError(404, { error: 'assist_configuration_not_found' });
  return publicConfiguration(item);
}

export async function saveAssistConfiguration(input = {}) {
  assertAllowedFields(input);
  const snapshot = await readState(), source = requireBaseProfile(snapshot, input.base_profile_id);
  const normalized = normalizeInput(input, source);
  assertVerifiedCombination(source, normalized.model, normalized.reasoning);
  return mutate((state) => {
    const currentSource = requireBaseProfile(state, source.id), actor = owner(state);
    if (state.assist_configurations.some((item) => item.base_profile_id === currentSource.id && item.name.toLocaleLowerCase() === normalized.name.toLocaleLowerCase())) throw new HttpError(409, { error: 'assist_configuration_name_conflict' });
    const created = { id: id('acfg'), base_profile_id: currentSource.id, ...normalized, created_by_user_id: actor.id, created_at: now(), updated_at: now() };
    state.assist_configurations.push(created);
    addTrace(state, 'codex.profile.created', { target_type: 'assist_configuration', target_id: created.id, summary: `Assist configuration: ${created.name}` }, actor.id);
    return publicConfiguration(created);
  });
}

export async function updateAssistConfiguration(configurationId, input = {}) {
  assertAllowedFields(input);
  return mutate((state) => {
    const item = state.assist_configurations.find((entry) => entry.id === configurationId);
    if (!item) throw new HttpError(404, { error: 'assist_configuration_not_found' });
    const source = requireBaseProfile(state, input.base_profile_id || item.base_profile_id);
    const normalized = normalizeInput({ name: input.name ?? item.name, model: input.model ?? item.model, reasoning: input.reasoning ?? item.reasoning }, source);
    assertVerifiedCombination(source, normalized.model, normalized.reasoning);
    if (state.assist_configurations.some((entry) => entry.id !== item.id && entry.base_profile_id === source.id && entry.name.toLocaleLowerCase() === normalized.name.toLocaleLowerCase())) throw new HttpError(409, { error: 'assist_configuration_name_conflict' });
    Object.assign(item, normalized, { base_profile_id: source.id, updated_at: now() });
    return publicConfiguration(item);
  });
}

export async function deleteAssistConfiguration(configurationId) {
  return mutate((state) => {
    const index = state.assist_configurations.findIndex((entry) => entry.id === configurationId);
    if (index < 0) throw new HttpError(404, { error: 'assist_configuration_not_found' });
    const [removed] = state.assist_configurations.splice(index, 1);
    return { id: removed.id, deleted: true };
  });
}

function requireBaseProfile(state, profileId) {
  const source = state.codex_profiles.find((item) => item.id === profileId && item.status === 'validated' && !item.assist_configuration);
  if (!source) throw new HttpError(404, { error: 'validated_profile_not_found' });
  return source;
}
function normalizeInput(input, source) { const name = cleanText(input.name, 100); if (!name) throw new HttpError(400, { error: 'assist_configuration_name_required' }); return { name, model: normalizeAssistModel(input.model ?? source.model), reasoning: normalizeAssistReasoning(input.reasoning ?? source.reasoning) }; }
function assertAllowedFields(input) { const unsupported = Object.keys(input).filter((key) => !ALLOWED_FIELDS.has(key)); if (unsupported.length) throw new HttpError(400, { error: 'unsupported_assist_configuration_field', fields: unsupported }); }
function assertVerifiedCombination(profile, model, reasoning) {
  const catalog = Array.isArray(profile.model_catalog) ? profile.model_catalog : [];
  if (!catalog.length) {
    if (model !== profile.model || reasoning !== profile.reasoning) throw new HttpError(409, { error: 'assist_configuration_combination_unverified', verified: { model: profile.model, reasoning: profile.reasoning } });
    return;
  }
  const entry = catalog.find((item) => item.model === model || item.id === model);
  const efforts = (entry?.supportedReasoningEfforts || []).map((item) => typeof item === 'string' ? item : item.reasoningEffort);
  if (!entry || efforts.length && !efforts.includes(reasoning)) throw new HttpError(409, { error: 'assist_configuration_combination_unverified' });
}
function publicConfiguration(item) { return { id: item.id, name: item.name, base_profile_id: item.base_profile_id, model: item.model, reasoning: item.reasoning, migrated_from: item.migrated_from || null, created_at: item.created_at, updated_at: item.updated_at }; }
