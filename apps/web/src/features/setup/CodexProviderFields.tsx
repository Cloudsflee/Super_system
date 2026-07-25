import { Route } from 'lucide-react';
import type { CodexWireApi } from '../../api/types';

export type ProviderChoice = 'openai' | 'openrouter' | 'custom';
export type WireApi = CodexWireApi;

export function ProviderFields({
  providerChoice,
  customProvider,
  baseUrl,
  wireApi,
  onProvider,
  onCustomProvider,
  onBaseUrl,
  onWireApi
}: {
  providerChoice: ProviderChoice;
  customProvider: string;
  baseUrl: string;
  wireApi: WireApi;
  onProvider: (value: ProviderChoice) => void;
  onCustomProvider: (value: string) => void;
  onBaseUrl: (value: string) => void;
  onWireApi: (value: WireApi) => void;
}) {
  const thirdParty = providerChoice !== 'openai';
  const invalidUrl = Boolean(baseUrl) && !validBaseUrl(baseUrl);
  const invalidProvider = Boolean(customProvider) && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(customProvider.trim());
  return (
    <>
      <label>
        服务商
        <select
          aria-label="服务商"
          value={providerChoice}
          onChange={(event) => onProvider(event.target.value as ProviderChoice)}
        >
          <option value="openai">OpenAI 官方</option>
          <option value="openrouter">OpenRouter</option>
          <option value="custom">自定义第三方 API</option>
        </select>
      </label>
      {providerChoice === 'custom' && (
        <label>
          <span>
            服务商标识 <em className="required-mark">必填</em>
          </span>
          <input
            aria-label="服务商标识"
            required
            value={customProvider}
            onChange={(event) => onCustomProvider(event.target.value)}
            placeholder="例如 my-provider"
            aria-invalid={invalidProvider}
          />
          {invalidProvider && <small className="field-error">仅允许字母、数字、点、下划线和连字符</small>}
        </label>
      )}
      {thirdParty && (
        <>
          <label className="span-2">
            <span>
              API 根地址 <em className="required-mark">第三方必填</em>
            </span>
            <input
              aria-label="API 根地址"
              type="url"
              inputMode="url"
              required
              value={baseUrl}
              onChange={(event) => onBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              aria-invalid={invalidUrl || !baseUrl}
            />
            {invalidUrl && (
              <small className="field-error" role="alert">
                请输入完整的 http:// 或 https:// API 根地址
              </small>
            )}
          </label>
          <label>
            API 协议
            <select
              aria-label="API 协议"
              value={wireApi}
              onChange={(event) => onWireApi(event.target.value as WireApi)}
              disabled
            >
              <option value="responses">OpenAI 响应接口</option>
              <option value="chat" disabled>
                聊天补全接口（需本地代理）
              </option>
            </select>
          </label>
          <div className="endpoint-note">
            <Route size={14} />
            <span>当前 Codex 执行器仅支持响应接口；聊天接口需要独立的 cc-switch 本地代理，本版未启用。</span>
          </div>
        </>
      )}
    </>
  );
}

export function validBaseUrl(value: string) {
  const raw = value.trim();
  if (!raw || raw.length > 2048 || /[\r\n\0]/.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}
