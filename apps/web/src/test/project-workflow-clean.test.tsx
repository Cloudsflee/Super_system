import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkflowPage } from '../features/project';
import { invalidateEventQueries, queryClient } from '../query';
import { OfflineOutbox } from '../offline/outbox';
import { newWorkflowNode } from '../features/project/WorkflowCanvas';

function envelope(data: unknown, meta: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ request_id: 'req_p3', data, meta: { api_version: '2', ...meta } }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
}

const project = { id: 'project_1', team_id: 'team_1', owner_actor_id: 'actor_1', name: 'Clean project', status: 'draft', onboarding_state: 'collecting', current_brief_revision: 0, current_workflow_revision: 0, revision: 1 };
const props = {
  projectId: 'project_1', selectedProject: undefined, selectProject: vi.fn(), refreshProjects: vi.fn(async () => {}),
  notify: vi.fn(), navigate: vi.fn(), navigateProject: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => {})
};

function cleanBundle(url: string) {
  if (url.endsWith('/api/v2/projects')) return envelope({ projects: [project] });
  if (url.endsWith('/intake')) return envelope({ intake: { id: 'intake_1', project_id: 'project_1', status: 'failed', mode: 'existing', source_kind: 'fixture', source_revision: 'r1', revision: 2, attempt: 1, error_code: 'source_drift' } });
  if (url.endsWith('/briefs')) return envelope({ briefs: [{ project_id: 'project_1', current_revision: 1, revision: 1, status: 'draft', current: { revision: 1, content: { objective: 'Ship', acceptance: ['test'] } } }] });
  if (url.endsWith('/repository-connections')) return envelope({ connections: [] });
  if (url.endsWith('/repository-lines')) return envelope({ lines: [] });
  if (url.endsWith('/workflow-draft')) return envelope({ workflow: { id: 'workflow_1', project_id: 'project_1', status: 'draft', current_revision: 0, revision: 1, current: null } });
  if (url.endsWith('/workflow-generations')) return envelope({ generations: [] });
  if (url.endsWith('/outcome-requirements')) return envelope({ requirements: [] });
  if (url.endsWith('/api/v2/projects/project_1')) return envelope({ project });
  return envelope({});
}

