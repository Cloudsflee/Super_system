import { PlugZap, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CodexProfile, DeploymentStatus } from '../../api/types';
import { displayStatus } from '../../components/common/display-labels';
import { formatCodexTimeout } from '../setup/codex-timeout';

export function CodexProfileTable({
  profiles,
  deployment,
  onPropose
}: {
  profiles?: CodexProfile[];
  deployment?: DeploymentStatus;
  onPropose: (id: string) => void;
}) {
  return (
    <div className="profile-table">
      {profiles?.map((item) => {
        const hostDisabled = deployment?.mode === 'container' && item.kind === 'host';
        return (
          <div key={item.id}>
            <span>
              <PlugZap size={16} />
              <span>
                <strong>{item.name}</strong>
                <small>{profileSummary(item, hostDisabled)}</small>
              </span>
            </span>
            <i className={`status ${item.status}`}>{displayStatus(hostDisabled ? 'disabled' : item.status)}</i>
            <button
              className="button secondary"
              disabled={hostDisabled || item.is_active || item.status !== 'validated'}
              onClick={() => onPropose(item.id)}
            >
              {item.is_active && !hostDisabled ? <ShieldCheck size={15} /> : <RefreshCw size={15} />}
              {profileAction(item, hostDisabled)}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function profileSummary(item: CodexProfile, hostDisabled: boolean) {
  if (hostDisabled) return '主机配置在容器部署中不可用';
  return `${item.provider || 'openai'} · ${item.model || '默认模型'} · ${formatCodexTimeout(item.timeout_ms)}${
    item.base_url ? ` · ${item.base_url}` : ''
  }${item.wire_api ? ` · ${wireApiLabel(item.wire_api)}` : ''}`;
}

function profileAction(item: CodexProfile, hostDisabled: boolean) {
  if (hostDisabled) return '不可用';
  if (item.is_active) return '当前使用';
  return item.status === 'validated' ? '切换' : '待验证';
}

function wireApiLabel(value: string) {
  return value === 'responses' ? 'Responses API' : value === 'chat' ? '聊天补全 API' : '自定义协议';
}
