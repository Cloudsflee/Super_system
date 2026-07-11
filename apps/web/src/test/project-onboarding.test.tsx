import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsPage } from '../features/projects/ProjectsPage';
import { ProjectOnboardingPage } from '../features/projects/onboarding/ProjectOnboardingPage';
import { WorkflowPage } from '../features/workflow/WorkflowPage';
import { useUi } from '../state/ui';

describe('V1.3 project onboarding', () => {
  beforeEach(() => useUi.getState().closeOverlay());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('creates a draft and navigates to its recoverable onboarding route', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if ((init?.method || 'GET') === 'GET') return response([]);
      return response({ project: project(), intake: { id: 'i1', project_id: 'p1', mode: null, status: 'awaiting_mode', answers: {}, context_sources: [], revision: 1 }, onboarding_route: '/projects/p1/onboarding' }, 201);
    }));
    renderWithClient(<MemoryRouter initialEntries={['/projects']}><Routes><Route path="/projects" element={<ProjectsPage />} /><Route path="/projects/:projectId/onboarding" element={<div>Onboarding route</div>} /></Routes></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('项目名称'), { target: { value: 'Desktop App' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始引导' }));
    expect(await screen.findByText('Onboarding route')).toBeInTheDocument();
    const create = calls.find((item) => item.url.endsWith('/projects') && item.body);
    expect(create?.body).toMatchObject({ title: 'Desktop App' });
    expect(create?.body?.operation_key).toMatch(/^web-/);
  });

  it('reviews the brief and atomically confirms its workflow draft', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method || 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/onboarding/confirm')) return response({ project: { ...project(), status: 'active', onboarding_state: 'confirmed' }, workflow: { id: 'wf1', project_id: 'p1', title: 'Workflow', status: 'active' }, route: '/projects/p1/workflow' });
      if (url.includes('/projects/p1/onboarding')) return response(onboarding());
      if (url.endsWith('/projects')) return response([project()]);
      if (url.endsWith('/projects/p1')) return response({ project: project(), workflows: [], nodes: [], contracts: [], assets: [], runs: [] });
      return response({});
    }));
    renderWithClient(<MemoryRouter initialEntries={['/projects/p1/onboarding']}><Routes><Route path="/projects/:projectId/onboarding" element={<ProjectOnboardingPage />} /><Route path="/projects/:projectId/workflow" element={<div>Workflow route</div>} /></Routes></MemoryRouter>);
    expect(await screen.findByText('审查项目简报与初始工作流')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认简报并激活项目' }));
    expect(await screen.findByText('Workflow route')).toBeInTheDocument();
    const confirm = calls.find((item) => item.url.endsWith('/onboarding/confirm'));
    expect(confirm?.method).toBe('POST');
    expect(confirm?.body?.workflow_nodes).toHaveLength(3);
  });

  it('redirects direct draft workflow access back to onboarding', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ project: project(), workflows: [], nodes: [], contracts: [], assets: [], runs: [] })));
    renderWithClient(<MemoryRouter initialEntries={['/projects/p1/workflow']}><Routes><Route path="/projects/:projectId/workflow" element={<WorkflowPage />} /><Route path="/projects/:projectId/onboarding" element={<div>Recover onboarding</div>} /></Routes></MemoryRouter>);
    expect(await screen.findByText('Recover onboarding')).toBeInTheDocument();
  });
});

function renderWithClient(value: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{value}</QueryClientProvider>);
}

function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function project() { return { id: 'p1', title: 'Desktop App', goal: 'Ship it', status: 'draft', current_workspace_id: 'w1', onboarding_state: 'brief_review', managed_workspace_state: 'empty' }; }
function onboarding() {
  const content = { goal: 'Ship it', users: ['Owner'], scope: { in: ['Desktop UI'], out: [] }, features: ['Desktop UI'], constraints: [], milestones: ['MVP'], acceptance_criteria: ['Tests pass'], risks: [], open_questions: [] };
  const workflow = [
    { type: 'goal_definition', title: '确认项目简报', goal: 'Ship it', dependency_indexes: [] },
    { type: 'execution', title: '实现核心交付', goal: 'Desktop UI', dependency_indexes: [0] },
    { type: 'retrospective', title: '验证与交付审查', goal: 'Tests pass', dependency_indexes: [1] }
  ];
  return { project: project(), intake: { id: 'i1', project_id: 'p1', mode: 'brainstorm', status: 'ready_for_review', answers: { goal: 'Ship it' }, code_source: null, context_sources: [], revision: 2 }, brief: { id: 'b1', project_id: 'p1', version: 2, status: 'draft', source: 'brainstorm', content, created_at: new Date(0).toISOString() }, briefs: [], workflow_draft: workflow, imports: [], can_confirm: true, onboarding_route: '/projects/p1/onboarding', assist_session: null };
}
