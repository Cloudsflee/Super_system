import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api, ApiError, apiUrl, describeOperation, json } from '../../api/client';
import type {
  CodexBuildLog,
  CodexBuildOperation,
  CodexBuildStart,
  CodexProbeReport,
  CodexProfile,
  CodexStatus,
  DeploymentStatus,
  StepState
} from '../../api/types';
import { validBaseUrl, type ProviderChoice, type WireApi } from './CodexProviderFields';
import type { ConnectionMode } from './CodexConnectionSetup';
import { publicDeviceAuthSummary, type DeviceAuthSummary } from './codex-device-auth';
import { useCodexDiscovery } from './useCodexDiscovery';
import { registerOperationRetry, upsertExternalOperation } from '../../operations/operation-store';
import { safeBuildDiagnostics } from './CodexBuildProgress';
import { CodexSetupView } from './CodexSetupView';
import {
  DEFAULT_CODEX_TIMEOUT_MINUTES,
  codexTimeoutMinutesFromMs,
  codexTimeoutMinutesToMs,
  validCodexTimeoutMinutes
} from './codex-timeout';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function CodexSetup({
  state,
  onChange,
  deployment
}: {
  state: StepState;
  onChange: () => Promise<unknown>;
  deployment?: DeploymentStatus;
}) {
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('codex_home');
  const [apiKey, setApiKey] = useState('');
  const [providerChoice, setProviderChoice] = useState<ProviderChoice>('openai');
  const [customProvider, setCustomProvider] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [wireApi, setWireApi] = useState<WireApi>('responses');
  const [model, setModel] = useState('gpt-5.1-codex');
  const [timeoutMinutes, setTimeoutMinutes] = useState(DEFAULT_CODEX_TIMEOUT_MINUTES);
  const [profileName, setProfileName] = useState('');
  const [authProvider, setAuthProvider] = useState('');
  const [repairApiKey, setRepairApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorAction, setErrorAction] = useState('');
  const [probeReport, setProbeReport] = useState<CodexProbeReport | null>(null);
  const checks = state.checks || {};
  const thirdParty = providerChoice !== 'openai';
  const provider = providerChoice === 'custom' ? customProvider.trim() : providerChoice;
  const providerValid = Boolean(provider) && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(provider);
  const endpointValid = !thirdParty || validBaseUrl(baseUrl);
  const profileInputValid =
    providerValid && endpointValid && Boolean(model.trim()) && validCodexTimeoutMinutes(timeoutMinutes);
  const needsProfileRepair = Boolean(
    state.profile_id && (checks.provider_endpoint_valid === false || checks.auth_profile_match === false)
  );
  const repairNeedsKey = needsProfileRepair && !sameProvider(authProvider, provider);
  const hydratedProfile = useCodexProfileHydration({
    authenticated: Boolean(checks.authenticated),
    profileId: state.profile_id,
    setProviderChoice,
    setCustomProvider,
    setBaseUrl,
    setWireApi,
    setModel,
    setTimeoutMinutes,
    setProfileName,
    setAuthProvider,
    setConnectionMode,
    setError
  });
  const authMetadataReady = hydratedProfile === (state.profile_id || 'new');

  const discovery = useCodexDiscovery(async () => {
    await onChange();
  });
  const { buildOperation, buildConnection, build, cancelBuild, copyBuildDiagnostics } = useCodexBuild({
    enabled: !checks.docker_ready && deployment?.mode !== 'container',
    onChange,
    setBusy,
    setError,
    setErrorAction,
    setProbeReport
  });
  const { deviceAuth, device } = useCodexDeviceAuth({
    onChange,
    setBusy,
    setError,
    setErrorAction,
    setProbeReport
  });
  useEffect(() => {
    if (connectionMode === 'codex_home' && deployment?.mode === 'container' && !deployment.imports.codex_home)
      setConnectionMode('manual');
    if (connectionMode === 'cc_switch' && deployment?.mode === 'container' && !deployment.imports.cc_switch)
      setConnectionMode('manual');
  }, [connectionMode, deployment]);
  const act = createCodexAction({ onChange, setBusy, setError, setErrorAction, setProbeReport });

  function selectProvider(value: ProviderChoice) {
    setProviderChoice(value);
    if (value === 'openai') setBaseUrl('');
    else if (value === 'openrouter') setBaseUrl(OPENROUTER_BASE_URL);
    else {
      if (!customProvider) setCustomProvider('custom');
      if (baseUrl === OPENROUTER_BASE_URL) setBaseUrl('');
    }
  }

  const connectionPayload = codexConnectionFields(provider, thirdParty, baseUrl);
  const profilePayload = codexProfileFields(connectionPayload, profileName, model, timeoutMinutes);
  const authenticate = () =>
    act(() => api('/codex/auth/api-key', json('POST', { ...connectionPayload, api_key: apiKey }, '保存 Codex 认证')));
  const createProfile = () => act(() => api('/codex/profiles', json('POST', profilePayload, '创建 Codex 配置')));
  const repairProfile = () =>
    act(async () => {
      if (thirdParty || repairNeedsKey)
        await api(
          '/codex/auth/api-key',
          json('POST', { ...connectionPayload, ...(repairApiKey ? { api_key: repairApiKey } : {}) }, '更新 Codex 认证')
        );
      await api(`/codex/profiles/${state.profile_id}`, json('PUT', profilePayload, '修复 Codex 配置'));
    });
  const probe = () => act(() => api('/codex/probe', json('POST', { profile_id: state.profile_id }, '运行 Codex 探针')));
  const viewModel: CodexSetupViewModel = {
    state,
    deployment,
    checks,
    feedback: { busy, error, errorAction, probeReport },
    build: { buildOperation, buildConnection, build, cancelBuild, copyBuildDiagnostics },
    connection: {
      connectionMode,
      providerChoice,
      customProvider,
      baseUrl,
      wireApi,
      apiKey,
      providerValid,
      endpointValid,
      deviceAuth,
      discovery,
      needsProfileRepair,
      setConnectionMode,
      selectProvider,
      setCustomProvider,
      setBaseUrl,
      setWireApi,
      setApiKey,
      device,
      authenticate
    },
    profile: {
      thirdParty,
      authMetadataReady,
      profileInputValid,
      repairNeedsKey,
      repairApiKey,
      model,
      timeoutMinutes,
      setModel,
      setTimeoutMinutes,
      setRepairApiKey,
      createProfile,
      repairProfile
    },
    probe
  };
  return <CodexSetupView model={viewModel} />;
}

