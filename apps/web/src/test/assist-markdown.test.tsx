import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistMarkdown } from '../features/assist/AssistMarkdown';
import { coalesceAssistEvents } from '../features/assist/TurnTimeline';
import { TypedEvent } from '../features/assist/TypedEvent';

describe('Assist output rendering', () => {
  afterEach(cleanup);

  it('renders GFM without executing raw HTML or remote markdown images', () => {
    const view = render(<AssistMarkdown>{'## Result\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>window.__xss = true</script>\n\n![remote](https://example.invalid/a.png)'}</AssistMarkdown>);
    expect(screen.getByRole('heading', { name: 'Result' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByText('remote')).toBeInTheDocument();
  });

  it('coalesces native streaming text deltas without a machine action envelope', () => {
    const base = { id: 1, sequence: 1, session_id: 's1', turn_id: 't1', type: 'text' as const, created_at: new Date().toISOString() };
    const merged = coalesceAssistEvents([{ ...base, data: { text: 'Hello ' } }, { ...base, id: 2, sequence: 2, data: { text: 'world' } }]);
    expect(merged).toHaveLength(1);
    render(<TypedEvent event={merged[0]} />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.queryByText(/machine action/)).not.toBeInTheDocument();
  });

  it('renders the authoritative Codex native plan instead of repeated delta cards', () => {
    const base = { id: 1, sequence: 1, session_id: 's1', turn_id: 't1', type: 'plan' as const, created_at: new Date().toISOString() };
    const merged = coalesceAssistEvents([
      { ...base, data: { text: '第一', status: 'streaming', source: 'codex-native' } },
      { ...base, id: 2, sequence: 2, data: { text: '步', status: 'streaming', source: 'codex-native' } },
      { ...base, id: 3, sequence: 3, data: { text: '1. 第一步\n2. 验证', status: 'completed', source: 'codex-native' } }
    ]);
    expect(merged).toHaveLength(1);
    render(<TypedEvent event={merged[0]} />);
    expect(screen.getByText('Codex 原生计划')).toBeInTheDocument();
    expect(screen.getByText(/第一步/)).toBeInTheDocument();
  });
});
