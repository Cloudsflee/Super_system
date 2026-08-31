import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesDrawer } from '../features/files';

const projectId = 'project_files_ui';
const batchId = 'change_batch_ui';
const mutations: Array<{ url: string; revision: string | null }> = [];
const envelope = (data: unknown) => new Response(JSON.stringify({ request_id: 'req_files_ui', data, meta: { api_version: 'v2' } }), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  mutations.length = 0;
  let batchStatus = 'proposed';
  let revision = 1;
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
    const url = String(request);
    const method = options?.method || 'GET';
    const batch = { id: batchId, workspace_id: 'workspace_files_ui', item_count: 1, total_bytes: 12, status: batchStatus, revision, batch_sha256: 'b'.repeat(64) };
    if (method !== 'GET') {
      mutations.push({ url, revision: new Headers(options?.headers).get('X-Expected-Revision') });
      if (url.endsWith(`/${batchId}/approve`)) batchStatus = 'approved';
      if (url.endsWith(`/${batchId}/apply`)) batchStatus = 'applied';
      if (url.endsWith(`/${batchId}/undo`)) batchStatus = 'undone';
      revision += 1;
      return envelope({ batch: { ...batch, status: batchStatus, revision } });
    }
    if (url.endsWith(`/projects/${projectId}/attachments`)) return envelope({ attachments: [{ id: 'attachment_quarantine_ui', filename: 'unsafe.svg', media_type: 'image/svg+xml', byte_length: 123, disposition: 'download_only', parser_status: 'pending', status: 'quarantined', revision: 1, content_sha256: 'a'.repeat(64) }] });
    if (url.endsWith(`/projects/${projectId}/files`)) return envelope({ files: [{ id: 'file_ui', path: 'README.md', content_sha256: 'c'.repeat(64), byte_length: 12, status: 'current', revision: 1 }] });
    if (url.endsWith(`/projects/${projectId}/change-batches`)) return envelope({ batches: [batch] });
    if (url.endsWith(`/projects/${projectId}/repository-workspaces`)) return envelope({ workspaces: [{ id: 'workspace_files_ui', status: 'ready', revision: 2 }] });
    if (url.endsWith(`/change-batches/${batchId}/review`)) return envelope({ batch, items: [{ id: 'item_ui', path: 'README.md', action: 'replace', before_sha256: 'd'.repeat(64), after_sha256: 'e'.repeat(64), status: batchStatus }] });
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('P5 Files drawer', () => {
  it('keeps quarantined attachments download-only and advances a revisioned batch through undo', async () => {
    render(<FilesDrawer open projectId={projectId} notify={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('unsafe.svg')).toBeVisible();
    expect(screen.getByRole('button', { name: '预览 unsafe.svg' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '变更' }));
    expect(await screen.findByText(/替换 README.md/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    await waitFor(() => expect(mutations[0]).toEqual({ url: `/api/v2/change-batches/${batchId}/approve`, revision: '1' }));

    fireEvent.click(await screen.findByRole('button', { name: '应用' }));
    await waitFor(() => expect(mutations[1]).toEqual({ url: `/api/v2/change-batches/${batchId}/apply`, revision: '2' }));

    fireEvent.click(await screen.findByRole('button', { name: '撤销' }));
    await waitFor(() => expect(mutations[2]).toEqual({ url: `/api/v2/change-batches/${batchId}/undo`, revision: '3' }));
  });
});
