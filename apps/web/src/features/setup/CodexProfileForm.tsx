import { Cpu, KeyRound } from 'lucide-react';
import { ProviderFields, type ProviderChoice, type WireApi } from './CodexProviderFields';

export function CodexProfileForm({
  repair,
  thirdParty,
  busy,
  valid,
  providerChoice,
  customProvider,
  baseUrl,
  wireApi,
  model,
  timeoutMinutes,
  repairNeedsKey,
  repairApiKey,
  onProvider,
  onCustomProvider,
  onBaseUrl,
  onWireApi,
  onModel,
  onTimeoutMinutes,
  onRepairApiKey,
  onCreate,
  onRepair
}: {
  repair: boolean;
  thirdParty: boolean;
  busy: boolean;
  valid: boolean;
  providerChoice: ProviderChoice;
  customProvider: string;
  baseUrl: string;
  wireApi: WireApi;
  model: string;
  timeoutMinutes: number;
  repairNeedsKey: boolean;
  repairApiKey: string;
  onProvider: (value: ProviderChoice) => void;
  onCustomProvider: (value: string) => void;
  onBaseUrl: (value: string) => void;
  onWireApi: (value: WireApi) => void;
  onModel: (value: string) => void;
  onTimeoutMinutes: (value: number) => void;
  onRepairApiKey: (value: string) => void;
  onCreate: () => void;
  onRepair: () => void;
}) {
  return (
    <div className="setup-block">
      <div className="setup-block-heading">
        <div>
          <strong>{repair ? '修复现有 Codex 配置' : 'Codex 配置'}</strong>
          <span>
            {repair
              ? '旧配置缺少接口地址或与当前凭据不匹配；补全后原位更新。'
              : '接口地址会写入当前配置的隔离 TOML，不会保存到全局配置。'}
          </span>
        </div>
      </div>
      <div className="form-grid codex-provider-form">
        <ProviderFields
          providerChoice={providerChoice}
          customProvider={customProvider}
          baseUrl={baseUrl}
          wireApi={wireApi}
          onProvider={onProvider}
          onCustomProvider={onCustomProvider}
          onBaseUrl={onBaseUrl}
          onWireApi={onWireApi}
        />
        <label className={thirdParty ? 'span-2' : ''}>
          模型
          <input
            aria-label="模型"
            value={model}
            onChange={(event) => onModel(event.target.value)}
            placeholder="例如 gpt-5.1-codex 或 provider/model"
          />
        </label>
        <label>
          <span>
            任务超时 <em className="required-mark">分钟</em>
          </span>
          <input
            aria-label="任务超时（分钟）"
            type="number"
            min={1}
            max={30}
            step={1}
            value={timeoutMinutes}
            onChange={(event) => onTimeoutMinutes(Number(event.target.value))}
          />
        </label>
        {repairNeedsKey && (
          <label className="span-2">
            <span>
              API 密钥 <em className="required-mark">当前凭据与服务商不匹配</em>
            </span>
            <input
              aria-label="修复配置 API 密钥"
              type="password"
              autoComplete="off"
              value={repairApiKey}
              onChange={(event) => onRepairApiKey(event.target.value)}
            />
          </label>
        )}
      </div>
      <div className="block-actions">
        <button className="button primary" disabled={busy || !valid} onClick={repair ? onRepair : onCreate}>
          {repair ? <KeyRound size={15} /> : <Cpu size={15} />}
          {repair ? '保存接口地址并修复配置' : '保存并校验配置'}
        </button>
      </div>
    </div>
  );
}
