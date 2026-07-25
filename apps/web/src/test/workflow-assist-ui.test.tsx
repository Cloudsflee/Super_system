import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistOperation } from '../api/types';
import { describeAssistSurface } from '../components/assist/semantic-actions';
import { ContextMenuProvider } from '../components/common/ContextMenu';
import { OperationReceipt } from '../features/assist/OperationReceipt';
import { WorkflowPage } from '../features/workflow/WorkflowPage';
import { useUi } from '../state/ui';

describe('formal workflow Assist UI', () => {
  beforeEach(() => { useUi.setState({ proposalId: null, inspectorNodeId: null, assistOpen: false, contextLane: null, inspectorMode: 'expanded' }); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('registers the exact workflow id and semantic version as the Assist surface', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(bundle())));
    renderWithClient(<MemoryRouter initialEntries={['/projects/project-1/workflow']}><Routes><Route path="/projects/:projectId/workflow" element={<WorkflowPage />} /></Routes></MemoryRouter>);
    expect(await screen.findByText('Formal workflow')).toBeInTheDocument();
    await waitFor(() => expect(describeAssistSurface()).toMatchObject({ id: 'workflow-workflow-1', revision: 'workflow-1:v4' }));
  });

  it('renders only the latest non-archived workflow and maps review-ready nodes to completed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(multiWorkflowBundle())));
    renderWithClient(<MemoryRouter initialEntries={['/projects/project-1/workflow']}><Routes><Route path="/projects/:projectId/workflow" element={<WorkflowPage />} /></Routes></MemoryRouter>);
    expect(await screen.findByText('Current node')).toBeInTheDocument();
    expect(screen.queryByText('Archived node')).not.toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    await waitFor(() => expect(describeAssistSurface()).toMatchObject({ id: 'workflow-workflow-current', revision: 'workflow-current:v7' }));
  });

  it('renders proposal semantics and never offers direct Undo for a formal graph proposal', () => {
    render(<OperationReceipt operation={proposalOperation()} busy={false} onConfirm={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.getByText('已创建工作流变更提案 · Formal workflow')).toBeInTheDocument();
    expect(screen.getByText('待审批')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '直接编辑' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '定位工作流' })).toHaveAttribute('href', '/projects/project-1/workflow#workflow-1');
    fireEvent.click(screen.getByRole('button', { name: '审查提案' }));
    expect(useUi.getState().proposalId).toBe('proposal-1');
  });

  it('shares node actions across pointer and keyboard menus and creates proposals without mutating the graph', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body });
      if (url.endsWith('/projects/project-1')) return response(nodeBundle());
      if (url.endsWith('/workflows/workflow-1/graph-proposals')) return response({ id: 'proposal-remove', project_id: 'project-1', title: 'Remove', summary: '', change_type: 'workflow_graph_patch', status: 'pending', created_at: new Date(0).toISOString() });
      return response([]);
    }));
    renderWithClient(<ContextMenuProvider><MemoryRouter initialEntries={['/projects/project-1/workflow']}><Routes><Route path="/projects/:projectId/workflow" element={<WorkflowPage />} /></Routes></MemoryRouter></ContextMenuProvider>);
    const title = await screen.findByText('Execute launch'), card = title.closest<HTMLElement>('.workspace-node')!;
    expect(card).toHaveTextContent('就绪');
    fireEvent.contextMenu(card, { clientX: 120, clientY: 120 });
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    for (const label of ['查看详情', '进入工作区', '让智能助手优化', '编辑节点', '移除节点']) expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    card.focus();
    fireEvent.keyDown(card, { key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menuitem', { name: '编辑节点' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    const more = card.querySelector<HTMLButtonElement>('[aria-label="更多节点操作"]')!;
    fireEvent.click(more);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(more).toHaveFocus());
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: '移除节点' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/workflows/workflow-1/graph-proposals'))).toBe(true));
    expect(calls.find((call) => call.url.endsWith('/workflows/workflow-1/graph-proposals'))?.body).toMatchObject({ parent_node_id: null, expected_revision: 4, operations: [{ type: 'delete_node', node_id: 'node-1' }] });
    expect(screen.getByText('Execute launch')).toBeInTheDocument();
    expect(useUi.getState().proposalId).toBe('proposal-remove');
  });
});

function renderWithClient(value: ReactNode) { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); return render(<QueryClientProvider client={client}>{value}</QueryClientProvider>); }
function response(value: unknown) { return Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })); }
function bundle() { return { project: { id: 'project-1', title: 'Formal', goal: 'Ship', status: 'active', onboarding_state: 'confirmed', current_workspace_id: 'workspace-1' }, workflows: [{ id: 'workflow-1', project_id: 'project-1', title: 'Formal workflow', status: 'active', version: 4 }], nodes: [], contracts: [], assets: [], runs: [] }; }
function multiWorkflowBundle() { return { ...bundle(), workflows: [{ id: 'workflow-archived', project_id: 'project-1', title: 'Archived workflow', status: 'archived', version: 9 }, { id: 'workflow-current', project_id: 'project-1', title: 'Current workflow', status: 'active', version: 7 }], nodes: [workstreamNode({ id: 'archived-node', workflow_id: 'workflow-archived', title: 'Archived node', goal: 'Old', status: 'ready' }), workstreamNode({ id: 'current-node', workflow_id: 'workflow-current', title: 'Current node', goal: 'Ship', status: 'needs_review' })] }; }
function nodeBundle() { return { ...bundle(), nodes: [workstreamNode({ id: 'node-1', workflow_id: 'workflow-1', workspace_id: 'workspace-1', title: 'Execute launch', goal: 'Ship the verified release', status: 'ready', position: { x: 100, y: 100 }, output_count: 1, pending_approval_count: 0 })] }; }
function workstreamNode(value: Record<string, unknown>) { return { type: 'workstream', role: 'workstream', outcome: value.goal || value.title, category: 'deliverable', boundary: { deliverable: value.id }, acceptance_criteria: ['Accepted'], plan_revision: 1, order_index: 0, dependencies: [], ...value }; }
function proposalOperation(): AssistOperation { return { id: 'operation-1', session_id: 'session-1', turn_id: 'turn-1', project_id: 'project-1', capability_id: 'project.workflow.graph.patch', action: 'patch', result_kind: 'change_proposal', proposal_id: 'proposal-1', proposal_status: 'pending', proposal_destructive: true, target_id: 'workflow-1', target_label: 'Formal workflow', summary: '已创建工作流变更提案 · Formal workflow', route: '/projects/project-1/workflow', surface_id: 'workflow-workflow-1', surface_revision: 'workflow-1:v4', status: 'committed', risk: 'low', revision: 2, forced: false, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() }; }
