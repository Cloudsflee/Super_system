import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys } from '../api/queries';
import { WorkflowPage } from '../features/workflow/WorkflowPage';
import { WorkstreamPage } from '../features/workflow/WorkstreamPage';
import { useUi } from '../state/ui';

describe('V1.9 workflow process density and topology', () => {
  beforeEach(setupWorkflowProcessUi);
  afterEach(cleanupWorkflowProcessUi);

  it('defaults to comfortable density and keeps full single-open details across density changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(bundle()))
    );
    const { container } = renderPage(<WorkflowPage />, '/projects/project-1/workflow', '/projects/:projectId/workflow');
    expect(await screen.findByRole('heading', { name: 'Delivery workflow' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '完整流程' })).toHaveAttribute('aria-selected', 'true');
    const coverage = screen.getByRole('list', { name: '六阶段覆盖' });
    expect(within(coverage).getAllByRole('listitem')).toHaveLength(6);
    const process = screen.getByRole('region', { name: '完整任务流程' });
    expect(process).toHaveAttribute('data-density', 'comfortable');
    fireEvent.click(screen.getByRole('button', { name: /显示设置，当前舒适/ }));
    expect(screen.getByRole('menuitemradio', { name: '舒适' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(screen.getByRole('menu', { name: '显示密度' }), { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'Collect evidence' })).toBeInTheDocument();
    expect(screen.getByText('收集可追溯发布证据。')).toBeInTheDocument();
    expect(screen.queryByText('Collect traceable release evidence.')).not.toBeInTheDocument();
    expect(container.querySelector('.workflow-code-bubble')).not.toBeInTheDocument();
    expect(screen.queryByText('23:50')).not.toBeInTheDocument();
    expect(screen.queryByText('Asia/Shanghai')).not.toBeInTheDocument();
    expect(screen.getByLabelText('已设置调度参数')).toHaveAttribute('data-tooltip', '已设置调度');
    expect(screen.queryByText('外部证据')).not.toBeInTheDocument();
    expect(screen.getByText('上次执行失败：上游模型服务返回 502 Bad Gateway')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '任务详情：Decide and implement' })).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Research dossier @ version-so -> 当前输入 -> Decision record @ version-de/)
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Decide and implement 执行摘要')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.workflow-topology-edge')).toHaveLength(2);
    const collectRow = screen.getByRole('heading', { name: 'Collect evidence' }).closest('article') as HTMLElement;
    const decisionRow = screen.getByRole('heading', { name: 'Decide and implement' }).closest('article') as HTMLElement;
    const verifyRow = screen.getByRole('heading', { name: 'Verify and deliver' }).closest('article') as HTMLElement;
    expect(verifyRow).toHaveAttribute('data-assist-scope-type', 'task');
    expect(verifyRow).toHaveAttribute('data-assist-scope-id', 'task-3');
    expect(verifyRow).toHaveAttribute(
      'data-assist-scope-lock-reason',
      '上次执行失败：上游模型服务返回 502 Bad Gateway'
    );
    fireEvent.pointerEnter(decisionRow, { pointerType: 'mouse' });
    expect(collectRow).toHaveClass('topology-upstream');
    expect(decisionRow).toHaveClass('topology-active');
    expect(verifyRow).toHaveClass('topology-downstream');
    expect(container.querySelectorAll('.workflow-topology-edge.upstream')).toHaveLength(1);
    expect(container.querySelectorAll('.workflow-topology-edge.downstream')).toHaveLength(1);
    fireEvent.pointerLeave(decisionRow, { pointerType: 'mouse' });
    expect(screen.getByRole('button', { name: '任务已锁定：Verify and deliver' })).toBeDisabled();
    expect(screen.getByRole('link', { name: '进入任务工作台：Decide and implement' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看代码：Verified increment' })).toHaveAttribute(
      'href',
      '/projects/project-1/nodes/workstream-1'
    );

    fireEvent.click(screen.getByRole('button', { name: '展开任务详情：Collect evidence' }));
    const collectDetails = screen.getByRole('region', { name: '任务详情：Collect evidence' });
    expect(within(collectDetails).getByText('收集可追溯发布证据。')).toBeInTheDocument();
    expect(
      within(collectDetails).getByLabelText('命令行：node src/cli.mjs collect --date 2026-07-23')
    ).toBeInTheDocument();
    expect(within(collectDetails).getByText('23:50')).toBeInTheDocument();
    expect(within(collectDetails).getByText('Asia/Shanghai')).toBeInTheDocument();
    expect(within(collectDetails).getByLabelText('Collect evidence 执行摘要')).toHaveTextContent(
      '0前置1输入1输出1版本'
    );

    selectDensity('紧凑');
    expect(process).toHaveAttribute('data-density', 'compact');
    expect(screen.getByRole('region', { name: '任务详情：Collect evidence' })).toBeInTheDocument();
    expect(
      within(
        screen.getByRole('heading', { name: 'Collect evidence' }).closest('.workflow-task-summary') as HTMLElement
      ).queryByText('收集可追溯发布证据。')
    ).not.toBeInTheDocument();

    selectDensity('详细');
    expect(process).toHaveAttribute('data-density', 'detailed');
    expect(screen.getByRole('region', { name: '任务详情：Collect evidence' })).toBeInTheDocument();
    const detailedSummary = screen
      .getByRole('heading', { name: 'Collect evidence' })
      .closest('.workflow-task-summary') as HTMLElement;
    expect(within(detailedSummary).getByText('收集可追溯发布证据。')).toBeInTheDocument();
    expect(within(detailedSummary).getByText('23:50')).toBeInTheDocument();
    expect(within(detailedSummary).getByLabelText('Collect evidence 执行摘要')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开任务详情：Verify and deliver' }));
    expect(screen.queryByRole('region', { name: '任务详情：Collect evidence' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: '任务详情：Verify and deliver' })).getByText('里程碑')
    ).toBeInTheDocument();
  });

  it('uses delayed fine-pointer previews, immediate keyboard previews, and no touch hover', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(bundle()))
    );
    renderPage(<WorkflowPage />, '/projects/project-1/workflow', '/projects/:projectId/workflow');
    await screen.findByRole('heading', { name: 'Delivery workflow' });
    const row = screen.getByRole('heading', { name: 'Collect evidence' }).closest('article') as HTMLElement;
    vi.useFakeTimers();

    fireEvent.pointerEnter(row, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(249));
    expect(screen.queryByRole('tooltip', { name: '任务快速预览：Collect evidence' })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    const preview = screen.getByRole('tooltip', { name: '任务快速预览：Collect evidence' });
    expect(within(preview).getByText('收集可追溯发布证据。')).toBeInTheDocument();
    expect(within(preview).getByLabelText('命令行：node src/cli.mjs collect --date 2026-07-23')).toBeInTheDocument();
    expect(within(preview).getByText('23:50')).toBeInTheDocument();
    expect(within(preview).getByText('Asia/Shanghai')).toBeInTheDocument();
    expect(within(preview).getByLabelText('Collect evidence 执行摘要')).toHaveTextContent('0前置1输入1输出1版本');

    fireEvent.pointerLeave(row, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(99));
    expect(screen.getByRole('tooltip', { name: '任务快速预览：Collect evidence' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('tooltip', { name: '任务快速预览：Collect evidence' })).not.toBeInTheDocument();

    const disclosure = screen.getByRole('button', { name: '展开任务详情：Collect evidence' });
    fireEvent.focus(disclosure);
    expect(screen.getByRole('tooltip', { name: '任务快速预览：Collect evidence' })).toBeInTheDocument();
    fireEvent.blur(disclosure, { relatedTarget: null });
    expect(screen.queryByRole('tooltip', { name: '任务快速预览：Collect evidence' })).not.toBeInTheDocument();

    fireEvent.pointerEnter(row, { pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole('tooltip', { name: '任务快速预览：Collect evidence' })).not.toBeInTheDocument();
  });

  it('keeps topology endpoints on real anchors while hover, density, and disclosure reflow rows', async () => {
    mockWorkflowRects();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(bundle()))
    );
    const { container } = renderPage(<WorkflowPage />, '/projects/project-1/workflow', '/projects/:projectId/workflow');
    await screen.findByRole('heading', { name: 'Delivery workflow' });
    expectTopologyAnchors(container);
    const beforeHover = topologyPaths(container);
    const firstRow = container.querySelector<HTMLElement>('[data-task-id="task-1"]') as HTMLElement;
    fireEvent.pointerEnter(firstRow, { pointerType: 'mouse' });
    expect(topologyPaths(container)).toEqual(beforeHover);

    selectDensity('详细');
    const afterDensity = topologyPaths(container);
    expect(afterDensity).not.toEqual(beforeHover);
    expectTopologyAnchors(container);

    fireEvent.click(screen.getByRole('button', { name: '展开任务详情：Collect evidence' }));
    const afterDisclosure = topologyPaths(container);
    expect(afterDisclosure).not.toEqual(afterDensity);
    expectTopologyAnchors(container);
  });
});

