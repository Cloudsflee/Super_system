import { Copy, Network, Plus, Trash2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, json } from '../../api/client';
import type { McpClientCreated, McpClientList } from '../../api/types';
import { displayStatus, mcpScopeLabel, roleLabel } from '../../components/common/display-labels';
import { useUi } from '../../state/ui';

const DEFAULT_MCP_SCOPES = [
  'system:read',
  'project:read',
  'project:write',
  'workflow:read',
  'workflow:write',
  'assist:read',
  'assist:write',
  'runs:read',
  'runs:write',
  'files:read',
  'files:write',
  'terminal:read',
  'terminal:write',
  'terminal:execute',
  'git:read',
  'git:write',
  'github:read',
  'assets:read',
  'assets:write',
  'governance:read',
  'governance:write',
  'approval:read',
  'setup:read'
];

export function McpSettingsBand({
  data,
  projects,
  teamGateway
}: {
  data?: McpClientList;
  projects?: Array<{ id: string; title: string }>;
  teamGateway: boolean;
}) {
  const controller = useMcpSettings({ data, projects, teamGateway });
  const { visibleMcpClients, mcpAdding, setMcpAdding, createdMcp } = controller;
  return (
    <section className="settings-band mcp-settings-band">
      <header>
        <Network size={19} />
        <div>
          <h2>MCP 客户端</h2>
          <p>可流式 HTTP · stdio 桥接 · 项目级隔离</p>
        </div>
        <span className={`status ${visibleMcpClients.some((item) => item.status === 'active') ? 'ready' : 'pending'}`}>
          {visibleMcpClients.filter((item) => item.status === 'active').length} 个已启用
        </span>
      </header>
      <div className="settings-actions">
        <button className="button secondary" onClick={() => setMcpAdding((value) => !value)}>
          <Plus size={15} />
          创建客户端
        </button>
      </div>
      {mcpAdding && <McpClientForm controller={controller} />}
      {createdMcp && <McpCredential controller={controller} />}
      <McpClientTable controller={controller} />
    </section>
  );
}

