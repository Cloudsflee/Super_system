import { HttpError } from './http.mjs';
import { createPrivateProviderConfig, managedCcSwitchStatus, parseProviderList, removePrivateProviderConfig, runManagedCcSwitch } from './cc-switch-managed-cli.mjs';
import { probeCodexCapabilities } from './codex-capabilities.mjs';
import { createChangeProposal, id, now } from '../../../packages/shared/index.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { readSecret } from './vault.mjs';
import { validateProfileInput, writeProfileConfig } from './codex-service.mjs';
import { proposalTargetHash } from './proposal-target.mjs';
import { assertProfileAllowed } from './container-runtime-config.mjs';
import { assertProjectLifecycleIdle } from './project-lifecycle-operations.mjs';

export async function proposeConfigRevision(body) {
  return mutate((state) => {
    const actor = owner(state), profile = state.codex_profiles.find((item) => item.id === body.profile_id);
    if (!profile) throw new HttpError(404, { error: 'profile_not_found' });
    if (body.project_id) assertProjectLifecycleIdle(state.projects.find((item) => item.id === body.project_id));
    const patch = normalizePatch(body.patch || {}), validation = validateProfileInput(state, { ...profile, ...patch });
    if (!validation.ok) throw new HttpError(400, { error: 'invalid_codex_profile', details: validation.errors });
    const applyMode = body.apply_mode === 'cc_switch' ? 'cc_switch' : 'native';
    const revision = { id: id('cfg'), project_id: body.project_id || null, profile_id: profile.id, kind: body.kind || 'provider', version: Math.max(0, ...state.config_revisions.filter((item) => item.profile_id === profile.id).map((item) => item.version || 0)) + 1, status: 'proposed', patch, apply_mode: applyMode, native_fallback_allowed: body.native_fallback === true, reconciliation: { status: 'pending' }, created_by_user_id: actor.id, created_at: now(), updated_at: now() };
    const summary = applyMode === 'cc_switch' ? '通过可选的受管 cc-switch CLI 写入、重新发现并 Probe 后激活。' : '写入 AIWS 托管 Codex Profile，Probe 通过后激活。';
    const proposal = createChangeProposal({ projectId: revision.project_id, changeType: 'config_revision', title: `配置变更：${profile.name}`, summary, before: publicProfile(profile), after: { ...publicProfile(profile), ...patch }, risks: ['Provider 切换失败时将自动回滚'], applyAction: { type: 'config_revision_apply', config_revision_id: revision.id }, actorId: actor.id });
    state.config_revisions.push(revision); proposal.target_hash_mode = 'state'; proposal.target_hash = proposalTargetHash(state, proposal); state.change_proposals.push(proposal); revision.proposal_id = proposal.id;
    addTrace(state, 'change_proposal.created', { project_id: revision.project_id, target_type: 'config_revision', target_id: revision.id, summary: proposal.title }, actor.id);
    return { revision, proposal };
  });
}

