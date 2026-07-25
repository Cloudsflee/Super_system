import { Box, Check, Cpu, LoaderCircle, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, apiUrl, describeOperation, json } from '../../api/client';
import type { CodexBuildLog, CodexBuildOperation, CodexBuildStart, CodexProbeReport, CodexProfile, CodexStatus, DeploymentStatus, StepState } from '../../api/types';
import { validBaseUrl, type ProviderChoice, type WireApi } from './CodexProviderFields';
import { CodexConnectionSetup, type ConnectionMode } from './CodexConnectionSetup';
import { CodexProfileForm } from './CodexProfileForm';
import { publicDeviceAuthSummary, type DeviceAuthSummary } from './codex-device-auth';
import { useCodexDiscovery } from './useCodexDiscovery';
import { registerOperationRetry, upsertExternalOperation } from '../../operations/operation-store';
import { CodexBuildProgress, safeBuildDiagnostics } from './CodexBuildProgress';
import { DEFAULT_CODEX_TIMEOUT_MINUTES, codexTimeoutMinutesFromMs, codexTimeoutMinutesToMs, validCodexTimeoutMinutes } from './codex-timeout';
import { displayStatus, setupDetailLabel } from '../../components/common/display-labels';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function CodexSetup({ state, onChange, deployment }: { state: StepState; onChange: () => Promise<unknown>; deployment?: DeploymentStatus }) {
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
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthSummary>({});
  const [error, setError] = useState('');
  const [errorAction, setErrorAction] = useState('');
  const [probeReport, setProbeReport] = useState<CodexProbeReport | null>(null);
  const [buildOperation, setBuildOperation] = useState<CodexBuildOperation | null>(null);
  const [buildConnection, setBuildConnection] = useState<'connected' | 'reconnecting'>('connected');
  const [hydratedProfile, setHydratedProfile] = useState<string | null>(null);
  const authHydrated = useRef(false);
  const buildSource = useRef<EventSource | null>(null);
  const checks = state.checks || {};
  const thirdParty = providerChoice !== 'openai';
  const provider = providerChoice === 'custom' ? customProvider.trim() : providerChoice;
  const providerValid = Boolean(provider) && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(provider);
  const endpointValid = !thirdParty || validBaseUrl(baseUrl);
  const profileInputValid = providerValid && endpointValid && Boolean(model.trim()) && validCodexTimeoutMinutes(timeoutMinutes);
  const needsProfileRepair = Boolean(state.profile_id && (checks.provider_endpoint_valid === false || checks.auth_profile_match === false));
  const repairNeedsKey = needsProfileRepair && !sameProvider(authProvider, provider);
  const authMetadataReady = hydratedProfile === (state.profile_id || 'new');

  const discovery = useCodexDiscovery(async () => { await onChange(); });
  useEffect(() => {
    if (checks.docker_ready || deployment?.mode === 'container') return;
    let active = true;
    void api<{ operation: CodexBuildOperation | null }>('/codex/docker/builds/active').then((result) => {
      if (active && result.operation) connectBuild(result.operation);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [checks.docker_ready, deployment?.mode]);
  useEffect(() => () => buildSource.current?.close(), []);
  useEffect(() => {
    if (connectionMode === 'codex_home' && deployment?.mode === 'container' && !deployment.imports.codex_home) setConnectionMode('manual');
    if (connectionMode === 'cc_switch' && deployment?.mode === 'container' && !deployment.imports.cc_switch) setConnectionMode('manual');
  }, [connectionMode, deployment]);
  useEffect(() => {
    if (!checks.authenticated) { authHydrated.current = false; setHydratedProfile(null); return; }
    if (authHydrated.current) return;
    authHydrated.current = true;
    const profiles = state.profile_id ? api<CodexProfile[]>('/codex/profiles') : Promise.resolve([]);
    void Promise.all([api<CodexStatus>('/codex/status'), profiles]).then(([result, records]) => {
      const auth = result.auth, record = records.find((item) => item.id === state.profile_id);
      const selectedProvider = record?.provider || auth?.provider;
      if (selectedProvider) {
        const choice: ProviderChoice = selectedProvider === 'openai' || selectedProvider === 'chatgpt' ? 'openai' : selectedProvider === 'openrouter' ? 'openrouter' : 'custom';
        setProviderChoice(choice);
        setCustomProvider(choice === 'custom' ? selectedProvider : '');
        setBaseUrl(choice === 'openai' ? '' : record?.base_url || auth?.base_url || (choice === 'openrouter' ? OPENROUTER_BASE_URL : ''));
        setWireApi('responses');
        if (record?.model) setModel(record.model);
        setTimeoutMinutes(codexTimeoutMinutesFromMs(record?.timeout_ms));
        if (record?.name) setProfileName(record.name);
        setAuthProvider(auth?.provider || '');
        if (auth?.auth_mode === 'api_key') setConnectionMode('manual');
      }
      setHydratedProfile(state.profile_id || 'new');
    }).catch((value) => { authHydrated.current = false; setError(`Codex 配置读取失败：${message(value)}`); });
  }, [checks.authenticated, state.profile_id]);

  async function act(task: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setErrorAction('');
    setProbeReport(null);
    try { await task(); await onChange(); }
    catch (value) {
      const feedback = errorFeedback(value);
      setError(feedback.message);
      setErrorAction(feedback.action);
      setProbeReport(feedback.probe);
    }
    finally { setBusy(false); }
  }

  function selectProvider(value: ProviderChoice) {
    setProviderChoice(value);
    if (value === 'openai') setBaseUrl('');
    else if (value === 'openrouter') setBaseUrl(OPENROUTER_BASE_URL);
    else {
      if (!customProvider) setCustomProvider('custom');
      if (baseUrl === OPENROUTER_BASE_URL) setBaseUrl('');
    }
  }

  function connectionFields() {
    return {
      provider,
      ...(thirdParty ? { base_url: baseUrl.trim(), wire_api: 'responses' as const } : {})
    };
  }

  function profileFields() {
    return {
      name: profileName || `${provider} workspace`,
      ...connectionFields(),
      model: model.trim(),
      reasoning: 'high',
      web_search: false,
      timeout_ms: codexTimeoutMinutesToMs(timeoutMinutes),
      mounts: []
    };
  }

  async function build() {
    setBusy(true); setError(''); setErrorAction(''); setProbeReport(null);
    try {
      const result = await api<CodexBuildStart>('/codex/docker/build', json('POST', undefined, describeOperation('启动 Codex 镜像构建', { phase: '启动构建', timeoutMs: 30_000, safeRetry: true })));
      if (result.operation_id && result.operation) connectBuild(result.operation, result.events_url);
      else await onChange();
    } catch (value) {
      const feedback = errorFeedback(value); setError(feedback.message); setErrorAction(feedback.action);
    } finally { setBusy(false); }
  }

  function connectBuild(snapshot: CodexBuildOperation, eventsUrl = `/codex/docker/builds/${snapshot.operation_id}/events`) {
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
        const next = { ...current, phase: { ...current.phase, ...value }, message: String(value.message || current.message || '') } as CodexBuildOperation;
        syncBuildDiagnostic(next); return next;
      });
    });
    source.addEventListener('log', (event) => {
      const value = parseEvent(event) as CodexBuildLog;
      setBuildOperation((current) => current ? { ...current, latest_log: value.text, logs: [...current.logs, value].slice(-200) } : current);
    });
    for (const type of ['completed', 'failed', 'cancelled'] as const) source.addEventListener(type, async (event) => {
      source.close();
      const value = parseBuildSnapshot(event);
      applyBuildSnapshot(value);
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
      id: externalId, name: '构建 Codex 隔离镜像', status, phase: snapshot.phase?.label || snapshot.status,
      startedAt: snapshot.started_at, endedAt: snapshot.completed_at, errorCode: snapshot.error_code,
      retryable: snapshot.retryable, reason: snapshot.status === 'failed' ? snapshot.message : '', action: snapshot.action || '', path: '/codex/docker/build'
    });
    if (snapshot.status === 'failed' && snapshot.retryable) registerOperationRetry(externalId, build);
  }

  async function cancelBuild() {
    if (!buildOperation || buildOperation.status !== 'running') return;
    try { await api(`/codex/docker/builds/${buildOperation.operation_id}/cancel`, json('POST', undefined, describeOperation('取消 Codex 镜像构建', { phase: '正在取消', timeoutMs: 30_000 }))); }
    catch (value) { const feedback = errorFeedback(value); setError(feedback.message); setErrorAction(feedback.action); }
  }

  async function copyBuildDiagnostics() {
    if (!buildOperation) return;
    await navigator.clipboard.writeText(JSON.stringify(safeBuildDiagnostics(buildOperation), null, 2));
  }
  const device = async () => {
    setBusy(true);
    setError('');
    setErrorAction('');
    setProbeReport(null);
    setDeviceAuth({ status: 'starting' });
    try {
      const result = await api<{ authenticated?: boolean; events_url?: string }>('/codex/auth/device/start', json('POST', undefined, '启动 Codex 设备登录'));
      if (!result.events_url) { setDeviceAuth({ status: 'completed' }); await onChange(); setBusy(false); return; }
      const source = new EventSource(`/api${result.events_url}`);
      source.addEventListener('auth', (event) => { const safe = publicDeviceAuthSummary(JSON.parse((event as MessageEvent).data)); setDeviceAuth((value) => ({ ...value, ...safe, status: safe.status || 'waiting' })); });
      source.addEventListener('done', async (event) => { source.close(); setBusy(false); const result = JSON.parse((event as MessageEvent).data), status = result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed'; setDeviceAuth((value) => ({ ...value, status })); if (status === 'failed') setError('Codex 设备登录失败，请重试'); await onChange(); });
      source.onerror = () => { source.close(); setBusy(false); setDeviceAuth((value) => ({ ...value, status: 'failed' })); setError('Codex 登录事件流已断开'); };
    } catch (value) { setBusy(false); setDeviceAuth({ status: 'failed' }); setError(message(value)); }
  };
  const authenticate = () => act(() => api('/codex/auth/api-key', json('POST', { ...connectionFields(), api_key: apiKey }, '保存 Codex 认证')));
  const createProfile = () => act(() => api('/codex/profiles', json('POST', profileFields(), '创建 Codex 配置')));
  const repairProfile = () => act(async () => {
    if (thirdParty || repairNeedsKey) await api('/codex/auth/api-key', json('POST', { ...connectionFields(), ...(repairApiKey ? { api_key: repairApiKey } : {}) }, '更新 Codex 认证'));
    await api(`/codex/profiles/${state.profile_id}`, json('PUT', profileFields(), '修复 Codex 配置'));
  });
  const probe = () => act(() => api('/codex/probe', json('POST', { profile_id: state.profile_id }, '运行 Codex 探针')));

  return (
    <section className="setup-section">
      <div className="section-title"><Cpu size={18} /><div><h2>Codex</h2><p>{setupDetailLabel(state.detail) || '等待运行环境验证'}</p></div><span className={`status ${state.ready ? 'ready' : 'pending'}`}>{state.ready && <Check size={12} />}{displayStatus(state.status)}</span></div>
      {!checks.docker_ready && <div className="setup-row"><div><strong>Docker 运行环境</strong><span>{deployment?.mode === 'container' ? '预构建执行器镜像当前不可用' : '隔离执行器镜像'}</span></div>{deployment?.mode === 'container' ? <span className="status failed"><Box size={13} />需要重新部署</span> : !buildOperation ? <button className="button primary" disabled={busy} onClick={build}><Box size={15} />检测并构建</button> : null}</div>}
      {buildOperation && <CodexBuildProgress operation={buildOperation} connection={buildConnection} busy={busy} onCancel={cancelBuild} onCopy={copyBuildDiagnostics} onRetry={build} />}

      {(!checks.authenticated || needsProfileRepair) && <CodexConnectionSetup mode={connectionMode} runtimeReady={Boolean(checks.docker_ready)} repairing={needsProfileRepair} busy={busy} sourceAvailability={{ codex_home: deployment?.mode !== 'container' || deployment.imports.codex_home, cc_switch: deployment?.mode !== 'container' || deployment.imports.cc_switch }} providerChoice={providerChoice} customProvider={customProvider} baseUrl={baseUrl} wireApi={wireApi} apiKey={apiKey} providerValid={providerValid} endpointValid={endpointValid} deviceAuth={deviceAuth} discovery={discovery} onMode={setConnectionMode} onProvider={selectProvider} onCustomProvider={setCustomProvider} onBaseUrl={setBaseUrl} onWireApi={setWireApi} onApiKey={setApiKey} onDevice={device} onAuthenticate={authenticate} onDiscoveryRefresh={discovery.refresh} onDiscoveryImport={discovery.importConfig} />}

      {checks.authenticated && !checks.profile_valid && (!state.profile_id || needsProfileRepair) && <CodexProfileForm repair={needsProfileRepair} thirdParty={thirdParty} busy={busy} valid={authMetadataReady && profileInputValid && (!repairNeedsKey || Boolean(repairApiKey))} providerChoice={providerChoice} customProvider={customProvider} baseUrl={baseUrl} wireApi={wireApi} model={model} timeoutMinutes={timeoutMinutes} repairNeedsKey={repairNeedsKey} repairApiKey={repairApiKey} onProvider={selectProvider} onCustomProvider={setCustomProvider} onBaseUrl={setBaseUrl} onWireApi={setWireApi} onModel={setModel} onTimeoutMinutes={setTimeoutMinutes} onRepairApiKey={setRepairApiKey} onCreate={createProfile} onRepair={repairProfile} />}
      {checks.docker_ready && checks.profile_valid && !checks.probe_ok && <div className="setup-row"><div><strong>非写入探针</strong><span>验证当前 Codex 配置、接口地址与隔离挂载</span></div><button className="button primary" disabled={busy} onClick={probe}><Play size={15} />运行探针</button></div>}
      {busy && <div className="inline-busy"><LoaderCircle className="spin" size={15} />正在执行</div>}
      {error && <div className="setup-feedback error probe-feedback" role="alert">
        <strong>{error}</strong>
        {errorAction && <span>{errorAction}</span>}
        {probeReport?.checks?.length ? <ol aria-label="探针校验结果">{probeReport.checks.map((check) => <li key={check.phase} className={check.status}>
          <span>{check.label}</span><b>{check.status === 'passed' ? '已通过' : check.status === 'failed' ? '失败' : '未执行'}</b>
        </li>)}</ol> : null}
      </div>}
    </section>
  );
}

function message(value: unknown) { return value instanceof Error ? value.message : 'Codex 操作失败'; }
function sameProvider(left: string, right: string) { const official = ['openai', 'chatgpt']; return left === right || (official.includes(left) && official.includes(right)); }
function errorFeedback(value: unknown): { message: string; action: string; probe: CodexProbeReport | null } {
  if (!(value instanceof ApiError)) return { message: message(value), action: '', probe: null };
  const action = typeof value.payload.action === 'string' ? value.payload.action : '';
  const candidate = value.payload.probe;
  const probe = candidate && typeof candidate === 'object' && typeof (candidate as CodexProbeReport).phase === 'string' ? candidate as CodexProbeReport : null;
  return { message: value.message, action, probe };
}

function parseEvent(event: Event) { try { return JSON.parse((event as MessageEvent).data) as Record<string, unknown>; } catch { return {}; } }
function parseBuildSnapshot(event: Event) { return parseEvent(event) as unknown as CodexBuildOperation; }
