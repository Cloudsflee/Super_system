import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectOnboardingPage } from '../features/projects/onboarding/ProjectOnboardingPage';
import { codeSource } from '../features/projects/onboarding/onboarding-support';
import { SetupPage } from '../features/setup/SetupPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('V1.4 deployment capabilities', () => {
  it('shows sanitized container capabilities during setup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/system/deployment')
          ? response(deployment(true))
          : response({
              complete: false,
              mode: null,
              can_complete: false,
              steps: { github: { ready: false, status: 'required' }, codex: { ready: false, status: 'required' } },
              reasons: []
            })
      )
    );
    renderWithClient(
      <MemoryRouter initialEntries={['/setup']}>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText('容器 · Docker 数据卷 · 套接字执行器')).toBeInTheDocument();
    expect(screen.getByText('相对路径')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('/var/run/docker.sock');
    expect(document.body.textContent).not.toContain('aiws-data-v14');
  });

  it('uses host import scope for relative project paths', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/system/deployment') ? response(deployment(true)) : response(onboarding())
      )
    );
    renderWithClient(
      <MemoryRouter initialEntries={['/projects/p1/onboarding']}>
        <Routes>
          <Route path="/projects/:projectId/onboarding" element={<ProjectOnboardingPage />} />
        </Routes>
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: '补充简报' }));
    expect(await screen.findByText('导入根下的相对路径')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('team/project')).toHaveValue('team/repo');
    expect(codeSource('local_directory', 'team/repo', true)).toEqual({
      type: 'local_directory',
      path: 'team/repo',
      path_scope: 'host_import_root'
    });
  });
});

function renderWithClient(value: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{value}</QueryClientProvider>);
}

function deployment(projectsRoot: boolean) {
  return {
    mode: 'container',
    local_only: true,
    storage: { type: 'docker_volume', ready: true },
    docker: { strategy: 'socket', ready: true },
    imports: { codex_home: false, cc_switch: false, projects_root: projectsRoot, project_path_mode: 'relative' }
  };
}
function onboarding() {
  return {
    project: {
      id: 'p1',
      title: 'Relative Import',
      goal: 'Ship',
      status: 'draft',
      current_workspace_id: 'w1',
      onboarding_state: 'brief_review',
      managed_workspace_state: 'empty'
    },
    intake: {
      id: 'i1',
      project_id: 'p1',
      mode: 'existing',
      status: 'ready_for_review',
      code_source: { type: 'local_directory', path: 'team/repo', path_scope: 'host_import_root' },
      context_sources: [],
      answers: { goal: 'Ship' },
      revision: 2
    },
    brief: {
      id: 'b1',
      project_id: 'p1',
      version: 1,
      status: 'draft',
      source: 'existing',
      content: {
        goal: 'Ship',
        users: [],
        scope: { in: ['Ship'], out: [] },
        features: ['Ship'],
        constraints: [],
        milestones: [],
        acceptance_criteria: ['Works'],
        risks: [],
        open_questions: []
      },
      created_at: new Date().toISOString()
    },
    briefs: [],
    workflow_draft: [
      { type: 'execution', title: 'Build', goal: 'Ship', dependency_indexes: [], position: { x: 80, y: 120 } }
    ],
    imports: [],
    can_confirm: false,
    onboarding_route: '/projects/p1/onboarding'
  };
}
function response(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}
