import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowNode } from '../api/types';
import { WorkflowTaskInlineDetails } from '../features/workflow/WorkflowTaskDetails';
import {
  parseTaskObjective,
  projectUsesChinese,
  taskDisplayTitle,
  workstreamDisplayTitle,
  type TaskObjectiveValue,
  type WorkflowTaskViewModel
} from '../features/workflow/WorkflowTaskViewModel';

describe('Workflow task objective context', () => {
  afterEach(cleanup);

  it('creates bounded semi-structured content without changing the source', () => {
    const core = '核心目标'.repeat(50);
    const points = ['验收标准'.repeat(40), '依赖约束'.repeat(40), '输出要求'.repeat(40), '额外说明'.repeat(40)];
    const source = `${core}。\n${points.map((point) => `- ${point}。`).join('\n')}\n每天 23:50 Asia/Shanghai\nCLI: \`pnpm verify\``;

    const objective = parseTaskObjective(source);

    expect(objective.raw).toBe(source);
    expect([...objective.summary]).toHaveLength(180);
    expect(objective.summary.endsWith('…')).toBe(true);
    expect(objective.keyPoints).toHaveLength(3);
    expect(objective.keyPoints.every((point) => [...point].length <= 120)).toBe(true);
    expect(objective.keyPoints.every((point) => point.endsWith('…'))).toBe(true);
    expect(objective.command).toBe('pnpm verify');
    expect(objective.times).toEqual(['23:50']);
    expect(objective.timezone).toBe('Asia/Shanghai');
    expect(objective.summary).not.toContain('23:50');
    expect(objective.keyPoints.join(' ')).not.toContain('23:50');
  });

  it('defaults to summary, exposes the exact source, and resets when the task changes', () => {
    const source =
      '交付可验证的工作流改动。\n- 保留公开路由与状态结构。\n- 覆盖键盘切换。\nCLI: `pnpm verify`\n每天 09:30 Asia/Shanghai';
    const first = taskModel('task-1', 'Implement workflow', source);
    const { rerender } = render(<WorkflowTaskInlineDetails model={first} density="comfortable" />);

    const switcher = screen.getByRole('group', { name: 'Implement workflow 上下文视图' });
    const summaryButton = within(switcher).getByRole('button', { name: '摘要' });
    const sourceButton = within(switcher).getByRole('button', { name: '原文' });
    expect(summaryButton).toHaveAttribute('aria-pressed', 'true');
    expect(sourceButton).toHaveAttribute('aria-pressed', 'false');

    const summary = screen.getByRole('region', { name: 'Implement workflow 上下文摘要' });
    expect(within(summary).getByText('核心目标')).toBeInTheDocument();
    expect(within(summary).getByText('交付可验证的工作流改动。')).toBeInTheDocument();
    expect(within(summary).getAllByRole('listitem')).toHaveLength(2);
    expect(within(summary).getByLabelText('命令行：pnpm verify')).toBeInTheDocument();
    expect(within(summary).getByText('09:30')).toBeInTheDocument();
    expect(within(summary).getByText('Asia/Shanghai')).toBeInTheDocument();

    fireEvent.click(sourceButton);
    expect(sourceButton).toHaveAttribute('aria-pressed', 'true');
    expect(summaryButton).toHaveAttribute('aria-pressed', 'false');
    const sourceRegion = screen.getByRole('region', { name: 'Implement workflow 上下文原文' });
    expect(sourceRegion.querySelector('pre')?.textContent).toBe(source);
    expect(screen.queryByRole('region', { name: 'Implement workflow 上下文摘要' })).not.toBeInTheDocument();

    rerender(
      <WorkflowTaskInlineDetails
        model={taskModel('task-2', 'Verify workflow', '验证发布结果。')}
        density="comfortable"
      />
    );
    const nextSwitcher = screen.getByRole('group', { name: 'Verify workflow 上下文视图' });
    expect(within(nextSwitcher).getByRole('button', { name: '摘要' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'Verify workflow 上下文摘要' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Verify workflow 上下文原文' })).not.toBeInTheDocument();
  });

  it('shows a Chinese structured fallback for an English task in a Chinese project', () => {
    const source =
      'Read the exact repository snapshot and map all integrity checks. Do not modify repository files. Retain deterministic test evidence at the fixed SHA.';
    const task = workflowTask('task-localized', 'Map run integrity evidence', source, 'research');
    const preferChinese = projectUsesChinese('DesignSignal 每日设计情报', '每天形成可追溯的设计情报、考纲映射和练习。');
    const displayTitle = taskDisplayTitle(task, preferChinese);
    const objective = parseTaskObjective(source, {
      preferChinese,
      displayTitle,
      projectGoal: '每天形成可追溯的设计情报、考纲映射和练习。',
      phaseTag: 'research_evidence'
    });

    expect(displayTitle).toBe('梳理并固化任务证据');
    expect(objective.summary).toBe('梳理并固化任务证据，并形成可核验的阶段成果。');
    expect(objective.keyPoints).toEqual([
      '对齐项目目标：每天形成可追溯的设计情报、考纲映射和练习。',
      '梳理输入材料、来源位置和验证证据，确保结论可追溯。',
      '执行要求：只读执行、固定 SHA、确定性与幂等、测试与验收证据。'
    ]);
    expect(objective.raw).toBe(source);
    expect(
      workstreamDisplayTitle(
        {
          ...workflowTask('workstream-localized', 'DesignSignal run verify integrity audit', source),
          type: 'workstream',
          role: 'workstream'
        },
        preferChinese
      )
    ).toBe('运行完整性审计与交付');

    render(
      <WorkflowTaskInlineDetails
        model={taskModel(task.id, task.title, source, displayTitle, objective)}
        density="comfortable"
      />
    );
    const summary = screen.getByRole('region', { name: '梳理并固化任务证据 上下文摘要' });
    expect(summary).toHaveTextContent('梳理并固化任务证据，并形成可核验的阶段成果。');
    expect(summary).not.toHaveTextContent('Read the exact repository snapshot');

    fireEvent.click(screen.getByRole('button', { name: '原文' }));
    const sourceRegion = screen.getByRole('region', { name: '梳理并固化任务证据 上下文原文' });
    expect(sourceRegion.querySelector('pre')?.textContent).toBe(source);
  });

  it('keeps English projects in English and prefers real Chinese sentences in mixed goals', () => {
    const englishTask = workflowTask('task-english', 'Map evidence', 'Map exact evidence. Keep it traceable.');
    const preferChinese = projectUsesChinese('Evidence workspace', 'Produce a traceable English report.');
    const englishTitle = taskDisplayTitle(englishTask, preferChinese);
    const englishObjective = parseTaskObjective(englishTask.goal, {
      preferChinese,
      displayTitle: englishTitle,
      projectGoal: 'Produce a traceable English report.',
      phaseTag: 'research_evidence'
    });
    expect(preferChinese).toBe(false);
    expect(englishTitle).toBe('Map evidence');
    expect(englishObjective.summary).toBe('Map exact evidence.');

    const mixed = 'Inspect the fixed SHA first. 然后核对同一版本的验收证据。 Keep the audit read-only.';
    const mixedObjective = parseTaskObjective(mixed, {
      preferChinese: true,
      displayTitle: '核对验收证据',
      projectGoal: '交付可追溯结果。',
      phaseTag: 'acceptance'
    });
    expect(mixedObjective.summary).toBe('然后核对同一版本的验收证据。');
    expect(mixedObjective.raw).toBe(mixed);
  });
});

function workflowTask(
  id: string,
  title: string,
  goal: string,
  taskKind: WorkflowNode['task_kind'] = 'code'
): WorkflowNode {
  return {
    id,
    workflow_id: 'workflow-1',
    type: 'task',
    role: 'task',
    title,
    goal,
    status: 'ready',
    order_index: 1,
    dependencies: [],
    task_kind: taskKind
  };
}

function taskModel(
  id: string,
  title: string,
  goal: string,
  displayTitle = title,
  objective: TaskObjectiveValue = parseTaskObjective(goal)
): WorkflowTaskViewModel {
  const task = workflowTask(id, title, goal);
  return {
    id,
    task,
    displayTitle,
    assistBreadcrumb: ['Project', 'Workflow', displayTitle],
    status: 'ready',
    statusText: '已就绪',
    phase: '实现执行',
    phaseTags: ['execution'],
    objective,
    metrics: { dependencies: 0, inputs: 0, outputs: 0, versions: 0 },
    dependencies: [],
    blockers: [],
    inputs: [],
    outputs: [],
    versions: [{ key: 'empty', label: '无显式输入 -> 待定义输出' }],
    capabilityTags: ['实现执行'],
    coverage: [],
    actionLocked: false,
    actionLockReason: '',
    detailsId: `workflow-task-details-${id}`
  };
}
