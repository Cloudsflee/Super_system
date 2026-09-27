import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProjectOnboardingPage } from '../features/project';

const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ request_id: 'req_project_onboarding', data, meta: { api_version: '2' } }), { status, headers: { 'content-type': 'application/json' } });
const project = { id: 'project_1', name: 'Onboarding project', status: 'draft', onboarding_state: 'collecting', revision: 1 };
const props = () => ({ projectId: 'project_1', selectedProject: undefined, selectProject: vi.fn(), refreshProjects: vi.fn(async () => {}), notify: vi.fn(), navigate: vi.fn(), navigateProject: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => {}) });

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });

it('owns only initial Intake and routes completed projects to the canonical Workflow workbench', async () => {
  let intake = { id: 'intake_1', status: 'draft', mode: 'brainstorm' as const, attempt: 0, revision: 1 };
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (options?.method === 'POST' && url.endsWith('/intake')) { calls.push('intake'); intake = { ...intake, status: 'ready', attempt: 1, revision: 2 }; return envelope({ intake }, 202); }
    if (url.endsWith('/api/v2/projects/project_1')) return envelope({ project });
    if (url.endsWith('/intake')) return envelope({ intake });
    if (url.endsWith('/profiles')) return envelope({ profiles: [] });
    return envelope({});
  }));
  const pageProps = props();
  render(<ProjectOnboardingPage {...pageProps} />);
  fireEvent.change(await screen.findByLabelText('初始构想'), { target: { value: '从零构思' } });
  fireEvent.click(screen.getByRole('button', { name: '提交 Intake' }));
  await screen.findByRole('heading', { name: 'Intake 已完成' });
  expect(calls).toEqual(['intake']);
  expect(screen.queryByRole('button', { name: '保存 Brief' })).toBeNull();
  expect(screen.queryByRole('button', { name: '生成候选' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '进入 Workflow 工作台' }));
  expect(pageProps.navigateProject).toHaveBeenCalledWith('project_1', 'workflow');
});

it('submits an existing read-only source selected through GitHub discovery', async () => {
  const submitted: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const method = options?.method || 'GET';
    if (method === 'POST' && url.endsWith('/intake')) { submitted.push(JSON.parse(String(options?.body))); return envelope({ intake: { id: 'intake_1', status: 'processing', mode: 'existing', attempt: 1, revision: 2 } }, 202); }
    if (url.endsWith('/api/v2/projects/project_1')) return envelope({ project });
    if (url.endsWith('/intake')) return envelope({ intake: { id: 'intake_1', status: 'draft', mode: 'brainstorm', attempt: 0, revision: 1 } });
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

it('retries failed Intake with its current revision', async () => {
  let retryHeader = '';
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (options?.method === 'POST' && url.endsWith('/intake/retry')) { retryHeader = new Headers(options.headers).get('X-Expected-Revision') || ''; return envelope({ intake: { id: 'intake_1', status: 'processing', mode: 'existing', attempt: 2, revision: 6 } }, 202); }
    if (url.endsWith('/api/v2/projects/project_1')) return envelope({ project });
    if (url.endsWith('/intake')) return envelope({ intake: { id: 'intake_1', status: 'failed', mode: 'existing', error_code: 'source_drift', attempt: 2, revision: 5 } });
    if (url.endsWith('/profiles')) return envelope({ profiles: [] });
    return envelope({});
  }));
  render(<ProjectOnboardingPage {...props()} />);
  await screen.findByText('源版本漂移');
  fireEvent.click(screen.getByRole('button', { name: '重试 Intake' }));
  await waitFor(() => expect(retryHeader).toBe('5'));
});
