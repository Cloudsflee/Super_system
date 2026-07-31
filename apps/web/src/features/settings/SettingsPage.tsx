import { Box, Github, HardDrive, KeyRound, Plus, RefreshCw, Search, Unplug } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, json } from '../../api/client';
import { keys, useDeployment, useProjects, useSetup } from '../../api/queries';
import { useUi, type UiState } from '../../state/ui';
import { displayStatus } from '../../components/common/display-labels';
import type {
  ChangeProposal,
  CodexDiscoverySource,
  CodexProfile,
  CodexStatus,
  DeploymentStatus,
  McpClientList
} from '../../api/types';
import { CodexDiscoveryPicker } from '../setup/CodexDiscoveryPicker';
import { ProviderFields, validBaseUrl, type ProviderChoice, type WireApi } from '../setup/CodexProviderFields';
import { useCodexDiscovery } from '../setup/useCodexDiscovery';
import {
  DEFAULT_CODEX_TIMEOUT_MINUTES,
  codexTimeoutMinutesToMs,
  validCodexTimeoutMinutes
} from '../setup/codex-timeout';
import { CodexProfileTable } from './CodexProfileTable';
import { McpSettingsBand } from './McpSettingsBand';

type GithubStatus = { connected: boolean; login?: string; installation_count?: number; repository_count?: number };
type ProfileDraft = {
  name: string;
  providerChoice: ProviderChoice;
  customProvider: string;
  baseUrl: string;
  wireApi: WireApi;
  model: string;
  timeoutMinutes: number;
};
const initialProfile: ProfileDraft = {
  name: '',
  providerChoice: 'openai',
  customProvider: '',
  baseUrl: '',
  wireApi: 'responses',
  model: 'gpt-5.1-codex',
  timeoutMinutes: DEFAULT_CODEX_TIMEOUT_MINUTES
};
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
export function SettingsPage() {
  const setup = useSetup();
  const deployment = useDeployment();
  const github = useQuery({ queryKey: ['github-status'], queryFn: () => api<GithubStatus>('/github/status') });
  const profiles = useQuery({ queryKey: ['codex-profiles'], queryFn: () => api<CodexProfile[]>('/codex/profiles') });
  const codex = useQuery({ queryKey: ['codex-status'], queryFn: () => api<CodexStatus>('/codex/status') });
  const mcpClients = useQuery({ queryKey: ['mcp-clients'], queryFn: () => api<McpClientList>('/mcp/clients') });
  const projects = useProjects();
  const client = useQueryClient();
  const navigate = useNavigate();
  const ui = useUi();
  const toast = ui.toast;
  async function act(path: string, notification: string, body?: unknown) {
    try {
      await api(path, json('POST', body, notification));
      await refresh();
      toast(notification);
      return true;
    } catch (error) {
      toast((error as Error).message, 'error');
      return false;
    }
  }
  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: keys.setup }),
      client.invalidateQueries({ queryKey: ['github-status'] }),
      client.invalidateQueries({ queryKey: ['codex-profiles'] }),
      client.invalidateQueries({ queryKey: ['codex-status'] }),
      client.invalidateQueries({ queryKey: ['mcp-clients'] })
    ]);
  }
  async function reopen(path: string) {
    if (!window.confirm('确认进入重新配置流程？当前首次配置门禁将重新启用。')) return;
    if (await act(path, '已进入重新配置流程', { confirmed: true })) navigate('/setup');
  }
  const profileController = useSettingsProfiles({
    status: codex.data,
    deployment: deployment.data,
    refresh,
    act,
    toast,
    showProposal: ui.showProposal
  });

  return (
    <SettingsPageView
      setup={setup}
      deployment={deployment}
      github={github}
      profiles={profiles}
      profileController={profileController}
      mcpData={mcpClients.data}
      mcpProjects={projects.data}
      teamGateway={Boolean(deployment.data?.collaboration?.mcp_gateway)}
      act={act}
      reopen={reopen}
    />
  );
}