function McpClientForm({ controller }: { controller: ReturnType<typeof useMcpSettings> }) {
  const {
    mcpSubjects,
    selectedMcpSubject,
    projects,
    teamGateway,
    mcpName,
    setMcpName,
    setMcpSubject,
    mcpScopes,
    mcpProjects,
    setMcpProjects,
    mcpExpires,
    setMcpExpires,
    mcpExpiryDays,
    setMcpExpiryDays,
    mcpConcurrency,
    setMcpConcurrency,
    mcpRate,
    setMcpRate,
    toggleMcpScope,
    toggleMcpProject,
    createMcp
  } = controller;
  return (
    <div className="mcp-client-form">
      <div className="mcp-form-grid">
        <label>
          名称
          <input
            aria-label="MCP 客户端名称"
            value={mcpName}
            maxLength={120}
            onChange={(event) => setMcpName(event.target.value)}
          />
        </label>
        <label>
          绑定用户
          <select
            aria-label="MCP 客户端绑定用户"
            value={selectedMcpSubject}
            onChange={(event) => setMcpSubject(event.target.value)}
          >
            {mcpSubjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.display_name} · {roleLabel(subject.role)}
              </option>
            ))}
          </select>
        </label>
        <label>
          并发上限
          <input
            aria-label="MCP 客户端并发上限"
            type="number"
            min={1}
            max={32}
            value={mcpConcurrency}
            onChange={(event) => setMcpConcurrency(Number(event.target.value))}
          />
        </label>
        <label>
          每分钟请求
          <input
            aria-label="MCP 客户端每分钟请求"
            type="number"
            min={1}
            max={6000}
            value={mcpRate}
            onChange={(event) => setMcpRate(Number(event.target.value))}
          />
        </label>
        <label className="mcp-expiry-toggle">
          <input type="checkbox" checked={mcpExpires} onChange={(event) => setMcpExpires(event.target.checked)} />
          设置到期
        </label>
        {mcpExpires && (
          <label>
            有效天数
            <input
              aria-label="MCP 客户端有效天数"
              type="number"
              min={1}
              max={366}
              value={mcpExpiryDays}
              onChange={(event) => setMcpExpiryDays(Number(event.target.value))}
            />
          </label>
        )}
      </div>
      <fieldset>
        <legend>权限范围</legend>
        <div className="mcp-choice-grid">
          {controller.availableScopes.map((scope) => (
            <label key={scope} title={scope}>
              <input type="checkbox" checked={mcpScopes.includes(scope)} onChange={() => toggleMcpScope(scope)} />
              <span>{mcpScopeLabel(scope)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>项目</legend>
        <div className="mcp-choice-grid project-choices">
          {!teamGateway && (
            <label>
              <input type="checkbox" checked={!mcpProjects.length} onChange={() => setMcpProjects([])} />
              <span>全部项目</span>
            </label>
          )}
          {projects.map((project) => (
            <label key={project.id}>
              <input
                type="checkbox"
                checked={mcpProjects.includes(project.id)}
                onChange={() => toggleMcpProject(project.id)}
              />
              <span>{project.title}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="settings-form-actions">
        <button
          className="button primary"
          disabled={
            !mcpName.trim() ||
            !mcpScopes.length ||
            (teamGateway && (!selectedMcpSubject || !mcpProjects.length)) ||
            mcpConcurrency < 1 ||
            mcpConcurrency > 32 ||
            mcpRate < 1 ||
            mcpRate > 6000
          }
          onClick={() => createMcp()}
        >
          <Plus size={15} />
          创建
        </button>
      </div>
    </div>
  );
}

function McpCredential({ controller }: { controller: ReturnType<typeof useMcpSettings> }) {
  const { createdMcp, setCreatedMcp, snippetMode, setSnippetMode, copyMcp } = controller;
  if (!createdMcp) return null;
  return (
    <div className="mcp-credential">
      <header>
        <div>
          <strong>一次性凭据</strong>
          <small>{createdMcp.client.name}</small>
        </div>
        <button
          className="icon-button"
          data-tooltip="关闭凭据"
          aria-label="关闭凭据"
          onClick={() => setCreatedMcp(null)}
        >
          <X size={16} />
        </button>
      </header>
      <div className="mcp-token-line">
        <code>{createdMcp.token}</code>
        <button
          className="icon-button"
          data-tooltip="复制令牌"
          aria-label="复制令牌"
          onClick={() => copyMcp(createdMcp.token)}
        >
          <Copy size={15} />
        </button>
      </div>
      <div className="segmented compact" role="group" aria-label="MCP 配置格式">
        <button className={snippetMode === 'codex' ? 'active' : ''} onClick={() => setSnippetMode('codex')}>
          Codex
        </button>
        <button className={snippetMode === 'stdio' ? 'active' : ''} onClick={() => setSnippetMode('stdio')}>
          stdio
        </button>
      </div>
      <div className="mcp-snippet">
        <pre>
          {snippetMode === 'codex'
            ? `$env:AIWS_MCP_TOKEN=${JSON.stringify(createdMcp.token)}\n${createdMcp.configuration.codex_toml}`
            : JSON.stringify(createdMcp.configuration.stdio_json, null, 2)}
        </pre>
        <button
          className="icon-button"
          data-tooltip="复制配置"
          aria-label="复制配置"
          onClick={() =>
            copyMcp(
              snippetMode === 'codex'
                ? `$env:AIWS_MCP_TOKEN=${JSON.stringify(createdMcp.token)}\n${createdMcp.configuration.codex_toml}`
                : JSON.stringify(createdMcp.configuration.stdio_json, null, 2)
            )
          }
        >
          <Copy size={15} />
        </button>
      </div>
    </div>
  );
}

function McpClientTable({ controller }: { controller: ReturnType<typeof useMcpSettings> }) {
  const { visibleMcpClients, mcpSubjects, revokeMcp } = controller;
  return (
    <div className="mcp-client-table">
      {visibleMcpClients.map((item) => (
        <div key={item.id}>
          <span>
            <Network size={16} />
            <span>
              <strong>{item.name}</strong>
              <small>
                {item.token_prefix}… · {item.scopes.length} 项权限 ·{' '}
                {item.project_allowlist.length ? `${item.project_allowlist.length} 个项目` : '全部项目'} ·{' '}
                {mcpSubjects.find((subject) => subject.id === item.subject_user_id)?.display_name || '服务账户'}
              </small>
            </span>
          </span>
          <span>
            <i className={`status ${item.status}`}>{displayStatus(item.status)}</i>
            <small>{item.expires_at ? new Date(item.expires_at).toLocaleDateString() : '永不过期'}</small>
          </span>
          <span>{item.usage_count} 次调用</span>
          <button
            className="icon-button danger"
            data-tooltip="撤销客户端"
            aria-label={`撤销 ${item.name}`}
            disabled={item.status !== 'active'}
            onClick={() => revokeMcp(item.id, item.name)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

function useMcpSettings({
  data,
  projects,
  teamGateway
}: {
  data?: McpClientList;
  projects?: Array<{ id: string; title: string }>;
  teamGateway: boolean;
}) {
  const [mcpAdding, setMcpAdding] = useState(false);
  const [mcpName, setMcpName] = useState('');
  const [mcpSubject, setMcpSubject] = useState('');
  const [mcpScopes, setMcpScopes] = useState<string[]>(DEFAULT_MCP_SCOPES);
  const [mcpProjects, setMcpProjects] = useState<string[]>([]);
  const [mcpExpires, setMcpExpires] = useState(true);
  const [mcpExpiryDays, setMcpExpiryDays] = useState(30);
  const [mcpConcurrency, setMcpConcurrency] = useState(4);
  const [mcpRate, setMcpRate] = useState(120);
  const [createdMcp, setCreatedMcp] = useState<McpClientCreated | null>(null);
  const [snippetMode, setSnippetMode] = useState<'codex' | 'stdio'>('codex');
  const client = useQueryClient();
  const toast = useUi((state) => state.toast);
  const visibleMcpClients = data?.clients || [];
  const mcpSubjects = data?.available_subjects || [];
  const availableScopes = data?.available_scopes || DEFAULT_MCP_SCOPES;
  const selectedMcpSubject = mcpSubject || mcpSubjects[0]?.id || '';

  function toggleMcpScope(scope: string) {
    setMcpScopes((current) =>
      current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]
    );
  }
  function toggleMcpProject(projectId: string) {
    setMcpProjects((current) =>
      current.includes(projectId) ? current.filter((item) => item !== projectId) : [...current, projectId]
    );
  }
  async function createMcp() {
    if (!mcpName.trim() || !mcpScopes.length || (teamGateway && (!selectedMcpSubject || !mcpProjects.length))) return;
    try {
      const result = await api<McpClientCreated>(
        '/mcp/clients',
        json(
          'POST',
          {
            name: mcpName.trim(),
            subject_user_id: selectedMcpSubject || undefined,
            scopes: mcpScopes,
            project_allowlist: mcpProjects,
            ...(mcpExpires
              ? { expires_at: new Date(Date.now() + mcpExpiryDays * 24 * 60 * 60 * 1000).toISOString() }
              : {}),
            concurrent_limit: mcpConcurrency,
            rate_limit_per_minute: mcpRate
          },
          '创建 MCP 客户端'
        )
      );
      setCreatedMcp(result);
      setMcpAdding(false);
      setMcpName('');
      await client.invalidateQueries({ queryKey: ['mcp-clients'] });
      toast('MCP 客户端已创建');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }
  async function revokeMcp(id: string, name: string) {
    if (!window.confirm(`确认撤销 ${name}？`)) return;
    try {
      await api(`/mcp/clients/${id}`, json('DELETE', undefined, '撤销 MCP 客户端'));
      await client.invalidateQueries({ queryKey: ['mcp-clients'] });
      toast('MCP 客户端已撤销');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }
  async function copyMcp(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast('已复制');
    } catch {
      toast('复制失败', 'error');
    }
  }
  return {
    visibleMcpClients,
    mcpSubjects,
    availableScopes,
    selectedMcpSubject,
    projects: projects || [],
    teamGateway,
    mcpAdding,
    setMcpAdding,
    mcpName,
    setMcpName,
    setMcpSubject,
    mcpScopes,
    mcpProjects,
    setMcpProjects,
    mcpExpires,
    setMcpExpires,
    mcpExpiryDays,
    setMcpExpiryDays,
    mcpConcurrency,
    setMcpConcurrency,
    mcpRate,
    setMcpRate,
    createdMcp,
    setCreatedMcp,
    snippetMode,
    setSnippetMode,
    toggleMcpScope,
    toggleMcpProject,
    createMcp,
    revokeMcp,
    copyMcp
  };
}
