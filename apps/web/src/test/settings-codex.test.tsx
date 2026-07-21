import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../features/settings/SettingsPage';

describe('Codex settings', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('offers local Codex by default and cc-switch as an optional import source', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/setup/status')) return response({ complete: true, mode: 'byo', can_complete: true, steps: { github: { ready: true, status: 'ready' }, codex: { ready: true, status: 'ready' } }, reasons: [] });
      if (url.endsWith('/github/status')) return response({ connected: true, login: 'owner' });
      if (url.endsWith('/codex/profiles') && (!init?.method || init.method === 'GET')) return response([{ id: 'profile-current', name: 'Current Profile', provider: 'openai', model: 'gpt-5.1-codex', timeout_ms: 1_800_000, status: 'validated', is_active: true }]);
      if (url.endsWith('/codex/cc-switch/status')) return response({ status: 'synced', sources: [{ name: 'cc-switch Desktop', repo: 'https://github.com/farion1231/cc-switch.git', status: 'synced' }, { name: 'cc-switch CLI', repo: 'https://github.com/SaladDay/cc-switch-cli.git', status: 'synced' }] });
      if (url.endsWith('/codex/discovery')) return response(discoveryFixture());
      if (url.endsWith('/codex/discovery/import')) return response({ authenticated: true, reconfiguration_started: true, profile: { id: 'imported', status: 'validated' }, source: { source_id: 'cc-switch', type: 'cc_switch', revision: 'revision-1' } }, 201);
      if (url.endsWith('/codex/profiles')) return response({ id: 'profile-acme', status: 'validated' }, 201);
      return response({});
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><SettingsPage /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByText(/30 分钟超时/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '导入本地配置' }));
    expect(await screen.findByText('Local CODEX_HOME')).toBeInTheDocument();
    expect(screen.getByText('本地登录可复用')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'cc-switch' }));
    expect(await screen.findByText('CC Switch Catalog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Acme Relay/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /重新进入 Setup/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认导入配置' }));
    await waitFor(() => expect(calls.some((item) => item.url.endsWith('/codex/discovery/import'))).toBe(true));
    const discoveryImport = calls.find((item) => item.url.endsWith('/codex/discovery/import'));
    expect(JSON.parse(String(discoveryImport?.init?.body))).toEqual({ discovery_id: 'provider-1', source_revision: 'revision-1', confirmed: true, reconfigure: true });
    await waitFor(() => expect(screen.queryByLabelText('cc-switch 配置发现')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '手动新增 Profile' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'custom' } });
    expect(screen.getByRole('textbox', { name: 'API Base URL' })).toBeRequired();
    expect(screen.getByRole('button', { name: '保存 Profile' })).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Profile 名称' }), { target: { value: 'Acme Gateway' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider ID' }), { target: { value: 'acme' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'API Base URL' }), { target: { value: 'https://gateway.acme.test/v1' } });
    expect(screen.getByRole('spinbutton', { name: 'Profile 任务超时（分钟）' })).toHaveValue(30);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Profile 任务超时（分钟）' }), { target: { value: '12' } });
    expect(screen.getByRole('combobox', { name: 'API 协议' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存 Profile' }));

    await waitFor(() => expect(calls.some((item) => item.url.endsWith('/codex/profiles') && item.init?.method === 'POST')).toBe(true));
    const request = calls.find((item) => item.url.endsWith('/codex/profiles') && item.init?.method === 'POST');
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({ provider: 'acme', base_url: 'https://gateway.acme.test/v1', wire_api: 'responses', timeout_ms: 720_000 });
  });
});

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function discoveryFixture() {
  return { sources: [
    { source_id: 'codex-home', type: 'codex_home', display_name: 'Local CODEX_HOME', status: 'ready', path_hint: '~/.codex/config.toml', revision: 'revision-home', providers: [{ discovery_id: 'provider-home', name: 'Local OpenAI Login', provider: 'openai', base_url: null, model: 'gpt-5.1-codex', wire_api: 'responses', has_credential: true, credential_kind: 'oauth_bundle', source_revision: 'revision-home' }] },
    { source_id: 'cc-switch', type: 'cc_switch', display_name: 'CC Switch Catalog', status: 'ready', path_hint: '%APPDATA%/cc-switch', revision: 'revision-1', providers: [{ discovery_id: 'provider-1', name: 'Acme Relay', provider: 'acme', base_url: 'https://relay.acme.test/v1', model: 'acme/codex', wire_api: 'responses', has_credential: true, credential_hint: 'stored', source_revision: 'revision-1' }] }
  ] };
}
