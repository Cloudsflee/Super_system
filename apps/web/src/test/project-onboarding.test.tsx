import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsPage } from '../features/projects/ProjectsPage';
import { ProjectOnboardingPage } from '../features/projects/onboarding/ProjectOnboardingPage';
import { WorkflowPage } from '../features/workflow/WorkflowPage';
import { useUi } from '../state/ui';
import { dispatchSemanticAction, executeAssistOperation } from '../components/assist/semantic-actions';

describe('V1.3 project onboarding', () => {
  beforeEach(() => useUi.getState().closeOverlay());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('creates a draft and navigates to its recoverable onboarding route', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown>; headers?: HeadersInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers });
      if (url.endsWith('/account/me')) return response({ user: { id: 'owner-user' } });
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
    expect(new Headers(create?.headers).get('x-aiws-user-id')).toBe('owner-user');
    expect(new Headers(create?.headers).get('x-aiws-scopes')).toBe('project:create');
  });

  it('reviews the brief and atomically confirms its workflow draft', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method || 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/onboarding/confirm')) return response({ project: { ...project(), status: 'active', onboarding_state: 'confirmed' }, workflow: { id: 'wf1', project_id: 'p1', title: 'Workflow', status: 'active' }, route: '/projects/p1/nodes/node-coding' });
      if (url.includes('/projects/p1/onboarding')) return response(onboarding());
      if (url.endsWith('/projects')) return response([project()]);
      if (url.endsWith('/projects/p1')) return response({ project: project(), workflows: [], nodes: [], contracts: [], assets: [], runs: [] });
      return response({});
    }));
    renderWithClient(<MemoryRouter initialEntries={['/projects/p1/onboarding']}><Routes><Route path="/projects/:projectId/onboarding" element={<ProjectOnboardingPage />} /><Route path="/projects/:projectId/nodes/:nodeId" element={<div>Coding route</div>} /></Routes></MemoryRouter>);
    expect(await screen.findByText('审查项目简报与初始工作流')).toBeInTheDocument();
    expect(screen.getByText(/1 个独立工作单元/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认简报并激活项目' }));
    expect(await screen.findByText('Coding route')).toBeInTheDocument();
    const confirm = calls.find((item) => item.url.endsWith('/onboarding/confirm'));
    expect(confirm?.method).toBe('POST');
    expect(confirm?.body?.workflow_nodes).toHaveLength(1);
    expect(confirm?.body?.expected_brief_revision).toBe(2);
    expect(confirm?.body?.expected_workflow_revision).toBe(1);
  });

  it('redirects direct draft workflow access back to onboarding', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ project: project(), workflows: [], nodes: [], contracts: [], assets: [], runs: [] })));
    renderWithClient(<MemoryRouter initialEntries={['/projects/p1/workflow']}><Routes><Route path="/projects/:projectId/workflow" element={<WorkflowPage />} /><Route path="/projects/:projectId/onboarding" element={<div>Recover onboarding</div>} /></Routes></MemoryRouter>);
    expect(await screen.findByText('Recover onboarding')).toBeInTheDocument();
  });

  it('exposes brief fields to Assist and applies edits to the unsaved draft', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/projects/p1/onboarding') ? response(onboarding()) : response({})));
    renderWithClient(<MemoryRouter initialEntries={['/projects/p1/onboarding']}><Routes><Route path="/projects/:projectId/onboarding" element={<ProjectOnboardingPage />} /></Routes></MemoryRouter>);
    await screen.findByText('审查项目简报与初始工作流');
    await act(async () => { expect((await dispatchSemanticAction({ id: 'a1', name: 'fill_field', label: '填写目标', status: 'ready', risk: 'reversible', args: { field_id: 'brief.goal', value: '由 Assist 填写的新目标' } })).handled).toBe(true); });
    expect(await screen.findByRole('textbox', { name: '核心目标' })).toHaveValue('由 Assist 填写的新目标');
    expect(screen.getByText('建立可验证的项目简报')).toBeInTheDocument();
  });

  it('persists Assist field operations before reporting them as committed', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const initial = onboarding();
    initial.intake.answers = {} as typeof initial.intake.answers;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/operations/persist-brief/claim')) return response({ operation_id: 'persist-brief', tool: 'aiws_page.set_field', target_id: 'brief.goal', value: '持久化后的目标', route: '/', surface_id: body?.surface_id, surface_revision: body?.surface_revision, forced: false, revision: 1 });
      if (url.endsWith('/operations/persist-brief/result')) return response({ status: 'committed' });
      if (url.endsWith('/projects/p1/intake') && method === 'PUT') {
        const updated = onboarding();
        Object.assign(updated.intake, { answers: body?.answers, revision: 3 });
        Object.assign(updated.brief, { version: 3, revision: 1, content: { ...updated.brief.content, goal: '持久化后的目标' } });
        return response({ project: updated.project, intake: updated.intake, brief: updated.brief, workflow_draft: updated.workflow_draft });
      }
      if (url.includes('/projects/p1/onboarding')) return response(initial);
      if (url.endsWith('/brief-templates')) return response({ items: [] });
      return response({ mode: 'host', imports: {} });
    }));
    renderWithClient(<MemoryRouter initialEntries={['/projects/p1/onboarding']}><Routes><Route path="/projects/:projectId/onboarding" element={<ProjectOnboardingPage />} /></Routes></MemoryRouter>);
    await screen.findByText('建立可验证的项目简报');
    await act(async () => { await executeAssistOperation('persist-brief', '/'); });
    const persisted = calls.find((item) => item.url.endsWith('/projects/p1/intake') && item.method === 'PUT');
    expect(persisted?.body).toMatchObject({ answers: { goal: '持久化后的目标' } });
    expect(calls.find((item) => item.url.endsWith('/operations/persist-brief/result'))?.body).toMatchObject({ persisted: true, after: '持久化后的目标' });
  });

  it('adds context material from the intake UI and persists it with the brief', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/projects/p1/intake') && method === 'PUT') {
        const updated = onboarding();
        Object.assign(updated.intake, { context_sources: body?.context_sources, revision: 3 });
        return response({ project: updated.project, intake: updated.intake, brief: updated.brief, workflow_draft: updated.workflow_draft });
      }
      if (url.includes('/projects/p1/onboarding')) return response(onboarding());
      if (url.endsWith('/brief-templates')) return response({ items: [] });
      return response({ mode: 'host', imports: {} });
    }));
    renderWithClient(<MemoryRouter initialEntries={['/projects/p1/onboarding']}><Routes><Route path="/projects/:projectId/onboarding" element={<ProjectOnboardingPage />} /></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /补充简报/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加上下文材料' }));
    fireEvent.change(screen.getByRole('combobox', { name: '材料类型' }), { target: { value: 'text' } });
    fireEvent.change(screen.getByRole('textbox', { name: '材料名称' }), { target: { value: '用户访谈' } });
    fireEvent.change(screen.getByRole('textbox', { name: '材料内容' }), { target: { value: '用户需要离线恢复完整工作流。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并生成简报' }));
    await waitFor(() => expect(calls.some((item) => item.url.endsWith('/projects/p1/intake') && item.method === 'PUT')).toBe(true));
    expect(calls.find((item) => item.url.endsWith('/projects/p1/intake') && item.method === 'PUT')?.body?.context_sources).toEqual([
      { type: 'text', label: '用户访谈', text: '用户需要离线恢复完整工作流。' }
    ]);
  });

  it('hydrates equal revisions per project and clears a missing source', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/projects/p1/onboarding')) return response(onboardingFor('p1', 'Alpha goal', { type: 'local_directory', path: 'C:/alpha' }));
      if (url.includes('/projects/p2/onboarding')) return response(onboardingFor('p2', 'Beta goal', null));
      if (url.endsWith('/brief-templates')) return response({ items: [] });
      return response({});
    }));
    renderWithClient(<MemoryRouter initialEntries={['/projects/p1/onboarding']}><Link to="/projects/p2/onboarding">切换项目</Link><Routes><Route path="/projects/:projectId/onboarding" element={<ProjectOnboardingPage />} /></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /补充简报/ }));
    expect(screen.getByRole('textbox', { name: '核心目标' })).toHaveValue('Alpha goal');
    expect(screen.getByRole('textbox', { name: '本机绝对路径' })).toHaveValue('C:/alpha');
    fireEvent.click(screen.getByRole('link', { name: '切换项目' }));
    await screen.findByRole('heading', { name: 'p2' });
    fireEvent.click(screen.getByRole('button', { name: /补充简报/ }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '核心目标' })).toHaveValue('Beta goal'));
    expect(screen.getByRole('textbox', { name: 'Repository URL' })).toHaveValue('');
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
  const workflow = [{ id: 'node-coding', type: 'execution', title: '编码', goal: '在同一工作区完成 Desktop UI、测试与文档', dependency_indexes: [] }];
  return { project: project(), intake: { id: 'i1', project_id: 'p1', mode: 'brainstorm', status: 'ready_for_review', answers: { goal: 'Ship it' }, code_source: null, context_sources: [], revision: 2 }, brief: { id: 'b1', project_id: 'p1', version: 2, status: 'draft', source: 'brainstorm', content, created_at: new Date(0).toISOString() }, briefs: [], workflow_draft: workflow, imports: [], can_confirm: true, onboarding_route: '/projects/p1/onboarding', assist_session: null };
}
function onboardingFor(id: string, goal: string, source: { type: 'local_directory'; path: string } | null) {
  const value = structuredClone(onboarding());
  Object.assign(value.project, { id, title: id, goal });
  Object.assign(value.intake, { project_id: id, mode: 'existing', answers: { goal }, code_source: source, revision: 2 });
  Object.assign(value.brief, { id: `brief-${id}`, project_id: id, content: { ...value.brief.content, goal } });
  return value;
}