describe('V1.9 workflow replanning and task actions', () => {
  beforeEach(setupWorkflowProcessUi);
  afterEach(cleanupWorkflowProcessUi);

  it('moves an already-open workflow to the Task DAG after a verified replan lands', async () => {
    const initial = bundle();
    initial.workflows[0].planning_quality = 'legacy_unverified';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(initial))
    );
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input),
          method = String(init?.method || 'GET'),
          body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (url.endsWith('/projects/project-1')) return response(bundle());
        if (url.includes('/workflow-draft/generations?')) return response({ items: [generation()] });
        if (url.endsWith('/workflow-draft/generations/generation-1')) return response(generation());
        if (url.endsWith('/workflow-draft/generations/generation-1/apply'))
          return response({
            generation: {
              ...generation(),
              result_mode: 'replan_change_proposal_created',
              change_proposal_id: 'proposal-1'
            },
            proposal: proposal()
          });
        return response({ error: 'not_found' }, 404);
      })
    );
    renderPage(<WorkflowPage />, '/projects/project-1/workflow', '/projects/:projectId/workflow');
    await screen.findByRole('heading', { name: 'Delivery workflow' });
    const replan = screen.getByRole('button', { name: '重新规划' });
    expect(replan).toHaveClass('icon-button');
    expect(replan.textContent).toBe('');
    fireEvent.click(replan);
    expect(await screen.findByText('Candidate verification')).toBeInTheDocument();
    expect(screen.getByLabelText('重新规划差异摘要')).toHaveTextContent('1修改');
    fireEvent.click(screen.getByRole('button', { name: '创建变更提案' }));
    await waitFor(() => expect(useUi.getState().proposalId).toBe('proposal-1'));
    const apply = calls.find((item) => item.url.endsWith('/generation-1/apply'));
    expect(apply).toMatchObject({ method: 'POST', body: { expected_revision: 7 } });
    expect(calls.filter((item) => item.url.endsWith('/projects/project-1'))).toHaveLength(1);
  });

  it('gives every Task a unique primary open action with an ArrowRight icon', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/workflows/workflow-1/graph') ? response(graph()) : response(bundle())
      )
    );
    renderPage(
      <WorkstreamPage />,
      '/projects/project-1/workflow/workstream-1',
      '/projects/:projectId/workflow/:workstreamId'
    );
    const first = await screen.findByRole('button', { name: '进入任务工作台：Collect evidence' });
    const second = screen.getByRole('button', { name: '进入任务工作台：Decide and implement' });
    expect(first).toHaveClass('task-open-primary');
    expect(first.querySelector('.lucide-arrow-right')).toBeInTheDocument();
    expect(second).toHaveClass('task-open-primary');
    expect(screen.getByRole('link', { name: '查看代码：Verified increment' })).toHaveAttribute(
      'href',
      '/projects/project-1/nodes/workstream-1'
    );
  });
});

