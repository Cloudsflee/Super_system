import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProjectOnboardingPage } from '../features/project';

function envelope(data: unknown, status = 200) {
  return new Response(JSON.stringify({ request_id: 'req_project_onboarding', data, meta: { api_version: '2' } }), { status, headers: { 'content-type': 'application/json' } });
}

function props() {
  return {
    projectId: 'project_1', selectedProject: undefined, selectProject: vi.fn(), refreshProjects: vi.fn(async () => {}),
    notify: vi.fn(), navigate: vi.fn(), navigateProject: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => {})
  };
}

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

it('runs template Brief, generation, critic, apply, and final confirm in order', async () => {
  let project: { id: string; name: string; status: string; onboarding_state: string; current_brief_revision: number; confirmed_brief_revision: number | null; current_workflow_revision: number; revision: number } = { id: 'project_1', name: 'Onboarding project', status: 'draft', onboarding_state: 'collecting', current_brief_revision: 0, confirmed_brief_revision: null, current_workflow_revision: 0, revision: 1 };
  let intake = { id: 'intake_1', status: 'draft', mode: 'brainstorm' as const, attempt: 0, revision: 1 };
  let briefRevision: Record<string, unknown> | null = null;
  let briefHead: Record<string, unknown> | null = null;
  let workflow = { id: 'workflow_1', status: 'draft', current_revision: 0, revision: 1, current: null as null | Record<string, unknown> };
  let generation: Record<string, unknown> | null = null;
  const order: string[] = [];
  const mutationHeaders: Record<string, string | null> = {};
  const template = { id: 'template_1', name: '交付模板', current_revision: 2, revision: 2, content: { objective: '模板目标', users: ['维护者'], scope: { in: ['Web'], out: ['Mobile'] }, constraints: ['CAS'], milestones: ['M1'], acceptance: ['通过'], risks: ['漂移'], open_questions: ['待定'] } };

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const method = options?.method || 'GET'; const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (method === 'GET') {
      if (url.endsWith('/api/v2/projects/project_1')) return envelope({ project, brief: briefHead, workflow });
      if (url.endsWith('/intake')) return envelope({ intake });
      if (url.endsWith('/briefs')) return envelope({ briefs: briefRevision ? [briefRevision] : [] });
      if (url.endsWith('/workflow-draft')) return envelope({ workflow });
      if (url.endsWith('/workflow-generations')) return envelope({ generations: generation ? [generation] : [] });
      if (url.endsWith('/brief-templates')) return envelope({ templates: [template] });
      if (url.endsWith('/profiles')) return envelope({ profiles: [] });
    }
    if (url.endsWith('/intake')) { order.push('intake'); intake = { ...intake, status: 'ready', attempt: 1, revision: 3 }; return envelope({ intake, operation: { operation_id: 'op_intake' } }, 202); }
    if (url.endsWith('/briefs')) {
      order.push('brief');
      expect(body.template_id).toBe('template_1');
      expect(body.content).toMatchObject({ objective: '模板目标', users: ['维护者'], acceptance: ['通过'] });
      project = { ...project, current_brief_revision: 1, revision: 2 };
      briefRevision = { id: 'brief_revision_1', brief_id: 'brief_1', revision: 1, content: body.content, content_sha256: 'a'.repeat(64), template_id: 'template_1', template_revision: 2 };
      briefHead = { id: 'brief_1', brief_id: 'brief_1', current_revision: 1, confirmed_revision: null, current: briefRevision };
      return envelope({ brief: briefHead, revision_record: briefRevision }, 201);
    }
    if (url.endsWith('/workflow-draft')) {
      order.push('workflow'); project = { ...project, current_workflow_revision: 1, revision: 3 };
      workflow = { id: 'workflow_1', status: 'draft', current_revision: 1, revision: 2, current: { graph: body.graph, graph_sha256: 'b'.repeat(64) } };
      return envelope({ workflow }, 201);
    }
    if (url.endsWith('/workflow-generations')) {
      order.push('generation'); mutationHeaders.generation = new Headers(options?.headers).get('X-Expected-Revision');
      generation = { id: 'generation_1', phase: 'critic_pending', revision: 3, proposal_id: null, attempt: 1 };
      return envelope({ generation, operation: { operation_id: 'op_generation' } }, 202);
    }
    if (url.endsWith('/workflow-generations/generation_1/critic')) {
      order.push('critic'); generation = { ...generation, phase: 'proposed', revision: 4, proposal_id: 'proposal_1' };
      return envelope({ generation, proposal: { id: 'proposal_1' } });
    }
    if (url.endsWith('/workflow-proposals/proposal_1/apply')) {
      order.push('apply'); mutationHeaders.apply = new Headers(options?.headers).get('X-Expected-Revision');
      generation = { ...generation, phase: 'applied', revision: 5 }; workflow = { ...workflow, status: 'active', current_revision: 2, revision: 3 }; project = { ...project, current_workflow_revision: 2, revision: 4 };
      return envelope({ proposal: { id: 'proposal_1', status: 'applied' }, workflow });
    }
    if (url.endsWith('/briefs/1/confirm')) {
      order.push('confirm'); mutationHeaders.confirm = new Headers(options?.headers).get('X-Expected-Revision');
      project = { ...project, status: 'active', onboarding_state: 'confirmed', confirmed_brief_revision: 1, revision: 5 };
      briefHead = { ...briefHead, confirmed_revision: 1 };
      return envelope({ project, brief: briefHead });
    }
    return envelope({});
  }));

  const pageProps = props();
  render(<ProjectOnboardingPage {...pageProps} />);
  await screen.findByRole('heading', { name: '选择项目来源' });
  fireEvent.change(screen.getByLabelText('初始构想'), { target: { value: '从零构思' } });
  fireEvent.click(screen.getByRole('button', { name: '提交 Intake' }));
  await screen.findByRole('heading', { name: '编辑完整 Brief' });
  fireEvent.change(screen.getByLabelText('Brief 模板'), { target: { value: 'template_1' } });
  fireEvent.click(screen.getByRole('button', { name: '应用模板' }));
  expect(screen.getByLabelText('目标')).toHaveValue('模板目标');
  fireEvent.click(screen.getByRole('button', { name: '保存 Brief' }));
  await screen.findByRole('heading', { name: '审查 Brief 与初始 Workflow' });
  fireEvent.click(screen.getByRole('button', { name: '保存初始 Workflow' }));
  await screen.findByRole('button', { name: '生成候选' });
  fireEvent.click(screen.getByRole('button', { name: '生成候选' }));
  await screen.findByRole('button', { name: '执行 Critic' });
  fireEvent.click(screen.getByRole('button', { name: '执行 Critic' }));
  await screen.findByRole('button', { name: '应用 Proposal' });
  fireEvent.click(screen.getByRole('button', { name: '应用 Proposal' }));
  await screen.findByRole('button', { name: '确认 Brief 并激活' });
  fireEvent.click(screen.getByRole('button', { name: '确认 Brief 并激活' }));
  await waitFor(() => expect(pageProps.navigateProject).toHaveBeenCalledWith('project_1', 'workflow'));
  expect(order).toEqual(['intake', 'brief', 'workflow', 'generation', 'critic', 'apply', 'confirm']);
  expect(mutationHeaders).toEqual({ generation: '3', apply: '2', confirm: '4' });
});