describe('ProjectWorkflowPage clean slice', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('shows a stable loading state while v2 data is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<ProjectWorkflowPage {...props} projectId="" />);
    expect(screen.getByTestId('project-workflow-loading')).toBeInTheDocument();
  });

  it('renders empty project creation and sends only v2 requests', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input); calls.push(`${options?.method || 'GET'} ${url}`);
      if (url.endsWith('/api/v2/projects') && options?.method === 'POST') return envelope({ project: { ...project, id: 'project_new' }, operation: { id: 'op_new' } });
      return envelope({ projects: [] });
    }));
    render(<ProjectWorkflowPage {...props} projectId="" />);
    await waitFor(() => expect(screen.getByTestId('project-workflow-empty')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'New project' } });
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    await waitFor(() => expect(calls.some((call) => call.startsWith('POST /api/v2/projects'))).toBe(true));
    expect(props.selectProject).toHaveBeenCalledWith('project_new');
    expect(props.navigateProject).toHaveBeenCalledWith('project_new', 'onboarding');
    expect(calls.every((call) => !call.includes('/api/v1/'))).toBe(true);
  });

  it('loads intake drift, retries with the intake revision, and exposes workflow controls', async () => {
    const calls: Array<{ url: string; options?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input); calls.push({ url, options });
      if (options?.method === 'POST' && url.endsWith('/intake/retry')) return envelope({ operation: { id: 'op_retry' } });
      return cleanBundle(url);
    }));
    render(<ProjectWorkflowPage {...props} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Clean project' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: '来源接入' }));
    expect(screen.getByTestId('project-workflow-drift')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试接入' }));
    await waitFor(() => expect(calls.some(({ url, options }) => url.endsWith('/intake/retry') && new Headers(options?.headers).get('X-Expected-Revision') === '2')).toBe(true));
    fireEvent.click(screen.getByRole('tab', { name: '工作流' }));
    expect(screen.getByText('工作流草稿')).toBeInTheDocument();
    expect(calls.every(({ url }) => !url.includes('/api/v1/'))).toBe(true);
  });

  it('renders denied state for a rejected project scope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'permission_denied', message: 'Project denied', retryable: false, details: {} } }), {
      status: 403, headers: { 'content-type': 'application/json' }
    })));
    render(<ProjectWorkflowPage {...props} />);
    await waitFor(() => expect(screen.getByTestId('project-workflow-denied')).toBeInTheDocument());
    expect(screen.getByText('Project denied')).toBeInTheDocument();
  });

  it('surfaces revision conflict on a brief mutation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (options?.method === 'POST' && url.endsWith('/briefs')) return new Response(JSON.stringify({ error: { code: 'revision_conflict', message: 'Project changed', retryable: true, details: { actual_revision: 4 } } }), { status: 409, headers: { 'content-type': 'application/json' } });
      return cleanBundle(url);
    }));
    render(<ProjectWorkflowPage {...props} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Clean project' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: 'Updated objective' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修订' }));
    await waitFor(() => expect(screen.getByTestId('project-workflow-conflict')).toBeInTheDocument());
    expect(screen.getByText('Project changed')).toBeInTheDocument();
    expect(screen.getByLabelText('目标')).toHaveValue('Updated objective');
    expect(screen.getByText('服务器修订 r4')).toBeVisible();
    expect(screen.getByRole('button', { name: '重新加载服务器版本' })).toBeVisible();
  });

  it('edits, sorts and validates Brief rows, preserving extra content and mutation headers', async () => {
    const writes: Array<{ body: Record<string, any>; headers: Headers }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (options?.method === 'POST') { writes.push({ body: JSON.parse(String(options.body)), headers: new Headers(options.headers) }); return envelope({ operation: { id: 'saved-brief' } }); }
      if (url.endsWith('/briefs')) return envelope({ briefs: [{ project_id: project.id, current_revision: 1, revision: 1, current: { revision: 1, content: { objective: 'Ship', acceptance: ['first', 'second'], risks: ['retain me'] } } }] });
      return cleanBundle(url);
    }));
    render(<ProjectWorkflowPage {...props} initialSection="brief" />);
    await screen.findByLabelText('验收标准 1');
    fireEvent.click(screen.getByRole('button', { name: '添加验收标准' }));
    expect(screen.getByRole('button', { name: '保存修订' })).toBeDisabled();
    expect(screen.getByText('条目不能为空')).toBeVisible();
    fireEvent.change(screen.getByLabelText('验收标准 3'), { target: { value: ' third ' } });
    fireEvent.click(screen.getByRole('button', { name: '上移验收标准 3' }));
    fireEvent.click(screen.getByRole('button', { name: '删除验收标准 1' }));
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: ' Ship changed ' } });
    expect(screen.getByRole('button', { name: '确认修订' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存修订' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.content).toEqual({ objective: 'Ship changed', acceptance: ['third', 'second'], risks: ['retain me'] });
    expect(writes[0].headers.get('X-Expected-Revision')).toBe('1');
    expect(writes[0].headers.get('Idempotency-Key')).toBeTruthy();
  });

  it('uses real nested proposal receipts and Workflow CAS, with online-only actions', async () => {
    const writes: Array<{ url: string; headers: Headers }> = [];
    const generation = { id: 'generation_ui', phase: 'proposed', revision: 20, proposal_id: 'proposal_ui', candidate_sha256: 'c'.repeat(64), proposal: { base_workflow_revision: 3, candidate: { nodes: [newWorkflowNode('task', [])] }, candidate_sha256: 'c'.repeat(64) }, critic: { status: 'passed', issues: [] } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (options?.method === 'POST') { writes.push({ url, headers: new Headers(options.headers) }); return envelope({ operation_id: 'op_apply' }); }
      if (url.endsWith('/workflow-generations')) return envelope({ generations: [generation] });
      if (url.endsWith('/workflow-generations/generation_ui')) return envelope({ generation });
      if (url.endsWith('/workflow-draft')) return envelope({ workflow: { id: 'workflow_ui', revision: 7, current_revision: 3, current: { graph: { nodes: [] } } } });
      return cleanBundle(url);
    }));
    render(<ProjectWorkflowPage {...props} initialSection="workflow" />);
    fireEvent.click(await screen.findByRole('button', { name: '查看提案' }));
    expect(screen.getByRole('region', { name: 'Workflow 提案 JSON' })).toBeVisible();
    expect(screen.getByText('c'.repeat(64))).toBeVisible();
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(screen.getByRole('button', { name: '应用提案' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '创建并开始执行' })).toBeDisabled();
    expect(writes).toHaveLength(0);
    online.mockReturnValue(true); act(() => { window.dispatchEvent(new Event('online')); });
    fireEvent.click(screen.getByRole('button', { name: '应用提案' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].url).toBe('/api/v2/workflow-proposals/proposal_ui/apply');
    expect(writes[0].headers.get('X-Expected-Revision')).toBe('7');
    expect(writes[0].headers.get('Idempotency-Key')).toBeTruthy();
  });

  it('queues only a Brief save offline while keeping confirmation and generation online', async () => {
    const writes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => { if (options?.method === 'POST') writes.push(String(input)); return cleanBundle(String(input)); }));
    const outbox = new OfflineOutbox({ actorId: sessionStorage.getItem('aiws:v3:actor-id') || 'actor_1', teamId: 'team_1', projectId: 'project_1' });
    const before = await outbox.list();
    render(<ProjectWorkflowPage {...props} initialSection="brief" />);
    await screen.findByLabelText('目标');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('offline')); });
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: 'Offline objective' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修订' }));
    await waitFor(() => expect(screen.getByText('已离线保存，等待同步')).toBeVisible());
    const added = (await outbox.list()).filter(row => !before.some(item => item.id === row.id));
    expect(added).toHaveLength(1); expect(added[0].command).toBe('brief.create');
    expect(writes).toEqual([]); expect(screen.getByRole('button', { name: '确认修订' })).toBeDisabled();
  });

  it('cancels the old project query and never renders a delayed previous-project response', async () => {
    let finishOld: (response: Response) => void = () => {}; let oldSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/v2/projects/project_1')) { oldSignal = options?.signal as AbortSignal; return new Promise<Response>(resolve => { finishOld = resolve; }); }
      if (url.endsWith('/api/v2/projects/project_2')) return envelope({ project: { ...project, id: 'project_2', name: 'Second project' } });
      return cleanBundle(url);
    }));
    const view = render(<ProjectWorkflowPage {...props} />);
    await waitFor(() => expect(oldSignal).toBeDefined());
    view.rerender(<ProjectWorkflowPage {...props} projectId="project_2" />);
    await screen.findByRole('heading', { name: 'Second project' });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => { finishOld(envelope({ project })); });
    expect(screen.queryByRole('heading', { name: 'Clean project' })).toBeNull();
    expect(queryClient.getQueryCache().getAll().some(query => query.queryKey[3] === 'project_2' && query.queryKey[4] === 'workflow')).toBe(true);
  });

  it('refreshes generation events independently, preserving a dirty graph and stopping terminal polling', async () => {
    let phase = 'running'; let generationReads = 0; let projectReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workflow-generations')) { generationReads++; return envelope({ generations: [{ id: 'polling', phase, revision: 3 }] }); }
      if (url.endsWith('/workflow-generations/polling')) return envelope({ generation: { id: 'polling', phase, revision: 3 } });
      if (url.endsWith('/api/v2/projects/project_1')) projectReads++;
      return cleanBundle(url);
    }));
    render(<ProjectWorkflowPage {...props} initialSection="workflow" />);
    await screen.findByRole('heading', { name: '工作流草稿' });
    fireEvent.click(screen.getByText('高级 JSON 编辑'));
    const source = JSON.stringify({ nodes: [newWorkflowNode('task', [])], marker: 'unsaved local data' });
    fireEvent.change(screen.getByLabelText('图谱 JSON'), { target: { value: source } });
    const initialProjectReads = projectReads;
    phase = 'critic_pending';
    await screen.findByRole('button', { name: '执行 Critic' }, { timeout: 3000 });
    expect(screen.queryByRole('button', { name: '取消生成' })).toBeNull();
    expect(projectReads).toBe(initialProjectReads);
    phase = 'failed';
    act(() => { invalidateEventQueries('workflow.generation.failed'); });
    await screen.findByRole('button', { name: '重试生成' });
    expect(screen.getByLabelText('图谱 JSON')).toHaveValue(source);
    const finalReads = generationReads;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1700)); });
    expect(generationReads).toBe(finalReads);
  });
});