function createCodexAction({
  onChange,
  setBusy,
  setError,
  setErrorAction,
  setProbeReport
}: {
  onChange: () => Promise<unknown>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  setErrorAction: Dispatch<SetStateAction<string>>;
  setProbeReport: Dispatch<SetStateAction<CodexProbeReport | null>>;
}) {
  return async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setErrorAction('');
    setProbeReport(null);
    try {
      await task();
      await onChange();
    } catch (value) {
      const feedback = errorFeedback(value);
      setError(feedback.message);
      setErrorAction(feedback.action);
      setProbeReport(feedback.probe);
    } finally {
      setBusy(false);
    }
  };
}

export type CodexSetupViewModel = {
  state: StepState;
  deployment?: DeploymentStatus;
  checks: Record<string, boolean>;
  feedback: {
    busy: boolean;
    error: string;
    errorAction: string;
    probeReport: CodexProbeReport | null;
  };
  build: ReturnType<typeof useCodexBuild>;
  connection: {
    connectionMode: ConnectionMode;
    providerChoice: ProviderChoice;
    customProvider: string;
    baseUrl: string;
    wireApi: WireApi;
    apiKey: string;
    providerValid: boolean;
    endpointValid: boolean;
    deviceAuth: DeviceAuthSummary;
    discovery: ReturnType<typeof useCodexDiscovery>;
    needsProfileRepair: boolean;
    setConnectionMode: Dispatch<SetStateAction<ConnectionMode>>;
    selectProvider: (value: ProviderChoice) => void;
    setCustomProvider: Dispatch<SetStateAction<string>>;
    setBaseUrl: Dispatch<SetStateAction<string>>;
    setWireApi: Dispatch<SetStateAction<WireApi>>;
    setApiKey: Dispatch<SetStateAction<string>>;
    device: () => Promise<void>;
    authenticate: () => Promise<void>;
  };
  profile: {
    thirdParty: boolean;
    authMetadataReady: boolean;
    profileInputValid: boolean;
    repairNeedsKey: boolean;
    repairApiKey: string;
    model: string;
    timeoutMinutes: number;
    setModel: Dispatch<SetStateAction<string>>;
    setTimeoutMinutes: Dispatch<SetStateAction<number>>;
    setRepairApiKey: Dispatch<SetStateAction<string>>;
    createProfile: () => Promise<void>;
    repairProfile: () => Promise<void>;
  };
  probe: () => Promise<void>;
};

