import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistOperation, Project } from '../api/types';
import { AssistWorkbench } from '../features/assist/AssistWorkbench';
import { useUi } from '../state/ui';
import { FakeEventSource } from './fake-transports';

describe('Assist operation browser synchronization', () => {
  beforeEach(() => {
    useUi.getState().closeOverlay();
    useUi.setState({ assistOpen: true, assistSurface: 'docked', assistDockWidth: 760, proposalId: null });
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('refreshes operations immediately when an operation event arrives', async () => {
    let operationReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/assist/v3/sessions?')) return response([sessionSummary()]);
      if (url.endsWith('/assist/v3/sessions/s1')) return response(sessionDetail());
      if (url.endsWith('/codex/profiles')) return response([]);
      if (url.includes('/assist/v3/operations?')) { operationReads++; return response([]); }
      return response([]);
    }));
    renderWithClient(<MemoryRouter><AssistWorkbench project={projectFixture()} /></MemoryRouter>);
    await waitFor(() => expect(operationReads).toBe(1));
    FakeEventSource.last?.emit('operation', eventData('pending-operation', false));
    await waitFor(() => expect(operationReads).toBeGreaterThan(1), { timeout: 1_000 });
  });

  it('retries a pending operation after a failed claim when the route changes', async () => {
    let claims = 0;
    const pending = operationFixture();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/assist/v3/sessions?')) return response([sessionSummary()]);
      if (url.endsWith('/assist/v3/sessions/s1')) return response(sessionDetail());
      if (url.endsWith('/codex/profiles')) return response([]);
      if (url.includes('/assist/v3/operations?')) return response([pending]);
      if (url.endsWith('/operations/pending-operation/claim')) { claims++; await new Promise((resolve) => setTimeout(resolve, 30)); return response({ error: 'assist_operation_surface_changed' }, 409); }
      return response([]);
    }));
    renderWithClient(<MemoryRouter initialEntries={['/wrong']}><RoutedAssistFixture /></MemoryRouter>);
    await screen.findByText('Thread One');
    await waitFor(() => expect(FakeEventSource.last).toBeTruthy());
    FakeEventSource.last?.emit('operation', eventData(pending.id, true));
    await waitFor(() => expect(claims).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(claims).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '切换测试路由' }));
    await waitFor(() => expect(claims).toBe(2));
  });
});

function renderWithClient(value: ReactNode) { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); return render(<QueryClientProvider client={client}>{value}</QueryClientProvider>); }
function RoutedAssistFixture() { const navigate = useNavigate(); return <><button onClick={() => navigate('/correct')}>切换测试路由</button><AssistWorkbench project={projectFixture()} /></>; }
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function sessionSummary() { return { id: 's1', version: 3, project_id: 'p1', scope_type: 'project', scope_id: 'p1', title: 'Thread One', status: 'idle', lifecycle: 'active', pinned: true, turn_count: 0, last_turn: null, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() }; }
function sessionDetail() { return { ...sessionSummary(), turns: [], attachments: [], last_event_id: 0 }; }
function projectFixture(): Project { return { id: 'p1', title: 'Project One', goal: 'Test', status: 'active', current_workspace_id: 'w1', onboarding_state: 'confirmed', managed_workspace_state: 'ready' }; }
function operationFixture(): AssistOperation { return { id: 'pending-operation', session_id: 's1', turn_id: 'turn-1', tool: 'aiws_page.set_field', target_id: 'brief.goal', route: '/correct', surface_id: 'empty', surface_revision: 'empty', status: 'pending', risk: 'low', revision: 1, forced: false, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() }; }
function eventData(operationId: string, claimable: boolean) { return { id: 2, sequence: 2, session_id: 's1', turn_id: 'turn-1', type: 'operation', data: { operation_id: operationId, claimable }, created_at: new Date(0).toISOString() }; }
