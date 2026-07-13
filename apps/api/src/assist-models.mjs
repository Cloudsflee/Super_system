import path from 'node:path';
import fsp from 'node:fs/promises';
import { HttpError } from './http.mjs';
import { PROBE_DIR } from './config.mjs';
import { mutate, readState } from './state.mjs';
import { runCodexAppServerRpc } from './codex-app-server.mjs';
import { isThirdPartyProvider } from './codex-service.mjs';

export async function listAssistModels(profileId, { rpc = runCodexAppServerRpc } = {}) {
  const state = await readState(), profile = state.codex_profiles.find((item) => item.id === profileId && item.status === 'validated' && !item.assist_configuration);
  if (!profile) throw new HttpError(404, { error: 'validated_profile_not_found' });
  if (Array.isArray(profile.model_catalog) && profile.model_catalog.length) return catalogResponse(profile, profile.model_catalog, 'validated_catalog');
  try {
    const cwd = path.join(PROBE_DIR, profile.id); await fsp.mkdir(cwd, { recursive: true, mode: 0o700 });
    const models = []; let cursor = null;
    for (let page = 0; page < 10; page++) {
      const response = await rpc({ state, profile, cwd, sandbox: 'read-only', method: 'model/list', params: { cursor, limit: 100, includeHidden: false } });
      const payload = response.result || {}, data = Array.isArray(payload.data) ? payload.data : [];
      models.push(...data); cursor = payload.nextCursor || null; if (!cursor) break;
    }
    if (!models.length) throw new Error('codex_model_catalog_empty');
    const catalog = catalogResponse(profile, models, 'codex_model_list');
    await cacheValidatedCatalog(profile.id, catalog.models);
    return catalog;
  } catch (error) {
    if (!isThirdPartyProvider(profile.provider) && profile.model_catalog_required === true) throw new HttpError(409, { error: 'codex_model_catalog_unavailable', reason: safeCatalogError(error), action: 'probe_profile' });
    return catalogResponse(profile, [{ id: profile.model, model: profile.model, displayName: profile.model, description: '', hidden: false, isDefault: true, defaultReasoningEffort: profile.reasoning, supportedReasoningEfforts: [{ reasoningEffort: profile.reasoning, description: 'Validated profile combination' }] }], 'verified_profile_fallback');
  }
}

function safeCatalogError(error) {
  const code = String(error?.code || '');
  return /^[a-z0-9_.-]{1,100}$/i.test(code) ? code : 'codex_model_list_failed';
}

async function cacheValidatedCatalog(profileId, models) {
  await mutate((state) => {
    const profile = state.codex_profiles.find((item) => item.id === profileId && item.status === 'validated' && !item.assist_configuration);
    if (!profile) return;
    profile.model_catalog = structuredClone(models);
    profile.model_catalog_updated_at = new Date().toISOString();
  });
}

function catalogResponse(profile, values, source) {
  const models = values.map(normalizeModel).filter((item) => item.model && !item.hidden);
  const selectedDefault = models.find((item) => item.isDefault)?.model || (models.some((item) => item.model === profile.model) ? profile.model : models[0]?.model || profile.model);
  return { profile_id: profile.id, default_model: selectedDefault, source, models };
}
function normalizeModel(item) {
  const supported = Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.map((entry) => typeof entry === 'string' ? { reasoningEffort: entry, description: '' } : { reasoningEffort: String(entry?.reasoningEffort || ''), description: String(entry?.description || '') }).filter((entry) => entry.reasoningEffort) : [];
  return { id: String(item.id || item.model || ''), model: String(item.model || item.id || ''), displayName: String(item.displayName || item.model || item.id || ''), description: String(item.description || ''), hidden: item.hidden === true, isDefault: item.isDefault === true, defaultReasoningEffort: String(item.defaultReasoningEffort || supported[0]?.reasoningEffort || ''), supportedReasoningEfforts: supported, inputModalities: Array.isArray(item.inputModalities) ? item.inputModalities : ['text'], supportsPersonality: item.supportsPersonality === true };
}
