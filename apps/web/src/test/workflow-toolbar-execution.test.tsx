import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Project,
  ProjectBundle,
  RepositoryLineRecord,
  Workflow,
  WorkflowExecutionRecord,
  WorkflowExecutionSnapshot
} from '../api/types';
import { RouteToolbarHostProvider, RouteToolbarPortal } from '../components/shell/RouteToolbarHost';
import { WorkflowHeaderActions, WorkflowProjectBreadcrumb } from '../components/shell/WorkflowShellHeader';
import { WorkflowExecutionBar } from '../features/workflow/WorkflowExecutionBar';
import { WorkflowRouteToolbar, type WorkflowView } from '../features/workflow/WorkflowRouteToolbar';
import { useUi, type WorkflowTaskDensity } from '../state/ui';

describe('Workflow route toolbar', () => {
  beforeEach(() =>
    useUi.setState({
      focusMode: true,
      assistOpen: false,
      contextLane: null,
      approvalCenterOpen: false,
      proposalId: null
    })
  );
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('portals controls into the route host and supports radio-menu keyboard navigation', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    render(
      <RouteToolbarHostProvider host={host}>
        <ToolbarHarness />
      </RouteToolbarHostProvider>
    );
    expect(within(host).getByRole('tab', { name: '完整流程' })).toBeInTheDocument();
    const trigger = within(host).getByRole('button', { name: /显示设置，当前舒适/ });
    fireEvent.click(trigger);
    const menu = within(host).getByRole('menu', { name: '显示密度' });
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3);
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole('menuitemradio', { name: '舒适' })));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitemradio', { name: '详细' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(within(host).queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    fireEvent.click(within(host).getByRole('menuitemradio', { name: '紧凑' }));
    expect(within(host).getByRole('button', { name: /当前紧凑/ })).toBeInTheDocument();
    host.remove();
  });

  it('offers one project breadcrumb menu and switches to the selected project', () => {
    const select = vi.fn(),
      projects = [project('p1', 'A very long current project title for delivery'), project('p2', 'Second project')];
    const { container } = render(
      <WorkflowProjectBreadcrumb projects={projects} current={projects[0]} onSelect={select} />
    );
    expect(screen.getAllByRole('navigation', { name: '工作流项目' })).toHaveLength(1);
    const trigger = screen.getByRole('button', { name: `当前项目：${projects[0].title}` });
    expect(trigger).toHaveAttribute('data-tooltip', projects[0].title);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Second project' }));
    expect(select).toHaveBeenCalledWith('p2');
    expect(container).toHaveTextContent('工作流');
  });

  it('keeps only Assist and the more menu in the compact global action group', () => {
    render(<WorkflowHeaderActions compact />);
    expect(screen.getByRole('button', { name: '打开 Codex 智能助手' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '审批队列' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '更多工作流操作' }));
    const menu = screen.getByRole('menu', { name: '更多工作流操作' });
    expect(within(menu).getByRole('menuitem', { name: '操作与诊断' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: '审批队列' })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: '退出专注模式' }));
    expect(useUi.getState().focusMode).toBe(false);
  });
});

describe('Workflow execution status band', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    [null, '启动工作流', true],
    ['running', '暂停', false],
    ['paused', '继续', true],
    ['completed', '再次运行', false],
    ['failed', '重新运行', false],
    ['cancelled', '重新运行', false]
  ] as const)('renders %s with the expected action weight', async (status, action, primary) => {
    const { container } = renderExecution(status);
    expect(await screen.findByRole('button', { name: action })).toBeInTheDocument();
    const actionButton = screen.getByRole('button', { name: action });
    expect(actionButton).toHaveClass(primary ? 'primary' : 'secondary');
    expect(container.querySelectorAll('.workflow-execution-actions .primary')).toHaveLength(primary ? 1 : 0);
    if (status === 'running') expect(screen.getByRole('button', { name: '取消' })).toHaveClass('danger-subtle');
    if (status === 'paused') expect(screen.getByRole('button', { name: '取消' })).toHaveClass('secondary');
  });

  it('hides every write action from viewers', async () => {
    renderExecution('running', [], false);
    await screen.findByText('任务流程运行中');
    expect(screen.queryByRole('button', { name: '暂停' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
  });

  it('shows one repository line directly and exposes every remaining full ref in a menu', async () => {
    const lines = [
      line('one', 'feature/release-evidence', '11111111111111111111', 'running'),
      line('two', 'integration/very-long-branch', '22222222222222222222', 'completed'),
      line('three', 'release/final', '33333333333333333333', 'failed')
    ];
    renderExecution('running', lines);
    expect(
      await screen.findByLabelText('feature/release-evidence · 11111111111111111111 · 运行中')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看其余 2 条仓库线' }));
    const menu = screen.getByRole('menu', { name: '其余仓库线' });
    expect(
      within(menu).getByRole('menuitem', { name: 'integration/very-long-branch · 22222222222222222222 · 已完成' })
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', { name: 'release/final · 33333333333333333333 · 失败' })
    ).toBeInTheDocument();
  });
});

function ToolbarHarness() {
  const [view, setView] = useState<WorkflowView>('process'),
    [density, setDensity] = useState<WorkflowTaskDensity>('comfortable');
  return (
    <RouteToolbarPortal>
      <WorkflowRouteToolbar
        view={view}
        density={density}
        replanOpen={false}
        canReplan
        onView={setView}
        onDensity={setDensity}
        onReplan={() => undefined}
      />
    </RouteToolbarPortal>
  );
}

function renderExecution(
  status: WorkflowExecutionRecord['status'] | null,
  lines: RepositoryLineRecord[] = [],
  canWrite = true
) {
  const current = status ? snapshot(status, lines) : null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/repository-connections')
        ? response({ items: [] })
        : response({ items: current ? [current.workflow_execution] : [], current })
    )
  );
  return renderWithClient(
    <WorkflowExecutionBar
      bundle={bundle()}
      workflow={workflow()}
      canWrite={canWrite}
      onRefresh={() => undefined}
      onSnapshot={() => undefined}
    />
  );
}

function renderWithClient(value: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(<QueryClientProvider client={client}>{value}</QueryClientProvider>);
}

function snapshot(
  status: WorkflowExecutionRecord['status'],
  repository_lines: RepositoryLineRecord[]
): WorkflowExecutionSnapshot {
  const workflow_execution: WorkflowExecutionRecord = {
    id: `execution-${status}`,
    project_id: 'p1',
    workflow_id: 'w1',
    workflow_revision: 4,
    status,
    frontier: [],
    waiting_reasons: [],
    started_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString()
  };
  return { workflow_execution, task_executions: [], repository_lines, frontier: [], waiting_reasons: [] };
}

function line(id: string, branch: string, head_sha: string, status: string): RepositoryLineRecord {
  return {
    id,
    workflow_execution_id: 'execution-running',
    workstream_id: 'ws1',
    connection_id: 'repo1',
    base_ref: 'main',
    branch,
    head_sha,
    status
  };
}
function workflow(): Workflow {
  return { id: 'w1', project_id: 'p1', title: 'Delivery', status: 'active', version: 4, workflow_revision: 4 };
}
function project(id: string, title: string): Project {
  return {
    id,
    title,
    goal: 'Ship',
    status: 'active',
    onboarding_state: 'confirmed',
    current_workspace_id: `workspace-${id}`
  };
}
function bundle(): ProjectBundle {
  return {
    project: project('p1', 'Project one'),
    workflows: [workflow()],
    nodes: [],
    contracts: [],
    assets: [],
    runs: []
  } as unknown as ProjectBundle;
}
function response(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}
