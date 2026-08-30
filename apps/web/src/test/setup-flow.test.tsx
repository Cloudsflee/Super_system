import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { SystemOnboarding, githubSkipKey, systemOnboardingKey, type SystemOnboardingSnapshot } from '../features/setup';

function envelope(data: unknown, status = 200) {
  return new Response(JSON.stringify({ request_id: 'req_onboarding', data, meta: { api_version: '2' } }), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  location.hash = '#/projects';
});

it('runs full-screen setup, enforces the Codex probe, supports GitHub skip, and stores no secret', async () => {
  let setupComplete = false;
  let credential: Record<string, unknown> | null = null;
  let profile: Record<string, unknown> | null = null;
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const method = options?.method || 'GET'; const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith('/api/v2/setup') && method === 'GET') return envelope({ needs_setup: !setupComplete, actor_count: setupComplete ? 1 : 0, bootstrap_actor_id: setupComplete ? 'account_1' : 'actor_system_bootstrap' });
    if (url.endsWith('/api/v2/setup') && method === 'POST') { setupComplete = true; return envelope({ actor: { id: 'account_1' }, team: { id: 'team_1' } }, 201); }
    if (url.endsWith('/api/v2/projects')) return envelope({ projects: [] });
    if (url.endsWith('/api/v2/account')) return envelope({ account: { id: 'account_1', display_name: '本地 Owner', revision: 1 } });
    if (url.endsWith('/api/v2/credentials') && method === 'GET') return envelope({ credentials: credential ? [credential] : [] });
    if (url.endsWith('/api/v2/credentials') && method === 'POST') { credential = { id: 'credential_1', provider: 'codex', status: 'rebind_required', revision: 1 }; return envelope({ credential }, 201); }
    if (url.endsWith('/credentials/credential_1/rebind')) { credential = { ...credential, status: 'active', revision: 3 }; return envelope({ operation_id: 'operation_rebind', status: 'succeeded' }, 202); }
    if (url.endsWith('/api/v2/profiles') && method === 'GET') return envelope({ profiles: profile ? [profile] : [] });
    if (url.endsWith('/api/v2/profiles') && method === 'POST') { profile = { id: 'profile_1', provider: 'codex', label: 'Codex', credential_ref_id: 'credential_1', status: 'unprobed', lifecycle_status: 'enabled', revision: 1 }; return envelope({ profile }, 201); }
    if (url.endsWith('/profiles/profile_1/probe')) { profile = { ...profile, status: 'available', revision: 3 }; return envelope({ operation_id: 'operation_probe', status: 'succeeded' }, 202); }
    if (url.includes('/api/v2/approvals')) return envelope({ approvals: [] });
    if (url.includes('/api/v2/user-inputs')) return envelope({ inputs: [] });
    return envelope({});
  }));

  render(<App />);
  expect(await screen.findByTestId('system-onboarding')).toHaveAttribute('data-step', '1');
  expect(document.querySelector('.app-shell')).toBeNull();
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '本地 Owner' } });
  fireEvent.change(screen.getByLabelText('Team 名称'), { target: { value: '本地 Team' } });
  fireEvent.click(screen.getByRole('button', { name: '创建并继续' }));
  await screen.findByLabelText('Codex credential');
  expect(screen.getByRole('button', { name: '验证并继续' })).toBeDisabled();
  const secret = 'codex-secret-regression-value';
  fireEvent.change(screen.getByLabelText('Codex credential'), { target: { value: secret } });
  fireEvent.click(screen.getByRole('button', { name: '验证并继续' }));
  await screen.findByRole('heading', { name: '连接 GitHub App' });
  expect([...Object.values(localStorage), ...Object.values(sessionStorage)].join('|')).not.toContain(secret);
  expect(calls.find((call) => call.url.endsWith('/credentials/credential_1/rebind'))?.body?.proof).toBe(secret);
  fireEvent.click(screen.getByRole('button', { name: '稍后配置' }));
  await screen.findByRole('heading', { name: '配置检查' });
  expect(localStorage.getItem(githubSkipKey('account_1'))).toBe('1');
  fireEvent.click(screen.getByRole('button', { name: '进入项目创建' }));
  await screen.findByRole('heading', { name: '项目' });
  expect(localStorage.getItem(systemOnboardingKey('account_1'))).toBe('1');
  expect(calls.every((call) => !call.url.includes('/api/v1/'))).toBe(true);
});

