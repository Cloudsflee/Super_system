import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys } from '../api/queries';
import { WorkflowPage } from '../features/workflow/WorkflowPage';
import { WorkstreamPage } from '../features/workflow/WorkstreamPage';
import { useUi } from '../state/ui';

describe('V1.9 workflow process UI', () => {
  beforeEach(() => {
    useUi.setState({ proposalId: null, contextNodeId: null, inspectorNodeId: null, assistOpen: false, contextLane: null });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('opens a verified workflow on the complete Task DAG with typed asset lineage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(bundle())));
    renderPage(<WorkflowPage />, '/projects/project-1/workflow', '/projects/:projectId/workflow');
    expect(await screen.findByRole('heading', { name: 'Delivery workflow' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '完整流程' })).toHaveAttribute('aria-selected', 'true');
    const coverage = screen.getByRole('list', { name: '六阶段覆盖' });
    expect(within(coverage).getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByRole('heading', { name: 'Collect evidence' })).toBeInTheDocument();
    expect(screen.getByText('等待 Decide and implement')).toBeInTheDocument();
    expect(screen.getByText(/Research dossier @ version-so -> 当前输入 -> Decision record @ version-de/)).toBeInTheDocument();
    expect(screen.getAllByText('Typed inputs')).toHaveLength(3);
    expect(screen.getByText('里程碑')).toBeInTheDocument();
  });

  it('moves an already-open workflow to the Task DAG after a verified replan lands', async () => {
    const initial = bundle();
    initial.workflows[0].planning_quality = 'legacy_unverified';
    vi.stubGlobal('fetch', vi.fn(async () => response(initial)));
    const { client } = renderPage(<WorkflowPage />, '/projects/project-1/workflow', '/projects/:projectId/workflow');
    expect(await screen.findByRole('tab', { name: '成果视图' })).toHaveAttribute('aria-selected', 'true');

    const replanned = bundle();
    replanned.workflows[0].workflow_revision = 8;
    replanned.workflows[0].version = 8;
    client.setQueryData(keys.project('project-1'), replanned);

    await waitFor(() => expect(screen.getByRole('tab', { name: '完整流程' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('heading', { name: 'Collect evidence' })).toBeInTheDocument();
  });

  it('reviews a replan diff and creates a proposal without replacing the formal workflow', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = String(init?.method || 'GET'), body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/projects/project-1')) return response(bundle());
      if (url.includes('/workflow-draft/generations?')) return response({ items: [generation()] });
      if (url.endsWith('/workflow-draft/generations/generation-1')) return response(generation());
      if (url.endsWith('/workflow-draft/generations/generation-1/apply')) return response({ generation: { ...generation(), result_mode: 'replan_change_proposal_created', change_proposal_id: 'proposal-1' }, proposal: proposal() });
      return response({ error: 'not_found' }, 404);
    }));
    renderPage(<WorkflowPage />, '/projects/project-1/workflow', '/projects/:projectId/workflow');
    await screen.findByRole('heading', { name: 'Delivery workflow' });
    fireEvent.click(screen.getByRole('button', { name: '重新规划' }));
    expect(await screen.findByText('Candidate verification')).toBeInTheDocument();
    expect(screen.getByLabelText('重新规划差异摘要')).toHaveTextContent('1修改');
    fireEvent.click(screen.getByRole('button', { name: '创建变更提案' }));
    await waitFor(() => expect(useUi.getState().proposalId).toBe('proposal-1'));
    const apply = calls.find((item) => item.url.endsWith('/generation-1/apply'));
    expect(apply).toMatchObject({ method: 'POST', body: { expected_revision: 7 } });
    expect(calls.filter((item) => item.url.endsWith('/projects/project-1'))).toHaveLength(1);
  });

  it('gives every Task a unique primary open action with an ArrowRight icon', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/workflows/workflow-1/graph') ? response(graph()) : response(bundle())));
    renderPage(<WorkstreamPage />, '/projects/project-1/workflow/workstream-1', '/projects/:projectId/workflow/:workstreamId');
    const first = await screen.findByRole('button', { name: '打开任务：Collect evidence' });
    const second = screen.getByRole('button', { name: '打开任务：Decide and implement' });
    expect(first).toHaveClass('task-open-primary');
    expect(first.querySelector('.lucide-arrow-right')).toBeInTheDocument();
    expect(second).toHaveClass('task-open-primary');
  });
});

function renderPage(element: ReactNode, entry: string, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } } });
  const result = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}><Routes><Route path={path} element={element} /><Route path="/projects/:projectId/nodes/:nodeId" element={<div>Task workspace</div>} /></Routes></MemoryRouter></QueryClientProvider>);
  return { ...result, client };
}

