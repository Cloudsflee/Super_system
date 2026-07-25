import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexSetup } from '../features/setup/CodexSetup';

const sources = [
  { name: 'cc-switch Desktop', repo: 'https://github.com/farion1231/cc-switch.git' },
  { name: 'cc-switch CLI', repo: 'https://github.com/SaladDay/cc-switch-cli.git' }
];

describe('Codex Setup provider configuration', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('requires and submits a Base URL for a custom third-party API', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/codex/cc-switch/status')) return response({ status: 'not_synced', sources });
      if (url.endsWith('/codex/auth/api-key')) return response({ authenticated: true, provider: 'acme' });
      return response({});
    }));
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<CodexSetup state={codexState({ docker_ready: true, authenticated: false, profile_valid: false, probe_ok: false })} onChange={onChange} />);

    expect(await screen.findByRole('group', { name: 'Codex 配置来源' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '官方账户' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'cc-switch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本地 Codex' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '手动 API' }));
    fireEvent.change(screen.getByRole('combobox', { name: '服务商' }), { target: { value: 'custom' } });

    const endpoint = screen.getByRole('textbox', { name: 'API 根地址' });
    const submit = screen.getByRole('button', { name: '保存凭据与接口地址' });
    expect(screen.getByRole('textbox', { name: '服务商标识' })).toHaveValue('custom');
    expect(endpoint).toBeRequired();
    expect(endpoint).toHaveAttribute('aria-invalid', 'true');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: '服务商标识' }), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'sk-third-party' } });
    fireEvent.change(endpoint, { target: { value: 'not-a-url' } });
    expect(await screen.findByRole('alert', { name: '' })).toHaveTextContent('请输入完整的 http:// 或 https:// API 根地址');
    expect(submit).toBeDisabled();

    fireEvent.change(endpoint, { target: { value: 'https://api.acme.test/v1' } });
    expect(screen.getByRole('combobox', { name: 'API 协议' })).toBeDisabled();
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    const request = calls.find((item) => item.url.endsWith('/codex/auth/api-key'));
    expect(request?.init?.method).toBe('POST');
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      provider: 'acme',
      base_url: 'https://api.acme.test/v1',
      wire_api: 'responses',
      api_key: 'sk-third-party'
    });
  });

  it('keeps cc-switch optional while creating a native third-party Profile', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/codex/status')) return response({ authenticated: true, auth: { provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', wire_api: 'responses', auth_mode: 'api_key' } });
      if (url.endsWith('/codex/profiles') && init?.method === 'POST') return response({ id: 'profile-openrouter', status: 'validated' }, 201);
      return response({});
    }));
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<CodexSetup state={codexState({ docker_ready: true, authenticated: true, cc_switch_ready: false, profile_valid: false, probe_ok: false })} onChange={onChange} />);

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'API 根地址' })).toHaveValue('https://openrouter.ai/api/v1'));
    expect(screen.queryByText(/Runtime Bridge/)).not.toBeInTheDocument();
    const save = screen.getByRole('button', { name: '保存并校验配置' });
    expect(screen.getByRole('spinbutton', { name: '任务超时（分钟）' })).toHaveValue(30);
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(calls.some((item) => item.url.endsWith('/codex/profiles') && item.init?.method === 'POST')).toBe(true));
    const request = calls.find((item) => item.url.endsWith('/codex/profiles') && item.init?.method === 'POST');
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({ provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', wire_api: 'responses', timeout_ms: 1_800_000 });
    expect(calls.some((item) => /cc-switch\/(?:sync|import)$/.test(item.url))).toBe(false);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('restores the authenticated provider endpoint before Profile creation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/codex/status')) return response({ authenticated: true, auth: { provider: 'acme', base_url: 'https://api.acme.test/v1', wire_api: 'chat', auth_mode: 'api_key' } });
      if (url.endsWith('/codex/cc-switch/status')) return response({ status: 'not_synced', sources });
      return response({});
    }));
    render(<CodexSetup state={codexState({ docker_ready: true, authenticated: true, cc_switch_ready: false, profile_valid: false, probe_ok: false })} onChange={vi.fn().mockResolvedValue(undefined)} />);

    await waitFor(() => expect(screen.getByRole('textbox', { name: '服务商标识' })).toHaveValue('acme'));
    expect(screen.getByRole('textbox', { name: 'API 根地址' })).toHaveValue('https://api.acme.test/v1');
    expect(screen.getByRole('combobox', { name: 'API 协议' })).toHaveValue('responses');
    expect(screen.getByRole('button', { name: '保存并校验配置' })).toBeEnabled();
    expect(screen.queryByText(/Runtime Bridge/)).not.toBeInTheDocument();
  });

  it('repairs a legacy third-party Profile that has no endpoint without asking for the stored key again', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/codex/status')) return response({ authenticated: true, auth: { provider: 'acme', base_url: null, wire_api: 'responses', auth_mode: 'api_key' } });
      if (url.endsWith('/codex/profiles') && (!init?.method || init.method === 'GET')) return response([{ id: 'legacy-profile', name: 'Legacy Acme', provider: 'acme', base_url: null, wire_api: 'responses', model: 'acme/codex', timeout_ms: 600_000, status: 'validated', is_active: true }]);
      if (url.endsWith('/codex/cc-switch/status')) return response({ status: 'not_synced', sources });
      if (url.endsWith('/codex/auth/api-key')) return response({ authenticated: true, provider: 'acme', base_url: 'https://api.acme.test/v1' });
      if (url.endsWith('/codex/profiles/legacy-profile')) return response({ id: 'legacy-profile', status: 'validated' });
      return response({});
    }));
    const onChange = vi.fn().mockResolvedValue(undefined);
    const state = { ...codexState({ docker_ready: true, authenticated: true, auth_profile_match: true, provider_endpoint_valid: false, cc_switch_ready: false, profile_valid: false, probe_ok: false }), profile_id: 'legacy-profile' };
    render(<CodexSetup state={state} onChange={onChange} />);

    expect(await screen.findByText('修复现有 Codex 配置')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Codex 配置来源' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'cc-switch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本地 Codex' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: '服务商标识' })).toHaveValue('acme'));
    expect(screen.getByRole('spinbutton', { name: '任务超时（分钟）' })).toHaveValue(10);
    expect(screen.queryByLabelText('修复配置 API 密钥')).not.toBeInTheDocument();
    expect(screen.queryByText('第三方配置已保存')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'API 根地址' }), { target: { value: 'https://api.acme.test/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存接口地址并修复配置' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    const auth = calls.find((item) => item.url.endsWith('/codex/auth/api-key') && item.init?.method === 'POST');
    expect(JSON.parse(String(auth?.init?.body))).toEqual({ provider: 'acme', base_url: 'https://api.acme.test/v1', wire_api: 'responses' });
    const update = calls.find((item) => item.url.endsWith('/codex/profiles/legacy-profile'));
    expect(update?.init?.method).toBe('PUT');
    expect(JSON.parse(String(update?.init?.body))).toMatchObject({ name: 'Legacy Acme', provider: 'acme', base_url: 'https://api.acme.test/v1', model: 'acme/codex', timeout_ms: 600_000 });
  });

  it('shows the actionable layered Probe diagnosis instead of a generic failure code', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/codex/cc-switch/status')) return response({ status: 'not_synced', sources });
      if (url.endsWith('/codex/status')) return response({ authenticated: true, auth: { provider: 'openai', wire_api: 'responses', auth_mode: 'api_key' } });
      if (url.endsWith('/codex/profiles')) return response([{ id: 'profile-probe', name: 'Probe', provider: 'openai', model: 'gpt-test', status: 'validated', is_active: true }]);
      if (url.endsWith('/codex/probe')) return response({
        error: 'codex_probe_docker_unavailable',
        message: 'Docker 引擎当前不可用',
        action: '启动 Docker Desktop，确认已切换到 Linux containers，然后重试。',
        probe: {
          ok: false,
          phase: 'runtime',
          error_code: 'codex_probe_docker_unavailable',
          checks: [
            { phase: 'configuration', label: '配置语法', status: 'passed' },
            { phase: 'runtime', label: 'Docker 运行时', status: 'failed' },
            { phase: 'binding', label: 'Endpoint / 凭据绑定', status: 'pending' }
          ]
        }
      }, 409);
      return response({});
    }));
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<CodexSetup state={{ ...codexState({ docker_ready: true, authenticated: true, profile_valid: true, probe_ok: false }), profile_id: 'profile-probe' }} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '运行探针' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Docker 引擎当前不可用');
    expect(alert).toHaveTextContent('启动 Docker Desktop');
    expect(screen.getByRole('list', { name: '探针校验结果' })).toHaveTextContent('配置语法已通过');
    expect(screen.getByRole('list', { name: '探针校验结果' })).toHaveTextContent('Docker 运行时失败');
    expect(onChange).not.toHaveBeenCalled();
  });
});

function codexState(checks: Record<string, boolean>) {
  return { ready: false, status: 'configuration_required', detail: '配置 Codex', checks };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
