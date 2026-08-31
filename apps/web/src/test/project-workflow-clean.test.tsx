import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkflowPage } from '../features/project';

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
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
  });
});
