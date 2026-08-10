import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { SetupPage } from '../features/setup';
import type { WorkspacePageProps } from '../pages';

const owner = { id: 'usr_local_owner', display_name: 'Local owner', locale: 'zh-CN', timezone: 'Asia/Shanghai', status: 'active', revision: 1 };
const checks = {
  owner: true, active_codex_credential: false, active_codex_profile: false, current_codex_probe: false,
  verified_github_app: false, active_github_installation: false, repository_permissions: false, current_github_probe: false
};

function setupState(overrides: Record<string, unknown> = {}) {
  return {
    id: 'setup_singleton', status: 'blocked', complete: false, can_complete: false, completed_at: null,
    revision: 1, checks, blockers: Object.keys(checks).filter((key) => !checks[key as keyof typeof checks]), owner,
    credentials: [], codex_profiles: [], github_apps: [], ...overrides
  };
}

const props: WorkspacePageProps = {
  projectId: '', selectedProject: undefined, selectProject: vi.fn(), refreshProjects: vi.fn(async () => undefined),
  notify: vi.fn(), navigate: vi.fn(), setupReady: false, refreshSetup: vi.fn(async () => undefined)
};

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  location.hash = '#/setup';
});

afterEach(() => cleanup());

describe('setup workflow', () => {
  it('shows blocked checks and exposes device human input, cancel, and failed retry', async () => {
    let current = setupState();
    const operationReads = new Map<string, number>();
    const operationStatuses = new Map<string, string>();
    let starts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      const method = options?.method || 'GET';
      if (url.endsWith('/api/v1/setup')) return response(current);
      if (url.endsWith('/api/v1/sessions')) return response([]);
      if (url.includes('/api/v1/integrations/codex/discovery')) return response([]);
      if (url.endsWith('/api/v1/system/capabilities')) return response({ version: '3.0.0', api: '/api/v1', codex: { status: 'unknown' }, github: { status: 'unknown' }, broker: { status: 'available', runner_digest: 'sha256:fixture' } });
      if (url.endsWith('/readyz')) return response({ status: 'not_ready' });
      if (url.endsWith('/api/v1/integrations/codex/device-auth') && method === 'POST') {
        starts += 1;
        const operationId = starts === 1 ? 'op_device_fixture' : 'op_retry_fixture';
        operationReads.set(operationId, 0);
        operationStatuses.set(operationId, 'running');
        return response({ operation_id: operationId, status: 'pending', revision: 1 }, 202);
      }
      const operationMatch = url.match(/\/api\/v1\/operations\/(op_[^/?]+)/);
      const operationId = operationMatch?.[1] || '';
      if (operationId && url.includes(`/api/v1/operations/${operationId}/events`)) return response([{ cursor: 1, operation_id: operationId, type: 'codex.device_auth.verification', data: { verification_url: 'https://auth.example.test/device', user_code: 'ABCD-EFGH', status: 'waiting_for_user' }, created_at: '2026-08-10T00:00:00.000Z' }]);
      if (operationId && url.endsWith(`/api/v1/operations/${operationId}`)) {
        const reads = (operationReads.get(operationId) || 0) + 1;
        operationReads.set(operationId, reads);
        const status = operationStatuses.get(operationId);
        if (status === 'cancelled') return response({ id: operationId, kind: 'codex.device_auth', status, revision: 2 });
        if (operationId === 'op_retry_fixture' && reads > 1) return response({ id: operationId, kind: 'codex.device_auth', status: 'failed', revision: 2, error_code: 'device_auth_failed' });
        return response({ id: operationId, kind: 'codex.device_auth', status: 'running', revision: 1 });
      }
      if (operationId && url.endsWith(`/api/v1/operations/${operationId}/cancel`) && method === 'POST') {
        operationStatuses.set(operationId, 'cancelled');
        return response({ id: operationId, kind: 'codex.device_auth', status: 'cancelled', revision: 2 });
      }
      return response({});
    }));

    render(<SetupPage {...props} />);
    await screen.findByRole('heading', { name: 'Workspace configuration' });
    expect(screen.getByText('Codex credential')).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Device sign-in' }));
    await screen.findByText('Device verification');
    expect(screen.getByText('ABCD-EFGH')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getAllByText('cancelled')).toHaveLength(2), { timeout: 2000 });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('device_auth_failed')).toBeVisible(), { timeout: 2000 });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  it('completes setup only after the server reports every check ready', async () => {
    let current = setupState({
      status: 'ready', complete: false, can_complete: true,
      checks: Object.fromEntries(Object.keys(checks).map((key) => [key, true])), blockers: []
    });
    let completed = false;
    const refreshSetup = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/v1/setup')) return response(completed ? { ...current, complete: true, completed_at: '2026-08-10T00:00:00.000Z' } : current);
      if (url.endsWith('/api/v1/sessions')) return response([]);
      if (url.includes('/api/v1/integrations/codex/discovery')) return response([]);
      if (url.endsWith('/api/v1/system/capabilities')) return response({ version: '3.0.0', api: '/api/v1', codex: { status: 'available' }, github: { status: 'available' }, broker: { status: 'available', runner_digest: 'sha256:fixture' } });
      if (url.endsWith('/readyz')) return response({ status: 'ready' });
      if (url.endsWith('/api/v1/setup/complete')) { completed = true; return response({ ...current, complete: true }, 200); }
      return response({});
    }));
    render(<SetupPage {...props} refreshSetup={refreshSetup} />);
    await screen.findByRole('button', { name: 'Complete setup' });
    fireEvent.click(screen.getByRole('button', { name: 'Complete setup' }));
    await waitFor(() => expect(refreshSetup).toHaveBeenCalled());
    expect(screen.getByText(/^Completed /)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reconfirm setup' })).toBeVisible();
  });

  it('does not load workspace data until ready checks are explicitly completed', async () => {
    const readyChecks = Object.fromEntries(Object.keys(checks).map((key) => [key, true]));
    let completed = false;
    const projectRequests: string[] = [];
    location.hash = '#/projects';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      const method = options?.method || 'GET';
      if (url.endsWith('/api/v1/setup') && method === 'GET') return response(setupState({
        status: 'ready', complete: completed, can_complete: true,
        completed_at: completed ? '2026-08-10T00:00:00.000Z' : null,
        checks: readyChecks, blockers: []
      }));
      if (url.endsWith('/api/v1/setup/complete')) { completed = true; return response(setupState({ status: 'ready', complete: true, can_complete: true, checks: readyChecks, blockers: [] })); }
      if (url.endsWith('/api/v1/projects')) { projectRequests.push(url); return response([]); }
      if (url.endsWith('/api/v1/sessions')) return response([]);
      if (url.includes('/api/v1/integrations/codex/discovery')) return response([]);
      if (url.endsWith('/api/v1/system/capabilities')) return response({ version: '3.0.0', api: '/api/v1', codex: { status: 'available' }, github: { status: 'available' }, broker: { status: 'available', runner_digest: 'sha256:fixture' } });
      if (url.endsWith('/readyz')) return response({ status: 'ready' });
      return response({});
    }));

    render(<App />);
    await screen.findByRole('button', { name: 'Complete setup' });
    expect(projectRequests).toHaveLength(0);
    expect(location.hash).toBe('#/setup');

    fireEvent.click(screen.getByRole('button', { name: 'Complete setup' }));
    await waitFor(() => expect(projectRequests).toHaveLength(1));
  });
});
