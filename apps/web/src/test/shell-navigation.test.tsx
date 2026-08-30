import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { systemOnboardingKey } from '../features/setup';

function envelope(data: unknown) {
  return new Response(JSON.stringify({ request_id: 'req_shell', data, meta: { api_version: '2' } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); location.hash = '#/projects';
});

function emptyShellFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/v2/setup')) return envelope({ needs_setup: false, actor_count: 1, bootstrap_actor_id: 'account_shell' });
    if (url.endsWith('/api/v2/account')) return envelope({ account: { id: 'account_shell', display_name: 'Shell owner', revision: 1 } });
    if (url.endsWith('/api/v2/credentials')) return envelope({ credentials: [] });
    if (url.endsWith('/api/v2/profiles')) return envelope({ profiles: [] });
    if (url.endsWith('/api/v2/projects')) return envelope({ projects: [] });
    return envelope({});
  });
}

it('keeps the six-entry drawer closed by default and traps, closes, and restores keyboard focus', async () => {
  localStorage.setItem(systemOnboardingKey('account_shell'), '1');
  vi.stubGlobal('fetch', emptyShellFetch());
  render(<App />);
  await screen.findByRole('heading', { name: '项目' });
  const opener = screen.getByRole('button', { name: '打开导航' });
  const drawer = document.querySelector('#workspace-navigation') as HTMLElement;
  expect(drawer).toHaveAttribute('aria-hidden', 'true');
  expect(document.querySelector('.nav-scrim')).toBeNull();
  expect(screen.queryByText('Final parity')).toBeNull();
  for (const tool of ['Assist', '审批中心，0 项待处理', '文件', 'Terminal']) expect(screen.getByRole('button', { name: tool })).toBeInTheDocument();

  fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: '工作区导航' });
  const navigation = within(dialog).getByRole('navigation', { name: '一级导航' });
  expect(within(navigation).getAllByRole('button').map((button) => button.textContent)).toEqual(['项目', '工作区', '资产', '上下文', '审计', '设置']);
  await waitFor(() => expect(within(navigation).getByRole('button', { name: '项目' })).toHaveFocus());
  const last = within(navigation).getByRole('button', { name: '设置' });
  last.focus();
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(within(dialog).getByRole('button', { name: '关闭导航' })).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(drawer).toHaveAttribute('aria-hidden', 'true'));
  await waitFor(() => expect(opener).toHaveFocus());

  fireEvent.click(opener);
  await screen.findByRole('dialog', { name: '工作区导航' });
  fireEvent.click(document.querySelector('.nav-scrim') as HTMLButtonElement);
  await waitFor(() => expect(opener).toHaveAttribute('aria-expanded', 'false'));

  fireEvent.click(opener);
  const reopened = await screen.findByRole('dialog', { name: '工作区导航' });
  fireEvent.click(within(reopened).getByRole('button', { name: '项目' }));
  await waitFor(() => expect(opener).toHaveAttribute('aria-expanded', 'false'));
  await waitFor(() => expect(opener).toHaveFocus());
});

it('redirects a draft project workflow deep-link to parameterized onboarding', async () => {
  location.hash = '#/projects/project_draft/workflow';
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const project = { id: 'project_draft', team_id: 'team_1', name: 'Draft project', description: '', status: 'draft', onboarding_state: 'collecting', current_brief_revision: 0, current_workflow_revision: 0, revision: 1, updated_at: '' };
    if (url.endsWith('/api/v2/setup')) return envelope({ needs_setup: false, actor_count: 1, bootstrap_actor_id: 'account_draft' });
    if (url.endsWith('/api/v2/account')) return envelope({ account: { id: 'account_draft', display_name: 'Draft owner', revision: 1 } });
    if (url.endsWith('/api/v2/credentials')) return envelope({ credentials: [] });
    if (url.endsWith('/api/v2/profiles')) return envelope({ profiles: [] });
    if (url.endsWith('/api/v2/projects')) return envelope({ projects: [project] });
    if (url.endsWith('/api/v2/projects/project_draft')) return envelope({ project });
    if (url.endsWith('/intake')) return envelope({ intake: { id: 'intake_1', status: 'draft', mode: 'brainstorm', attempt: 0, revision: 1 } });
    if (url.endsWith('/briefs')) return envelope({ briefs: [] });
    if (url.endsWith('/workflow-draft')) return envelope({ workflow: { id: 'workflow_1', status: 'draft', current_revision: 0, revision: 1, current: null } });
    if (url.endsWith('/workflow-generations')) return envelope({ generations: [] });
    if (url.endsWith('/brief-templates')) return envelope({ templates: [] });
    if (url.endsWith('/repository-connections')) return envelope({ connections: [] });
    if (url.endsWith('/repository-lines')) return envelope({ lines: [] });
    if (url.endsWith('/outcome-requirements')) return envelope({ requirements: [] });
    if (url.includes('/approvals')) return envelope({ approvals: [] });
    if (url.includes('/user-inputs')) return envelope({ inputs: [] });
    return envelope({});
  }));
  render(<App />);
  await screen.findByTestId('project-onboarding');
  expect(location.hash).toBe('#/projects/project_draft/onboarding');
});