it('submits an existing read-only source selected through GitHub discovery', async () => {
  const submitted: Record<string, unknown>[] = [];
  const project = { id: 'project_1', name: 'Existing source', status: 'draft', onboarding_state: 'collecting', current_brief_revision: 0, current_workflow_revision: 0, revision: 1 };
  const intake = { id: 'intake_1', status: 'draft', mode: 'brainstorm', attempt: 0, revision: 1 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const method = options?.method || 'GET';
    if (method === 'POST' && url.endsWith('/intake')) { submitted.push(JSON.parse(String(options?.body))); return envelope({ intake: { ...intake, status: 'processing', revision: 2 } }, 202); }
    if (url.endsWith('/api/v2/projects/project_1')) return envelope({ project });
    if (url.endsWith('/intake')) return envelope({ intake });
    if (url.endsWith('/briefs')) return envelope({ briefs: [] });
    if (url.endsWith('/workflow-draft')) return envelope({ workflow: { id: 'workflow_1', status: 'draft', current_revision: 0, revision: 1 } });
    if (url.endsWith('/workflow-generations')) return envelope({ generations: [] });
    if (url.endsWith('/brief-templates')) return envelope({ templates: [] });
    if (url.endsWith('/profiles')) return envelope({ profiles: [{ id: 'github_profile', provider: 'github', status: 'available', lifecycle_status: 'enabled' }] });
    if (url.endsWith('/provider-profiles/github_profile/repositories')) return envelope({ repositories: [{ id: 7, full_name: 'ORG/repository', default_branch: 'main' }] });
    return envelope({});
  }));
  render(<ProjectOnboardingPage {...props()} />);
  await screen.findByRole('heading', { name: '选择项目来源' });
  fireEvent.click(screen.getByRole('button', { name: '已有项目' }));
  fireEvent.click(screen.getByRole('button', { name: '发现 GitHub 仓库' }));
  await screen.findByLabelText('GitHub 仓库');
  fireEvent.change(screen.getByLabelText('GitHub 仓库'), { target: { value: 'ORG/repository' } });
  fireEvent.click(screen.getByRole('button', { name: '提交 Intake' }));
  await waitFor(() => expect(submitted).toHaveLength(1));
  expect(submitted[0]).toMatchObject({ mode: 'existing', source: { kind: 'github', locator: 'ORG/repository', revision: 'main' }, content: { read_only: true } });
});

