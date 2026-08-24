import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsPage } from '../features/connections';
import type { WorkspacePageProps } from '../workspace';

const deviceId = 'bridge_device_ui';
const baseDevice = { id: deviceId, label: 'Windows workstation', paired_transcript_sha256: 'a'.repeat(64), status: 'paired', last_nonce_sequence: 0, revision: 1, created_at: '2026-08-20T00:00:00.000Z', updated_at: '2026-08-20T00:00:00.000Z' };
const calls: Array<{ url: string; body: Record<string, unknown>; revision: string | null }> = [];
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ request_id: 'req_bridge_ui', data, meta: { api_version: 'v2' } }), { status, headers: { 'content-type': 'application/json' } });
const props: WorkspacePageProps = {
  projectId: 'project_bridge_ui', selectedProject: undefined, selectProject: vi.fn(), refreshProjects: vi.fn(async () => undefined),
  notify: vi.fn(), navigate: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => undefined)
};

beforeEach(() => {
  calls.length = 0;
  let device: typeof baseDevice | null = null;
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
    const url = String(request);
    const method = options?.method || 'GET';
    if (method === 'GET' && url.endsWith('/api/v2/bridge/devices')) return envelope({ devices: device ? [device] : [] });
    if (method === 'GET' && url.endsWith(`/api/v2/bridge/devices/${deviceId}/transfers`)) return envelope({ transfers: [] });
    const headers = new Headers(options?.headers);
    const body = JSON.parse(String(options?.body || '{}')) as Record<string, unknown>;
    calls.push({ url, body, revision: headers.get('X-Expected-Revision') });
    if (url.endsWith('/api/v2/bridge/pairing')) {
      device = { ...baseDevice };
      return envelope({ device, operation: { operation_id: 'op_pair', status: 'succeeded', revision: 1 } }, 201);
    }
    if (url.endsWith(`/${deviceId}/probe`)) {
      device = { ...baseDevice, last_nonce_sequence: 1, revision: 2 };
      return envelope({ device, probe: { status: 'ready', capabilities: { conpty: true, git_bundle: true } } });
    }
    if (url.endsWith(`/${deviceId}/revoke`)) {
      device = { ...baseDevice, status: 'revoked', revision: 3 };
      return envelope({ device });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('P5 Windows Bridge connections', () => {
  it('pairs, probes and revokes a revision-bound device', async () => {
    render(<ConnectionsPage {...props} />);
    expect(await screen.findByText('No Bridge devices')).toBeVisible();
    fireEvent.change(screen.getByPlaceholderText('6-12 digits'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(calls[0]).toMatchObject({ url: '/api/v2/bridge/pairing', body: { label: 'Windows workstation', confirmation_code: '123456' }, revision: '0' }));

    expect(await screen.findByText('Transcript aaaaaaaaaa | r1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Probe Bridge' }));
    await waitFor(() => expect(calls[1]).toMatchObject({ url: `/api/v2/bridge/devices/${deviceId}/probe`, revision: '1' }));
    expect(await screen.findByText('conpty, git_bundle')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Bridge' }));
    await waitFor(() => expect(calls[2]).toMatchObject({ url: `/api/v2/bridge/devices/${deviceId}/revoke`, revision: '2' }));
    expect(await screen.findByText('revoked')).toBeVisible();
  });
});