function bundle() {
  return {
    project: { id: 'project-1', title: 'Release project', goal: 'Ship safely', status: 'active', onboarding_state: 'confirmed', current_workspace_id: 'workspace-1', current_user_role: 'owner' },
    workflows: [{ id: 'workflow-1', project_id: 'project-1', title: 'Delivery workflow', status: 'active', version: 7, workflow_revision: 7, hierarchy_mode: 'two_level', planning_quality: 'verified', project_classification: 'software_delivery', brief_coverage: { features: ['task-2'], acceptance_criteria: ['task-3'], milestones: ['task-3'], risks: ['task-1'] } }],
    nodes: nodes(), contracts: contracts(), runs: [{ id: 'run-3', node_id: 'task-3', status: 'completed', summary: '', created_at: new Date(0).toISOString(), input_superseded: true }],
    assets: [
      { id: 'asset-source', project_id: 'project-1', node_id: 'task-1', title: 'Research dossier', asset_type: 'ResearchEvidenceAsset', status: 'confirmed', current_version_id: 'version-source-1', updated_at: new Date(0).toISOString() },
      { id: 'asset-decision', project_id: 'project-1', node_id: 'task-2', title: 'Decision record', asset_type: 'DecisionAsset', status: 'confirmed', current_version_id: 'version-decision-1', updated_at: new Date(0).toISOString() }
    ],
    asset_versions: [{ id: 'version-source-1', asset_id: 'asset-source', title: 'Research v1' }, { id: 'version-decision-1', asset_id: 'asset-decision', title: 'Decision v1' }],
    asset_relations: [{ id: 'relation-1', relation_type: 'derived_from', source_asset_id: 'asset-source', source_asset_version_id: 'version-source-1', target_asset_id: 'asset-decision', target_asset_version_id: 'version-decision-1' }],
    submissions: [{ id: 'submission-1', node_id: 'task-2', status: 'accepted', output_bindings: [{ key: 'decision', asset_id: 'asset-decision', version_id: 'version-decision-1' }] }], membership: { project_id: 'project-1', user_id: 'owner', role: 'owner' }
  };
}

function nodes() {
  return [
    { id: 'workstream-1', workflow_id: 'workflow-1', type: 'workstream', role: 'workstream', title: 'Verified increment', goal: 'Deliver a verified increment', outcome: 'A fixed, tested product increment', category: 'deliverable', status: 'ready', order_index: 0, dependencies: [], acceptance_criteria: ['Accepted'] },
    task('task-1', 'Collect evidence', 'research', 'completed', [], ['research_evidence', 'constraint_analysis'], 1),
    task('task-2', 'Decide and implement', 'code', 'ready', ['task-1'], ['solution_decision', 'execution'], 2),
    task('task-3', 'Verify and deliver', 'test', 'blocked', ['task-2'], ['acceptance', 'integration_delivery'], 3)
  ];
}
function task(id: string, title: string, kind: string, status: string, dependencies: string[], tags: string[], order: number) { return { id, workflow_id: 'workflow-1', parent_node_id: 'workstream-1', type: 'task', role: 'task', title, goal: `${title} goal`, task_kind: kind, execution_mode: kind === 'research' ? 'assist' : 'codex', status, order_index: order, dependencies: dependencies.map((node_id) => ({ node_id, type: 'finish_to_start' })), capability_tags: tags, acceptance_criteria: [`${title} accepted`], repository_target_ids: [] }; }
function contracts() { return nodes().filter((item) => item.role === 'task').map((item, index) => ({ id: `contract-${index + 1}`, node_id: item.id, version: 1, contract_schema_version: 2, node_goal: item.goal, acceptance_criteria: item.acceptance_criteria, allowed_tools: [], expected_inputs: index ? [{ key: `upstream_${index}`, kind: 'asset_version', required: true, source: 'dependency', selector: 'required_outputs', ref_id: `task-${index}`, version_id: null }] : [{ key: 'project_brief', kind: 'context', required: true, source: 'brief', selector: 'current', ref_id: null, version_id: null }], expected_outputs: [{ key: index === 0 ? 'evidence' : index === 1 ? 'decision' : 'verification', kind: 'asset', required: true, asset_type: index === 0 ? 'ResearchEvidenceAsset' : index === 1 ? 'DecisionAsset' : 'TestEvidenceAsset', acceptance_criteria: item.acceptance_criteria, confirmation_policy: index < 2 ? 'human' : 'system_evidence' }] })); }
function graph() { return { project: bundle().project, workflow: bundle().workflows[0], parent: nodes()[0], parent_node_id: 'workstream-1', revision: 7, nodes: nodes().slice(1), graph: { nodes: nodes().slice(1).map((item, index) => ({ id: item.id, type: 'task', label: item.title, position: { x: index * 220, y: 100 } })), edges: [{ id: 'edge-1', source: 'task-1', target: 'task-2' }, { id: 'edge-2', source: 'task-2', target: 'task-3' }] } }; }
function generation() { const current = nodes().map((item) => ({ ...item, dependency_ids: item.dependencies.map((entry) => entry.node_id) })); const candidate = current.map((item) => item.id === 'task-3' ? { ...item, title: 'Candidate verification' } : item); return { id: 'generation-1', project_id: 'project-1', workflow_id: 'workflow-1', mode: 'replan', status: 'completed', phase: 'completed', result_mode: 'replan_diff', candidate: { nodes: candidate, confidence: .88 }, diff: { workflow_id: 'workflow-1', from_revision: 7, current_nodes: current, candidate_nodes: candidate } }; }
function proposal() { return { id: 'proposal-1', project_id: 'project-1', workflow_id: 'workflow-1', title: 'Replan', summary: 'Review replacement', change_type: 'workflow_replan_replace', status: 'pending', created_at: new Date(0).toISOString() }; }
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