it('restores the critic step after refresh and retries source drift with Intake CAS', async () => {
  let retryHeader = '';
  const project = { id: 'project_1', name: 'Recovered', status: 'draft', onboarding_state: 'collecting', current_brief_revision: 1, current_workflow_revision: 1, revision: 3 };
  const base = async (url: string) => {
    if (url.endsWith('/api/v2/projects/project_1')) return envelope({ project, brief: { current_revision: 1, current: { revision: 1, content: { objective: 'Recovered' } } } });
    if (url.endsWith('/briefs')) return envelope({ briefs: [{ revision: 1, content: { objective: 'Recovered' } }] });
    if (url.endsWith('/workflow-draft')) return envelope({ workflow: { id: 'workflow_1', status: 'draft', current_revision: 1, revision: 2, current: { graph: { nodes: [] } } } });
    if (url.endsWith('/brief-templates')) return envelope({ templates: [] });
    if (url.endsWith('/profiles')) return envelope({ profiles: [] });
    return null;
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); const known = await base(url); if (known) return known;
    if (url.endsWith('/intake')) return envelope({ intake: { id: 'intake_1', status: 'ready', mode: 'brainstorm', attempt: 1, revision: 3 } });
    if (url.endsWith('/workflow-generations')) return envelope({ generations: [{ id: 'generation_1', phase: 'critic_pending', revision: 3, attempt: 1 }] });
    return envelope({});
  }));
  const first = render(<ProjectOnboardingPage {...props()} />);
  await screen.findByRole('button', { name: '执行 Critic' });
  first.unmount();

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const known = await base(url); if (known) return known;
    if (options?.method === 'POST' && url.endsWith('/intake/retry')) { retryHeader = new Headers(options.headers).get('X-Expected-Revision') || ''; return envelope({ operation: { operation_id: 'retry' } }, 202); }
    if (url.endsWith('/intake')) return envelope({ intake: { id: 'intake_1', status: 'failed', mode: 'existing', error_code: 'source_drift', attempt: 2, revision: 5 } });
    if (url.endsWith('/workflow-generations')) return envelope({ generations: [] });
    return envelope({});
  }));
  render(<ProjectOnboardingPage {...props()} />);
  await screen.findByText('源版本漂移');
  fireEvent.click(screen.getByRole('button', { name: '重试 Intake' }));
  await waitFor(() => expect(retryHeader).toBe('5'));
});

