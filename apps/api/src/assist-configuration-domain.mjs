import { HttpError } from './http.mjs';

const CODEX_MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/+:@-]{0,199}$/;
const REASONING_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;

export function resolveAssistTurnConfiguration(state, input = {}, { allowMissingProfile = false } = {}) {
  const explicitConfiguration = resolveExplicitConfiguration(state, input),
    requestedProfile = resolveRequestedProfile(state, input),
    configuration = resolveLegacyConfiguration(state, explicitConfiguration, requestedProfile),
    profile = resolveBaseProfile(state, configuration, requestedProfile);
  if (!profile && !allowMissingProfile) throw new HttpError(409, { error: 'active_codex_profile_required' });
  return {
    profile,
    configuration,
    model: normalizeAssistModel(modelValue(input, configuration, requestedProfile, profile, allowMissingProfile)),
    reasoning: normalizeAssistReasoning(reasoningValue(input, configuration, requestedProfile, profile))
  };
}

export function normalizeAssistModel(value) {
  const model = cleanText(value, 200);
  if (!CODEX_MODEL_PATTERN.test(model)) throw new HttpError(400, { error: 'invalid_assist_model' });
  return model;
}

export function normalizeAssistReasoning(value) {
  const reasoning = cleanText(value, 64).toLowerCase();
  if (!REASONING_PATTERN.test(reasoning)) throw new HttpError(400, { error: 'invalid_assist_reasoning' });
  return reasoning;
}

function resolveRequestedProfile(state, input) {
  const requestedId = cleanText(input.profile_id, 200),
    profile = requestedId
      ? state.codex_profiles.find((item) => item.id === requestedId && item.status === 'validated')
      : null;
  if (requestedId && !profile) throw new HttpError(404, { error: 'validated_profile_not_found' });
  return profile;
}

function resolveExplicitConfiguration(state, input) {
  const configurationId = cleanText(input.configuration_id, 200),
    configuration = configurationId ? state.assist_configurations.find((item) => item.id === configurationId) : null;
  if (configurationId && !configuration) throw new HttpError(404, { error: 'assist_configuration_not_found' });
  return configuration;
}

function resolveLegacyConfiguration(state, configuration, requestedProfile) {
  if (configuration || !requestedProfile?.assist_configuration) return configuration;
  return (
    state.assist_configurations.find((item) => item.legacy_profile_id === requestedProfile.id) ||
    legacyConfiguration(requestedProfile)
  );
}

function legacyConfiguration(requestedProfile) {
  return {
    id: null,
    base_profile_id: requestedProfile.base_profile_id,
    model: requestedProfile.model,
    reasoning: requestedProfile.reasoning
  };
}

function resolveBaseProfile(state, configuration, requestedProfile) {
  const baseProfileId = configuration?.base_profile_id || requestedProfile?.base_profile_id || requestedProfile?.id;
  if (baseProfileId)
    return state.codex_profiles.find(
      (item) => item.id === baseProfileId && item.status === 'validated' && !item.assist_configuration
    );
  return (
    state.codex_profiles.find((item) => item.is_active && item.status === 'validated' && !item.assist_configuration) ||
    state.codex_profiles.find((item) => item.status === 'validated' && !item.assist_configuration)
  );
}

function modelValue(input, configuration, requestedProfile, profile, allowMissingProfile) {
  return (
    input.model ??
    configuration?.model ??
    requestedProfile?.model ??
    profile?.model ??
    (allowMissingProfile ? 'test' : '')
  );
}

function reasoningValue(input, configuration, requestedProfile, profile) {
  return input.reasoning ?? configuration?.reasoning ?? requestedProfile?.reasoning ?? profile?.reasoning ?? 'high';
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .slice(0, max)
    .trim();
}
