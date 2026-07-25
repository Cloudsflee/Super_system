import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectBundle, WorkflowMigrationState } from '../api/types';
import { WorkflowPage } from '../features/workflow/WorkflowPage';

describe('workflow migration owner gate', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('lets the Project Owner approve the pending two-level migration from the workflow page', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let approved = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method || 'GET';
      calls.push({ url, method });
      if (url.endsWith('/projects/project-1')) return response(bundle('owner'));
      if (url.endsWith('/workflow-migrations/batches/batch-1/approve') && method === 'POST') {
        approved = true;
        return response({ batch: { ...migration().batch, status: 'approved' } }, 202);
      }
      if (url.endsWith('/workflow-migrations')) {
        const value = migration();
        if (approved && value.batch) value.batch.status = 'approved';
        return response(value);
      }
      return response({});
    }));

    renderPage();
    expect(await screen.findByRole('heading', { name: '工作流等待所有者批准' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '批准两级迁移' }));

    await waitFor(() => expect(calls).toContainEqual({ url: '/api/workflow-migrations/batches/batch-1/approve', method: 'POST' }));
    expect(await screen.findByRole('heading', { name: '正在生成两级工作流' })).toBeInTheDocument();
  });

  it('keeps collaborators read-only while showing who must approve', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/projects/project-1') ? response(bundle('collaborator')) : response(migration())));
    renderPage();
    expect(await screen.findByText('只有项目所有者可以批准')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '批准两级迁移' })).not.toBeInTheDocument();
  });

  it('offers an owner retry after a failed migration job', async () => {
    const calls: string[] = [];
    let retried = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method || 'GET';
      if (url.endsWith('/projects/project-1')) return response(bundle('owner'));
      if (url.endsWith('/workflow-migrations/jobs/job-1/retry') && method === 'POST') { calls.push(url); retried = true; return response({}); }
      const value = migration();
      if (value.batch) value.batch.status = retried ? 'approved' : 'completed_with_failures';
      value.jobs[0].status = retried ? 'pending' : 'failed';
      value.jobs[0].error_code = retried ? null : 'active_codex_profile_required';
      return response(value);
    }));

    renderPage();
    expect(await screen.findByText('迁移失败代码：active_codex_profile_required')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试迁移' }));
    await waitFor(() => expect(calls).toEqual(['/api/workflow-migrations/jobs/job-1/retry']));
  });
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return renderWithClient(client, <MemoryRouter initialEntries={['/projects/project-1/workflow']}><Routes><Route path="/projects/:projectId/workflow" element={<WorkflowPage />} /></Routes></MemoryRouter>);
}

function renderWithClient(client: QueryClient, value: ReactNode) { return render(<QueryClientProvider client={client}>{value}</QueryClientProvider>); }
function response(value: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })); }
function bundle(role: 'owner' | 'collaborator'): ProjectBundle {
  return {
    project: { id: 'project-1', title: 'Legacy project', goal: 'Migrate safely', status: 'active', onboarding_state: 'confirmed', current_workspace_id: 'workspace-1', workflow_migration_status: 'pending' },
    membership: { id: 'membership-1', project_id: 'project-1', user_id: 'user-1', role, status: 'active' },
    workflows: [{ id: 'workflow-1', project_id: 'project-1', title: 'Legacy workflow', status: 'active', hierarchy_mode: 'legacy', legacy_read_only: true, semantic_migration_status: 'pending', version: 1 }],
    nodes: [], contracts: [], assets: [], runs: []
  };
}
function migration(): WorkflowMigrationState {
  return {
    batch: { id: 'batch-1', status: 'pending_approval', workflow_ids: ['workflow-1'], project_ids: ['project-1'], created_at: new Date(0).toISOString() },
    jobs: [{ id: 'job-1', batch_id: 'batch-1', project_id: 'project-1', workflow_id: 'workflow-1', status: 'pending', attempt: 0, error_code: null }],
    legacy_workflow_ids: ['workflow-1']
  };
}
