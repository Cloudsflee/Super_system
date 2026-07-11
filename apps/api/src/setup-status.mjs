import { connectedGithubAccount, resolveGithubAppConfig } from './github-service.mjs';
import { codexAuthMatchesProfile, isThirdPartyProvider, normalizeProviderBaseUrl } from './codex-service.mjs';
import { codexProbeEvidenceMatches, createCodexProbeEvidence } from './codex-probe-evidence.mjs';

export function setupRecord(state) {
  let record = state.setup_states[0];
  if (!record) {
    record = { id: 'setup_owner', mode: null, completed_at: null, updated_at: new Date().toISOString() };
    state.setup_states.push(record);
  }
  return record;
}

export function computeSetupStatus(state, runtime = null) {
  const record = state.setup_states[0] || { mode: null, completed_at: null };
  const account = connectedGithubAccount(state);
  const config = resolveGithubAppConfig(state);
  const installations = state.github_installations.filter((item) => item.status === 'active' && String(item.app_id || '') === String(config?.app_id || ''));
  const selectedRepositories = installations.flatMap((item) => item.repositories || []).filter((item) => item.selected === true);
  const appConfigured = Boolean(config);
  const githubChecks = {
    app_configured: appConfigured,
    account_connected: Boolean(account),
    installation_installed: installations.length > 0,
    installation_ready: installations.length > 0 && selectedRepositories.length > 0
  };
  const docker = state.integration_statuses.find((item) => item.key === 'codex_docker');
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  const profile = state.codex_profiles.find((item) => item.is_active) || state.codex_profiles.find((item) => item.status === 'validated');
  const probe = state.integration_statuses.find((item) => item.key === 'codex_probe' && item.profile_id === profile?.id);
  const thirdParty = profile && isThirdPartyProvider(profile.provider);
  const endpointValid = !thirdParty || Boolean(normalizeProviderBaseUrl(profile.base_url));
  const authMatches = Boolean(profile && codexAuthMatchesProfile(auth, profile));
  const dockerReady = runtime ? runtime.ready === true : docker?.status === 'ready';
  const currentEvidence = runtime ? createCodexProbeEvidence({ profile, auth, runtime }) : null;
  const probeCurrent = probe?.status === 'ready' && (!runtime || codexProbeEvidenceMatches(probe.evidence, currentEvidence));
  const codexChecks = {
    docker_ready: dockerReady,
    authenticated: auth?.status === 'authenticated',
    auth_profile_match: authMatches,
    provider_endpoint_valid: endpointValid,
    cc_switch_ready: true,
    profile_valid: Boolean(profile?.status === 'validated' && endpointValid && authMatches),
    probe_ok: dockerReady && probeCurrent && authMatches
  };
  const githubReady = Boolean(record.mode) && Object.values(githubChecks).every(Boolean);
  const codexReady = Object.values(codexChecks).every(Boolean);
  const reasons = [];
  if (!record.mode) reasons.push('请选择运行模式');
  if (!githubReady) reasons.push('GitHub 尚未完成验证与 repository 选择');
  if (!codexReady) reasons.push('Codex 尚未通过隔离运行探针');
  return {
    complete: Boolean(record.completed_at && githubReady && codexReady),
    mode: record.mode || null,
    can_complete: githubReady && codexReady,
    completed_at: record.completed_at || null,
    steps: {
      github: githubStep({ githubReady, appConfigured, account, installations, selectedRepositories, githubChecks }),
      codex: { ready: codexReady, status: codexReady ? 'ready' : !dockerReady ? 'runtime_required' : 'configuration_required', checks: codexChecks, detail: codexReady ? profile.name : runtime && !runtime.ready ? runtime.image?.summary || runtime.docker?.summary || 'Docker Runtime 不可用' : probe?.status === 'ready' && !probeCurrent ? 'Profile、凭据、配置或镜像已变化，请重新运行 Probe' : '完成 Docker、凭据、Profile 与 Probe', profile_id: profile?.id, runtime }
    },
    reasons
  };
}

function githubStep({ githubReady, appConfigured, account, installations, selectedRepositories, githubChecks }) {
  const status = githubReady ? 'ready' : !appConfigured ? 'configuration_required' : !account ? 'authorization_required'
    : !installations.length ? 'installation_required' : 'repository_selection_required';
  const detail = githubReady ? `${selectedRepositories.length} repositories` : !appConfigured ? '验证 GitHub App 配置'
    : !account ? '完成 GitHub Owner 授权' : !installations.length ? '安装 GitHub App 并同步 repository' : '选择至少一个 repository';
  return { ready: githubReady, status, checks: githubChecks, detail, installation_count: installations.length };
}

export function isSetupExempt(pathname) {
  if (pathname === '/health' || pathname === '/setup/status' || pathname === '/setup/mode' || pathname === '/setup/complete' || pathname === '/github/webhook') return true;
  if (/^\/github\/(status|app-config\/(defaults|validate|manual|reset)|manifest\/(start|callback)|device\/(start|poll)|disconnect|repositories\/sync)$/.test(pathname)) return true;
  if (/^\/github\/installations(?:\/start|\/discover|\/setup|\/[^/]+\/repositories(?:\/sync)?)?$/.test(pathname)) return true;
  if (/^\/codex\/(status|docker\/build|auth\/(?:device\/start|device\/[^/]+\/(?:events|cancel)|api-key|reset)|profiles(?:\/[^/]+(?:\/validate)?)?|cc-switch\/(?:status|sync|import)|probe)$/.test(pathname)) return true;
  if (/^\/codex\/discovery(?:\/import)?$/.test(pathname)) return true;
  return false;
}
