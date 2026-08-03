import path from 'node:path';

import {
  createLocalOwner,
  defaultCodexProfiles,
  defaultTools,
  hashString,
  makeTrace,
  now
} from '../../../packages/shared/index.mjs';
import { WORKSPACE_DIR, collections } from './config-v22.mjs';
import {
  codexAuthMatchesProfile,
  isThirdPartyProvider,
  isValidCodexTimeoutMs,
  normalizeProviderBaseUrl,
  resolveCodexTimeoutMs,
  writeProfileConfig
} from './codex-service.mjs';
import { ensureProjectGovernanceDefaults, expireProjectInvitationsInState } from './project-governance-v19.mjs';
import {
  ensureRepositoryLifecycleDefaults,
  expireRepositoryDeletionIntentsInState
} from './repository-lifecycle-v19.mjs';
import { ensureExchangeDefaults, expireExchangeRequestsInState } from './exchange-v19.mjs';
import { recoverInterruptedRepositoryDeletionsInState } from './repository-deletion-recovery.mjs';
import { recoverInvalidDeliveryPullRequestClaimsInState } from './delivery-recovery.mjs';
import { recoverPullRequestIntentsInState } from './pull-request-intent-domain.mjs';
import { governanceFingerprint, lifecycleFingerprint } from './state-fingerprints.mjs';
export { recoverInterruptedRuntimeWork } from './state-v22-runtime-recovery.mjs';

export function normalizeRuntimeCollections(state, changes) {
  for (const key of collections)
    if (!Array.isArray(state[key])) {
      state[key] = [];
      changes.value = true;
    }
}

export function ensureRuntimeDefaults(state, changes) {
  if (!state.users.length) {
    const { user, session } = createLocalOwner();
    state.users.push(user);
    state.sessions.push(session);
    changes.value = true;
  }
  if (!state.tools.length) {
    state.tools.push(...defaultTools(state.users[0].id));
    changes.value = true;
  }
  if (!state.codex_profiles.length) {
    state.codex_profiles.push(...defaultCodexProfiles(state.users[0]?.id));
    changes.value = true;
  }
}

export function normalizeRuntimeGovernance(state, changes) {
  const governanceBefore = governanceFingerprint(state);
  ensureProjectGovernanceDefaults(state);
  if (expireProjectInvitationsInState(state)) changes.value = true;
  if (governanceBefore !== governanceFingerprint(state)) changes.value = true;
  const lifecycleBefore = lifecycleFingerprint(state);
  ensureRepositoryLifecycleDefaults(state);
  ensureExchangeDefaults(state);
  if (recoverInterruptedRepositoryDeletionsInState(state)) changes.value = true;
  if (expireRepositoryDeletionIntentsInState(state) || expireExchangeRequestsInState(state)) changes.value = true;
  if (lifecycleBefore !== lifecycleFingerprint(state)) changes.value = true;
  const deliveryRecovery = recoverInvalidDeliveryPullRequestClaimsInState(state);
  if (deliveryRecovery.changed) {
    changes.value = true;
    for (const deliveryId of deliveryRecovery.delivery_ids) appendIntegrationTrace(state, deliveryId);
  }
  if (recoverPullRequestIntentsInState(state)) changes.value = true;
}

function appendIntegrationTrace(state, deliveryId) {
  state.traces.push(
    makeTrace('integration.synced', {
      target_type: 'delivery',
      target_id: deliveryId,
      summary: 'Removed an invalid webhook PR claim from a failed Delivery.'
    })
  );
}

export function normalizeRuntimeProjects(state, changes) {
  for (const project of state.projects) changes.value = normalizeProject(project) || changes.value;
}

function normalizeProject(project) {
  let changed = false;
  if (!project.status) {
    project.status = 'active';
    changed = true;
  }
  project.settings ||= {};
  changed = normalizeProjectSettings(project) || changed;
  if (!project.onboarding_state) {
    project.onboarding_state = project.status === 'draft' ? 'intake' : 'confirmed';
    changed = true;
  }
  changed = normalizeProjectMetadata(project) || changed;
  if (!project.managed_workspace_state) {
    project.managed_workspace_state = resolveWorkspaceState(project);
    changed = true;
  }
  changed = normalizeProjectLifecycle(project) || changed;
  return changed;
}

