import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCenter } from '../components/approvals/ApprovalCenter';
import { invalidateApprovalState } from '../components/approvals/ApprovalPrompt';
import { AppShell } from '../components/shell/AppShell';
import { GoalCard } from '../features/assist/GoalCard';
import { NodeWorkspacePage } from '../features/nodes/NodeWorkspacePage';
import { markSavedSnapshot } from '../features/nodes/renderers/ExecutionWorkspace';
import { GoalWorkspace } from '../features/nodes/renderers/GoalWorkspace';
import { useUi } from '../state/ui';

describe('project and UI hardening audit', () => {
  beforeEach(() => {
    useUi.setState({ activeProjectId: 'project-a', assistOpen: false, contextLane: null, inspectorNodeId: null, proposalId: null, approvalCenterOpen: false, approvalSelectionId: null, toasts: [] });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('synchronizes the active project from every project child route', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/projects')) return response([project('project-a'), project('project-b')]);
      return response([]);
    }));
    const view = renderWithClient(<MemoryRouter initialEntries={['/projects/project-b/nodes/workflow-node-b']}><Routes><Route element={<AppShell />}><Route path="/projects/:projectId/nodes/:nodeId" element={<div>Node child</div>} /></Route></Routes></MemoryRouter>);
    expect(await screen.findByText('Node child')).toBeInTheDocument();
    expect(view.container.querySelector('.app-shell')).not.toHaveClass('canvas-route');
    await waitFor(() => expect(useUi.getState().activeProjectId).toBe('project-b'));
  });

  it('redirects a node URL to the project that actually owns the node', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(nodeWorkspace())));
    renderWithClient(<MemoryRouter initialEntries={['/projects/project-a/nodes/node-b']}><Routes><Route path="/projects/:projectId/nodes/:nodeId" element={<><NodeWorkspacePage /><Location /></>} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText('location')).toHaveTextContent('/projects/project-b/nodes/node-b'));
  });

  it('runs a retrospective node after its write proposal is applied', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/change-proposals') && method === 'POST') return response({ id: 'proposal-run', project_id: 'project-b', node_id: 'node-b', status: 'pending' });
      if (url.endsWith('/nodes/node-b/run/start') && method === 'POST') return response({ run: { id: 'run-b', status: 'queued' } });
      return response(nodeWorkspace('retrospective'));
    }));
    renderWithClient(<MemoryRouter initialEntries={['/projects/project-b/nodes/node-b']}><Routes><Route path="/projects/:projectId/nodes/:nodeId" element={<NodeWorkspacePage />} /></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '运行节点' }));
    await waitFor(() => expect(useUi.getState().proposalId).toBe('proposal-run'));
    expect(calls.find((item) => item.url.endsWith('/change-proposals') && item.method === 'POST')?.body).toMatchObject({
      project_id: 'project-b', node_id: 'node-b', change_type: 'node_run_write',
      apply_action: { type: 'node_run_authorization', node_id: 'node-b', runner: 'codex_docker' }
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('aiws:proposal-applied', { detail: { proposal: { id: 'proposal-run' }, applied: { type: 'node_run_authorization', node_id: 'node-b' } } }));
    });
    await waitFor(() => expect(calls.find((item) => item.url.endsWith('/nodes/node-b/run/start') && item.method === 'POST')?.body).toEqual({ runner: 'codex_docker', approval_id: 'proposal-run' }));
  });

  it('opens a mobile approval detail task before raising the decision prompt', async () => {
    useUi.setState({ approvalCenterOpen: true, approvalSelectionId: null, proposalId: null });
    vi.stubGlobal('fetch', vi.fn(async () => response([approval()])))
    const view = renderWithClient(<ApprovalCenter projectId="project-b" />);
    fireEvent.click(await screen.findByRole('button', { name: /Review mobile change/ }));
    expect(view.container.querySelector('.approval-center')).toHaveClass('mobile-detail');
    expect(screen.getByRole('button', { name: '返回审批列表' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /打开审批/ }));
    expect(useUi.getState()).toMatchObject({ approvalCenterOpen: false, proposalId: 'proposal-b' });
  });

  it('invalidates both the route project and the approval owner project', async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    await invalidateApprovalState({ invalidateQueries } as unknown as QueryClient, 'project-a', 'project-b');
    const keys = invalidateQueries.mock.calls.map(([input]) => JSON.stringify(input.queryKey));
    for (const id of ['project-a', 'project-b']) {
      expect(keys).toContain(JSON.stringify(['project', id]));
      expect(keys).toContain(JSON.stringify(['approvals', id]));
      expect(keys).toContain(JSON.stringify(['proposals', id]));
    }
  });

  it('acknowledges only the content snapshot sent to the file API', () => {
    const tabs = [{ path: 'src/index.ts', content: 'new edit during save', saved: 'old', language: 'typescript' }];
    expect(markSavedSnapshot(tabs, 'src/index.ts', 'submitted snapshot')[0]).toMatchObject({ content: 'new edit during save', saved: 'submitted snapshot' });
  });

  it('does not allow a busy Goal to enter edit mode', () => {
    render(<GoalCard goal={null} busy onSet={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByRole('button', { name: '设置线程 Goal' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '编辑 Goal' })).toBeDisabled();
  });

  it('gives the Goal open-questions editor a stable accessible name', () => {
    render(<GoalWorkspace value={nodeWorkspace()} onSaved={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByRole('textbox', { name: '待确认问题' })).toBeInTheDocument();
  });
});

function renderWithClient(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

function Location() { return <output aria-label="location">{useLocation().pathname}</output>; }
function response(value: unknown) { return Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })); }
function project(id: string) { return { id, title: id, goal: 'Ship', status: 'active', onboarding_state: 'confirmed', current_workspace_id: `workspace-${id}`, managed_workspace_state: 'ready' }; }
function approval() { return { id: 'proposal-b', type: 'proposal', project_id: 'project-b', title: 'Review mobile change', summary: 'Inspect this proposal before applying it.', status: 'pending', attention_state: 'queued', revision: 1, target_hash: 'hash-b', created_at: new Date(0).toISOString(), impact: ['Workflow'], risks: ['Review required'] }; }
function nodeWorkspace(type: 'goal_definition' | 'retrospective' = 'goal_definition') {
  return {
    project: project('project-b'), workflow: { id: 'workflow-b', project_id: 'project-b', title: 'Workflow B', status: 'active' },
    node: { id: 'node-b', workflow_id: 'workflow-b', workspace_id: 'workspace-node-b', type, title: 'Goal B', goal: 'Ship B', status: 'ready', order_index: 0, dependencies: [] },
    workspace: { id: 'workspace-node-b', project_id: 'project-b', workflow_node_id: 'node-b', title: 'Goal B', status: 'active', open_questions: [] },
    contract: { id: 'contract-b', node_id: 'node-b', version: 1, node_goal: 'Ship B', acceptance_criteria: [], allowed_tools: [], expected_inputs: [], expected_outputs: [] },
    data: {}, runs: [], code_changes: [], assets: [], traces: []
  };
}
