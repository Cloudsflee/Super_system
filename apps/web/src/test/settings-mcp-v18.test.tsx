import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../features/settings/SettingsPage';

describe('V1.8 MCP client settings', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('creates a project-scoped client, reveals its token once, switches snippets, and revokes it', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/setup/status')) return response({ complete: true, mode: 'byo', steps: { github: { ready: true, status: 'ready' }, codex: { ready: true, status: 'ready' } }, reasons: [] });
      if (url.endsWith('/system/deployment')) return response({ mode: 'host', local_only: true, collaboration: { mode: 'local', mcp_gateway: false, public_endpoint_configured: false }, storage: { ready: true }, docker: { ready: true }, imports: { codex_home: true, cc_switch: true, projects_root: true, project_path_mode: 'managed' } });
      if (url.endsWith('/github/status')) return response({ connected: false });
      if (url.endsWith('/codex/profiles')) return response([]);
      if (url.endsWith('/codex/status')) return response({ authenticated: false });
      if (url.endsWith('/projects')) return response([{ id: 'project-1', title: 'Project One', status: 'active', onboarding_state: 'confirmed', managed_workspace_state: 'ready' }]);
      if (url.endsWith('/mcp/clients') && method === 'GET') return response({ clients: [existingClient()], available_scopes: scopes(), available_subjects: subjects() });
      if (url.endsWith('/mcp/clients') && method === 'POST') return response(createdClient(), 201);
      if (url.endsWith('/mcp/clients/mcp-existing') && method === 'DELETE') return response({ client: { ...existingClient(), status: 'revoked' } });
      return response({});
    }));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><SettingsPage /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText('Existing Client')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '创建 Client' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'MCP Client 名称' }), { target: { value: 'Project Operator' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Project One' }));
    expect(screen.getByRole('checkbox', { name: 'approval:decide' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'destructive:execute' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(calls.some((item) => item.url.endsWith('/mcp/clients') && item.method === 'POST')).toBe(true));
    const request = calls.find((item) => item.url.endsWith('/mcp/clients') && item.method === 'POST');
    expect(request?.body?.project_allowlist).toEqual(['project-1']);
    expect(request?.body?.subject_user_id).toBe('usr-owner');
    expect(request?.body?.scopes).toContain('project:write');
    expect(request?.body?.scopes).not.toContain('approval:decide');
    expect(request?.body).toMatchObject({ concurrent_limit: 4, rate_limit_per_minute: 120 });
    expect(await screen.findByText('一次性凭据')).toBeInTheDocument();
    expect(screen.getByText('aiws_mcp_once_only_fixture_token_12345678901234567890')).toBeInTheDocument();
    expect(screen.getByText(/bearer_token_env_var = "AIWS_MCP_TOKEN"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'stdio' }));
    expect(screen.getByText(/"command": "corepack"/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '撤销 Existing Client' }));
    await waitFor(() => expect(calls.some((item) => item.url.endsWith('/mcp/clients/mcp-existing') && item.method === 'DELETE')).toBe(true));
  });

  it('requires a user and project scope when the team gateway is active', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method || 'GET', body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/setup/status')) return response({ complete: true, mode: 'byo', steps: { github: { ready: true }, codex: { ready: true } }, reasons: [] });
      if (url.endsWith('/system/deployment')) return response({ mode: 'container', local_only: false, collaboration: { mode: 'gateway', mcp_gateway: true, public_endpoint_configured: true }, storage: { ready: true }, docker: { ready: true }, imports: {} });
      if (url.endsWith('/projects')) return response([{ id: 'project-1', title: 'Project One' }]);
      if (url.endsWith('/mcp/clients') && method === 'GET') return response({ clients: [], available_scopes: scopes(), available_subjects: [{ id: 'usr-member', display_name: 'Team Member', role: 'member' }] });
      if (url.endsWith('/mcp/clients') && method === 'POST') return response(createdClient(), 201);
      if (url.endsWith('/github/status')) return response({ connected: false });
      if (url.endsWith('/codex/profiles')) return response([]);
      if (url.endsWith('/codex/status')) return response({ authenticated: false });
      return response({});
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><SettingsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('team gateway');
    fireEvent.click(screen.getByRole('button', { name: '创建 Client' }));
    expect(screen.queryByRole('checkbox', { name: 'All projects' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'MCP Client 名称' }), { target: { value: 'Member Codex' } });
    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Project One' }));
    expect(screen.getByRole('button', { name: '创建' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(calls.some((item) => item.method === 'POST' && item.url.endsWith('/mcp/clients'))).toBe(true));
    const request = calls.find((item) => item.method === 'POST' && item.url.endsWith('/mcp/clients'));
    expect(request?.body).toMatchObject({ subject_user_id: 'usr-member', project_allowlist: ['project-1'] });
  });
});

function existingClient() {
  return { id: 'mcp-existing', name: 'Existing Client', kind: 'external', token_prefix: 'aiws_mcp_exist', scopes: ['system:read'], project_allowlist: [], expires_at: null, status: 'active', concurrent_limit: 4, rate_limit_per_minute: 120, created_by: 'owner', created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), last_used_at: null, revoked_at: null, usage_count: 3 };
}
function createdClient() {
  const token = 'aiws_mcp_once_only_fixture_token_12345678901234567890';
  return { client: { ...existingClient(), id: 'mcp-created', name: 'Project Operator', token_prefix: token.slice(0, 16), project_allowlist: ['project-1'], usage_count: 0 }, token, token_visible_once: true, configuration: { streamable_http: { url: 'http://127.0.0.1:4317/api/mcp', headers: { Authorization: `Bearer ${token}` } }, codex_toml: '[mcp_servers.aiws-built-in]\nurl = "http://127.0.0.1:4317/api/mcp"\nbearer_token_env_var = "AIWS_MCP_TOKEN"\n', stdio_json: { command: 'corepack', args: ['pnpm', 'mcp:stdio'], env: { AIWS_MCP_URL: 'http://127.0.0.1:4317/api/mcp', AIWS_MCP_TOKEN: token } } } };
}
function scopes() {
  return ['system:read', 'project:read', 'project:write', 'workflow:read', 'workflow:write', 'assist:read', 'assist:write', 'runs:read', 'runs:write', 'files:read', 'files:write', 'terminal:read', 'terminal:write', 'terminal:execute', 'git:read', 'git:write', 'github:read', 'github:write', 'assets:read', 'assets:write', 'governance:read', 'governance:write', 'approval:read', 'approval:decide', 'setup:read', 'setup:admin', 'mcp:admin', 'destructive:execute'];
}
function subjects() { return [{ id: 'usr-owner', display_name: 'Local Owner', role: 'owner' }]; }
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
