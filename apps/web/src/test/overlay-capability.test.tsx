import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeWorkspace } from '../api/types';
import { AppShell } from '../components/shell/AppShell';
import { ExecutionWorkspace } from '../features/nodes/renderers/ExecutionWorkspace';
import { useUi } from '../state/ui';
import { ProposalDrawer } from '../components/proposals/ProposalDrawer';
import { ApprovalPrompt } from '../components/approvals/ApprovalPrompt';

vi.mock('@monaco-editor/react', () => ({ default: () => null }));
vi.mock('../monaco', () => ({}));

describe('overlay and capability contracts', () => {
  beforeEach(() => {
    useUi.getState().closeOverlay();
    useUi.setState({ contextNodeId: null, activeProjectId: null, toasts: [] });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('allows Assist, proposal prompt, and inspector to coexist while nav remains dismissible', () => {
    useUi.getState().setNav(true);
    expect(openOverlays()).toEqual(['nav']);

    useUi.getState().setAssist(true);
    expect(openOverlays()).toEqual(['assist']);

    useUi.getState().inspect('node-1');
    expect(openOverlays()).toEqual(['assist', 'inspector']);
    expect(useUi.getState().contextNodeId).toBe('node-1');

    useUi.getState().showProposal('proposal-1');
    expect(openOverlays()).toEqual(['assist', 'proposal', 'inspector']);
  });

  it('closes the active overlay with Escape and makes closed drawers inert', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([])));
    useUi.getState().inspect('node-1');
    renderShell();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUi.getState().inspectorNodeId).toBeNull();

    act(() => useUi.getState().setNav(true));
    const nav = document.querySelector<HTMLElement>('.nav-drawer');
    expect(nav).not.toHaveAttribute('inert');
    expect(document.querySelector('.assist-workbench')).not.toBeInTheDocument();
    expect(document.querySelector('.approval-center')).toHaveAttribute('inert');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(nav).toHaveAttribute('inert'));
    expect(openOverlays()).toEqual([]);
  });

  it('disables repository capabilities when a project is not bound', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    renderWithClient(<ExecutionWorkspace value={workspace()} onSaved={vi.fn()} />);

    expect(screen.getByText('未绑定 Repository')).toBeInTheDocument();
    expect(screen.getByText('Repository 文件能力不可用')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '测试任务' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '运行任务' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows a file-query failure and keeps repository actions disabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'repository_root_unavailable' }, 409)));
    renderWithClient(<ExecutionWorkspace value={workspace('C:/missing-repository')} onSaved={vi.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('文件加载失败');
    expect(alert).toHaveTextContent('repository_root_unavailable');
    expect(screen.getByRole('button', { name: '运行任务' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重新加载文件' })).toBeEnabled();
  });

  it('drives proposal approve and apply commands through the API', async () => {
    let status = 'pending';
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method || 'GET';
      calls.push(`${method} ${url}`);
      if (url.endsWith('/approve')) status = 'approved';
      if (url.endsWith('/apply')) { status = 'applied'; return jsonResponse({ proposal: proposal(status), applied: { type: 'record_only' } }); }
      return jsonResponse(method === 'GET' ? [proposal(status)] : proposal(status));
    }));
    useUi.getState().showProposal('proposal-1');
    renderWithClient(<ProposalDrawer projectId="project-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '批准' }));
    fireEvent.click(await screen.findByRole('button', { name: '应用变更' }));
    await waitFor(() => expect(calls.some((item) => item.endsWith('/change-proposals/proposal-1/apply'))).toBe(true));
  });

  it('persists Escape from the immediate prompt as a defer decision', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/approvals')) return jsonResponse([approval()]);
      if (url.endsWith('/decision')) return jsonResponse({ item: { ...approval(), attention_state: 'queued' } });
      return jsonResponse([]);
    }));
    useUi.getState().showProposal('proposal-1');
    renderWithClient(<MemoryRouter><ApprovalPrompt projectId="project-1" /></MemoryRouter>);
    expect(await screen.findByText('确认变更')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(calls.some((item) => item.url.endsWith('/approvals/change_proposal/proposal-1/decision') && (item.body as { decision?: string })?.decision === 'defer')).toBe(true));
    await waitFor(() => expect(useUi.getState().proposalId).toBeNull());
  });
});

function openOverlays() {
  const state = useUi.getState();
  return [state.navOpen && 'nav', state.assistOpen && 'assist', state.proposalId && 'proposal', state.inspectorNodeId && 'inspector'].filter(Boolean);
}

function renderShell() {
  return renderWithClient(<MemoryRouter initialEntries={['/projects']}><Routes><Route element={<AppShell />}><Route path="/projects" element={<div>Projects</div>} /></Route></Routes></MemoryRouter>);
}

function renderWithClient(value: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{value}</QueryClientProvider>);
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function proposal(status: string) { return { id: 'proposal-1', project_id: 'project-1', change_type: 'record', title: '确认变更', summary: '测试审批命令', before_json: null, after_json: {}, impact: [], risks: [], evidence_refs: [], status, created_at: new Date(0).toISOString() }; }
function approval() { return { ...proposal('pending'), type: 'proposal', attention_state: 'interrupting', revision: 2, target_hash: 'hash-2' }; }

function workspace(repoPath = ''): NodeWorkspace {
  return {
    project: { id: 'project-1', title: 'Fixture', goal: '', status: 'active', current_workspace_id: 'workspace-1', repo_path: repoPath },
    workflow: { id: 'workflow-1', project_id: 'project-1', title: 'Workflow', status: 'active' },
    node: { id: 'node-1', workflow_id: 'workflow-1', workspace_id: 'workspace-1', type: 'execution', title: 'Execute', goal: '', status: 'ready', order_index: 0, dependencies: [] },
    contract: { id: 'contract-1', node_id: 'node-1', version: 1, node_goal: '', acceptance_criteria: [], allowed_tools: [], expected_inputs: [], expected_outputs: [] },
    workspace: { id: 'workspace-1', title: 'Execute', open_questions: [] },
    data: {}, runs: [], code_changes: [], assets: [], traces: []
  };
}