function SettingsPageView({
  setup,
  deployment,
  github,
  profiles,
  profileController,
  mcpData,
  mcpProjects,
  teamGateway,
  act,
  reopen
}: {
  setup: ReturnType<typeof useSetup>;
  deployment: ReturnType<typeof useDeployment>;
  github: ReturnType<typeof useQuery<GithubStatus>>;
  profiles: ReturnType<typeof useQuery<CodexProfile[]>>;
  profileController: ReturnType<typeof useSettingsProfiles>;
  mcpData?: McpClientList;
  mcpProjects?: Array<{ id: string; title: string }>;
  teamGateway: boolean;
  act: (path: string, notification: string, body?: unknown) => Promise<boolean>;
  reopen: (path: string) => Promise<void>;
}) {
  return (
    <section className="settings-page">
      <header className="page-heading">
        <div>
          <span className="overline">集成与策略</span>
          <h1>设置</h1>
          <p>当前所有者工作空间</p>
        </div>
        <span className={`status ${setup.data?.complete ? 'ready' : 'pending'}`}>
          {setup.data?.complete ? '配置完成' : '需要配置'}
        </span>
      </header>
      <DeploymentSettingsBand deployment={deployment.data} />
      <McpSettingsBand data={mcpData} projects={mcpProjects} teamGateway={teamGateway} />
      <GithubSettingsBand setup={setup} github={github} act={act} reopen={reopen} />
      <CodexSettingsBand
        setup={setup}
        deployment={deployment}
        profiles={profiles}
        controller={profileController}
        reopen={reopen}
      />
    </section>
  );
}

function DeploymentSettingsBand({ deployment }: { deployment?: DeploymentStatus }) {
  return (
    <section className="settings-band deployment-band">
      <header>
        <HardDrive size={19} />
        <div>
          <h2>部署环境</h2>
          <p>{deployment?.mode === 'container' ? '容器 · Docker 数据卷 · 套接字' : '主机开发 · 本地目录'}</p>
        </div>
        <span className={`status ${deployment?.storage?.ready && deployment?.docker?.ready ? 'ready' : 'pending'}`}>
          {deployment?.collaboration?.mcp_gateway ? '团队网关' : '仅限本机'}
        </span>
      </header>
      <div className="deployment-flags">
        <span>
          存储 <b>{displayStatus(deployment?.storage?.ready ? 'ready' : 'unavailable')}</b>
        </span>
        <span>
          Docker <b>{displayStatus(deployment?.docker?.ready ? 'ready' : 'unavailable')}</b>
        </span>
        <span>
          MCP 网关 <b>{displayStatus(deployment?.collaboration?.mcp_gateway ? 'ready' : 'local')}</b>
        </span>
        <span>
          Codex 导入 <b>{displayStatus(deployment?.imports?.codex_home ? 'ready' : 'off')}</b>
        </span>
        <span>
          cc-switch <b>{displayStatus(deployment?.imports?.cc_switch ? 'ready' : 'off')}</b>
        </span>
        <span>
          项目根目录{' '}
          <b>
            {deployment?.imports?.projects_root
              ? pathModeLabel(deployment.imports.project_path_mode)
              : displayStatus('off')}
          </b>
        </span>
      </div>
    </section>
  );
}

function GithubSettingsBand({
  setup,
  github,
  act,
  reopen
}: {
  setup: ReturnType<typeof useSetup>;
  github: ReturnType<typeof useQuery<GithubStatus>>;
  act: (path: string, notification: string, body?: unknown) => Promise<boolean>;
  reopen: (path: string) => Promise<void>;
}) {
  return (
    <section className="settings-band">
      <header>
        <Github size={19} />
        <div>
          <h2>GitHub</h2>
          <p>
            {github.data?.connected
              ? `${github.data.login || '所有者'} · ${github.data.repository_count || 0} 个代码仓库`
              : '未连接'}
          </p>
        </div>
        <span className={`status ${github.data?.connected ? 'ready' : 'pending'}`}>
          {displayStatus(github.data?.connected ? 'connected' : 'required')}
        </span>
      </header>
      <div className="settings-actions">
        <button
          className="button secondary"
          onClick={() => act('/github/repositories/sync', '代码仓库已同步')}
          disabled={!github.data?.connected}
        >
          <RefreshCw size={15} />
          同步
        </button>
        {setup.data?.mode === 'byo' && (
          <button className="button secondary" onClick={() => reopen('/github/app-config/reset')}>
            <KeyRound size={15} />
            更换 GitHub App
          </button>
        )}
        <button
          className="button danger"
          onClick={() => reopen('/github/disconnect')}
          disabled={!github.data?.connected}
        >
          <Unplug size={15} />
          重新授权
        </button>
      </div>
    </section>
  );
}