export async function applyConfigRevision(proposalId, expected = {}) {
  const snapshot = await readState(), proposal = snapshot.change_proposals.find((item) => item.id === proposalId), revision = snapshot.config_revisions.find((item) => item.id === proposal?.apply_action?.config_revision_id), profile = snapshot.codex_profiles.find((item) => item.id === revision?.profile_id);
  if (!proposal || !revision || !profile) throw new HttpError(404, { error: 'config_revision_not_found' });
  if (proposal.project_id) assertProjectLifecycleIdle(snapshot.projects.find((item) => item.id === proposal.project_id));
  try { assertProfileAllowed(profile); } catch (error) { throw new HttpError(409, { error: error.message }); }
  if (proposal.status === 'applied') return { proposal, revision, idempotent: true };
  if (proposal.status !== 'pending') throw new HttpError(409, { error: 'proposal_not_pending' });
  if (expected.revision === undefined || !expected.target_hash) throw new HttpError(400, { error: 'approval_expectation_required', required: ['revision', 'target_hash'] });
  if (Number(expected.revision) !== Number(proposal.revision || 1)) throw new HttpError(409, { error: 'proposal_stale', reason: 'revision_mismatch', revision: proposal.revision });
  if (expected.target_hash !== proposal.target_hash || proposalTargetHash(snapshot, proposal) !== proposal.target_hash) throw new HttpError(409, { error: 'proposal_stale', reason: 'target_hash_mismatch' });
  const adapted = expected.adapter === 'test' && process.env.NODE_ENV === 'test', adapterFailure = adapted ? String(expected.test_failure || '') : '', useCcSwitch = revision.apply_mode === 'cc_switch';
  const status = useCcSwitch ? (adapted ? { installed: expected.test_managed_missing !== true } : await managedCcSwitchStatus()) : { installed: false };
  if (useCcSwitch && !status.installed && !(expected.native_fallback === true && revision.native_fallback_allowed)) throw new HttpError(409, { error: 'managed_cc_switch_install_required', native_fallback_requires_explicit_selection: true });
  const merged = { ...profile, ...revision.patch }, auth = snapshot.integration_statuses.find((item) => item.key === 'codex_auth'), apiKey = await readSecret(auth?.refs?.credential);
  const oldProvider = snapshot.integration_statuses.find((item) => item.key === 'cc_switch_managed')?.active_provider_id || null;
  let temp = null, switched = false;
  try {
    if (useCcSwitch && status.installed) {
      temp = await createPrivateProviderConfig(merged, apiKey);
      const providerId = providerKey(merged.provider), added = await managedCall('add', ['--app', 'codex', 'provider', 'add', '--name', merged.name, '--id', providerId, '--config-file', temp, '--api-format', 'responses'], 'provider added');
      if (!added.ok && !/already|exists|duplicate/i.test(`${added.stderr}\n${added.stdout}`)) throw new HttpError(409, { error: 'cc_switch_provider_add_failed', detail: added.stderr || added.error });
      const selected = await managedCall('switch', ['--app', 'codex', 'provider', 'switch', providerId], 'provider switched');
      if (!selected.ok) throw new HttpError(409, { error: 'cc_switch_provider_switch_failed', detail: selected.stderr || selected.error });
      switched = true;
      const discovered = await managedCall('rediscover', ['--app', 'codex', 'provider', 'list'], `*  ${providerId}  ${merged.name}`);
      if (!discovered.ok || (!adapted && !parseProviderList(discovered.stdout).some((item) => item.id === providerId))) throw new HttpError(409, { error: 'cc_switch_rediscovery_failed' });
    } else Object.assign(merged, await writeProfileConfig(merged, auth?.home));
    const capability = adapted && adapterFailure === 'reprobe' ? { compatible: false, guided_transport: 'unavailable' } : probeCodexCapabilities({ adapted, profile: merged });
    if (!capability.compatible || capability.guided_transport === 'unavailable') throw new HttpError(409, { error: 'codex_reprobe_failed' });
    const mode = useCcSwitch && status.installed ? 'cc-switch-cli' : useCcSwitch ? 'native-fallback' : 'native-profile';
    return mutate((state) => activateRevision(state, proposalId, revision.id, merged, mode, capability));
  } catch (error) {
    let rollback = { attempted: false, ok: false };
    if (switched && oldProvider) { const result = await managedCall('rollback', ['--app', 'codex', 'provider', 'switch', oldProvider], 'provider rolled back').catch(() => ({ ok: false })); rollback = { attempted: true, ok: result.ok === true }; }
    await mutate((state) => { const current = state.config_revisions.find((item) => item.id === revision.id); if (current) Object.assign(current, { status: 'failed', reconciliation: { status: rollback.ok ? 'rolled_back' : 'manual_reconciliation_required', rollback, error_code: error.payload?.error || error.message }, updated_at: now() }); });
    throw error;
  } finally { await removePrivateProviderConfig(temp); }

  async function managedCall(phase, args, adaptedOutput) {
    if (adapterFailure === phase || (phase === 'rollback' && expected.test_rollback_failure === true)) return { ok: false, status: 1, stdout: '', stderr: `test ${phase} failure`, error: null };
    return runManagedCcSwitch(args, { codexHome: merged.codex_home, adapted, adaptedOutput });
  }
}

function activateRevision(state, proposalId, revisionId, merged, mode, capability) {
  const actor = owner(state), proposal = state.change_proposals.find((item) => item.id === proposalId), revision = state.config_revisions.find((item) => item.id === revisionId), profile = state.codex_profiles.find((item) => item.id === revision.profile_id);
  if (proposal.project_id) assertProjectLifecycleIdle(state.projects.find((item) => item.id === proposal.project_id));
  if (proposal.status !== 'pending' || proposalTargetHash(state, proposal) !== proposal.target_hash) throw new HttpError(409, { error: 'proposal_stale', reason: 'target_changed' });
  Object.assign(profile, revision.patch, { status: 'validated', updated_at: now() }); for (const item of state.codex_profiles) item.is_active = item.id === profile.id;
  Object.assign(revision, { status: 'active', reconciliation: { status: 'reconciled', mode, capability }, activated_at: now(), updated_at: now() });
  Object.assign(proposal, { status: 'applied', attention_state: 'resolved', approved_by_user_id: actor.id, applied_by_user_id: actor.id, applied_at: now(), revision: Number(proposal.revision || 1) + 1, updated_at: now() });
  if (mode !== 'native-profile') {
    let managed = state.integration_statuses.find((item) => item.key === 'cc_switch_managed');
    if (!managed) { managed = { key: 'cc_switch_managed', created_at: now() }; state.integration_statuses.push(managed); }
    Object.assign(managed, { status: 'ready', active_provider_id: providerKey(merged.provider), profile_id: profile.id, mode, updated_at: now() });
  }
  addTrace(state, 'config_revision.activated', { project_id: revision.project_id, target_type: 'config_revision', target_id: revision.id, summary: `激活配置 revision ${revision.version}。`, data: { mode, profile_id: profile.id } }, actor.id);
  return { proposal, revision, profile: publicProfile(profile), capability, idempotent: false };
}
function normalizePatch(value) { const allowed = new Set(['name', 'provider', 'provider_name', 'base_url', 'model', 'reasoning', 'web_search', 'timeout_ms', 'mcp_servers']); const patch = {}; for (const [key, item] of Object.entries(value)) if (allowed.has(key)) patch[key] = item; if (patch.base_url) { let url; try { url = new URL(patch.base_url); } catch { throw new HttpError(400, { error: 'invalid_base_url' }); } if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new HttpError(400, { error: 'invalid_base_url' }); } return patch; }
function publicProfile(item) { return { id: item.id, name: item.name, provider: item.provider, provider_name: item.provider_name, base_url: item.base_url, model: item.model, reasoning: item.reasoning, web_search: item.web_search, status: item.status, is_active: item.is_active }; }
function providerKey(value) { return String(value || 'custom').toLowerCase().replace(/[^a-z0-9_-]/g, '_'); }
