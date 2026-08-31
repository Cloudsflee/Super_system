import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Ban, Cable, Check, Clipboard, KeyRound, LoaderCircle, PackageCheck, Plus,
  ShieldCheck, Trash2, X
} from 'lucide-react';
import { ApiError, apiV2, formatTime, mutateV2 } from '../../api';
import type { ExchangeGrant, ExchangeRequest, McpClient, McpTool } from './types';
import { mcpToolDescriptionLabel, statusLabel } from '../../i18n';

export function McpSettings({ projectId, notify }: { projectId: string; notify: (text: string, tone?: 'ok' | 'error') => void }) {
  const [clients, setClients] = useState<McpClient[]>([]);
  const [requests, setRequests] = useState<ExchangeRequest[]>([]);
  const [grants, setGrants] = useState<ExchangeGrant[]>([]);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [name, setName] = useState('Local MCP');
  const [transport, setTransport] = useState('stdio');
  const [endpoint, setEndpoint] = useState('');
  const [ttl, setTtl] = useState(3600);
  const [targetProjectId, setTargetProjectId] = useState('');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [issuedToken, setIssuedToken] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const cleanApi = useCallback(async <T,>(path: string): Promise<T> => (await apiV2<T>(path)).data, []);

  const load = useCallback(async () => {
    const emptyExchange = { requests: [] as ExchangeRequest[], grants: [] as ExchangeGrant[] };
    const [clientList, toolList, exchange] = await Promise.all([
      cleanApi<{ clients: McpClient[] }>('/api/v2/mcp/clients'),
      cleanApi<{ tools: McpTool[] }>('/api/v2/mcp/tools'),
      projectId ? Promise.all([
        cleanApi<{ requests: ExchangeRequest[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/exchange-requests`),
        cleanApi<{ grants: ExchangeGrant[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/exchange-grants`)
      ]).then(([requestList, grantList]) => ({ requests: requestList.requests || [], grants: grantList.grants || [] })) : Promise.resolve(emptyExchange)
    ]);
    setClients(clientList.clients || []);
    setTools(toolList.tools || []);
    setRequests(exchange.requests);
    setGrants(exchange.grants);
    setSelectedTools((current) => current.length
      ? current.filter((item) => toolList.tools.some((tool) => tool.name === item))
      : toolList.tools.filter((tool) => ['project_get', 'context_map', 'context_search', 'context_read', 'operation_get', 'operation_events'].includes(tool.name)).map((tool) => tool.name));
  }, [cleanApi, projectId]);

  useEffect(() => {
    void load().catch((caught) => {
      const message = caught instanceof Error ? caught.message : 'MCP 设置加载失败';
      setError(message); notify(message, 'error');
    });
  }, [load, notify]);

  const projectClients = useMemo(() => clients.filter((client) => !projectId || client.project_allowlist.includes(projectId)), [clients, projectId]);
  const run = async (key: string, action: () => Promise<void>, message: string) => {
    setBusy(key); setError('');
    try { await action(); await load(); notify(message); }
    catch (caught) {
      const text = caught instanceof ApiError && caught.code === 'revision_conflict' ? '交换版本已变化，状态已刷新。' : caught instanceof Error ? caught.message : 'MCP 操作失败';
      setError(text); notify(text, 'error'); await load().catch(() => undefined);
    } finally { setBusy(''); }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId) return;
    await run('create', async () => {
      const response = await mutateV2<{ client: McpClient; token?: string }>('/api/v2/mcp/clients', {
        name, transport, endpoint, ttl_seconds: ttl,
        scope: { project_ids: [projectId], tools: selectedTools }
      }, 'POST', 0);
      setIssuedToken(response.data.token || '');
    }, 'MCP 客户端已创建');
  };

  const createExchange = () => run('exchange-create', async () => {
    await mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/exchange-requests`, {
      target_project_id: targetProjectId.trim(), ttl_seconds: ttl,
      scope: { project_ids: [projectId], tools: selectedTools, actions: ['read'], resources: ['context'] }
    }, 'POST', 0);
    setTargetProjectId('');
  }, '交换请求已创建');

  const approve = (request: ExchangeRequest, side: 'source' | 'target') => run(`${request.id}-${side}`, async () => {
    await mutateV2(`/api/v2/exchange-requests/${request.id}/approve`, { side }, 'POST', request.revision);
  }, `${side === 'source' ? '来源' : '目标'}审批已记录`);

  const toggleTool = (tool: string) => setSelectedTools((current) => current.includes(tool) ? current.filter((item) => item !== tool) : [...current, tool].sort());

  return <div className="mcp-settings-grid">
    {error && <div className="context-alert mcp-alert" role="alert"><Ban size={16} /><span>{error}</span><button className="icon-button" aria-label="关闭 MCP 错误" title="关闭错误" onClick={() => setError('')}><X size={14} /></button></div>}
    <section className="panel mcp-client-panel"><div className="section-title"><div><h2>MCP 客户端</h2><span>{projectClients.length} 个范围内客户端</span></div><Cable size={18} /></div>
      <form className="mcp-client-form" onSubmit={(event) => void create(event)}><label><span>名称</span><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} required /></label><label><span>传输方式</span><select value={transport} onChange={(event) => setTransport(event.target.value)}><option value="stdio">stdio</option><option value="http">HTTP</option></select></label>{transport === 'http' && <label className="mcp-endpoint"><span>回环地址</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:4317/api/v2/mcp" required /></label>}<label><span>TTL（秒）</span><input type="number" min={300} max={31622400} value={ttl} onChange={(event) => setTtl(Number(event.target.value))} /></label><button className="button primary" disabled={!projectId || !selectedTools.length || busy === 'create'}>{busy === 'create' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}创建客户端</button></form>
      {issuedToken && <div className="mcp-issued-token"><KeyRound size={17} /><div><strong>一次性令牌</strong><code>{issuedToken}</code></div><button className="icon-button" aria-label="复制 MCP 令牌" title="复制令牌" onClick={() => { void navigator.clipboard?.writeText(issuedToken); notify('MCP 令牌已复制'); }}><Clipboard size={15} /></button><button className="icon-button" aria-label="关闭 MCP 令牌" title="关闭令牌" onClick={() => setIssuedToken('')}><X size={15} /></button></div>}
      <div className="mcp-client-list">{projectClients.map((client) => <div key={client.id}><span><strong>{client.name}</strong><small>{client.transport} · {client.token_prefix || '已签发令牌'} · 到期 {formatTime(client.expires_at || undefined)} · r{client.revision}</small></span><span className={`status ${client.status === 'active' ? 'positive' : 'neutral'}`}><span />{statusLabel(client.status)}</span><button className="icon-button" aria-label={`撤销 ${client.name}`} title="撤销客户端" disabled={client.status !== 'active' || busy === client.id} onClick={() => void run(client.id, async () => { await mutateV2(`/api/v2/mcp/clients/${client.id}/revoke`, {}, 'POST', client.revision); }, 'MCP 客户端已撤销')}><Trash2 size={14} /></button></div>)}{!projectClients.length && <div className="list-empty">该项目暂无 MCP 客户端</div>}</div>
    </section>

    <section className="panel mcp-tools-panel"><div className="section-title"><div><h2>工具允许列表</h2><span>已选择 {selectedTools.length} / {tools.length}</span></div><ShieldCheck size={18} /></div><div className="mcp-tool-list">{tools.map((tool) => <label key={tool.name}><input type="checkbox" checked={selectedTools.includes(tool.name)} onChange={() => toggleTool(tool.name)} /><span><strong>{tool.name}</strong><small>{mcpToolDescriptionLabel(tool.name, tool.description)}</small></span></label>)}</div></section>

    <section className="panel mcp-grants-panel"><div className="section-title"><div><h2>交换请求</h2><span>{requests.length} 项请求</span></div><KeyRound size={18} /></div>
      <div className="exchange-request-form"><label><span>目标项目 ID</span><input value={targetProjectId} onChange={(event) => setTargetProjectId(event.target.value)} placeholder="project_target" /></label><button className="button" disabled={!projectId || !targetProjectId.trim() || targetProjectId.trim() === projectId || busy === 'exchange-create'} onClick={() => void createExchange()}>{busy === 'exchange-create' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}申请交换</button></div>
      <div className="mcp-request-list">{requests.map((request) => <article key={request.id}><div><strong className="mono">{request.source_project_id} -&gt; {request.target_project_id}</strong><small>{request.scope.tools?.length || 0} 个工具 · 到期 {formatTime(request.expires_at)} · r{request.revision}</small></div><span className={`status ${request.status === 'active' ? 'positive' : ['requested', 'partially_approved'].includes(request.status) ? 'working' : 'neutral'}`}><span />{statusLabel(request.status)}</span><div className="exchange-actions">{!request.source_approver_actor_id && !['rejected', 'active'].includes(request.status) && <button className="button" disabled={busy.startsWith(request.id)} onClick={() => void approve(request, 'source')}><Check size={14} />来源审批</button>}{!request.target_approver_actor_id && !['rejected', 'active'].includes(request.status) && <button className="button" disabled={busy.startsWith(request.id)} onClick={() => void approve(request, 'target')}><Check size={14} />目标审批</button>}{!['rejected', 'active'].includes(request.status) && <button className="icon-button" title="拒绝交换" aria-label={`拒绝交换 ${request.id}`} onClick={() => void run(`${request.id}-reject`, async () => { await mutateV2(`/api/v2/exchange-requests/${request.id}/reject`, {}, 'POST', request.revision); }, '交换请求已拒绝')}><X size={14} /></button>}</div></article>)}{!requests.length && <div className="list-empty">暂无交换请求</div>}</div>
    </section>

    <section className="panel mcp-grants-panel"><div className="section-title"><div><h2>交换授权</h2><span>{grants.length} 项授权</span></div><PackageCheck size={18} /></div><div className="mcp-request-list">{grants.map((grant) => <article key={grant.id}><div><strong className="mono">{grant.source_project_id} -&gt; {grant.target_project_id}</strong><small>{grant.scope.tools?.length || 0} 个工具 · 到期 {formatTime(grant.expires_at)} · r{grant.revision}</small></div><span className={`status ${grant.status === 'active' ? 'positive' : 'neutral'}`}><span />{statusLabel(grant.status)}</span><div className="exchange-actions">{grant.status === 'active' && <button className="button" disabled={busy === `${grant.id}-pack`} onClick={() => void run(`${grant.id}-pack`, async () => { await mutateV2(`/api/v2/exchange-grants/${grant.id}/context-packs`, { require_authoritative: false }, 'POST', 0); }, '授权上下文包已封存')}><PackageCheck size={14} />封存上下文包</button>}{grant.status === 'active' && <button className="icon-button" title="撤销授权" aria-label={`撤销授权 ${grant.id}`} onClick={() => void run(`${grant.id}-revoke`, async () => { await mutateV2(`/api/v2/exchange-grants/${grant.id}/revoke`, {}, 'POST', grant.revision); }, '交换授权已撤销')}><Trash2 size={14} /></button>}</div></article>)}{!grants.length && <div className="list-empty">暂无交换授权</div>}</div></section>
  </div>;
}
