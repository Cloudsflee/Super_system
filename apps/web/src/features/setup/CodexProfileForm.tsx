import { Cpu, KeyRound } from 'lucide-react';
import { ProviderFields, type ProviderChoice, type WireApi } from './CodexProviderFields';

export function CodexProfileForm({ repair, thirdParty, busy, valid, providerChoice, customProvider, baseUrl, wireApi, model, repairNeedsKey, repairApiKey, onProvider, onCustomProvider, onBaseUrl, onWireApi, onModel, onRepairApiKey, onCreate, onRepair }: {
  repair: boolean; thirdParty: boolean; busy: boolean; valid: boolean;
  providerChoice: ProviderChoice; customProvider: string; baseUrl: string; wireApi: WireApi; model: string;
  repairNeedsKey: boolean; repairApiKey: string;
  onProvider: (value: ProviderChoice) => void; onCustomProvider: (value: string) => void;
  onBaseUrl: (value: string) => void; onWireApi: (value: WireApi) => void; onModel: (value: string) => void;
  onRepairApiKey: (value: string) => void; onCreate: () => void; onRepair: () => void;
}) {
  return <div className="setup-block">
    <div className="setup-block-heading"><div><strong>{repair ? '修复现有 Codex Profile' : 'Codex Profile'}</strong><span>{repair ? '旧 Profile 缺少 Endpoint 或与当前凭据不匹配；补全后原位更新。' : 'Endpoint 会写入当前 Profile 的隔离 TOML，不会保存到全局配置。'}</span></div></div>
    <div className="form-grid codex-provider-form">
      <ProviderFields providerChoice={providerChoice} customProvider={customProvider} baseUrl={baseUrl} wireApi={wireApi} onProvider={onProvider} onCustomProvider={onCustomProvider} onBaseUrl={onBaseUrl} onWireApi={onWireApi} />
      <label className={thirdParty ? 'span-2' : ''}>Model<input aria-label="Model" value={model} onChange={(event) => onModel(event.target.value)} placeholder="例如 gpt-5.1-codex 或 provider/model" /></label>
      {repairNeedsKey && <label className="span-2"><span>API Key <em className="required-mark">当前凭据 Provider 不匹配</em></span><input aria-label="修复 Profile API Key" type="password" autoComplete="off" value={repairApiKey} onChange={(event) => onRepairApiKey(event.target.value)} /></label>}
    </div>
    <div className="block-actions">
      <button className="button primary" disabled={busy || !valid} onClick={repair ? onRepair : onCreate}>{repair ? <KeyRound size={15} /> : <Cpu size={15} />}{repair ? '保存 Endpoint 并修复 Profile' : '保存并校验 Profile'}</button>
    </div>
  </div>;
}
