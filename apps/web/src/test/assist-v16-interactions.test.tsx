import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistAttachment,
  AssistGoal,
  AssistOperation,
  AssistV3Event,
  AssistV3Session,
  AssistV3Turn,
  RuntimeUserInput
} from '../api/types';
import { ContextMenuProvider, useContextMenuResolver } from '../components/common/ContextMenu';
import { publishSelectionAsk, subscribeSelectionAsk } from '../components/common/selection-ask';
import { IconButton } from '../components/common/IconButton';
import {
  previewErrorLabel,
  referenceKindLabel,
  runtimeUnavailableReasonLabel
} from '../components/common/display-labels';
import { AssistComposer } from '../features/assist/AssistComposer';
import AttachmentPreview, { parseCsvRow } from '../features/assist/AttachmentPreview';
import { BtwPopover } from '../features/assist/BtwPopover';
import { activeComposerToken, ASSIST_COMMANDS, removeComposerToken } from '../features/assist/composer-support';
import { GoalCard } from '../features/assist/GoalCard';
import { sessionTree, ThreadSidebar } from '../features/assist/ThreadSidebar';
import { TurnTimeline } from '../features/assist/TurnTimeline';
import { LONG_PASTE_THRESHOLD, MAX_DROP_FILES } from '../features/assist/useComposerFiles';
import { useUi } from '../state/ui';

