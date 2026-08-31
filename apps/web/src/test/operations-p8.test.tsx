import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OperationsPage } from '../features/operations';

const envelope = (data: unknown) => new Response(JSON.stringify({ request_id: 'p8', data, meta: { api_version: '2' } }), { headers: { 'content-type': 'application/json' } });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('loads delivery, deployment, backup, import, lineage and GC states from API v2', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/v2/deliveries/') && init?.method === 'POST') return envelope({ operation_id: 'op_reconcile', status: 'queued', revision: 1 });
    if (url.startsWith('/api/v2/deliveries')) return envelope({ deliveries: [{ id: 'delivery_1', branch_name: 'aiws/deliveries/delivery_1', status: 'needs_reconcile', target_head_sha: 'abcdef012345', revision: 2 }] });
    if (url.startsWith('/api/v2/operations')) return envelope({ operations: [{ operation_id: 'op_1', command_id: 'cas.gc.apply', status: 'failed', revision: 2, error_code: 'reference_race' }] });
    if (url === '/api/v2/system/deployment') return envelope({ active: null, candidates: [{ id: 'candidate_1', status: 'candidate', revision: 1, app_digest: 'd'.repeat(64), candidate_sha256: 'e'.repeat(64) }] });
    if (url === '/api/v2/backups') return envelope({ backups: [{ id: 'backup_1', source_user_version: 8, manifest_sha256: 'f'.repeat(64), retention_class: 'diagnostic', created_at: '2026-08-26T00:00:00.000Z' }] });
    if (url === '/api/v2/cas/gc/plan') return envelope({ plan: { count: 2, candidates: ['a'.repeat(64), 'b'.repeat(64)], plan_sha256: 'c'.repeat(64) } });
    return envelope({ imports: [{ id: 'import_1', status: 'blocked', revision: 1, target_sha256: '1'.repeat(64) }] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const notify = vi.fn();
  render(<OperationsPage projectId="project_1" selectedProject={undefined} selectProject={vi.fn()} refreshProjects={vi.fn()} notify={notify} navigate={vi.fn()} setupReady refreshSetup={vi.fn()} />);

  expect(await screen.findByText('外部结果未知')).toBeVisible();
  expect(screen.getAllByText('候选').length).toBeGreaterThan(0);
  expect(screen.getByText('schema v8 · 诊断')).toBeVisible();
  expect(screen.getByText('引用发生并发变更')).toBeVisible();
  expect(screen.getByText('已阻塞')).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: '创建 GC 计划' }));
  expect(await screen.findByText('2 个候选')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '对账交付' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v2/deliveries/delivery_1/reconcile', expect.objectContaining({ method: 'POST' })));
});
