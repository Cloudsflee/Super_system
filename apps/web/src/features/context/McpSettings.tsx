import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Ban, Cable, Check, Clipboard, KeyRound, LoaderCircle, PackageCheck, Plus,
  ShieldCheck, Trash2, X
} from 'lucide-react';
import { ApiError, apiV2, formatTime, mutateV2 } from '../../api';
import type { ExchangeGrant, ExchangeRequest, McpClient, McpTool } from './types';

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
      const message = caught instanceof Error ? caught.message : 'MCP settings failed';
      setError(message); notify(message, 'error');
    });
  }, [load, notify]);

  const projectClients = useMemo(() => clients.filter((client) => !projectId || client.project_allowlist.includes(projectId)), [clients, projectId]);
  const run = async (key: string, action: () => Promise<void>, message: string) => {
    setBusy(key); setError('');
    try { await action(); await load(); notify(message); }
    catch (caught) {
      const text = caught instanceof ApiError && caught.code === 'revision_conflict' ? 'Exchange revision changed. State refreshed.' : caught instanceof Error ? caught.message : 'MCP command failed';
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
    }, 'MCP client created');
  };

  const createExchange = () => run('exchange-create', async () => {
    await mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/exchange-requests`, {
      target_project_id: targetProjectId.trim(), ttl_seconds: ttl,
      scope: { project_ids: [projectId], tools: selectedTools, actions: ['read'], resources: ['context'] }
    }, 'POST', 0);
    setTargetProjectId('');
  }, 'Exchange request created');

  const approve = (request: ExchangeRequest, side: 'source' | 'target') => run(`${request.id}-${side}`, async () => {
    await mutateV2(`/api/v2/exchange-requests/${request.id}/approve`, { side }, 'POST', request.revision);
  }, `${side === 'source' ? 'Source' : 'Target'} approval recorded`);

  const toggleTool = (tool: string) => setSelectedTools((current) => current.includes(tool) ? current.filter((item) => item !== tool) : [...current, tool].sort());

  return <div className="mcp-settings-grid">
    {error && <div className="context-alert mcp-alert" role="alert"><Ban size={16} /><span>{error}</span><button className="icon-button" aria-label="Dismiss MCP error" title="Dismiss MCP error" onClick={() => setError('')}><X size={14} /></button></div>}
    <section className="panel mcp-client-panel"><div className="section-title"><div><h2>MCP clients</h2><span>{projectClients.length} scoped clients</span></div><Cable size={18} /></div>
      <form className="mcp-client-form" onSubmit={(event) => void create(event)}><label><span>Name</span><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} required /></label><label><span>Transport</span><select value={transport} onChange={(event) => setTransport(event.target.value)}><option value="stdio">stdio</option><option value="http">HTTP</option></select></label>{transport === 'http' && <label className="mcp-endpoint"><span>Loopback endpoint</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:4317/api/v2/mcp" required /></label>}<label><span>TTL seconds</span><input type="number" min={300} max={31622400} value={ttl} onChange={(event) => setTtl(Number(event.target.value))} /></label><button className="button primary" disabled={!projectId || !selectedTools.length || busy === 'create'}>{busy === 'create' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}Create client</button></form>
      {issuedToken && <div className="mcp-issued-token"><KeyRound size={17} /><div><strong>One-time token</strong><code>{issuedToken}</code></div><button className="icon-button" aria-label="Copy MCP token" title="Copy MCP token" onClick={() => { void navigator.clipboard?.writeText(issuedToken); notify('MCP token copied'); }}><Clipboard size={15} /></button><button className="icon-button" aria-label="Dismiss MCP token" title="Dismiss MCP token" onClick={() => setIssuedToken('')}><X size={15} /></button></div>}
      <div className="mcp-client-list">{projectClients.map((client) => <div key={client.id}><span><strong>{client.name}</strong><small>{client.transport} · {client.token_prefix || 'token issued'} · expires {formatTime(client.expires_at || undefined)} · r{client.revision}</small></span><span className={`status ${client.status === 'active' ? 'positive' : 'neutral'}`}><span />{client.status}</span><button className="icon-button" aria-label={`Revoke ${client.name}`} title="Revoke client" disabled={client.status !== 'active' || busy === client.id} onClick={() => void run(client.id, async () => { await mutateV2(`/api/v2/mcp/clients/${client.id}/revoke`, {}, 'POST', client.revision); }, 'MCP client revoked')}><Trash2 size={14} /></button></div>)}{!projectClients.length && <div className="list-empty">No MCP clients for this project</div>}</div>
    </section>

    <section className="panel mcp-tools-panel"><div className="section-title"><div><h2>Tool allowlist</h2><span>{selectedTools.length} of {tools.length} selected</span></div><ShieldCheck size={18} /></div><div className="mcp-tool-list">{tools.map((tool) => <label key={tool.name}><input type="checkbox" checked={selectedTools.includes(tool.name)} onChange={() => toggleTool(tool.name)} /><span><strong>{tool.name}</strong><small>{tool.description}</small></span></label>)}</div></section>

    <section className="panel mcp-grants-panel"><div className="section-title"><div><h2>Exchange requests</h2><span>{requests.length} requests</span></div><KeyRound size={18} /></div>
      <div className="exchange-request-form"><label><span>Target project ID</span><input value={targetProjectId} onChange={(event) => setTargetProjectId(event.target.value)} placeholder="project_target" /></label><button className="button" disabled={!projectId || !targetProjectId.trim() || targetProjectId.trim() === projectId || busy === 'exchange-create'} onClick={() => void createExchange()}>{busy === 'exchange-create' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}Request exchange</button></div>
      <div className="mcp-request-list">{requests.map((request) => <article key={request.id}><div><strong className="mono">{request.source_project_id} -&gt; {request.target_project_id}</strong><small>{request.scope.tools?.length || 0} tools · expires {formatTime(request.expires_at)} · r{request.revision}</small></div><span className={`status ${request.status === 'active' ? 'positive' : ['requested', 'partially_approved'].includes(request.status) ? 'working' : 'neutral'}`}><span />{request.status}</span><div className="exchange-actions">{!request.source_approver_actor_id && !['rejected', 'active'].includes(request.status) && <button className="button" disabled={busy.startsWith(request.id)} onClick={() => void approve(request, 'source')}><Check size={14} />Source</button>}{!request.target_approver_actor_id && !['rejected', 'active'].includes(request.status) && <button className="button" disabled={busy.startsWith(request.id)} onClick={() => void approve(request, 'target')}><Check size={14} />Target</button>}{!['rejected', 'active'].includes(request.status) && <button className="icon-button" title="Reject exchange" aria-label={`Reject exchange ${request.id}`} onClick={() => void run(`${request.id}-reject`, async () => { await mutateV2(`/api/v2/exchange-requests/${request.id}/reject`, {}, 'POST', request.revision); }, 'Exchange request rejected')}><X size={14} /></button>}</div></article>)}{!requests.length && <div className="list-empty">No Exchange requests</div>}</div>
    </section>

    <section className="panel mcp-grants-panel"><div className="section-title"><div><h2>Exchange grants</h2><span>{grants.length} grants</span></div><PackageCheck size={18} /></div><div className="mcp-request-list">{grants.map((grant) => <article key={grant.id}><div><strong className="mono">{grant.source_project_id} -&gt; {grant.target_project_id}</strong><small>{grant.scope.tools?.length || 0} tools · expires {formatTime(grant.expires_at)} · r{grant.revision}</small></div><span className={`status ${grant.status === 'active' ? 'positive' : 'neutral'}`}><span />{grant.status}</span><div className="exchange-actions">{grant.status === 'active' && <button className="button" disabled={busy === `${grant.id}-pack`} onClick={() => void run(`${grant.id}-pack`, async () => { await mutateV2(`/api/v2/exchange-grants/${grant.id}/context-packs`, { require_authoritative: false }, 'POST', 0); }, 'Grant-bound Context Pack sealed')}><PackageCheck size={14} />Seal pack</button>}{grant.status === 'active' && <button className="icon-button" title="Revoke grant" aria-label={`Revoke grant ${grant.id}`} onClick={() => void run(`${grant.id}-revoke`, async () => { await mutateV2(`/api/v2/exchange-grants/${grant.id}/revoke`, {}, 'POST', grant.revision); }, 'Exchange grant revoked')}><Trash2 size={14} /></button>}</div></article>)}{!grants.length && <div className="list-empty">No active Exchange grants</div>}</div></section>
  </div>;
}
