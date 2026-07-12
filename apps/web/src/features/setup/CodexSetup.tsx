import { Box, Check, Cpu, LoaderCircle, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, json } from '../../api/client';
import type { CodexProbeReport, CodexProfile, CodexStatus, DeploymentStatus, StepState } from '../../api/types';
import { validBaseUrl, type ProviderChoice, type WireApi } from './CodexProviderFields';
import { CodexConnectionSetup, type ConnectionMode } from './CodexConnectionSetup';
import { CodexProfileForm } from './CodexProfileForm';
import { publicDeviceAuthSummary, type DeviceAuthSummary } from './codex-device-auth';
import { useCodexDiscovery } from './useCodexDiscovery';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function CodexSetup({ state, onChange, deployment }: { state: StepState; onChange: () => Promise<unknown>; deployment?: DeploymentStatus }) {
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('codex_home');
  const [apiKey, setApiKey] = useState('');
  const [providerChoice, setProviderChoice] = useState<ProviderChoice>('openai');
  const [customProvider, setCustomProvider] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [wireApi, setWireApi] = useState<WireApi>('responses');
  const [model, setModel] = useState('gpt-5.1-codex');
  const [profileName, setProfileName] = useState('');
  const [authProvider, setAuthProvider] = useState('');
  const [repairApiKey, setRepairApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthSummary>({});
  const [error, setError] = useState('');
  const [errorAction, setErrorAction] = useState('');
  const [probeReport, setProbeReport] = useState<CodexProbeReport | null>(null);
  const [hydratedProfile, setHydratedProfile] = useState<string | null>(null);
  const authHydrated = useRef(false);
  const checks = state.checks || {};
  const thirdParty = providerChoice !== 'openai';
  const provider = providerChoice === 'custom' ? customProvider.trim() : providerChoice;
  const providerValid = Boolean(provider) && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(provider);
  const endpointValid = !thirdParty || validBaseUrl(baseUrl);
  const profileInputValid = providerValid && endpointValid && Boolean(model.trim());
  const needsProfileRepair = Boolean(state.profile_id && (checks.provider_endpoint_valid === false || checks.auth_profile_match === false));
  const repairNeedsKey = needsProfileRepair && !sameProvider(authProvider, provider);
  const authMetadataReady = hydratedProfile === (state.profile_id || 'new');

  const discovery = useCodexDiscovery(async () => { await onChange(); });
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
      timeout_ms: 120000,
      mounts: []
    };
  }

  const build = () => act(() => api('/codex/docker/build', json('POST')));
  const device = async () => {
    setBusy(true);
    setError('');
    setErrorAction('');
    setProbeReport(null);
    setDeviceAuth({ status: 'starting' });
    try {
      const result = await api<{ authenticated?: boolean; events_url?: string }>('/codex/auth/device/start', json('POST'));
      if (!result.events_url) { setDeviceAuth({ status: 'completed' }); await onChange(); setBusy(false); return; }
      const source = new EventSource(`/api${result.events_url}`);
      source.addEventListener('auth', (event) => { const safe = publicDeviceAuthSummary(JSON.parse((event as MessageEvent).data)); setDeviceAuth((value) => ({ ...value, ...safe, status: safe.status || 'waiting' })); });
      source.addEventListener('done', async (event) => { source.close(); setBusy(false); const result = JSON.parse((event as MessageEvent).data), status = result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed'; setDeviceAuth((value) => ({ ...value, status })); if (status === 'failed') setError('Codex Device Login 失败，请重试'); await onChange(); });
      source.onerror = () => { source.close(); setBusy(false); setDeviceAuth((value) => ({ ...value, status: 'failed' })); setError('Codex 登录事件流已断开'); };
    } catch (value) { setBusy(false); setDeviceAuth({ status: 'failed' }); setError(message(value)); }
  };
  const authenticate = () => act(() => api('/codex/auth/api-key', json('POST', { ...connectionFields(), api_key: apiKey })));
  const createProfile = () => act(() => api('/codex/profiles', json('POST', profileFields())));
  const repairProfile = () => act(async () => {
    if (thirdParty || repairNeedsKey) await api('/codex/auth/api-key', json('POST', { ...connectionFields(), ...(repairApiKey ? { api_key: repairApiKey } : {}) }));
    await api(`/codex/profiles/${state.profile_id}`, json('PUT', profileFields()));
  });
  const probe = () => act(() => api('/codex/probe', json('POST', { profile_id: state.profile_id })));

  return (
    <section className="setup-section">
      <div className="section-title"><Cpu size={18} /><div><h2>Codex</h2><p>{state.detail || '等待运行时验证'}</p></div><span className={`status ${state.ready ? 'ready' : 'pending'}`}>{state.ready && <Check size={12} />}{state.status}</span></div>
      {!checks.docker_ready && <div className="setup-row"><div><strong>Docker Runtime</strong><span>{deployment?.mode === 'container' ? '预构建 Runner 镜像当前不可用' : '隔离镜像 aiws-codex-runner:1.4.0-codex-0.144.0'}</span></div>{deployment?.mode === 'container' ? <span className="status failed"><Box size={13} />需要重新部署</span> : <button className="button primary" disabled={busy} onClick={build}><Box size={15} />检测并构建</button>}</div>}

      {(!checks.authenticated || needsProfileRepair) && <CodexConnectionSetup mode={connectionMode} runtimeReady={Boolean(checks.docker_ready)} repairing={needsProfileRepair} busy={busy} sourceAvailability={{ codex_home: deployment?.mode !== 'container' || deployment.imports.codex_home, cc_switch: deployment?.mode !== 'container' || deployment.imports.cc_switch }} providerChoice={providerChoice} customProvider={customProvider} baseUrl={baseUrl} wireApi={wireApi} apiKey={apiKey} providerValid={providerValid} endpointValid={endpointValid} deviceAuth={deviceAuth} discovery={discovery} onMode={setConnectionMode} onProvider={selectProvider} onCustomProvider={setCustomProvider} onBaseUrl={setBaseUrl} onWireApi={setWireApi} onApiKey={setApiKey} onDevice={device} onAuthenticate={authenticate} onDiscoveryRefresh={discovery.refresh} onDiscoveryImport={discovery.importConfig} />}

      {checks.authenticated && !checks.profile_valid && (!state.profile_id || needsProfileRepair) && <CodexProfileForm repair={needsProfileRepair} thirdParty={thirdParty} busy={busy} valid={authMetadataReady && profileInputValid && (!repairNeedsKey || Boolean(repairApiKey))} providerChoice={providerChoice} customProvider={customProvider} baseUrl={baseUrl} wireApi={wireApi} model={model} repairNeedsKey={repairNeedsKey} repairApiKey={repairApiKey} onProvider={selectProvider} onCustomProvider={setCustomProvider} onBaseUrl={setBaseUrl} onWireApi={setWireApi} onModel={setModel} onRepairApiKey={setRepairApiKey} onCreate={createProfile} onRepair={repairProfile} />}
      {checks.docker_ready && checks.profile_valid && !checks.probe_ok && <div className="setup-row"><div><strong>非写入探针</strong><span>验证当前 profile、Endpoint 与隔离挂载</span></div><button className="button primary" disabled={busy} onClick={probe}><Play size={15} />运行 Probe</button></div>}
      {busy && <div className="inline-busy"><LoaderCircle className="spin" size={15} />正在执行</div>}
      {error && <div className="setup-feedback error probe-feedback" role="alert">
        <strong>{error}</strong>
        {errorAction && <span>{errorAction}</span>}
        {probeReport?.checks?.length ? <ol aria-label="Probe 校验结果">{probeReport.checks.map((check) => <li key={check.phase} className={check.status}>
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
