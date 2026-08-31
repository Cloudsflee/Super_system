import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FinalBusinessParityPage } from '../features/p10';
import type { WorkspacePageProps } from '../workspace';

const props: WorkspacePageProps = { projectId: 'project-p10', selectedProject: { id: 'project-p10', name: 'P10 Project', description: '', status: 'active', revision: 4, updated_at: '', team_id: 'team-p10' } as WorkspacePageProps['selectedProject'], selectProject: vi.fn(), refreshProjects: vi.fn(), notify: vi.fn(), navigate: vi.fn(), setupReady: true, refreshSetup: vi.fn() };
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ request_id: 'p10-web', data, meta: { api_version: '2' } }), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('renders Provider, template, deletion, Assist and Quality workflow tabs through API v2', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method || 'GET'; calls.push({ url, method });
    if (method !== 'GET') {
      if (url.includes('/profiles/')) return envelope({ profile: { id: 'profile-p10', provider: 'codex', label: 'Updated', status: 'available', lifecycle_status: 'enabled', revision: 3 } });
      if (url.endsWith('/deletion-intents')) return envelope({ intent: { id: 'intent-p10', status: 'prepared', revision: 1, target_name: 'P10 Project', blockers: [] } }, 201);
      return envelope({});
    }
    if (url === '/api/v2/profiles') return envelope({ profiles: [{ id: 'profile-p10', provider: 'codex', label: 'Reviewer', status: 'available', lifecycle_status: 'enabled', revision: 2 }] });
    if (url === '/api/v2/brief-templates') return envelope({ templates: [{ id: 'template-p10', name: 'Delivery Brief', description: '', status: 'active', current_revision: 2, revision: 2, content: { sections: ['objective'] } }] });
    if (url.startsWith('/api/v2/assist/sessions')) return envelope({ sessions: [{ id: 'assist-p10', title: 'Review', mode: 'guided', status: 'active', revision: 2 }] });
    if (url.endsWith('/executions')) return envelope({ executions: [{ id: 'execution-p10' }] });
    if (url.endsWith('/quality-reviews/prepare')) return envelope({ policy: { rubric: { dimensions: ['coverage','accuracy','depth','consistency','clarity'].map((key) => ({ key, weight: 20 })) } }, readiness: { ready: true, checks: { assets: 'ready', reviewer: 'ready' } } });
    return envelope({ project: { revision: 4 } });
  }));
  render(<FinalBusinessParityPage {...props} />);
  expect(await screen.findByText('Provider Profile')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Profile 名称'), { target: { value: 'Updated' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(calls.some((call) => call.url.includes('/profiles/profile-p10') && call.method === 'PATCH')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: /Brief 模板/ }));
  expect(await screen.findByText(/模板修订 2/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /项目删除/ }));
  fireEvent.change(screen.getByPlaceholderText('输入完整项目名称'), { target: { value: 'P10 Project' } });
  fireEvent.click(screen.getByRole('button', { name: '准备' }));
  expect(await screen.findByText('已准备')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /质量就绪/ }));
  expect(await screen.findByText('覆盖度')).toBeVisible();
  expect(calls.every((call) => !call.url.includes('/api/v1/'))).toBe(true);
});