it('configures GitHub and verifies repository discovery without persisting the private key', async () => {
  const snapshot: SystemOnboardingSnapshot = {
    needsSetup: false,
    account: { id: 'account_github', display_name: 'Owner', revision: 1 },
    credentials: [{ id: 'credential_codex', provider: 'codex', status: 'active', revision: 3 }],
    profiles: [{ id: 'profile_codex', provider: 'codex', label: 'Codex', status: 'available', revision: 3, credential_ref_id: 'credential_codex' }],
    projectCount: 0
  };
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const body = options?.body ? JSON.parse(String(options.body)) : undefined; calls.push({ url, body });
    if (url.endsWith('/api/v2/credentials')) return envelope({ credential: { id: 'credential_github', provider: 'github', status: 'rebind_required', revision: 1 } }, 201);
    if (url.endsWith('/credentials/credential_github/rebind')) return envelope({ operation_id: 'rebind_github', status: 'succeeded' }, 202);
    if (url.endsWith('/api/v2/profiles')) return envelope({ profile: { id: 'profile_github', provider: 'github', label: 'GitHub App', status: 'unprobed', revision: 1, credential_ref_id: 'credential_github' } }, 201);
    if (url.endsWith('/profiles/profile_github/probe')) return envelope({ operation_id: 'probe_github', status: 'succeeded' }, 202);
    if (url.endsWith('/provider-profiles/profile_github/repositories')) return envelope({ repositories: [{ id: 1, full_name: 'fixture/repository' }] });
    return envelope({});
  }));
  const refresh = vi.fn(async () => {});
  render(<SystemOnboarding snapshot={snapshot} refresh={refresh} onComplete={vi.fn(async () => {})} />);
  const privateKey = 'private-key-regression-value';
  fireEvent.change(screen.getByLabelText('GitHub App ID'), { target: { value: '100' } });
  fireEvent.change(screen.getByLabelText('GitHub Installation ID'), { target: { value: '200' } });
  fireEvent.change(screen.getByLabelText('GitHub private key'), { target: { value: privateKey } });
  fireEvent.click(screen.getByRole('button', { name: '验证仓库访问' }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect((screen.getByLabelText('GitHub private key') as HTMLTextAreaElement).value).toBe('');
  expect([...Object.values(localStorage), ...Object.values(sessionStorage)].join('|')).not.toContain(privateKey);
  expect(String(calls.find((call) => call.url.endsWith('/credentials/credential_github/rebind'))?.body?.proof)).toContain(privateKey);
  expect(calls.some((call) => call.url.endsWith('/provider-profiles/profile_github/repositories'))).toBe(true);
});

it('automatically bypasses system onboarding for an existing project', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/v2/setup')) return envelope({ needs_setup: false, actor_count: 1, bootstrap_actor_id: 'account_upgrade' });
    if (url.endsWith('/api/v2/account')) return envelope({ account: { id: 'account_upgrade', display_name: 'Upgrade', revision: 1 } });
    if (url.endsWith('/api/v2/credentials')) return envelope({ credentials: [] });
    if (url.endsWith('/api/v2/profiles')) return envelope({ profiles: [] });
    if (url.endsWith('/api/v2/projects')) return envelope({ projects: [{ id: 'project_upgrade', name: 'Existing', description: '', status: 'active', onboarding_state: 'confirmed', revision: 4, updated_at: '' }] });
    if (url.endsWith('/api/v2/projects/project_upgrade')) return envelope({ project: { id: 'project_upgrade', name: 'Existing', status: 'active', onboarding_state: 'confirmed', revision: 4 } });
    if (url.endsWith('/intake')) return envelope({ intake: { id: 'intake', status: 'ready', mode: 'brainstorm', attempt: 1, revision: 3 } });
    if (url.endsWith('/briefs')) return envelope({ briefs: [] });
    if (url.endsWith('/repository-connections')) return envelope({ connections: [] });
    if (url.endsWith('/repository-lines')) return envelope({ lines: [] });
    if (url.endsWith('/workflow-draft')) return envelope({ workflow: { id: 'workflow', status: 'active', current_revision: 1, revision: 2 } });
    if (url.endsWith('/workflow-generations')) return envelope({ generations: [] });
    if (url.endsWith('/outcome-requirements')) return envelope({ requirements: [] });
    if (url.includes('/approvals')) return envelope({ approvals: [] });
    if (url.includes('/user-inputs')) return envelope({ inputs: [] });
    return envelope({});
  }));
  render(<App />);
  await screen.findByRole('heading', { name: 'Existing' });
  expect(screen.queryByTestId('system-onboarding')).toBeNull();
});