it('surfaces a Brief revision conflict without advancing onboarding', async () => {
  const project = { id: 'project_1', name: 'Conflict', status: 'draft', onboarding_state: 'collecting', current_brief_revision: 0, current_workflow_revision: 0, revision: 4 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (options?.method === 'POST' && url.endsWith('/briefs')) return new Response(JSON.stringify({ error: { code: 'revision_conflict', message: 'Project changed', retryable: true, details: { actual_revision: 5 } } }), { status: 409, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/v2/projects/project_1')) return envelope({ project });
    if (url.endsWith('/intake')) return envelope({ intake: { id: 'intake_1', status: 'ready', mode: 'brainstorm', attempt: 1, revision: 3 } });
    if (url.endsWith('/briefs')) return envelope({ briefs: [] });
    if (url.endsWith('/workflow-draft')) return envelope({ workflow: { id: 'workflow_1', status: 'draft', current_revision: 0, revision: 1 } });
    if (url.endsWith('/workflow-generations')) return envelope({ generations: [] });
    if (url.endsWith('/brief-templates')) return envelope({ templates: [] });
    if (url.endsWith('/profiles')) return envelope({ profiles: [] });
    return envelope({});
  }));
  render(<ProjectOnboardingPage {...props()} />);
  fireEvent.change(await screen.findByLabelText('目标'), { target: { value: 'Conflict objective' } });
  fireEvent.click(screen.getByRole('button', { name: '保存 Brief' }));
  expect(await screen.findByTestId('project-onboarding-conflict')).toHaveTextContent('Project changed');
  expect(screen.getByTestId('project-onboarding')).toHaveAttribute('data-step', '2');
});

it.each([false, true])('opens Assist from the complete Brief surface with saved=%s and preserves draft content', async (saved) => {
  const pageProps = { ...props(), openAssist: vi.fn() };
  const revision = saved ? { id: 'brief_revision_1', brief_id: 'brief_1', revision: 1, content: { objective: 'Saved objective', users: ['Maintainer'], acceptance: ['Pass'] }, content_sha256: 'a'.repeat(64) } : null;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/v2/projects/project_1')) return envelope({ project: { id: 'project_1', name: 'Brief review', status: 'draft', current_brief_revision: saved ? 1 : 0, current_workflow_revision: 0, revision: 2 }, brief: { id: 'brief_1', brief_id: 'brief_1', current_revision: saved ? 1 : 0, current: revision } });
    if (url.endsWith('/intake')) return envelope({ intake: { id: 'intake_1', status: 'ready', mode: 'brainstorm', revision: 3 } });
    if (url.endsWith('/briefs')) return envelope({ briefs: revision ? [revision] : [] });
    if (url.endsWith('/workflow-draft')) return envelope({ workflow: { id: 'workflow_1', status: 'draft', current_revision: 0, revision: 1 } });
    if (url.endsWith('/workflow-generations')) return envelope({ generations: [] });
    if (url.endsWith('/brief-templates')) return envelope({ templates: [] });
    if (url.endsWith('/profiles')) return envelope({ profiles: [] });
    throw new Error(`Unexpected request ${url}`);
  }));
  render(<ProjectOnboardingPage {...pageProps} />);
  const button = await screen.findByRole('button', { name: '在 Assist 中审阅当前 Brief' });
  if (!saved) fireEvent.change(screen.getByLabelText('目标'), { target: { value: 'Unsaved draft content' } });
  fireEvent.click(button);
  if (saved) expect(pageProps.openAssist).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project_1', resourceType: 'brief', resourceId: 'brief_1', revision: 1, contentHash: 'a'.repeat(64) }), true);
  else {
    expect(pageProps.openAssist).toHaveBeenCalledWith(expect.objectContaining({ label: '未保存 Brief 草稿', resourceId: undefined }), false);
    expect(screen.getByLabelText('目标')).toHaveValue('Unsaved draft content');
  }
});
