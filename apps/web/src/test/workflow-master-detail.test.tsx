import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectBundle, Workflow } from '../api/types';
import { WorkflowFullProcess } from '../features/workflow/WorkflowFullProcess';
import { selectDefaultWorkflowTask, type WorkflowTaskViewModel } from '../features/workflow/WorkflowTaskViewModel';

let processWidth = 1359;

describe('Workflow master-detail process', () => {
  beforeEach(() => {
    processWidth = 1359;
    vi.stubGlobal('PointerEvent', class TestPointerEvent extends MouseEvent {
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType || ''; }
    });
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rect(0, 0, this.classList.contains('workflow-full-process') ? processWidth : 0, 0);
    });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); TestResizeObserver.instances = []; });

  it('chooses the first visually ordered active task, then ready, then the first task', () => {
    const models = (statuses: string[]) => statuses.map((status, index) => ({ id: `${status}-${index}`, status }) as WorkflowTaskViewModel);
    expect(selectDefaultWorkflowTask(models(['ready', 'failed', 'running']))).toBe('failed-1');
    expect(selectDefaultWorkflowTask(models(['completed', 'queued', 'ready']))).toBe('queued-1');
    expect(selectDefaultWorkflowTask(models(['completed', 'blocked']))).toBe('completed-0');
    expect(selectDefaultWorkflowTask([])).toBeNull();
  });

  it('switches at exactly 1360px and carries the pinned accordion task across modes', () => {
    renderProcess();
    const process = screen.getByRole('region', { name: '完整任务流程' });
    expect(process).toHaveAttribute('data-layout', 'accordion');
    fireEvent.click(screen.getByRole('button', { name: '展开任务详情：Collect evidence' }));
    expect(screen.getByRole('region', { name: '任务详情：Collect evidence' })).toBeInTheDocument();

    resizeProcess(process, 1360);
    expect(process).toHaveAttribute('data-layout', 'master-detail');
    expect(screen.queryByRole('region', { name: '任务详情：Collect evidence' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Collect evidence' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '取消固定任务：Collect evidence' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '取消固定任务：Collect evidence' })[0]).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('.workflow-task-quick-preview')).not.toBeInTheDocument();

    resizeProcess(process, 1359);
    expect(process).toHaveAttribute('data-layout', 'accordion');
    expect(screen.getByRole('region', { name: '任务详情：Collect evidence' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('pins blank-row clicks and restores the pinned detail after pointer and focus previews', () => {
    processWidth = 1600;
    vi.useFakeTimers();
    const { container } = renderProcess();
    const process = screen.getByRole('region', { name: '完整任务流程' });
    expect(process).toHaveAttribute('data-layout', 'master-detail');
    expect(screen.getByRole('complementary', { name: 'Decide and implement' })).toBeInTheDocument();
    const collect = container.querySelector<HTMLElement>('[data-task-id="task-1"]') as HTMLElement;
    const decide = container.querySelector<HTMLElement>('[data-task-id="task-2"]') as HTMLElement;
    const paths = topologyPaths(container);

    fireEvent.click(collect.querySelector('.workflow-task-main') as HTMLElement);
    let aside = screen.getByRole('complementary', { name: 'Collect evidence' });
    expect(within(collect).getByRole('button', { name: '取消固定任务：Collect evidence' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(collect.querySelector('.workflow-task-main') as HTMLElement);
    expect(within(collect).getByRole('button', { name: '取消固定任务：Collect evidence' })).toHaveAttribute('aria-pressed', 'true');
    aside.scrollTop = 180;

    fireEvent.pointerEnter(decide, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(249));
    expect(screen.getByRole('complementary', { name: 'Collect evidence' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    aside = screen.getByRole('complementary', { name: 'Decide and implement' });
    expect(aside.scrollTop).toBe(0);
    expect(topologyPaths(container)).toEqual(paths);
    expect(document.querySelector('.workflow-task-quick-preview')).not.toBeInTheDocument();

    fireEvent.pointerLeave(decide, { pointerType: 'mouse' });
    fireEvent.pointerEnter(aside, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('complementary', { name: 'Decide and implement' })).toBeInTheDocument();
    expect(within(aside).getByRole('link', { name: '进入任务工作台：Decide and implement' })).toBeInTheDocument();
    fireEvent.pointerLeave(aside, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(100));
    aside = screen.getByRole('complementary', { name: 'Collect evidence' });
    expect(aside.scrollTop).toBe(180);

    const decidePin = within(decide).getByRole('button', { name: '固定任务：Decide and implement' });
    fireEvent.focus(decidePin);
    expect(screen.getByRole('complementary', { name: 'Decide and implement' })).toBeInTheDocument();
    fireEvent.blur(decidePin, { relatedTarget: null });
    expect(screen.getByRole('complementary', { name: 'Collect evidence' })).toBeInTheDocument();
    fireEvent.pointerEnter(decide, { pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole('complementary', { name: 'Collect evidence' })).toBeInTheDocument();

    fireEvent.click(within(aside).getByRole('button', { name: '取消固定任务：Collect evidence' }));
    expect(screen.getByRole('complementary', { name: 'Decide and implement' })).toBeInTheDocument();
  });

  it('keeps one pin through density changes and falls back when that task is deleted', () => {
    processWidth = 1600;
    const source = fixtureBundle();
    const { container, rerender } = renderProcess(source);
    const collect = container.querySelector<HTMLElement>('[data-task-id="task-1"]') as HTMLElement;
    fireEvent.click(within(collect).getByRole('button', { name: '固定任务：Collect evidence' }));
    expect(screen.getByRole('complementary', { name: 'Collect evidence' })).toBeInTheDocument();

    rerender(processElement(source, 'detailed'));
    expect(screen.getByRole('region', { name: '完整任务流程' })).toHaveAttribute('data-density', 'detailed');
    expect(screen.getByRole('complementary', { name: 'Collect evidence' })).toBeInTheDocument();
    fireEvent.click(within(container.querySelector<HTMLElement>('[data-task-id="task-2"]') as HTMLElement).getByRole('button', { name: '固定任务：Decide and implement' }));
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(2);

    const refreshed = { ...source, nodes: source.nodes.filter((item) => item.id !== 'task-2') };
    rerender(processElement(refreshed, 'detailed'));
    expect(screen.getByRole('complementary', { name: 'Collect evidence' })).toBeInTheDocument();
    expect(container.querySelector('[data-task-id="task-2"]')).not.toBeInTheDocument();
  });
});

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { TestResizeObserver.instances.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
}

function resizeProcess(process: HTMLElement, width: number) {
  processWidth = width;
  act(() => {
    for (const observer of TestResizeObserver.instances.filter((item) => item.targets.has(process))) {
      observer.callback([{ target: process, contentRect: rect(0, 0, width, 600) } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
    }
  });
}

function renderProcess(value = fixtureBundle()) { return render(processElement(value, 'comfortable')); }
function processElement(value: ProjectBundle, density: 'compact' | 'comfortable' | 'detailed') {
  return <MemoryRouter><WorkflowFullProcess bundle={value} workflow={value.workflows[0]} density={density} /></MemoryRouter>;
}
function topologyPaths(container: HTMLElement) { return [...container.querySelectorAll<SVGPathElement>('.workflow-topology-edge')].map((item) => item.getAttribute('d')); }
function rect(left: number, top: number, width: number, height: number) { return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect; }

function fixtureBundle() {
  const workflow: Workflow = { id: 'workflow-1', project_id: 'project-1', title: 'Delivery', status: 'active', project_classification: 'software_delivery', brief_coverage: { features: ['task-2'] } };
  const nodes = [
    { id: 'workstream-1', workflow_id: workflow.id, type: 'workstream', role: 'workstream', title: 'Verified increment', goal: 'Ship', outcome: 'Verified output', category: 'deliverable', status: 'ready', order_index: 0, dependencies: [] },
    task('task-1', 'Collect evidence', 'completed', 1, []),
    task('task-2', 'Decide and implement', 'ready', 2, ['task-1']),
    task('task-3', 'Verify and deliver', 'blocked', 3, ['task-2'])
  ];
  return {
    project: { id: 'project-1', title: 'Project', goal: 'Ship', status: 'active', onboarding_state: 'confirmed' },
    workflows: [workflow], nodes,
    contracts: nodes.slice(1).map((item, index) => ({ id: `contract-${index}`, node_id: item.id, version: 1, node_goal: item.goal, acceptance_criteria: [], allowed_tools: [], expected_inputs: [], expected_outputs: [] })),
    assets: [], runs: []
  } as unknown as ProjectBundle;
}

function task(id: string, title: string, status: string, order: number, dependencies: string[]) {
  return { id, workflow_id: 'workflow-1', parent_node_id: 'workstream-1', type: 'task', role: 'task', title, goal: `${title} goal`, task_kind: 'code', status, order_index: order, dependencies: dependencies.map((node_id) => ({ node_id, type: 'finish_to_start' })), capability_tags: ['execution'] };
}