function useCodexProfileHydration({
  authenticated,
  profileId,
  setProviderChoice,
  setCustomProvider,
  setBaseUrl,
  setWireApi,
  setModel,
  setTimeoutMinutes,
  setProfileName,
  setAuthProvider,
  setConnectionMode,
  setError
}: {
  authenticated: boolean;
  profileId?: string | null;
  setProviderChoice: Dispatch<SetStateAction<ProviderChoice>>;
  setCustomProvider: Dispatch<SetStateAction<string>>;
  setBaseUrl: Dispatch<SetStateAction<string>>;
  setWireApi: Dispatch<SetStateAction<WireApi>>;
  setModel: Dispatch<SetStateAction<string>>;
  setTimeoutMinutes: Dispatch<SetStateAction<number>>;
  setProfileName: Dispatch<SetStateAction<string>>;
  setAuthProvider: Dispatch<SetStateAction<string>>;
  setConnectionMode: Dispatch<SetStateAction<ConnectionMode>>;
  setError: Dispatch<SetStateAction<string>>;
}) {
  const [hydratedProfile, setHydratedProfile] = useState<string | null>(null);
  const hydrated = useRef(false);
  useEffect(() => {
    if (!authenticated) {
      hydrated.current = false;
      setHydratedProfile(null);
      return;
    }
    if (hydrated.current) return;
    hydrated.current = true;
    const profiles = profileId ? api<CodexProfile[]>('/codex/profiles') : Promise.resolve([]);
    void Promise.all([api<CodexStatus>('/codex/status'), profiles])
      .then(([result, records]) => {
        const auth = result.auth;
        const record = records.find((item) => item.id === profileId);
        const selectedProvider = record?.provider || auth?.provider;
        if (selectedProvider) {
          const choice = providerChoiceFor(selectedProvider);
          setProviderChoice(choice);
          setCustomProvider(choice === 'custom' ? selectedProvider : '');
          setBaseUrl(
            choice === 'openai'
              ? ''
              : record?.base_url || auth?.base_url || (choice === 'openrouter' ? OPENROUTER_BASE_URL : '')
          );
          setWireApi('responses');
          if (record?.model) setModel(record.model);
          setTimeoutMinutes(codexTimeoutMinutesFromMs(record?.timeout_ms));
          if (record?.name) setProfileName(record.name);
          setAuthProvider(auth?.provider || '');
          if (auth?.auth_mode === 'api_key') setConnectionMode('manual');
        }
        setHydratedProfile(profileId || 'new');
      })
      .catch((value) => {
        hydrated.current = false;
        setError(`Codex 配置读取失败：${message(value)}`);
      });
  }, [authenticated, profileId]);
  return hydratedProfile;
}

type CodexFeedbackSetters = {
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  setErrorAction: Dispatch<SetStateAction<string>>;
  setProbeReport: Dispatch<SetStateAction<CodexProbeReport | null>>;
};