function setupWorkflowProcessUi() {
  localStorage.clear();
  useUi.setState({
    proposalId: null,
    contextNodeId: null,
    inspectorNodeId: null,
    assistOpen: false,
    contextLane: null,
    workflowTaskDensity: 'comfortable'
  });
  vi.stubGlobal(
    'PointerEvent',
    class TestPointerEvent extends MouseEvent {
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType || '';
      }
    }
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
}

function cleanupWorkflowProcessUi() {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

function renderPage(element: ReactNode, entry: string, path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } }
  });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path={path} element={element} />
          <Route path="/projects/:projectId/nodes/:nodeId" element={<div>Task workspace</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...result, client };
}
function selectDensity(label: '紧凑' | '舒适' | '详细') {
  fireEvent.click(screen.getByRole('button', { name: /显示设置/ }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: label }));
}

function bundle() {
  return {
    project: {
      id: 'project-1',
      title: 'Release project',
      goal: 'Ship safely',
      status: 'active',
      onboarding_state: 'confirmed',
      current_workspace_id: 'workspace-1',
      current_user_role: 'owner'
    },
    workflows: [
      {
        id: 'workflow-1',
        project_id: 'project-1',
        title: 'Delivery workflow',
        status: 'active',
        version: 7,
        workflow_revision: 7,
        hierarchy_mode: 'two_level',
        planning_quality: 'verified',
        project_classification: 'software_delivery',
        brief_coverage: {
          features: ['task-2'],
          acceptance_criteria: ['task-3'],
          milestones: ['task-3'],
          risks: ['task-1']
        }
      }
    ],
    nodes: nodes(),
    contracts: contracts(),
    runs: [
      {
        id: 'run-3',
        node_id: 'task-3',
        status: 'completed',
        summary: '',
        created_at: new Date(0).toISOString(),
        input_superseded: true
      }
    ],
    assets: [
      {
        id: 'asset-source',
        project_id: 'project-1',
        node_id: 'task-1',
        title: 'Research dossier',
        asset_type: 'ResearchEvidenceAsset',
        status: 'confirmed',
        current_version_id: 'version-source-1',
        updated_at: new Date(0).toISOString()
      },
      {
        id: 'asset-decision',
        project_id: 'project-1',
        node_id: 'task-2',
        title: 'Decision record',
        asset_type: 'DecisionAsset',
        status: 'confirmed',
        current_version_id: 'version-decision-1',
        updated_at: new Date(0).toISOString()
      }
    ],
    asset_versions: [
      { id: 'version-source-1', asset_id: 'asset-source', title: 'Research v1' },
      { id: 'version-decision-1', asset_id: 'asset-decision', title: 'Decision v1' }
    ],
    asset_relations: [
      {
        id: 'relation-1',
        relation_type: 'derived_from',
        source_asset_id: 'asset-source',
        source_asset_version_id: 'version-source-1',
        target_asset_id: 'asset-decision',
        target_asset_version_id: 'version-decision-1'
      }
    ],
    submissions: [
      {
        id: 'submission-1',
        node_id: 'task-2',
        status: 'accepted',
        output_bindings: [{ key: 'decision', asset_id: 'asset-decision', version_id: 'version-decision-1' }]
      }
    ],
    membership: { project_id: 'project-1', user_id: 'owner', role: 'owner' }
  };
}