function normalizeProjectSettings(project) {
  let changed = false;
  if (!Number.isFinite(Number(project.settings.token_budget))) {
    project.settings.token_budget = 12000;
    changed = true;
  }
  if (!['codex', 'codex_docker'].includes(project.settings.preferred_runner)) {
    project.settings.preferred_runner = 'codex_docker';
    changed = true;
  }
  if (!Array.isArray(project.settings.workspace_root_whitelist)) {
    project.settings.workspace_root_whitelist = [project.repo_path || project.workspace_root].filter(Boolean);
    changed = true;
  }
  return changed;
}

function normalizeProjectMetadata(project) {
  let changed = false;
  for (const field of ['source_metadata', 'github_account_id'])
    if (project[field] === undefined) {
      project[field] = null;
      changed = true;
    }
  return changed;
}

function resolveWorkspaceState(project) {
  const managed = isWithin(WORKSPACE_DIR, project.repo_path || project.workspace_root || '');
  return managed ? 'ready' : project.repo_path || project.workspace_root ? 'workspace_migration_required' : 'empty';
}

function normalizeProjectLifecycle(project) {
  let changed = false;
  if (project.deleted_at === undefined) {
    project.deleted_at = null;
    changed = true;
  }
  if (project.lifecycle_operation === undefined) {
    project.lifecycle_operation = null;
    changed = true;
  }
  if (project.trash_metadata === undefined) {
    project.trash_metadata = project.trash_path
      ? {
          path: project.trash_path,
          status_before_trash: project.status_before_trash || 'active',
          trashed_at: project.deleted_at
        }
      : null;
    changed = true;
  }
  return changed;
}

export function normalizeRuntimeDraftsAndProposals(state, changes) {
  for (const draft of state.workflow_drafts) changes.value = normalizeDraft(draft) || changes.value;
  for (const proposal of state.change_proposals) changes.value = normalizeProposal(proposal) || changes.value;
}

function normalizeDraft(draft) {
  let changed = false;
  if (!draft.status) {
    draft.status = draft.workflow_id || draft.activated_at ? 'activated' : 'draft';
    changed = true;
  }
  if (draft.user_modified_at === undefined) {
    draft.user_modified_at = Number(draft.revision || 1) > 1 ? draft.updated_at || now() : null;
    changed = true;
  }
  return changed;
}

function normalizeProposal(proposal) {
  let changed = false;
  if (!Number.isInteger(proposal.revision) || proposal.revision < 1) {
    proposal.revision = 1;
    changed = true;
  }
  if (!proposal.attention_state) {
    proposal.attention_state = proposal.status === 'pending' ? 'queued' : 'resolved';
    changed = true;
  }
  if (!proposal.target_hash) {
    proposal.target_hash = hashString(JSON.stringify(proposal.before_json ?? null));
    changed = true;
  }
  return changed;
}

export function normalizeLegacyRuntimeRecords(state, changes) {
  for (const workflow of state.workflows)
    if (workflow.generated_by === 'system' && workflow.title?.includes('V1 闭环工作流')) {
      workflow.title = workflow.title.replace('V1 闭环工作流', '工作流');
      changes.value = true;
    }
  const retiredProfileKind = 'mock',
    productionProfiles = state.codex_profiles.filter(
      (item) => item.kind !== retiredProfileKind && item.kind !== 'cc_switch'
    );
  if (productionProfiles.length !== state.codex_profiles.length) {
    state.codex_profiles = productionProfiles;
    changes.value = true;
  }
  if (!state.codex_profiles.length) {
    state.codex_profiles.push(...defaultCodexProfiles(state.users[0]?.id));
    changes.value = true;
  }
  const ccSwitch = state.integration_statuses.find((item) => item.key === 'cc_switch');
  if (ccSwitch && !isCcSwitchReady(ccSwitch)) {
    Object.assign(ccSwitch, {
      status: 'not_synced',
      bridge: {
        ...(ccSwitch.bridge || {}),
        ready: false,
        revision: Number(ccSwitch.bridge?.revision || 0),
        reason: 'bridge_resync_required'
      },
      updated_at: now()
    });
    changes.value = true;
  }
}