describe('Assist V1.6 interactions', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    window.getSelection()?.removeAllRanges();
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
    useUi.setState({ assistOpen: false });
    const dispose = subscribeSelectionAsk(() => undefined);
    dispose();
  });

  it('owns ordinary context menus, keeps Shift escape, supports selection Ask and keyboard entry', async () => {
    const asked = vi.fn(),
      special = vi.fn(),
      disposeAsk = subscribeSelectionAsk(asked);
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(12, 18, 80, 16)
    });
    render(
      <ContextMenuProvider>
        <RegisteredTarget onSpecial={special} />
        <input aria-label="Secret" type="password" />
      </ContextMenuProvider>
    );
    const target = screen.getByRole('button', { name: 'Context target' }),
      range = document.createRange();
    range.selectNodeContents(target);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.contextMenu(target, { clientX: 30, clientY: 40 });
    const menu = screen.getByRole('menu', { name: '上下文菜单' });
    expect(within(menu).getByRole('menuitem', { name: '询问智能助手' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: '专属动作' })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: '询问智能助手' }));
    await waitFor(() => expect(asked).toHaveBeenCalledWith(expect.objectContaining({ selection: 'Context target' })));
    expect(useUi.getState().assistOpen).toBe(true);

    const shiftMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true });
    target.dispatchEvent(shiftMenu);
    expect(shiftMenu.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    target.focus();
    fireEvent.keyDown(target, { key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.contextMenu(screen.getByLabelText('Secret'));
    expect(screen.queryByRole('menuitem', { name: '询问智能助手' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '粘贴' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    const sensitiveRange = document.createRange();
    sensitiveRange.selectNodeContents(screen.getByText('Sensitive selection'));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(sensitiveRange);
    fireEvent.contextMenu(target);
    expect(screen.queryByRole('menuitem', { name: '询问智能助手' })).not.toBeInTheDocument();
    disposeAsk();
  });

  it('renders the real Fork tree, protects roots, and leaves deleted branches in place', () => {
    const root = session('root', null, 'Root'),
      branch = {
        ...session('branch', 'root', 'Branch'),
        turn_count: 1,
        last_turn: {
          id: 'turn-1',
          mode: 'default' as const,
          status: 'completed',
          updated_at: new Date(0).toISOString()
        }
      },
      deleted = {
        ...session('deleted', 'branch', 'Deleted'),
        deleted_at: new Date(0).toISOString(),
        delete_batch_id: 'batch-1'
      };
    const tree = sessionTree([deleted, branch, root]);
    expect(tree[0].item.id).toBe('root');
    expect(tree[0].children[0].item.id).toBe('branch');
    expect(tree[0].children[0].children[0].depth).toBe(2);
    const onDelete = vi.fn(),
      onRestoreDeleted = vi.fn();
    render(
      <ContextMenuProvider>
        <ThreadSidebar
          sessions={[root, branch, deleted]}
          selectedId="root"
          search=""
          archived={false}
          loading={false}
          onSearch={vi.fn()}
          onArchived={vi.fn()}
          onSelect={vi.fn()}
          onCreate={vi.fn()}
          onRename={vi.fn()}
          onPin={vi.fn()}
          onArchive={vi.fn()}
          onFork={vi.fn()}
          onDelete={onDelete}
          onRestoreDeleted={onRestoreDeleted}
        />
      </ContextMenuProvider>
    );
    expect(screen.getByText('1 轮')).toBeInTheDocument();
    expect(screen.getByText('尚无对话')).toBeInTheDocument();
    expect(screen.queryByText('completed')).not.toBeInTheDocument();
    expect(screen.getByText('已删除分支')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(onRestoreDeleted).toHaveBeenCalledWith(deleted);
    fireEvent.contextMenu(screen.getByText('Root').closest('article')!);
    expect(screen.queryByRole('menuitem', { name: '删除分支' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.contextMenu(screen.getByText('Branch').closest('article')!);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除分支' }));
    expect(onDelete).toHaveBeenCalledWith(branch);
  });

  it('parses file paths and all structured slash commands without putting commands in text', () => {
    const reference = activeComposerToken('ask @src/features/file.ts', 'ask @src/features/file.ts'.length);
    expect(reference).toEqual({ kind: 'reference', query: 'src/features/file.ts', start: 4, end: 25 });
    expect(removeComposerToken('ask @src/features/file.ts', reference!)).toBe('ask ');
    expect(activeComposerToken('path/to/file', 12)).toBeNull();
    expect(activeComposerToken('go /review', 10)?.query).toBe('review');
    expect(ASSIST_COMMANDS.map(([name]) => name)).toEqual([
      'plan',
      'goal',
      'model',
      'reasoning',
      'terminal',
      'review',
      'fork',
      'btw'
    ]);
    expect(referenceKindLabel('current_editor_file')).toBe('当前编辑文件');
    expect(runtimeUnavailableReasonLabel('windows_bridge_not_paired')).toBe('Windows 本机桥接尚未配对');
    expect(previewErrorLabel('preview_404')).toBe('预览内容读取失败（HTTP 404）');
    expect(LONG_PASTE_THRESHOLD).toBe(8000);
    expect(MAX_DROP_FILES).toBe(10);
    expect(parseCsvRow('')).toEqual(['']);
    expect(parseCsvRow('a,"b,b","c""d",')).toEqual(['a', 'b,b', 'c"d', '']);
  });

  it('turns an exact 8,000-character paste into an upload, preserves input, and blocks send while pending', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const onPrompt = vi.fn(),
      onCreated = vi.fn(),
      onAttachments = vi.fn();
    render(
      <AssistComposer
        {...composerProps({ prompt: 'keep existing', onPrompt, onAttachmentCreated: onCreated, onAttachments })}
      />
    );
    const textarea = screen.getByRole('textbox', { name: '智能助手消息' }) as HTMLTextAreaElement;
    textarea.setSelectionRange(4, 4);
    fireEvent.paste(textarea, { clipboardData: { getData: () => 'x'.repeat(LONG_PASTE_THRESHOLD) } });
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeDisabled());
    finish(jsonResponse(attachment()));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onAttachments).toHaveBeenCalledWith(['attachment-1']);
    expect(onPrompt).not.toHaveBeenCalled();
  });

  it('keeps Stop available while a running Turn is finishing background refreshes', () => {
    const onStop = vi.fn();
    render(
      <AssistComposer {...composerProps({ activeTurn: { ...turnFixture(), status: 'running' }, busy: true, onStop })} />
    );
    const stop = screen.getByRole('button', { name: '停止' });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('exposes the selected follow-up action as the send button name', () => {
    const onSubmit = vi.fn();
    render(
      <AssistComposer
        {...composerProps({ activeTurn: { ...turnFixture(), status: 'running' }, busy: true, onSubmit })}
      />
    );
    expect(screen.getByRole('button', { name: '加入队列' })).toBeEnabled();
    fireEvent.change(screen.getByRole('combobox', { name: '后续消息处理方式' }), { target: { value: 'steer' } });
    const steer = screen.getByRole('button', { name: '调整当前方向' });
    fireEvent.click(steer);
    expect(onSubmit).toHaveBeenCalledWith('steer');
  });

  it('leaves a 7,999-character paste native and restores text when conversion fails', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'upload_failed' }, 500));
    vi.stubGlobal('fetch', fetchMock);
    const shortPrompt = vi.fn(),
      first = render(<AssistComposer {...composerProps({ prompt: 'base', onPrompt: shortPrompt })} />);
    fireEvent.paste(screen.getByRole('textbox', { name: '智能助手消息' }), {
      clipboardData: { getData: () => 'x'.repeat(LONG_PASTE_THRESHOLD - 1) }
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shortPrompt).not.toHaveBeenCalled();
    first.unmount();
    const restored = vi.fn();
    render(<AssistComposer {...composerProps({ prompt: 'base', onPrompt: restored })} />);
    const textarea = screen.getByRole('textbox', { name: '智能助手消息' }) as HTMLTextAreaElement;
    textarea.setSelectionRange(4, 4);
    fireEvent.paste(textarea, { clipboardData: { getData: () => 'z'.repeat(LONG_PASTE_THRESHOLD) } });
    await waitFor(() => expect(restored).toHaveBeenCalledWith(`base${'z'.repeat(LONG_PASTE_THRESHOLD)}`));
  });

  it('tracks same-name uploads independently and clears a cancelled media confirmation', async () => {
    const finishes: Array<(response: Response) => void> = [],
      fetchMock = vi.fn(() => new Promise<Response>((resolve) => finishes.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<AssistComposer {...composerProps()} />),
      composer = view.container.querySelector('.assist-composer-v3')!;
    const first = new File(['a'], 'same.txt'),
      second = new File(['b'], 'same.txt');
    fireEvent.drop(composer, { dataTransfer: { types: ['Files'], files: [first, second] } });
    await waitFor(() => expect(finishes).toHaveLength(2));
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    finishes[0](jsonResponse(attachment('attachment-a')));
    await waitFor(() => expect(screen.getAllByText(/same\.txt/)).toHaveLength(1));
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    finishes[1](jsonResponse(attachment('attachment-b')));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled());
    view.unmount();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false),
      cancelled = render(<AssistComposer {...composerProps()} />),
      media = new File(['x'], 'large.mp4', { type: 'video/mp4' });
    Object.defineProperty(media, 'size', { value: 25 * 1024 * 1024 + 1 });
    fireEvent.drop(cancelled.container.querySelector('.assist-composer-v3')!, {
      dataTransfer: { types: ['Files'], files: [media] }
    });
    await waitFor(() => expect(cancelled.container.querySelector('.composer-uploads')).not.toBeInTheDocument());
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('traps preview focus, closes with Escape, and restores the opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn(),
      view = render(<AttachmentPreview attachment={{ ...attachment(), preview_kind: 'metadata' }} onClose={onClose} />);
    const download = await screen.findByRole('link', { name: '下载原文件' });
    await waitFor(() => expect(download).toHaveFocus());
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: '关闭预览' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });

  it('focuses the BTW question and lets Escape close only the popover', async () => {
    render(<BtwPopover sessionId="session-1" />);
    act(() => publishSelectionAsk({ selection: 'selected text', rect: null, pageUrl: 'http://localhost/projects/1' }));
    expect(await screen.findByRole('dialog', { name: '问点什么' })).toBeInTheDocument();
    const question = screen.getByRole('textbox', { name: '临时问题' });
    await waitFor(() => expect(question).toHaveFocus());
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '问点什么' })).not.toBeInTheDocument());
  });

  it('keeps history focused on the conversation and moves runtime data into collapsed details', () => {
    const turn = {
      ...turnFixture(),
      collaboration_mode: 'plan' as const,
      model: 'MODEL_HISTORY_SENTINEL',
      reasoning: 'REASONING_HISTORY_SENTINEL'
    };
    const events = [
      assistEvent('queued', { queue_position: 1 }, 1),
      assistEvent(
        'started',
        {
          profile: {
            name: 'PROFILE_HISTORY_SENTINEL',
            model: 'MODEL_HISTORY_SENTINEL',
            reasoning: 'REASONING_HISTORY_SENTINEL'
          }
        },
        2
      ),
      assistEvent('status', { status: 'thread_started' }, 3),
      assistEvent('plan', { text: 'Short reply', status: 'completed', source: 'codex-native' }, 4),
      assistEvent('command', { command: 'pnpm test', output: 'passed', status: 'completed', exit_code: 0 }, 5),
      assistEvent(
        'reasoning_summary',
        { summary: 'Public concise summary', internal_reasoning: 'PRIVATE_REASONING_SENTINEL' },
        6
      ),
      assistEvent('usage', { input_tokens: 1000, output_tokens: 234, total_tokens: 1234 }, 7),
      assistEvent('completed', { review_status: 'not_applicable' }, 8)
    ];
    const view = render(<TurnTimeline {...timelineProps({ turns: [turn], events })} />),
      timeline = view.container.querySelector('.turn-timeline')!;
    expect(screen.getByText('用户消息')).toHaveClass('sr-only');
    expect(screen.getByText('助手回复')).toHaveClass('sr-only');
    expect(timeline).not.toHaveTextContent('completed');
    expect(timeline).not.toHaveTextContent('MODEL_HISTORY_SENTINEL');
    expect(timeline).not.toHaveTextContent('REASONING_HISTORY_SENTINEL');
    expect(timeline).not.toHaveTextContent('PROFILE_HISTORY_SENTINEL');
    expect(timeline).not.toHaveTextContent('PRIVATE_REASONING_SENTINEL');
    expect(timeline.textContent?.toLowerCase()).not.toContain('reasoning');
    expect(timeline.querySelectorAll('.turn-output')).toHaveLength(1);
    const details = screen.getByText('运行详情').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('pnpm test');
    expect(details).toHaveTextContent('Public concise summary');
    expect(within(details).getByLabelText('令牌用量')).toHaveTextContent('输入 1,000');
    expect(within(details).getByLabelText('令牌用量')).toHaveTextContent('输出 234');
    expect(within(details).getByLabelText('令牌用量')).toHaveTextContent('总计 1,234');
    expect(screen.queryByRole('button', { name: '查看本次回复用量' })).not.toBeInTheDocument();
    expect(screen.queryByText('实时事件已连接')).not.toBeInTheDocument();
  });

  it('keeps runtime details collapsed by default while preserving explicit expansion', async () => {
    const running = { ...turnFixture(), status: 'running', output_text: '' },
      events = [
        assistEvent('command', { command: 'pnpm test', output: '', status: 'running' }, 1),
        assistEvent('usage', { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, 2)
      ];
    const view = render(<TurnTimeline {...timelineProps({ turns: [running], events })} />);
    const details = screen.getByText('运行详情').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByRole('status')).toHaveTextContent('正在处理');
    view.rerender(
      <TurnTimeline {...timelineProps({ turns: [{ ...running, status: 'completed', output_text: 'Done' }], events })} />
    );
    await waitFor(() => expect(details).not.toHaveAttribute('open'));
    expect(screen.queryByText('正在处理')).not.toBeInTheDocument();
    fireEvent.click(within(details).getByText('运行详情'));
    expect(details).toHaveAttribute('open');
  });

  it('keeps approvals, user input, errors, conflicts, Undo, Retry and Review outside runtime details', () => {
    const input: RuntimeUserInput = {
      id: 'input-1',
      session_id: 'session-1',
      turn_id: 'turn-1',
      item_id: 'question-1',
      status: 'pending',
      contains_secret: false,
      questions: [{ id: 'answer', header: '确认', question: '继续吗？' }],
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    };
    const operation: AssistOperation = {
      id: 'operation-1',
      session_id: 'session-1',
      turn_id: 'turn-1',
      tool: 'aiws_page.set_field',
      target_id: 'brief.goal',
      route: '/',
      surface_revision: 'r1',
      status: 'conflicted',
      risk: 'low',
      revision: 2,
      inverse_of: 'operation-original',
      forced: false,
      conflict: { before: 'a', after: 'b', current: 'c' },
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    };
    const turn = {
      ...turnFixture(),
      status: 'failed',
      output_text: '',
      error_code: 'assist_workspace_unavailable',
      change_batch_id: 'batch-1',
      review_status: 'ready',
      user_inputs: [input],
      operations: [operation]
    };
    const events = [
      assistEvent('approval', { approval_id: 'approval-1', command: 'pnpm test' }, 1),
      assistEvent('failed', { error: 'assist_workspace_unavailable' }, 2)
    ];
    render(<TurnTimeline {...timelineProps({ turns: [turn], events })} />);
    const approval = screen.getByRole('button', { name: '立即审查' }),
      retry = screen.getByRole('button', { name: '重试' }),
      review = screen.getByRole('button', { name: '审查变更批次' });
    expect(approval).toBeInTheDocument();
    expect(screen.getByText('Codex 需要你的输入')).toBeInTheDocument();
    expect(screen.getByText('智能助手工作目录不可用，请重新进入项目后重试。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '强制撤回' })).toBeInTheDocument();
    expect(retry).toBeInTheDocument();
    expect(review).toBeInTheDocument();
    expect(approval.closest('details')).toBeNull();
    expect(retry.closest('details')).toBeNull();
    expect(review.closest('details')).toBeNull();
  });

  it('keeps an open no-change batch reachable for explicit cleanup', () => {
    const onReview = vi.fn(),
      turn = { ...turnFixture(), change_batch_id: 'batch-1', review_status: 'no_changes' as const };
    render(<TurnTimeline {...timelineProps({ turns: [turn], onReview })} />);
    fireEvent.click(screen.getByRole('button', { name: '审查变更批次' }));
    expect(onReview).toHaveBeenCalledWith(turn);
  });

  it('shows only the Goal objective and icon actions', () => {
    const goal: AssistGoal = {
      objective: 'Ship V1.6',
      status: 'active',
      tokenBudget: 99_999,
      tokensUsed: 42_000,
      timeUsedSeconds: 3600
    };
    const onSet = vi.fn(),
      view = render(<GoalCard goal={goal} busy={false} onSet={onSet} onClear={vi.fn()} />);
    expect(screen.getByText('Ship V1.6')).toHaveClass('goal-objective');
    expect(view.container).not.toHaveTextContent('99,999');
    expect(view.container).not.toHaveTextContent('42,000');
    expect(view.container).not.toHaveTextContent('3600');
    expect(screen.getByRole('button', { name: '完成目标' })).toHaveAttribute('data-tooltip', '完成目标');
    fireEvent.click(screen.getByRole('button', { name: '完成目标' }));
    expect(onSet).toHaveBeenCalledWith({ status: 'complete' });
    view.unmount();
    render(
      <IconButton label="统一说明" onClick={() => undefined}>
        <span>i</span>
      </IconButton>
    );
    expect(screen.getByRole('button', { name: '统一说明' })).toHaveAttribute('data-tooltip', '统一说明');
  });
});