function CodexSettingsBand({
  setup,
  deployment,
  profiles,
  controller,
  reopen
}: {
  setup: ReturnType<typeof useSetup>;
  deployment: ReturnType<typeof useDeployment>;
  profiles: ReturnType<typeof useQuery<CodexProfile[]>>;
  controller: ReturnType<typeof useSettingsProfiles>;
  reopen: (path: string) => Promise<void>;
}) {
  const {
    codexImport,
    ccSwitchImport,
    toggleDiscovery,
    toggleAdding,
    discoveryOpen,
    discoveryType,
    setDiscoveryType,
    discovery,
    adding,
    profile,
    setProfile,
    thirdParty,
    profileValid,
    chooseProvider,
    saveProfile,
    proposeProfile
  } = controller;
  return (
    <section className="settings-band">
      <header>
        <Box size={19} />
        <div>
          <h2>Codex 配置</h2>
          <p>Docker 工作区写入 · 独立 CODEX_HOME · 独立接口地址</p>
        </div>
        <span className={`status ${setup.data?.steps.codex.ready ? 'ready' : 'pending'}`}>
          {displayStatus(setup.data?.steps.codex.status)}
        </span>
      </header>
      <div className="settings-actions">
        <button className="button secondary" disabled={!codexImport && !ccSwitchImport} onClick={toggleDiscovery}>
          <Search size={15} />
          导入本地配置
        </button>
        <button className="button secondary" onClick={toggleAdding}>
          <Plus size={15} />
          手动新增配置
        </button>
        <button className="button danger" onClick={() => reopen('/codex/auth/reset')}>
          <KeyRound size={15} />
          官方账户 / API 重新认证
        </button>
      </div>
      {discoveryOpen && (
        <div className="settings-discovery">
          <div className="segmented compact" role="group" aria-label="本地配置来源">
            <button
              disabled={!codexImport}
              className={discoveryType === 'codex_home' ? 'active' : ''}
              onClick={() => setDiscoveryType('codex_home')}
            >
              本地 Codex
            </button>
            <button
              disabled={!ccSwitchImport}
              className={discoveryType === 'cc_switch' ? 'active' : ''}
              onClick={() => setDiscoveryType('cc_switch')}
            >
              cc-switch
            </button>
          </div>
          <CodexDiscoveryPicker
            type={discoveryType}
            data={discovery.data}
            loading={discovery.loading}
            error={discovery.error}
            actionError={discovery.actionError}
            busy={discovery.busy}
            reconfigure
            onRefresh={discovery.refresh}
            onImport={discovery.importConfig}
          />
        </div>
      )}
      {adding && (
        <div className="settings-form codex-settings-form">
          <label>
            名称
            <input
              aria-label="配置名称"
              value={profile.name}
              onChange={(event) => setProfile({ ...profile, name: event.target.value })}
            />
          </label>
          <ProviderFields
            providerChoice={profile.providerChoice}
            customProvider={profile.customProvider}
            baseUrl={profile.baseUrl}
            wireApi={profile.wireApi}
            onProvider={chooseProvider}
            onCustomProvider={(value) => setProfile({ ...profile, customProvider: value })}
            onBaseUrl={(value) => setProfile({ ...profile, baseUrl: value })}
            onWireApi={(value) => setProfile({ ...profile, wireApi: value })}
          />
          <label className={thirdParty ? 'span-2' : ''}>
            模型
            <input
              aria-label="配置模型"
              value={profile.model}
              onChange={(event) => setProfile({ ...profile, model: event.target.value })}
            />
          </label>
          <label>
            任务超时（分钟）
            <input
              aria-label="配置任务超时（分钟）"
              type="number"
              min={1}
              max={30}
              step={1}
              value={profile.timeoutMinutes}
              onChange={(event) => setProfile({ ...profile, timeoutMinutes: Number(event.target.value) })}
            />
          </label>
          <div className="settings-form-actions span-2">
            <button className="button primary" disabled={!profileValid} onClick={() => saveProfile()}>
              <Plus size={15} />
              保存配置
            </button>
          </div>
        </div>
      )}
      <CodexProfileTable
        profiles={profiles.data}
        deployment={deployment.data}
        onPropose={(id) => void proposeProfile(id)}
      />
    </section>
  );
}

