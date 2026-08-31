import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsPage } from '../features/connections';
import type { WorkspacePageProps } from '../workspace';

const profile = { id: 'runner_profile_ui', label: 'Local Host', runner_type: 'host', endpoint_ref: '', image_digest: '', bridge_device_id: null, capabilities: ['workspace:read', 'network:none'], limits: { light: { cpus: 1, memory_bytes: 1073741824, pids: 256, tmpfs_bytes: 268435456 }, standard: { cpus: 2, memory_bytes: 4294967296, pids: 512, tmpfs_bytes: 1073741824 } }, status: 'ready', revision: 3, profile_hash: 'a'.repeat(64), last_probe_at: '2026-08-24T00:00:00.000Z' };
const calls: Array<{ url: string; method: string; revision: string | null; body: Record<string, unknown> }> = [];
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ request_id: 'req_runner_ui', data, meta: { api_version: '2' } }), { status, headers: { 'content-type': 'application/json' } });
const props: WorkspacePageProps = { projectId: 'project_runner_ui', selectedProject: undefined, selectProject: vi.fn(), refreshProjects: vi.fn(async () => undefined), notify: vi.fn(), navigate: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => undefined) };

beforeEach(() => {
  calls.length = 0; let profiles = [profile];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const method = options?.method || 'GET';
    if (method === 'GET' && url === '/api/v2/bridge/devices') return envelope({ devices: [] });
    if (method === 'GET' && url === '/api/v2/runners/profiles') return envelope({ profiles });
    const headers = new Headers(options?.headers); const body = JSON.parse(String(options?.body || '{}')) as Record<string, unknown>; calls.push({ url, method, revision: headers.get('X-Expected-Revision'), body });
    if (url.endsWith('/probe')) { profiles = [{ ...profile, status: 'probing', revision: 4 }]; return envelope({ operation_id: 'op_probe', command_id: 'runner.profile.probe', status: 'queued', revision: 1 }, 202); }
    if (url === '/api/v2/runners/profiles') { const created = { ...profile, id: 'runner_docker_ui', label: String(body.label), runner_type: 'docker', image_digest: String(body.image_digest), status: 'unprobed', revision: 1 }; profiles = [created, ...profiles]; return envelope({ profile: created }, 201); }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('P6 Runner Profiles connections tab', () => {
  it('shows fixed resource limits, probes by revision and creates a digest-pinned Docker profile', async () => {
    render(<ConnectionsPage {...props} />); fireEvent.click(screen.getByRole('button', { name: '执行器 Profile' }));
    expect(await screen.findByText('Profile aaaaaaaaaa')).toBeVisible(); expect(screen.getAllByText('1024.0 MB')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '探测执行器 Profile' })); await waitFor(() => expect(calls[0]).toMatchObject({ url: `/api/v2/runners/profiles/${profile.id}/probe`, revision: '3' }));
    fireEvent.change(screen.getByLabelText('执行器类型'), { target: { value: 'docker' } }); fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Pinned Docker' } });
    const digest = `sha256:${'b'.repeat(64)}`; fireEvent.change(screen.getByLabelText('镜像摘要'), { target: { value: digest } }); fireEvent.click(screen.getByRole('button', { name: '添加 Profile' }));
    await waitFor(() => expect(calls[1]).toMatchObject({ url: '/api/v2/runners/profiles', method: 'POST', revision: '0', body: { label: 'Pinned Docker', runner_type: 'docker', image_digest: digest } }));
  });
});