function RegisteredTarget({ onSpecial }: { onSpecial: () => void }) {
  useContextMenuResolver(
    useCallback(
      (context) =>
        context.target.closest('[data-special]') ? [{ id: 'special', label: '专属动作', onSelect: onSpecial }] : [],
      [onSpecial]
    )
  );
  return (
    <>
      <button data-special type="button" onClick={() => undefined}>
        Context target
      </button>
      <span data-sensitive="true">Sensitive selection</span>
    </>
  );
}
function session(id: string, parent: string | null, title: string): AssistV3Session {
  return {
    id,
    version: 3,
    project_id: 'project-1',
    scope_type: 'project',
    scope_id: 'project-1',
    title,
    status: 'idle',
    lifecycle: 'active',
    pinned: false,
    forked_from_session_id: parent,
    turn_count: 0,
    last_turn: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString()
  };
}
function attachment(id = 'attachment-1'): AssistAttachment {
  return {
    id,
    project_id: 'project-1',
    session_id: 'session-1',
    kind: 'project_attachment',
    title: 'paste.txt',
    original_filename: 'paste.txt',
    content_type: 'text/plain',
    size_bytes: 8000,
    model_policy: 'injectable',
    status: 'ready',
    created_at: new Date(0).toISOString()
  };
}
function turnFixture(): AssistV3Turn {
  return {
    id: 'turn-1',
    session_id: 'session-1',
    project_id: 'project-1',
    mode: 'default',
    collaboration_mode: 'default',
    prompt: 'Short prompt',
    output_text: 'Short reply',
    status: 'completed',
    model: 'gpt-v16',
    reasoning: 'high',
    attachment_ids: [],
    usage: { input_tokens: 1000, output_tokens: 234, total_tokens: 1234 },
    review_status: 'not_applicable',
    user_inputs: [],
    operations: [],
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString()
  };
}
function assistEvent(type: AssistV3Event['type'], data: Record<string, unknown>, sequence: number): AssistV3Event {
  return {
    id: sequence,
    sequence,
    session_id: 'session-1',
    turn_id: 'turn-1',
    type,
    data,
    created_at: new Date(0).toISOString()
  };
}
function timelineProps(
  overrides: Partial<ComponentProps<typeof TurnTimeline>> = {}
): ComponentProps<typeof TurnTimeline> {
  return {
    turns: [],
    events: [],
    reconnecting: false,
    busy: false,
    onRetry: vi.fn(),
    onReview: vi.fn(),
    onRespondUserInput: vi.fn(),
    onConfirmOperation: vi.fn(),
    onUndoOperation: vi.fn(),
    ...overrides
  };
}
function composerProps(
  overrides: Partial<ComponentProps<typeof AssistComposer>> = {}
): ComponentProps<typeof AssistComposer> {
  return {
    session: session('session-1', null, 'Root'),
    profileName: 'Profile',
    catalog: {
      profile_id: 'profile-1',
      default_model: 'gpt-v16',
      source: 'test',
      models: [
        {
          id: 'gpt-v16',
          model: 'gpt-v16',
          displayName: 'gpt-v16',
          description: 'test',
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'high' }]
        }
      ]
    },
    configurations: [],
    model: 'gpt-v16',
    reasoning: 'high',
    configurationId: '',
    planNext: false,
    prompt: 'message',
    attachments: [],
    selectedAttachments: [],
    activeTurn: null,
    busy: false,
    writeModeUnavailableReason: null,
    onModel: vi.fn(),
    onReasoning: vi.fn(),
    onConfiguration: vi.fn(),
    onPlanNext: vi.fn(),
    onPrompt: vi.fn(),
    onAttachments: vi.fn(),
    onAttachmentCreated: vi.fn(),
    onAttachmentDeleted: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    onTerminal: vi.fn(),
    onCommand: vi.fn(),
    onSaveConfiguration: vi.fn(async () => true),
    onError: vi.fn(),
    ...overrides
  };
}
function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
