import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Cable, Check, Clipboard, KeyRound, LoaderCircle, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { api, formatTime, mutate } from '../../api';
import type { McpClient, McpScopeRequest, McpTool } from './types';

export function McpSettings({ projectId, notify }: { projectId: string; notify: (text: string, tone?: 'ok' | 'error') => void }) {
  const [clients, setClients] = useState<McpClient[]>([]);
  const [requests, setRequests] = useState<McpScopeRequest[]>([]);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [name, setName] = useState('Local MCP');
  const [transport, setTransport] = useState('stdio');
  const [endpoint, setEndpoint] = useState('');
  const [ttl, setTtl] = useState(3600);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [issuedToken, setIssuedToken] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const [clientRows, toolList, scopeRows] = await Promise.all([
      api<McpClient[]>('/api/v1/mcp/clients'),
      api<{ tools: McpTool[] }>('/api/v1/mcp/tools'),
      api<McpScopeRequest[]>(`/api/v1/mcp/scopes${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`)
    ]);
    setClients(clientRows); setTools(toolList.tools); setRequests(scopeRows);
    setSelectedTools((current) => current.length ? current.filter((item) => toolList.tools.some((tool) => tool.name === item)) : toolList.tools.filter((tool) => ['project.get', 'context.map', 'context.search', 'context.read', 'operation.get', 'operation.events'].includes(tool.name)).map((tool) => tool.name));
  }, [projectId]);
  useEffect(() => { void load().catch((error) => notify(error instanceof Error ? error.message : 'MCP settings failed', 'error')); }, [load, notify]);
  const projectClients = useMemo(() => clients.filter((client) => !projectId || client.project_allowlist.includes(projectId)), [clients, projectId]);

  const run = async (key: string, action: () => Promise<void>, message: string) => {
    setBusy(key);
    try { await action(); await load(); notify(message); }
    catch (error) { notify(error instanceof Error ? error.message : 'MCP command failed', 'error'); }
    finally { setBusy(''); }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId) return;
    await run('create', async () => {
      const client = await mutate<McpClient>('/api/v1/mcp/clients', { name, transport, endpoint, ttl_seconds: ttl, scope: { project_ids: [projectId], tools: selectedTools } });
      setIssuedToken(client.token || '');
    }, 'MCP client created');
  };
  const requestScope = () => projectId && run('request', async () => {
    await mutate('/api/v1/mcp/scopes/requests', { project_id: projectId, ttl_seconds: ttl, transport, scope: { project_ids: [projectId], tools: selectedTools } });
  }, 'MCP scope requested');
  const toggleTool = (tool: string) => setSelectedTools((current) => current.includes(tool) ? current.filter((item) => item !== tool) : [...current, tool].sort());

  return <div className="mcp-settings-grid">
    <section className="panel mcp-client-panel"><div className="section-title"><div><h2>MCP clients</h2><span>{projectClients.length} scoped clients</span></div><Cable size={18} /></div>
      <form className="mcp-client-form" onSubmit={(event) => void create(event)}><label><span>Name</span><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} required /></label><label><span>Transport</span><select value={transport} onChange={(event) => setTransport(event.target.value)}><option value="stdio">stdio</option><option value="http">HTTP</option></select></label>{transport === 'http' && <label className="mcp-endpoint"><span>Loopback endpoint</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:4317/api/v1/mcp" required /></label>}<label><span>TTL seconds</span><input type="number" min={300} max={31622400} value={ttl} onChange={(event) => setTtl(Number(event.target.value))} /></label><button className="button primary" disabled={!projectId || busy === 'create'}>{busy === 'create' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}Create client</button></form>
      {issuedToken && <div className="mcp-issued-token"><KeyRound size={17} /><div><strong>One-time token</strong><code>{issuedToken}</code></div><button className="icon-button" aria-label="Copy MCP token" title="Copy MCP token" onClick={() => { void navigator.clipboard?.writeText(issuedToken); notify('MCP token copied'); }}><Clipboard size={15} /></button><button className="icon-button" aria-label="Dismiss MCP token" title="Dismiss MCP token" onClick={() => setIssuedToken('')}><X size={15} /></button></div>}
      <div className="mcp-client-list">{projectClients.map((client) => <div key={client.id}><span><strong>{client.name}</strong><small>{client.transport} · {client.token_prefix || 'token issued'} · r{client.revision}</small></span><span className={`status ${client.status === 'available' ? 'positive' : 'neutral'}`}><span />{client.status}</span><button className="icon-button" aria-label={`Revoke ${client.name}`} title="Revoke client" disabled={client.status === 'revoked' || busy === client.id} onClick={() => void run(client.id, async () => { await mutate(`/api/v1/mcp/clients/${client.id}/revoke`, { expected_revision: client.revision }); }, 'MCP client revoked')}><Trash2 size={14} /></button></div>)}{!projectClients.length && <div className="list-empty">No MCP clients for this project</div>}</div>
    </section>
    <section className="panel mcp-tools-panel"><div className="section-title"><div><h2>Tool scope</h2><span>{selectedTools.length} of {tools.length} selected</span></div><ShieldCheck size={18} /></div><div className="mcp-tool-list">{tools.map((tool) => <label key={tool.name}><input type="checkbox" checked={selectedTools.includes(tool.name)} onChange={() => toggleTool(tool.name)} /><span><strong>{tool.name}</strong><small>{tool.description}</small></span></label>)}</div><button className="button" disabled={!projectId || busy === 'request'} onClick={() => void requestScope()}>{busy === 'request' ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}Request scope</button></section>
    <section className="panel mcp-grants-panel"><div className="section-title"><div><h2>Scope requests</h2><span>{requests.length} requests</span></div><KeyRound size={18} /></div><div className="mcp-request-list">{requests.map((request) => <article key={request.id}><div><strong className="mono">{request.id.slice(-12)}</strong><small>{request.scope.tools?.length || 0} tools · expires {formatTime(request.expires_at)} · r{request.revision}</small></div><span className={`status ${request.status === 'granted' ? 'positive' : request.status === 'pending' ? 'working' : 'neutral'}`}><span />{request.status}</span>{request.status === 'pending' && <button className="button" disabled={busy === request.id} onClick={() => void run(request.id, async () => { const grant = await mutate<{ token?: string }>(`/api/v1/mcp/scopes/requests/${request.id}/grant`, { expected_revision: request.revision, ttl_seconds: ttl }); setIssuedToken(grant.token || ''); }, 'MCP scope granted')}><Check size={14} />Grant</button>}{request.grants.map((grant) => <div className="mcp-grant" key={grant.id}><span>{grant.revoked_at ? 'revoked' : `active · ${grant.token_prefix || 'token'}`}</span>{!grant.revoked_at && <button className="icon-button" title="Revoke grant" aria-label="Revoke grant" onClick={() => void run(grant.id, async () => { await mutate(`/api/v1/mcp/scopes/grants/${grant.id}/revoke`, { expected_revision: grant.revision }); }, 'MCP grant revoked')}><Trash2 size={14} /></button>}</div>)}</article>)}{!requests.length && <div className="list-empty">No scope requests</div>}</div></section>
  </div>;
}