function isCcSwitchReady(record) {
  return (
    record.bridge?.ready &&
    record.bridge?.conformance?.ok === true &&
    Number(record.bridge?.revision || 0) >= 2 &&
    record.sources?.find((item) => item.name === 'cc-switch-cli')?.commit
  );
}

export function normalizeCodexProfileRecords(state, changes) {
  for (const profile of state.codex_profiles) changes.value = normalizeCodexProfile(profile) || changes.value;
}

function normalizeCodexProfile(profile) {
  const before = JSON.stringify(profile);
  if (!isValidCodexTimeoutMs(profile.timeout_ms) || profile.timeout_ms == null)
    profile.timeout_ms = resolveCodexTimeoutMs(profile.timeout_ms);
  normalizeProfileMcpNames(profile);
  normalizeProfileProvider(profile);
  normalizeProfileSwitch(profile);
  if (JSON.stringify(profile) !== before) {
    profile.updated_at = now();
    return true;
  }
  return false;
}

function normalizeProfileMcpNames(profile) {
  const usedNames = new Set();
  for (const server of Array.isArray(profile.mcp_servers) ? profile.mcp_servers : []) {
    const baseName = server.name === 'aiws-built-in' ? 'aiws-built-in-external' : String(server.name || 'external');
    let name = baseName,
      suffix = 2;
    while (usedNames.has(name)) name = `${baseName}-${suffix++}`;
    server.name = name;
    usedNames.add(name);
  }
}

function normalizeProfileProvider(profile) {
  if (!profile.base_url) profile.base_url = profile.api_url || profile.provider_url || null;
  if (profile.base_url) profile.base_url = normalizeProviderBaseUrl(profile.base_url) || profile.base_url;
  profile.wire_api ||= 'responses';
  if (typeof profile.requires_openai_auth !== 'boolean') profile.requires_openai_auth = false;
}

function normalizeProfileSwitch(profile) {
  profile.cc_switch_mode ||= 'native';
  if (profile.cc_switch_mode !== 'managed')
    Object.assign(profile, {
      cc_switch_required: false,
      cc_switch_status: 'not_required',
      cc_switch_provider_id: null,
      cc_switch_synced_at: null,
      cc_switch_bridge_revision: null,
      cc_switch_source_commit: null
    });
  if (
    isThirdPartyProvider(profile.provider) &&
    !normalizeProviderBaseUrl(profile.base_url) &&
    profile.status === 'validated'
  )
    profile.status = 'configuration_required';
}

export async function refreshValidatedCodexProfiles(state, changes) {
  const codexAuth = state.integration_statuses.find((item) => item.key === 'codex_auth'),
    activeProfile =
      state.codex_profiles.find((item) => item.is_active) ||
      state.codex_profiles.find((item) => item.status === 'validated');
  if (activeProfile && !isActiveProfileValid(activeProfile, codexAuth)) resetCompletedSetups(state, changes);
  for (const profile of state.codex_profiles.filter(isRefreshableProfile)) {
    const generated = await writeProfileConfig(profile, codexAuth?.home);
    if (profile.codex_home !== generated.codex_home || profile.config_file !== generated.config_file) {
      Object.assign(profile, generated);
      changes.value = true;
    }
  }
}

function isActiveProfileValid(profile, codexAuth) {
  return (
    profile.status === 'validated' &&
    codexAuthMatchesProfile(codexAuth, profile) &&
    (!isThirdPartyProvider(profile.provider) || normalizeProviderBaseUrl(profile.base_url))
  );
}

function resetCompletedSetups(state, changes) {
  for (const setup of state.setup_states.filter((item) => item.completed_at)) {
    setup.completed_at = null;
    setup.updated_at = now();
    changes.value = true;
  }
}

function isRefreshableProfile(profile) {
  return (
    profile.status === 'validated' &&
    profile.model &&
    (!isThirdPartyProvider(profile.provider) || normalizeProviderBaseUrl(profile.base_url))
  );
}

function isWithin(root, candidate) {
  if (!candidate) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