function useSettingsProfiles({
  status,
  deployment,
  refresh,
  act,
  toast,
  showProposal
}: {
  status?: CodexStatus;
  deployment?: DeploymentStatus;
  refresh: () => Promise<void>;
  act: (path: string, notification: string, body?: unknown) => Promise<boolean>;
  toast: UiState['toast'];
  showProposal: UiState['showProposal'];
}) {
  const [adding, setAdding] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [discoveryType, setDiscoveryType] = useState<CodexDiscoverySource['type']>('codex_home');
  const [profile, setProfile] = useState<ProfileDraft>(initialProfile);
  const discovery = useCodexDiscovery(
    async () => {
      await refresh();
      toast('本地 Codex 配置已导入，正在进入重配置');
      setDiscoveryOpen(false);
    },
    { reconfigure: true }
  );
  const provider = profile.providerChoice === 'custom' ? profile.customProvider.trim() : profile.providerChoice;
  const thirdParty = profile.providerChoice !== 'openai';
  const profileValid = Boolean(
    profile.name.trim() &&
    profile.model.trim() &&
    provider &&
    (!thirdParty || validBaseUrl(profile.baseUrl)) &&
    validCodexTimeoutMinutes(profile.timeoutMinutes)
  );
  const codexImport = deployment?.mode !== 'container' || Boolean(deployment.imports.codex_home);
  const ccSwitchImport = deployment?.mode !== 'container' || Boolean(deployment.imports.cc_switch);

  function chooseProvider(value: ProviderChoice) {
    setProfile((current) => ({
      ...current,
      providerChoice: value,
      customProvider: value === 'custom' && !current.customProvider ? 'custom' : current.customProvider,
      baseUrl:
        value === 'openai'
          ? ''
          : value === 'openrouter'
            ? OPENROUTER_URL
            : current.baseUrl === OPENROUTER_URL
              ? ''
              : current.baseUrl
    }));
  }
  function toggleAdding() {
    if (adding) {
      setAdding(false);
      return;
    }
    setDiscoveryOpen(false);
    const auth = status?.auth;
    if (!auth?.provider) {
      setProfile(initialProfile);
      setAdding(true);
      return;
    }
    const providerChoice = providerChoiceFor(auth.provider);
    setProfile({
      ...initialProfile,
      providerChoice,
      customProvider: providerChoice === 'custom' ? auth.provider : '',
      baseUrl:
        providerChoice === 'openai' ? '' : auth.base_url || (providerChoice === 'openrouter' ? OPENROUTER_URL : ''),
      wireApi: 'responses'
    });
    setAdding(true);
  }
  function toggleDiscovery() {
    setAdding(false);
    if (!codexImport && !ccSwitchImport) return;
    if (!codexImport) setDiscoveryType('cc_switch');
    else if (!ccSwitchImport) setDiscoveryType('codex_home');
    setDiscoveryOpen((value) => !value);
  }
  async function saveProfile() {
    if (!profileValid || !window.confirm('确认创建新的 Codex 配置？')) return;
    const body = settingsProfileBody(profile, provider, thirdParty);
    if (await act('/codex/profiles', 'Codex 配置已创建', { ...body, confirmed: true })) {
      setAdding(false);
      setProfile(initialProfile);
    }
  }
  async function proposeProfile(id: string) {
    try {
      const proposal = await api<ChangeProposal>(
        `/codex/profiles/${id}/propose-apply`,
        json('POST', undefined, '创建 Codex 配置切换提案')
      );
      await refresh();
      showProposal(proposal.id);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }
  return {
    adding,
    discoveryOpen,
    discoveryType,
    setDiscoveryType,
    profile,
    setProfile,
    discovery,
    provider,
    thirdParty,
    profileValid,
    codexImport,
    ccSwitchImport,
    chooseProvider,
    toggleAdding,
    toggleDiscovery,
    saveProfile,
    proposeProfile
  };
}

function providerChoiceFor(value: string): ProviderChoice {
  if (value === 'openai' || value === 'chatgpt') return 'openai';
  if (value === 'openrouter') return 'openrouter';
  return 'custom';
}

function settingsProfileBody(profile: ProfileDraft, provider: string, thirdParty: boolean) {
  return {
    name: profile.name.trim(),
    provider,
    model: profile.model.trim(),
    ...(thirdParty ? { base_url: profile.baseUrl.trim(), wire_api: 'responses' as const } : {}),
    reasoning: 'high',
    web_search: false,
    timeout_ms: codexTimeoutMinutesToMs(profile.timeoutMinutes),
    mounts: []
  };
}

function pathModeLabel(value?: string | null) {
  return value === 'relative' ? '相对路径' : value === 'absolute' ? '绝对路径' : '已配置';
}
