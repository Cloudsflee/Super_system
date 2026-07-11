import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { IconButton } from '../components/common/IconButton';
import { RequireSetup } from '../app/setup-guard';
import { nodeRenderers } from '../features/nodes/registry';
import { autoLayout, reconcileCanvasNodes, toCanvasNodes } from '../features/workflow/canvas/graph';
import { GithubSetup } from '../features/setup/GithubSetup';
import type { ProjectBundle } from '../api/types';
import { dispatchSemanticAction, useAssistSurface } from '../components/assist/semantic-actions';

describe('V1.2 UI contracts', () => {
  it('wires icon buttons to commands', () => {
    const action = vi.fn();
    render(<IconButton label="执行命令" onClick={action}><span>+</span></IconButton>);
    fireEvent.click(screen.getByRole('button', { name: '执行命令' }));
    expect(action).toHaveBeenCalledOnce();
  });

  it('registers all five node renderers', () => {
    expect(Object.keys(nodeRenderers).sort()).toEqual(['analysis', 'execution', 'goal_definition', 'research', 'retrospective']);
    for (const renderer of Object.values(nodeRenderers)) expect(renderer.component).toBeTruthy();
  });

  it('keeps a 100-node layout stable', () => {
    const bundle = fixtureBundle(100);
    const nodes = autoLayout(toCanvasNodes(bundle));
    expect(nodes).toHaveLength(100);
    expect(new Set(nodes.map((node) => `${node.position.x}:${node.position.y}`)).size).toBe(100);
  });

  it('reconciles graph records after a proposal is applied', () => {
    const before = toCanvasNodes(fixtureBundle(2));
    const after = toCanvasNodes(fixtureBundle(3));
    expect(reconcileCanvasNodes(before, after).map((node) => node.id)).toEqual(['n0', 'n1', 'n2']);
    expect(reconcileCanvasNodes(after, before)).toHaveLength(2);
  });

  it('reports whether a semantic Assist action was actually handled', async () => {
    render(<SemanticFixture />);
    await act(async () => { expect((await dispatchSemanticAction(action('fill_field', { field_id: 'fixture.name', value: 'Codex' }))).handled).toBe(true); });
    expect(screen.getByDisplayValue('Codex')).toBeInTheDocument();
    expect((await dispatchSemanticAction(action('fill_field', { field_id: 'missing', value: 'x' }))).handled).toBe(false);
  });

  it('redirects business routes while setup is incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ complete: false, mode: null, can_complete: false, steps: { github: { ready: false, status: 'required' }, codex: { ready: false, status: 'required' } }, reasons: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/projects']}><Routes><Route path="/setup" element={<div>Setup route</div>} /><Route element={<RequireSetup />}><Route path="/projects" element={<div>Projects route</div>} /></Route></Routes></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Setup route')).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it('opens the GitHub installation flow in a separate tab', async () => {
    sessionStorage.clear();
    const replace = vi.fn(), close = vi.fn();
    const popup = { opener: window, location: { replace }, close };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.endsWith('/github/installations/start')
        ? { installation_url: 'https://github.com/apps/aiws/installations/new' }
        : [];
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
    }));
    render(<GithubSetup mode="byo" state={{ ready: false, status: 'installation_required', installation_count: 0, checks: { app_configured: true, account_connected: true, installation_installed: false, installation_ready: false } }} onChange={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(await screen.findByRole('button', { name: '打开安装页' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('https://github.com/apps/aiws/installations/new'));
    expect(open).toHaveBeenCalledWith('about:blank', 'aiws-github-install');
    expect(screen.getByRole('button', { name: '我已安装，立即同步' })).toBeInTheDocument();
    open.mockRestore();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });
});

function SemanticFixture() {
  const [value, setValue] = useState('');
  useAssistSurface({ id: 'fixture', fields: { 'fixture.name': { label: '名称', set: (input) => setValue(String(input)) } } });
  return <input aria-label="语义字段" value={value} readOnly />;
}
function action(name: string, args: Record<string, unknown>) { return { id: 'a1', name, label: name, status: 'ready', risk: 'reversible' as const, args }; }

function fixtureBundle(count: number): ProjectBundle {
  return {
    project: { id: 'p1', title: 'Fixture', goal: '', status: 'active', current_workspace_id: 'w1' },
    workflows: [], contracts: [], assets: [], runs: [],
    nodes: Array.from({ length: count }, (_, index) => ({ id: `n${index}`, workflow_id: 'wf1', type: 'execution', title: `Node ${index}`, goal: '', status: 'ready', order_index: index, dependencies: [] }))
  };
}
