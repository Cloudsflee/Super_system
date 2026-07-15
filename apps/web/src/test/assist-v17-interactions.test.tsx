import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistOperation, AssistV3Session, ProjectBrief, RuntimeUserInput, WorkflowDraft } from '../api/types';
import { AssistComposer } from '../features/assist/AssistComposer';
import { OperationReceipt } from '../features/assist/OperationReceipt';
import { UserInputCard } from '../features/assist/UserInputCard';
import { BriefWorkspace } from '../features/projects/onboarding/BriefWorkspace';

describe('Assist V1.7 interactions', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });

  it('keeps clarification policy and native Plan independently controlled', () => {
    const onClarificationPolicy = vi.fn(), onPlanNext = vi.fn();
    const view = render(<AssistComposer {...composerProps({ clarificationPolicy: 'ask', planNext: false, onClarificationPolicy, onPlanNext })} />);
    const clarification = screen.getByRole('group', { name: '澄清方式' });
    expect(within(clarification).getByRole('button', { name: '问我' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(within(clarification).getByRole('button', { name: '自动推荐' }));
    expect(onClarificationPolicy).toHaveBeenCalledWith('auto_recommend');
    expect(onPlanNext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    expect(onPlanNext).toHaveBeenCalledWith(true);
    expect(onClarificationPolicy).toHaveBeenCalledTimes(1);

    view.rerender(<AssistComposer {...composerProps({ clarificationPolicy: 'auto_recommend', planNext: true, onClarificationPolicy, onPlanNext })} />);
    expect(within(clarification).getByRole('button', { name: '自动推荐' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders recommendations and submits Other answers with a request-only Note', () => {
    const onRespond = vi.fn();
    render(<UserInputCard item={userInput()} busy={false} onRespond={onRespond} />);
    expect(screen.getByText('推荐')).toBeInTheDocument();
    expect(screen.getByText('安全范围').closest('label')).toHaveClass('recommended');

    fireEvent.click(screen.getByRole('radio', { name: /其他/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '范围 其他回答' }), { target: { value: '仅桌面端' } });
    fireEvent.change(screen.getByRole('textbox', { name: '范围 Note' }), { target: { value: '  本轮先验证  ' } });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    expect(onRespond).toHaveBeenCalledWith({ scope: { answers: ['仅桌面端'], note: '本轮先验证' } });
  });

  it('shows semantic operation receipts without exposing machine tool names', () => {
    const view = render(<OperationReceipt operation={operation()} busy={false} onConfirm={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.getByText('已更新 · 核心目标')).toBeInTheDocument();
    expect(screen.getByText(/核心目标 · 低风险/)).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent('aiws_page');
    expect(view.container).not.toHaveTextContent('set_field');
  });

  it('offers a targeted retry for revision conflicts instead of force undo', () => {
    const onRevise = vi.fn();
    render(<OperationReceipt operation={{ ...operation(), status: 'conflicted', action: 'revise', operation_reference_id: 'operation-original', conflict: { before: '旧值', after: '拟修改值', current: '外部新值' } }} busy={false} onConfirm={vi.fn()} onUndo={vi.fn()} onRevise={onRevise} />);
    expect(screen.queryByRole('button', { name: '强制撤回' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '基于当前值重新编辑' }));
    expect(onRevise).toHaveBeenCalledOnce();
  });

  it('switches the mobile Brief, outline, and workflow panes without changing data', () => {
    const view = render(<BriefWorkspace brief={brief()} workflow={workflow()} templates={[]} busy={false} onBrief={vi.fn(async () => true)} onWorkflow={vi.fn(async () => true)} onSaveTemplate={vi.fn()} onApplyTemplate={vi.fn()} onSearchTemplates={vi.fn()} />);
    const tabs = screen.getByRole('navigation', { name: '简报工作区视图' });
    expect(within(tabs).getAllByRole('button')).toHaveLength(3);
    expect(within(tabs).getByRole('button', { name: '简报' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(tabs).getByRole('button', { name: '大纲' }));
    expect(view.container.querySelector('.brief-outline')).toHaveClass('mobile-active');
    expect(view.container.querySelector('.brief-document')).not.toHaveClass('mobile-active');
    fireEvent.click(within(tabs).getByRole('button', { name: '工作流' }));
    expect(view.container.querySelector('.workflow-draft-panel')).toHaveClass('mobile-active');
    expect(view.container.querySelector('.brief-outline')).not.toHaveClass('mobile-active');
  });

  it('preserves dirty Brief and workflow drafts across unrelated revisions', () => {
    const firstBrief = briefWithSections(), firstWorkflow = workflowWithNodes();
    const props = { templates: [], busy: false, onBrief: vi.fn(async () => true), onWorkflow: vi.fn(async () => true), onSaveTemplate: vi.fn(), onApplyTemplate: vi.fn(), onSearchTemplates: vi.fn() };
    const view = render(<BriefWorkspace brief={firstBrief} workflow={firstWorkflow} {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: '简报标题' }), { target: { value: '本地未保存标题' } });
    fireEvent.change(screen.getByRole('textbox', { name: '核心目标 Markdown' }), { target: { value: '本地未保存目标' } });
    fireEvent.change(screen.getByRole('textbox', { name: '确认简报 目标' }), { target: { value: '本地未保存节点目标' } });

    const nextBrief: ProjectBrief = { ...firstBrief, revision: firstBrief.revision + 1, content: { ...firstBrief.content, sections: firstBrief.content.sections.map((section) => section.id === 'features' && section.type === 'list' ? { ...section, items: ['服务端新功能'] } : { ...section }) } };
    const nextWorkflow: WorkflowDraft = { ...firstWorkflow, revision: firstWorkflow.revision + 1, nodes: firstWorkflow.nodes.map((node) => node.id === 'node-2' ? { ...node, goal: '服务端新节点目标' } : { ...node }) };
    view.rerender(<BriefWorkspace brief={nextBrief} workflow={nextWorkflow} {...props} />);

    expect(screen.getByRole('textbox', { name: '简报标题' })).toHaveValue('本地未保存标题');
    expect(screen.getByRole('textbox', { name: '核心目标 Markdown' })).toHaveValue('本地未保存目标');
    expect(screen.getByRole('textbox', { name: '功能 列表' })).toHaveValue('服务端新功能');
    expect(screen.getByRole('textbox', { name: '确认简报 目标' })).toHaveValue('本地未保存节点目标');
    expect(screen.getByRole('textbox', { name: '实现功能 目标' })).toHaveValue('服务端新节点目标');
  });

  it('keeps local editor values when a revision-conflicted save fails', async () => {
    const firstBrief = briefWithSections(), firstWorkflow = workflowWithNodes();
    const onBrief = vi.fn(async () => false), onWorkflow = vi.fn(async () => false);
    const props = { templates: [], busy: false, onBrief, onWorkflow, onSaveTemplate: vi.fn(), onApplyTemplate: vi.fn(), onSearchTemplates: vi.fn() };
    const view = render(<BriefWorkspace brief={firstBrief} workflow={firstWorkflow} {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: '核心目标 Markdown' }), { target: { value: '冲突后仍保留的目标' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 核心目标' }));
    fireEvent.change(screen.getByRole('textbox', { name: '确认简报 目标' }), { target: { value: '冲突后仍保留的节点目标' } });
    fireEvent.blur(screen.getByRole('textbox', { name: '确认简报 目标' }));
    await waitFor(() => { expect(onBrief).toHaveBeenCalledOnce(); expect(onWorkflow).toHaveBeenCalledOnce(); });
    const serverBrief = { ...firstBrief, revision: firstBrief.revision + 1, content: { ...firstBrief.content, sections: firstBrief.content.sections.map((section) => section.id === 'goal' && section.type === 'markdown' ? { ...section, markdown: '服务端冲突目标' } : section) } };
    const serverWorkflow = { ...firstWorkflow, revision: firstWorkflow.revision + 1, nodes: firstWorkflow.nodes.map((node) => node.id === 'node-1' ? { ...node, goal: '服务端冲突节点目标' } : node) };
    view.rerender(<BriefWorkspace brief={serverBrief} workflow={serverWorkflow} {...props} />);
    expect(screen.getByRole('textbox', { name: '核心目标 Markdown' })).toHaveValue('冲突后仍保留的目标');
    expect(screen.getByRole('button', { name: '保存 核心目标' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '确认简报 目标' })).toHaveValue('冲突后仍保留的节点目标');
  });
});

function session(): AssistV3Session {
  return { id: 'session-1', version: 3, project_id: 'project-1', scope_type: 'project', scope_id: 'project-1', title: 'V1.7', status: 'idle', lifecycle: 'active', pinned: false, clarification_policy: 'ask', created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
}

function composerProps(overrides: Partial<ComponentProps<typeof AssistComposer>> = {}): ComponentProps<typeof AssistComposer> {
  return { session: session(), profileName: 'Profile', catalog: { profile_id: 'profile-1', default_model: 'gpt-v17', source: 'test', models: [{ id: 'gpt-v17', model: 'gpt-v17', displayName: 'gpt-v17', description: 'test', hidden: false, isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'high' }] }] }, configurations: [], model: 'gpt-v17', reasoning: 'high', configurationId: '', clarificationPolicy: 'ask', planNext: false, prompt: 'message', attachments: [], selectedAttachments: [], activeTurn: null, busy: false, writeModeUnavailableReason: null, onModel: vi.fn(), onReasoning: vi.fn(), onConfiguration: vi.fn(), onClarificationPolicy: vi.fn(), onPlanNext: vi.fn(), onPrompt: vi.fn(), onAttachments: vi.fn(), onAttachmentCreated: vi.fn(), onAttachmentDeleted: vi.fn(), onSubmit: vi.fn(), onStop: vi.fn(), onTerminal: vi.fn(), onCommand: vi.fn(), onSaveConfiguration: vi.fn(async () => true), onError: vi.fn(), ...overrides };
}

function userInput(): RuntimeUserInput {
  return { id: 'input-1', session_id: 'session-1', turn_id: 'turn-1', item_id: 'item-1', status: 'pending', contains_secret: false, questions: [{ id: 'scope', header: '范围', question: '采用哪个范围？', isOther: true, options: [{ label: '安全范围', description: '只做可逆改动', recommended: true }, { label: '完整范围', description: '一次完成全部改动' }] }], created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
}

function operation(): AssistOperation {
  return { id: 'operation-1', session_id: 'session-1', turn_id: 'turn-1', project_id: 'project-1', tool: 'aiws_page.set_field', capability_id: 'surface.field.set', action: 'set', target_id: 'brief.goal', target_label: '核心目标', summary: '已更新 · 核心目标', route: '/projects/project-1/onboarding', surface_revision: 'r1', status: 'committed', risk: 'low', revision: 2, forced: false, before_value: '旧目标', after_value: '新目标', created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
}

function brief(): ProjectBrief {
  return { id: 'brief-1', project_id: 'project-1', version: 1, revision: 3, status: 'draft', source: 'assist', content: { schema_version: 2, title: '项目简报', summary: '交付 V1.7', sections: [{ id: 'goal', semantic_key: 'goal', title: '核心目标', type: 'markdown', markdown: '交付 V1.7' }], goal: '交付 V1.7', users: [], scope: { in: ['Assist'], out: [] }, features: ['Assist'], constraints: [], milestones: [], acceptance_criteria: ['通过测试'], risks: [], open_questions: [] }, created_at: new Date(0).toISOString() };
}

function workflow(): WorkflowDraft {
  return { id: 'draft-1', project_id: 'project-1', revision: 2, source_brief_id: 'brief-1', source_brief_revision: 3, nodes: [{ id: 'node-1', type: 'goal_definition', title: '确认简报', goal: '确认目标', dependency_ids: [], position: { x: 80, y: 120 }, order: 0 }] };
}

function briefWithSections(): ProjectBrief {
  const value = brief();
  return { ...value, content: { ...value.content, sections: [...value.content.sections, { id: 'features', semantic_key: 'features', title: '功能', type: 'list', items: ['原功能'] }] } };
}

function workflowWithNodes(): WorkflowDraft {
  const value = workflow();
  return { ...value, nodes: [...value.nodes, { id: 'node-2', type: 'execution', title: '实现功能', goal: '原节点目标', dependency_ids: ['node-1'], position: { x: 390, y: 120 }, order: 1 }] };
}
