import { KeyRound } from 'lucide-react';
import type { CodexDiscovery, CodexDiscoveryImportInput } from '../../api/types';
import { CodexDiscoveryPicker } from './CodexDiscoveryPicker';
import { ProviderFields, type ProviderChoice, type WireApi } from './CodexProviderFields';
import type { DeviceAuthSummary } from './codex-device-auth';

export type ConnectionMode = 'device' | 'cc_switch' | 'codex_home' | 'manual';

export function CodexConnectionSetup({ mode, runtimeReady, repairing = false, busy, sourceAvailability = { codex_home: true, cc_switch: true }, providerChoice, customProvider, baseUrl, wireApi, apiKey, providerValid, endpointValid, deviceAuth, discovery, onMode, onProvider, onCustomProvider, onBaseUrl, onWireApi, onApiKey, onDevice, onAuthenticate, onDiscoveryRefresh, onDiscoveryImport }: {
  mode: ConnectionMode; busy: boolean; providerChoice: ProviderChoice; customProvider: string; baseUrl: string; wireApi: WireApi; apiKey: string;
  runtimeReady: boolean; repairing?: boolean; providerValid: boolean; endpointValid: boolean; deviceAuth: DeviceAuthSummary;
  sourceAvailability?: { codex_home: boolean; cc_switch: boolean };
  discovery: { data: CodexDiscovery | null; loading: boolean; error: string; actionError: string; busy: boolean };
  onMode: (value: ConnectionMode) => void; onProvider: (value: ProviderChoice) => void; onCustomProvider: (value: string) => void;
  onBaseUrl: (value: string) => void; onWireApi: (value: WireApi) => void; onApiKey: (value: string) => void;
  onDevice: () => void; onAuthenticate: () => void; onDiscoveryRefresh: () => Promise<unknown>; onDiscoveryImport: (input: CodexDiscoveryImportInput) => Promise<unknown>;
}) {
  const thirdParty = providerChoice !== 'openai';
  return <div className="setup-block codex-auth-block">
    <div className="segmented compact connection-modes" role="group" aria-label="Codex 配置来源">
      <button disabled={!sourceAvailability.codex_home} className={mode === 'codex_home' ? 'active' : ''} onClick={() => onMode('codex_home')}>本地 Codex</button>
      <button className={mode === 'device' ? 'active' : ''} onClick={() => onMode('device')}>官方账户</button>
      <button className={mode === 'manual' ? 'active' : ''} onClick={() => onMode('manual')}>手动 API</button>
      <button disabled={!sourceAvailability.cc_switch} className={mode === 'cc_switch' ? 'active' : ''} onClick={() => onMode('cc_switch')}>cc-switch</button>
    </div>
    {mode === 'device' && <><div className="connection-command"><div><strong>ChatGPT 设备登录</strong><span>{runtimeReady ? '使用 OpenAI 官方账户授权，不读取本地第三方配置。' : '设备登录依赖 Codex Docker 运行环境，请先完成镜像构建。'}</span></div><button className="button primary" disabled={busy || !runtimeReady} onClick={onDevice}><KeyRound size={15} />启动设备登录</button></div>{deviceAuth.status && <div className="device-auth-summary" role="status"><span className={`status ${deviceAuth.status === 'completed' ? 'ready' : deviceAuth.status === 'failed' ? 'failed' : 'pending'}`}>{deviceStatus(deviceAuth.status)}</span>{deviceAuth.verification_uri && <a href={deviceAuth.verification_uri} target="_blank" rel="noreferrer">打开 OpenAI 官方授权页</a>}{deviceAuth.user_code && <code>{deviceAuth.user_code}</code>}</div>}</>}
    {(mode === 'cc_switch' || mode === 'codex_home') && <CodexDiscoveryPicker type={mode} data={discovery.data} loading={discovery.loading} error={discovery.error} actionError={discovery.actionError} busy={busy || discovery.busy} onRefresh={onDiscoveryRefresh} onImport={onDiscoveryImport} />}
    {mode === 'manual' && repairing && <div className="connection-command"><div><strong>修复当前手动 API 配置</strong><span>请在下方现有配置表单补齐服务商、API 根地址与模型；已保存凭据可安全复用。</span></div></div>}
    {mode === 'manual' && !repairing && <div className="form-grid codex-provider-form">
      <ProviderFields providerChoice={providerChoice} customProvider={customProvider} baseUrl={baseUrl} wireApi={wireApi} onProvider={onProvider} onCustomProvider={onCustomProvider} onBaseUrl={onBaseUrl} onWireApi={onWireApi} />
      <label className={thirdParty ? 'span-2' : ''}>API 密钥<input aria-label="API 密钥" type="password" autoComplete="off" value={apiKey} onChange={(event) => onApiKey(event.target.value)} /></label>
      <div className="block-actions span-2"><button className="button primary" disabled={busy || !apiKey.trim() || !providerValid || !endpointValid} onClick={onAuthenticate}><KeyRound size={15} />保存凭据与接口地址</button></div>
    </div>}
  </div>;
}

function deviceStatus(value: NonNullable<DeviceAuthSummary['status']>) { return ({ starting: '正在启动', running: '等待授权', waiting: '等待授权', completed: '授权完成', failed: '授权失败', cancelled: '已取消' } as const)[value]; }
