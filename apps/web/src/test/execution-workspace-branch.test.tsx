import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeWorkspace, RepositoryWorkspace } from '../api/types';
import { ExecutionWorkspace } from '../features/nodes/renderers/ExecutionWorkspace';
import { useUi } from '../state/ui';

vi.mock('@monaco-editor/react', () => ({ default: () => null }));
vi.mock('../monaco', () => ({}));

describe('execution workspace branch selection', () => {
  beforeEach(() => useUi.setState({ toasts: [] }));
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('reuses the current branch copy without exposing a Workspace selector', async () => {
    const fetch = repositoryFetch([repositoryWorkspace()]);
    vi.stubGlobal('fetch', fetch);
    renderWithClient(<ExecutionWorkspace value={nodeWorkspace()} onSaved={vi.fn()} />);

    expect(await screen.findByText('当前目录为空')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '代码仓库' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '分支' })).toHaveValue('main');
    expect(screen.queryByRole('combobox', { name: '执行副本' })).not.toBeInTheDocument();
    expect(screen.queryByText('执行副本')).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('automatically creates a branch copy when none exists', async () => {
    let created = false;
    const current = repositoryWorkspace();
    const fetch = repositoryFetch(() => created ? [current] : [], async (input, init) => {
      if (String(input).endsWith('/projects/project-1/repository-workspaces') && init?.method === 'POST') {
        created = true;
        return response({ workspace: current });
      }
    });
    vi.stubGlobal('fetch', fetch);
    renderWithClient(<ExecutionWorkspace value={nodeWorkspace()} onSaved={vi.fn()} />);

    expect(await screen.findByText('当前目录为空')).toBeInTheDocument();
    const createCalls = fetch.mock.calls.filter(([input, init]) => String(input).endsWith('/projects/project-1/repository-workspaces') && init?.method === 'POST');
    expect(createCalls).toHaveLength(1);
    expect(JSON.parse(String(createCalls[0][1]?.body))).toMatchObject({ ref: 'main', expected_sha: 'abcdef1234567890' });
    expect(screen.queryByRole('combobox', { name: '执行副本' })).not.toBeInTheDocument();
  });

  it('only offers advanced copy selection when a branch has multiple copies', async () => {
    const stale = repositoryWorkspace({ id: 'copy-old', fixed_sha: '1111111122222222', current_sha: '1111111122222222', stale: true, sync_status: 'stale', mode: 'read_only' });
    vi.stubGlobal('fetch', repositoryFetch([repositoryWorkspace(), stale]));
    renderWithClient(<ExecutionWorkspace value={nodeWorkspace()} onSaved={vi.fn()} />);

    expect(await screen.findByText('当前目录为空')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('选择执行副本'));
    const selector = screen.getByRole('combobox', { name: '执行副本' });
    expect(selector).toHaveValue('copy-current');
    fireEvent.change(selector, { target: { value: 'copy-old' } });
    await waitFor(() => expect(selector).toHaveValue('copy-old'));
    expect(screen.getByText('已过期')).toBeInTheDocument();
  });

  it('keeps viewers read-only when the selected branch has no reusable copy', async () => {
    const fetch = repositoryFetch([]);
    vi.stubGlobal('fetch', fetch);
    renderWithClient(<ExecutionWorkspace value={nodeWorkspace('viewer')} onSaved={vi.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('当前分支没有可用执行副本');
    expect(alert).toHaveTextContent('只读角色无法为当前分支创建执行副本');
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});

function renderWithClient(value: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{value}</QueryClientProvider>);
}

function repositoryFetch(workspaces: RepositoryWorkspace[] | (() => RepositoryWorkspace[]), override?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response | undefined>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const custom = await override?.(input, init);
    if (custom) return custom;
    const url = String(input);
    if (url.includes('/repository-connections')) return response({ items: [{ id: 'connection-1', project_id: 'project-1', full_name: 'acme/app', default_branch: 'main' }] });
    if (url.includes('/repository-branches')) return response({ project_id: 'project-1', connection_id: 'connection-1', default_branch: 'main', branches: [{ name: 'main', ref: 'main', sha: 'abcdef1234567890', source: 'local', full_ref: 'refs/heads/main' }] });
    if (url.endsWith('/projects/project-1/repository-workspaces')) return response({ items: typeof workspaces === 'function' ? workspaces() : workspaces });
    if (url.includes('/repository-workspaces/copy-current/files?')) return response({ entries: [] });
    if (url.includes('/repository-workspaces/copy-old/files?')) return response({ entries: [] });
    return response({ error: 'not_found' }, 404);
  });
}

function repositoryWorkspace(overrides: Partial<RepositoryWorkspace> = {}): RepositoryWorkspace {
  return {
    id: 'copy-current', project_id: 'project-1', connection_id: 'connection-1', ref: 'main', fixed_sha: 'abcdef1234567890', current_sha: 'abcdef1234567890',
    mode: 'read_write', scope: { type: 'task', id: 'node-1', path_prefixes: ['.'] }, sync_status: 'ready', stale: false, ahead: 0, behind: 0,
    dirty: false, status: 'ready', revision: 1, last_synced_at: '2026-07-21T00:00:00.000Z', pull_requests: [], ...overrides
  };
}

function nodeWorkspace(role: 'owner' | 'viewer' = 'owner'): NodeWorkspace {
  return {
    project: { id: 'project-1', title: 'Fixture', goal: '', status: 'active', current_workspace_id: 'workspace-1', current_user_role: role, repo_path: 'C:/repo' },
    workflow: { id: 'workflow-1', project_id: 'project-1', title: 'Workflow', status: 'active' },
    node: { id: 'node-1', workflow_id: 'workflow-1', workspace_id: 'workspace-1', type: 'execution', title: 'Execute', goal: '', status: 'ready', order_index: 0, dependencies: [] },
    contract: { id: 'contract-1', node_id: 'node-1', version: 1, node_goal: '', acceptance_criteria: [], allowed_tools: [], expected_inputs: [], expected_outputs: [] },
    workspace: { id: 'workspace-1', title: 'Execute', open_questions: [] }, data: {}, runs: [], code_changes: [], assets: [], traces: []
  };
}

function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