function nodes() {
  return [
    {
      id: 'workstream-1',
      workflow_id: 'workflow-1',
      type: 'execution',
      role: 'workstream',
      title: 'Verified increment',
      goal: 'Deliver a verified increment',
      outcome: 'A fixed, tested product increment',
      category: 'deliverable',
      status: 'ready',
      order_index: 0,
      dependencies: [],
      acceptance_criteria: ['Accepted'],
      repository_target_ids: ['repository-target-1']
    },
    task(
      'task-1',
      'Collect evidence',
      'research',
      'completed',
      [],
      ['research_evidence', 'constraint_analysis'],
      1,
      '收集可追溯发布证据。 Collect traceable release evidence. CLI: `node src/cli.mjs collect --date 2026-07-23`. Run at 23:50 Asia/Shanghai.'
    ),
    task('task-2', 'Decide and implement', 'code', 'ready', ['task-1'], ['solution_decision', 'execution'], 2),
    task('task-3', 'Verify and deliver', 'test', 'blocked', ['task-2'], ['acceptance', 'integration_delivery'], 3)
  ];
}
function task(
  id: string,
  title: string,
  kind: string,
  status: string,
  dependencies: string[],
  tags: string[],
  order: number,
  goal = `${title} goal`
) {
  return {
    id,
    workflow_id: 'workflow-1',
    parent_node_id: 'workstream-1',
    type: 'task',
    role: 'task',
    title,
    goal,
    task_kind: kind,
    execution_mode: kind === 'research' ? 'assist' : 'codex',
    status,
    execution_evidence_status: 'external_unverified',
    order_index: order,
    dependencies: dependencies.map((node_id) => ({ node_id, type: 'finish_to_start' })),
    capability_tags: tags,
    acceptance_criteria: [`${title} accepted`],
    repository_target_ids: [],
    ...(id === 'task-3'
      ? {
          latest_run: {
            id: 'run-task-3',
            status: 'partial',
            summary: '上游模型服务返回 502 Bad Gateway'
          }
        }
      : {})
  };
}
function contracts() {
  return nodes()
    .filter((item) => item.role === 'task')
    .map((item, index) => ({
      id: `contract-${index + 1}`,
      node_id: item.id,
      version: 1,
      contract_schema_version: 2,
      node_goal: item.goal,
      acceptance_criteria: item.acceptance_criteria,
      allowed_tools: [],
      expected_inputs: index
        ? [
            {
              key: `upstream_${index}`,
              kind: 'asset_version',
              required: true,
              source: 'dependency',
              selector: 'required_outputs',
              ref_id: `task-${index}`,
              version_id: null
            }
          ]
        : [
            {
              key: 'project_brief',
              kind: 'context',
              required: true,
              source: 'brief',
              selector: 'current',
              ref_id: null,
              version_id: null
            }
          ],
      expected_outputs: [
        {
          key: index === 0 ? 'evidence' : index === 1 ? 'decision' : 'verification',
          kind: 'asset',
          required: true,
          asset_type: index === 0 ? 'ResearchEvidenceAsset' : index === 1 ? 'DecisionAsset' : 'TestEvidenceAsset',
          acceptance_criteria: item.acceptance_criteria,
          confirmation_policy: index < 2 ? 'human' : 'system_evidence'
        }
      ]
    }));
}
function graph() {
  return {
    project: bundle().project,
    workflow: bundle().workflows[0],
    parent: nodes()[0],
    parent_node_id: 'workstream-1',
    revision: 7,
    nodes: nodes().slice(1),
    graph: {
      nodes: nodes()
        .slice(1)
        .map((item, index) => ({ id: item.id, type: 'task', label: item.title, position: { x: index * 220, y: 100 } })),
      edges: [
        { id: 'edge-1', source: 'task-1', target: 'task-2' },
        { id: 'edge-2', source: 'task-2', target: 'task-3' }
      ]
    }
  };
}
function generation() {
  const current = nodes().map((item) => ({ ...item, dependency_ids: item.dependencies.map((entry) => entry.node_id) }));
  const candidate = current.map((item) => (item.id === 'task-3' ? { ...item, title: 'Candidate verification' } : item));
  return {
    id: 'generation-1',
    project_id: 'project-1',
    workflow_id: 'workflow-1',
    mode: 'replan',
    status: 'completed',
    phase: 'completed',
    result_mode: 'replan_diff',
    candidate: { nodes: candidate, confidence: 0.88 },
    diff: { workflow_id: 'workflow-1', from_revision: 7, current_nodes: current, candidate_nodes: candidate }
  };
}
function proposal() {
  return {
    id: 'proposal-1',
    project_id: 'project-1',
    workflow_id: 'workflow-1',
    title: 'Replan',
    summary: 'Review replacement',
    change_type: 'workflow_replan_replace',
    status: 'pending',
    created_at: new Date(0).toISOString()
  };
}