function useCodexBuild({
  enabled,
  onChange,
  setBusy,
  setError,
  setErrorAction,
  setProbeReport
}: CodexFeedbackSetters & { enabled: boolean; onChange: () => Promise<unknown> }) {
  const [buildOperation, setBuildOperation] = useState<CodexBuildOperation | null>(null);
  const [buildConnection, setBuildConnection] = useState<'connected' | 'reconnecting'>('connected');
  const buildSource = useRef<EventSource | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void api<{ operation: CodexBuildOperation | null }>('/codex/docker/builds/active')
      .then((result) => {
        if (active && result.operation) connectBuild(result.operation);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [enabled]);
  useEffect(() => () => buildSource.current?.close(), []);

  async function build() {
    setBusy(true);
    setError('');
    setErrorAction('');
    setProbeReport(null);
    try {
      const result = await api<CodexBuildStart>(
        '/codex/docker/build',
        json(
          'POST',
          undefined,
          describeOperation('启动 Codex 镜像构建', { phase: '启动构建', timeoutMs: 30_000, safeRetry: true })
        )
      );
      if (result.operation_id && result.operation) connectBuild(result.operation, result.events_url);
      else await onChange();
    } catch (value) {
      reportFeedback(value, setError, setErrorAction);
    } finally {
      setBusy(false);
    }
  }

  function connectBuild(
    snapshot: CodexBuildOperation,
    eventsUrl = `/codex/docker/builds/${snapshot.operation_id}/events`
  ) {
    buildSource.current?.close();
    applyBuildSnapshot(snapshot);
    if (snapshot.status !== 'running') return;
    setBuildConnection('connected');
    const source = new EventSource(apiUrl(eventsUrl));
    buildSource.current = source;
    source.onopen = () => setBuildConnection('connected');
    source.onerror = () => setBuildConnection('reconnecting');
    source.addEventListener('snapshot', (event) => applyBuildSnapshot(parseBuildSnapshot(event)));
    source.addEventListener('phase', (event) => {
      const value = parseEvent(event);
      setBuildOperation((current) => {
        if (!current) return current;
        const next = {
          ...current,
          phase: { ...current.phase, ...value },
          message: String(value.message || current.message || '')
        } as CodexBuildOperation;
        syncBuildDiagnostic(next);
        return next;
      });
    });
    source.addEventListener('log', (event) => {
      const value = parseEvent(event) as CodexBuildLog;
      setBuildOperation((current) =>
        current ? { ...current, latest_log: value.text, logs: [...current.logs, value].slice(-200) } : current
      );
    });
    for (const type of ['completed', 'failed', 'cancelled'] as const)
      source.addEventListener(type, async (event) => {
        source.close();
        applyBuildSnapshot(parseBuildSnapshot(event));
        await onChange();
      });
  }

  function applyBuildSnapshot(snapshot: CodexBuildOperation) {
    setBuildOperation(snapshot);
    syncBuildDiagnostic(snapshot);
  }

  function syncBuildDiagnostic(snapshot: CodexBuildOperation) {
    const status = snapshot.status === 'completed' ? 'succeeded' : snapshot.status;
    const externalId = `codex-build:${snapshot.operation_id}`;
    upsertExternalOperation({
      id: externalId,
      name: '构建 Codex 隔离镜像',
      status,
      phase: snapshot.phase?.label || snapshot.status,
      startedAt: snapshot.started_at,
      endedAt: snapshot.completed_at,
      errorCode: snapshot.error_code,
      retryable: snapshot.retryable,
      reason: snapshot.status === 'failed' ? snapshot.message : '',
      action: snapshot.action || '',
      path: '/codex/docker/build'
    });
    if (snapshot.status === 'failed' && snapshot.retryable) registerOperationRetry(externalId, build);
  }

  async function cancelBuild() {
    if (!buildOperation || buildOperation.status !== 'running') return;
    try {
      await api(
        `/codex/docker/builds/${buildOperation.operation_id}/cancel`,
        json('POST', undefined, describeOperation('取消 Codex 镜像构建', { phase: '正在取消', timeoutMs: 30_000 }))
      );
    } catch (value) {
      reportFeedback(value, setError, setErrorAction);
    }
  }

  async function copyBuildDiagnostics() {
    if (!buildOperation) return;
    await navigator.clipboard.writeText(JSON.stringify(safeBuildDiagnostics(buildOperation), null, 2));
  }
  return { buildOperation, buildConnection, build, cancelBuild, copyBuildDiagnostics };
}

function useCodexDeviceAuth({
  onChange,
  setBusy,
  setError,
  setErrorAction,
  setProbeReport
}: CodexFeedbackSetters & { onChange: () => Promise<unknown> }) {
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthSummary>({});
  const device = async () => {
    setBusy(true);
    setError('');
    setErrorAction('');
    setProbeReport(null);
    setDeviceAuth({ status: 'starting' });
    try {
      const result = await api<{ authenticated?: boolean; events_url?: string }>(
        '/codex/auth/device/start',
        json('POST', undefined, '启动 Codex 设备登录')
      );
      if (!result.events_url) {
        setDeviceAuth({ status: 'completed' });
        await onChange();
        setBusy(false);
        return;
      }
      const source = new EventSource(`/api${result.events_url}`);
      source.addEventListener('auth', (event) => {
        const safe = publicDeviceAuthSummary(JSON.parse((event as MessageEvent).data));
        setDeviceAuth((value) => ({ ...value, ...safe, status: safe.status || 'waiting' }));
      });
      source.addEventListener('done', async (event) => {
        source.close();
        setBusy(false);
        const result = JSON.parse((event as MessageEvent).data);
        const status =
          result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
        setDeviceAuth((value) => ({ ...value, status }));
        if (status === 'failed') setError('Codex 设备登录失败，请重试');
        await onChange();
      });
      source.onerror = () => {
        source.close();
        setBusy(false);
        setDeviceAuth((value) => ({ ...value, status: 'failed' }));
        setError('Codex 登录事件流已断开');
      };
    } catch (value) {
      setBusy(false);
      setDeviceAuth({ status: 'failed' });
      setError(message(value));
    }
  };
  return { deviceAuth, device };
}

function message(value: unknown) {
  return value instanceof Error ? value.message : 'Codex 操作失败';
}
function sameProvider(left: string, right: string) {
  const official = ['openai', 'chatgpt'];
  return left === right || (official.includes(left) && official.includes(right));
}
function providerChoiceFor(value: string): ProviderChoice {
  if (value === 'openai' || value === 'chatgpt') return 'openai';
  if (value === 'openrouter') return 'openrouter';
  return 'custom';
}
function codexConnectionFields(provider: string, thirdParty: boolean, baseUrl: string) {
  return {
    provider,
    ...(thirdParty ? { base_url: baseUrl.trim(), wire_api: 'responses' as const } : {})
  };
}
function codexProfileFields(
  connection: ReturnType<typeof codexConnectionFields>,
  profileName: string,
  model: string,
  timeoutMinutes: number
) {
  return {
    name: profileName || `${connection.provider} workspace`,
    ...connection,
    model: model.trim(),
    reasoning: 'high',
    web_search: false,
    timeout_ms: codexTimeoutMinutesToMs(timeoutMinutes),
    mounts: []
  };
}
function errorFeedback(value: unknown): { message: string; action: string; probe: CodexProbeReport | null } {
  if (!(value instanceof ApiError)) return { message: message(value), action: '', probe: null };
  const action = typeof value.payload.action === 'string' ? value.payload.action : '';
  const candidate = value.payload.probe;
  const probe =
    candidate && typeof candidate === 'object' && typeof (candidate as CodexProbeReport).phase === 'string'
      ? (candidate as CodexProbeReport)
      : null;
  return { message: value.message, action, probe };
}

function reportFeedback(
  value: unknown,
  setError: Dispatch<SetStateAction<string>>,
  setErrorAction: Dispatch<SetStateAction<string>>
) {
  const feedback = errorFeedback(value);
  setError(feedback.message);
  setErrorAction(feedback.action);
}

function parseEvent(event: Event) {
  try {
    return JSON.parse((event as MessageEvent).data) as Record<string, unknown>;
  } catch {
    return {};
  }
}
function parseBuildSnapshot(event: Event) {
  return parseEvent(event) as unknown as CodexBuildOperation;
}
