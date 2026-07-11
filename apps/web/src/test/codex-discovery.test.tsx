import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexSetup } from '../features/setup/CodexSetup';
import { publicDeviceAuthSummary, summarizeDeviceAuthOutput } from '../features/setup/codex-device-auth';

describe('Codex local configuration discovery', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('auto-discovers, selects, confirms, and imports both local source types without exposing secrets', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/codex/discovery')) return response(discoveryFixture());
      if (url.endsWith('/codex/cc-switch/status')) return response({ status: 'synced', sources: [] });
      if (url.endsWith('/codex/discovery/import')) return response({ authenticated: true, profile: { id: 'imported', status: 'validated' }, source: { source_id: 'source', type: 'cc_switch', revision: 'revision-1' } }, 201);
      return response({});
    }));
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<CodexSetup state={state(false)} onChange={onChange} />);

    expect(await screen.findByRole('group', { name: 'Codex 配置来源' })).toBeInTheDocument();
    expect(calls.some((item) => item.url.endsWith('/codex/discovery'))).toBe(true);
    expect(await screen.findByText('Local CODEX_HOME')).toBeInTheDocument();
    expect(screen.getByText('本地登录可复用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '官方账户' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '官方账户' }));
    expect(screen.getByRole('button', { name: '启动 Device Login' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'cc-switch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本地 Codex' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '手动 API' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'cc-switch' }));
    expect(await screen.findByText('CC Switch Catalog')).toBeInTheDocument();
    expect(screen.getByText('https://relay.acme.test/...')).toBeInTheDocument();
    expect(screen.getByText('凭据已配置（内容隐藏）')).toBeInTheDocument();
    expect(screen.queryByText(/92x/)).not.toBeInTheDocument();
    expect(screen.queryByText('sk-live-never-render')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Acme Relay/ }));
    expect(screen.queryByLabelText('Discovery API Key')).not.toBeInTheDocument();
    const consent = screen.getByRole('checkbox', { name: /确认导入所选脱敏配置/ });
    const importButton = screen.getByRole('button', { name: '确认导入配置' });
    expect(importButton).toBeDisabled();
    fireEvent.click(consent);
    fireEvent.click(importButton);
    await waitFor(() => expect(importCalls(calls)).toHaveLength(1));
    expect(body(importCalls(calls)[0])).toEqual({ discovery_id: 'cc-acme', source_revision: 'revision-1', confirmed: true });

    fireEvent.click(screen.getByRole('button', { name: '本地 Codex' }));
    expect(await screen.findByText('Local CODEX_HOME')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Local Gateway/ }));
    fireEvent.change(screen.getByLabelText('Discovery API Key'), { target: { value: 'sk-explicit-import' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /确认导入所选脱敏配置/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认导入配置' }));
    await waitFor(() => expect(importCalls(calls)).toHaveLength(2));
    expect(body(importCalls(calls)[1])).toEqual({ discovery_id: 'home-local', source_revision: 'revision-2', confirmed: true, api_key: 'sk-explicit-import' });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('shows stale import errors and keeps refresh available', async () => {
    let discoveryReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/codex/discovery')) { discoveryReads += 1; return response(discoveryFixture()); }
      if (url.endsWith('/codex/cc-switch/status')) return response({ status: 'synced', sources: [] });
      if (url.endsWith('/codex/discovery/import')) return response({ error: 'discovery_source_stale' }, 409);
      return response({});
    }));
    render(<CodexSetup state={state()} onChange={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'cc-switch' }));
    fireEvent.click(await screen.findByRole('radio', { name: /Acme Relay/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /确认导入所选脱敏配置/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认导入配置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('discovery_source_stale');
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(discoveryReads).toBeGreaterThanOrEqual(2));
  });

  it('extracts only official Device Login URI, code, and status-safe fields', () => {
    const summary = summarizeDeviceAuthOutput('raw-secret=never-render https://evil.test/code https://auth.openai.com/codex/device?token=hidden Enter code: ABCD-EFGH');
    expect(summary).toEqual({ verification_uri: 'https://auth.openai.com/codex/device', user_code: 'ABCD-EFGH' });
    expect(JSON.stringify(summary)).not.toContain('raw-secret');
    expect(JSON.stringify(summary)).not.toContain('token=hidden');
    expect(publicDeviceAuthSummary({ status: 'running', verification_uri: 'https://auth.openai.com/codex/device?private=drop', user_code: 'WXYZ-1234', secret: 'never' })).toEqual({ status: 'running', verification_uri: 'https://auth.openai.com/codex/device', user_code: 'WXYZ-1234' });
    expect(publicDeviceAuthSummary({ status: 'cancelled', verification_uri: 'https://evil.test/device', user_code: 'not-a-code' })).toEqual({ status: 'cancelled' });
  });
});

function state(dockerReady = true) { return { ready: false, status: 'configuration_required', checks: { docker_ready: dockerReady, authenticated: false, profile_valid: false, probe_ok: false } }; }
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function importCalls(calls: Array<{ url: string; init?: RequestInit }>) { return calls.filter((item) => item.url.endsWith('/codex/discovery/import')); }
function body(call: { init?: RequestInit } | undefined) { return JSON.parse(String(call?.init?.body)); }
function discoveryFixture() {
  return { updated_at: '2026-07-10T00:00:00.000Z', sources: [
    { source_id: 'cc-switch', type: 'cc_switch', display_name: 'CC Switch Catalog', status: 'ready', path_hint: '%APPDATA%/cc-switch', revision: 'revision-1', providers: [{ discovery_id: 'cc-acme', name: 'Acme Relay', provider: 'acme', provider_name: 'Acme', base_url: 'https://relay.acme.test/v1', model: 'acme/codex', wire_api: 'responses', has_credential: true, credential_hint: 'stored', source_revision: 'revision-1' }] },
    { source_id: 'codex-home', type: 'codex_home', display_name: 'Local CODEX_HOME', status: 'ready', path_hint: '~/.codex/config.toml', revision: 'revision-2', providers: [{ discovery_id: 'home-official', name: 'Local OpenAI Login', provider: 'openai', base_url: null, model: 'gpt-5.1-codex', wire_api: 'responses', has_credential: true, credential_kind: 'oauth_bundle', source_revision: 'revision-2' }, { discovery_id: 'home-local', name: 'Local Gateway', provider: 'local', base_url: 'http://127.0.0.1:8080/v1', model: 'local/codex', wire_api: 'responses', has_credential: false, credential_hint: null, source_revision: 'revision-2' }] }
  ] };
}
