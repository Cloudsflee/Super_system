import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistOperation, RuntimeUserInput, TerminalCapabilities } from '../api/types';
import { ActivityLedger } from '../features/assist/ActivityLedger';
import { GoalCard } from '../features/assist/GoalCard';
import { OperationReceipt } from '../features/assist/OperationReceipt';
import { TerminalRuntimeSelector } from '../features/assist/TerminalRuntimeSelector';
import { UserInputCard } from '../features/assist/UserInputCard';

describe('Assist V1.5 interactions', () => {
  afterEach(cleanup);

  it('shows pending inverse navigation and marks completed originals as undone', () => {
    const pending = operationFixture({ id: 'inverse-pending', status: 'pending', inverse_of: 'operation-original', route: '/projects/p1' });
    const view = render(<OperationReceipt operation={pending} busy={false} onConfirm={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.getByRole('link', { name: '前往页面并撤回' })).toHaveAttribute('href', '/projects/p1');
    const original = operationFixture({ id: 'operation-original', undone_by: 'inverse-committed' });
    view.rerender(<OperationReceipt operation={original} busy={false} onConfirm={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.getByText('undone')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    view.unmount();
    render(<ActivityLedger operations={[original]} />);
    expect(screen.getByText('undone')).toBeInTheDocument();
  });

  it('submits custom native input and omits an empty Goal budget', () => {
    const onRespond = vi.fn(), onSet = vi.fn();
    const question: RuntimeUserInput = { id: 'input-1', session_id: 's1', turn_id: 'turn-1', item_id: 'item-1', status: 'pending', contains_secret: false, questions: [{ id: 'choice', header: '运行方式', question: '选择一种方式', isOther: true, options: [{ label: '自动', description: '自动执行' }] }], created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
    const inputView = render(<UserInputCard item={question} busy={false} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('radio', { name: /其他/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '运行方式 其他回答' }), { target: { value: '手动检查' } });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    expect(onRespond).toHaveBeenCalledWith({ choice: { answers: ['手动检查'] } });
    inputView.unmount();
    render(<GoalCard goal={null} busy={false} onSet={onSet} onClear={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /设置线程 Goal/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Objective' }), { target: { value: '完成 V1.5' } });
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(onSet).toHaveBeenCalledWith({ objective: '完成 V1.5' });
  });

  it('focuses and traps the runtime chooser, closes with Escape, and restores focus', async () => {
    const opener = document.createElement('button'); opener.textContent = 'Terminal'; document.body.append(opener); opener.focus();
    const capabilities: TerminalCapabilities = { linux_container: { available: true, default: true }, windows_bridge: { available: true }, host_dev: { available: false, reason: 'development only' } };
    const onClose = vi.fn(), view = render(<TerminalRuntimeSelector capabilities={capabilities} onClose={onClose} onSelect={vi.fn()} />);
    const linux = screen.getByRole('button', { name: /Linux Container/ }), windows = screen.getByRole('button', { name: /Windows Native/ }), close = screen.getByRole('button', { name: '关闭运行时选择器' });
    await waitFor(() => expect(linux).toHaveFocus());
    windows.focus(); fireEvent.keyDown(windows, { key: 'Tab' }); expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Escape' }); expect(onClose).toHaveBeenCalledOnce();
    view.unmount(); expect(opener).toHaveFocus(); opener.remove();
  });
});

function operationFixture(overrides: Partial<AssistOperation> = {}): AssistOperation { return { id: 'operation-1', session_id: 's1', turn_id: 'turn-1', tool: 'aiws_page.set_field', target_id: 'brief.goal', route: '/', surface_revision: 'r1', status: 'committed', risk: 'low', revision: 2, forced: false, before_value: 'before', after_value: 'after', conflict: null, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), ...overrides }; }