function mockWorkflowRects() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('workflow-task-dag')) return testRect(20, 100, 620, 520);
    if (this.hasAttribute('data-topology-anchor')) {
      const row = this.closest<HTMLElement>('[data-task-id]'),
        dag = this.closest<HTMLElement>('.workflow-task-dag');
      const rows = dag ? [...dag.querySelectorAll<HTMLElement>('[data-task-id]')] : [];
      const index = row ? rows.indexOf(row) : 0;
      const density = this.closest<HTMLElement>('.workflow-full-process')?.dataset.density || 'comfortable';
      const summaryHeight = density === 'compact' ? 48 : density === 'detailed' ? 96 : 64;
      const previousDetails = rows.slice(0, index).filter((item) => item.classList.contains('expanded')).length * 136;
      const centerX = 58,
        centerY = 108 + summaryHeight / 2 + index * (summaryHeight + 8) + previousDetails;
      return testRect(centerX - 3, centerY - 3, 6, 6);
    }
    return testRect(0, 0, 0, 0);
  });
}

function expectTopologyAnchors(container: HTMLElement) {
  const dag = container.querySelector<HTMLElement>('.workflow-task-dag') as HTMLElement,
    dagRect = dag.getBoundingClientRect();
  for (const path of container.querySelectorAll<SVGPathElement>('.workflow-topology-edge')) {
    for (const side of ['source', 'target'] as const) {
      const taskId = path.dataset[`${side}Id`],
        anchor = container.querySelector<HTMLElement>(
          `[data-task-id="${taskId}"] [data-topology-anchor]`
        ) as HTMLElement;
      const rect = anchor.getBoundingClientRect(),
        expectedX = rect.left - dagRect.left + rect.width / 2,
        expectedY = rect.top - dagRect.top + rect.height / 2;
      expect(Math.abs(Number(path.dataset[`${side}X`]) - expectedX)).toBeLessThanOrEqual(1);
      expect(Math.abs(Number(path.dataset[`${side}Y`]) - expectedY)).toBeLessThanOrEqual(1);
    }
  }
}

function topologyPaths(container: HTMLElement) {
  return [...container.querySelectorAll<SVGPathElement>('.workflow-topology-edge')].map((path) =>
    path.getAttribute('d')
  );
}
function testRect(left: number, top: number, width: number, height: number) {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({})
  } as DOMRect;
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
