import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectOnboarding } from '../features/project';
import { AssistPage, ProjectsPage, type WorkspacePageProps } from '../pages';
import type { Project } from '../types';

const projectId = 'prj_r3_ui';
const timestamp = '2026-08-11T00:00:00.000Z';

function draftProject(): Project {
  return {
    id: projectId, name: 'R3 UI fixture', description: 'Draft onboarding', status: 'draft', onboarding_state: 'draft', revision: 1, updated_at: timestamp,
    confirmed_brief_revision: null, confirmed_brief_hash: '',
    brief: { project_id: projectId, revision: 1, content_hash: 'a'.repeat(64), content: {}, created_at: timestamp },
    brief_head: { revision: 1, confirmed_revision: null, confirmation_revision: 0 },
    intake: { id: 'int_r3_ui', project_id: projectId, status: 'draft', mode: 'brainstorm', revision: 1, attempt: 0 },
    workflow_draft: { id: 'wfd_r3_ui', project_id: projectId, revision: 1, source_brief_revision: 0, status: 'draft' },
    repository: { id: 'repo_r3_ui', local_path: '', remote_url: '', head_sha: '', baseline_sha: '', revision: 1, status: 'pending' },
    repository_connections: [], repository_lines: []
  };
}

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

const props: WorkspacePageProps = {
  projectId, selectedProject: undefined, selectProject: vi.fn(), refreshProjects: vi.fn(async () => undefined),
  notify: vi.fn(), navigate: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => undefined)
};

beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
afterEach(() => cleanup());

describe('R3 project onboarding', () => {
  it('runs intake, confirms a Brief, and recovers a faulted checkout Line', async () => {
    let current = draftProject();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input), method = options?.method || 'GET';
      if (url.endsWith('/api/v1/projects') && method === 'GET') return response([current]);
      if (url.endsWith(`/api/v1/projects/${projectId}`) && method === 'GET') return response(current);
      if (url.endsWith(`/api/v1/projects/${projectId}/intakes`) && method === 'POST') {
        current = { ...current, revision: 2, onboarding_state: 'running', intake: { ...current.intake!, status: 'running', revision: 2, attempt: 1, operation_id: 'op_intake_ui' } };
        return response({ operation_id: 'op_intake_ui', status: 'running', revision: 1 }, 202);
      }
      if (url.endsWith('/api/v1/operations/op_intake_ui')) {
        current = { ...current, revision: 3, onboarding_state: 'ready', intake: { ...current.intake!, status: 'ready', revision: 3, completed_at: timestamp }, repository: { ...current.repository!, baseline_sha: 'b'.repeat(40), head_sha: 'b'.repeat(40), status: 'ready', source: { kind: 'fixture', display_label: 'designsignal-v1', read_only: true } } };
        return response({ id: 'op_intake_ui', operation_id: 'op_intake_ui', status: 'completed', revision: 3 });
      }
      if (url.endsWith(`/api/v1/projects/${projectId}/briefs`) && method === 'POST') {
        const brief = { project_id: projectId, revision: 2, content_hash: 'c'.repeat(64), content: { objective: 'Ship R3', acceptance: ['verified'] }, created_at: timestamp };
        current = { ...current, revision: 4, brief, brief_head: { revision: 2, confirmed_revision: null, confirmation_revision: 0 } };
        return response(brief, 201);
      }
      if (url.endsWith(`/api/v1/projects/${projectId}/briefs/2/confirm`) && method === 'POST') {
        current = {
          ...current, status: 'active', onboarding_state: 'confirmed', revision: 5, confirmed_brief_revision: 2, confirmed_brief_hash: 'c'.repeat(64),
          brief_head: { revision: 2, confirmed_revision: 2, confirmation_revision: 1, confirmed_hash: 'c'.repeat(64) },
          workflow_draft: { ...current.workflow_draft!, source_brief_revision: 2, source_brief_hash: 'c'.repeat(64) },
          repository_connections: [{ id: 'con_r3_ui', project_id: projectId, status: 'connected', revision: 1, source_kind: 'fixture', display_label: 'designsignal-v1', read_only: true }],
          repository_lines: [
            { id: 'lin_external', project_id: projectId, line_kind: 'external_readonly', status: 'ready', revision: 1, baseline_sha: 'b'.repeat(10) },
            { id: 'lin_staging', project_id: projectId, line_kind: 'managed_staging', status: 'blocked', revision: 1, baseline_sha: 'b'.repeat(10) },
            { id: 'lin_checkout', project_id: projectId, line_kind: 'managed_checkout', status: 'fault', revision: 4, baseline_sha: 'b'.repeat(10), fault_code: 'repository_line_interrupted' }
          ]
        };
        return response(current);
      }
      if (url.endsWith('/api/v1/repository-lines/lin_checkout/recover') && method === 'POST') return response({ operation_id: 'op_recover_ui', status: 'running' }, 202);
      if (url.endsWith('/api/v1/operations/op_recover_ui')) {
        current = { ...current, repository_lines: current.repository_lines?.map((line) => line.id === 'lin_checkout' ? { ...line, status: 'ready', revision: 6, fault_code: '' } : line) };
        return response({ id: 'op_recover_ui', operation_id: 'op_recover_ui', status: 'completed', revision: 3 });
      }
      return response({});
    }));

    render(<ProjectsPage {...props} />);
    await screen.findByRole('button', { name: 'Run intake' });
    fireEvent.click(screen.getByRole('button', { name: 'Run intake' }));
    await screen.findByText(/Ready 08\/11/);
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Ship R3' } });
    fireEvent.change(screen.getByLabelText('Acceptance'), { target: { value: 'verified' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save preview' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm revision' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revision' }));
    await screen.findByText('repository_line_interrupted');
    expect(screen.getByText('External read-only')).toBeVisible();
    expect(screen.getByText('Managed staging')).toBeVisible();
    expect(screen.getByText('Managed checkout')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Recover' }));
    await waitFor(() => expect(screen.queryByText('repository_line_interrupted')).not.toBeInTheDocument());
  });

  it('exposes Retry and Resume only for their matching Intake states', () => {
    const failed = draftProject();
    failed.intake = { ...failed.intake!, status: 'failed', error_code: 'repository_probe_failed' };
    const view = render(<ProjectOnboarding project={failed} onChanged={vi.fn(async () => undefined)} notify={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Retry intake' })).toBeVisible();
    expect(screen.getByText('repository_probe_failed')).toBeVisible();
    view.rerender(<ProjectOnboarding project={{ ...failed, intake: { ...failed.intake!, status: 'cancelled' } }} onChanged={vi.fn(async () => undefined)} notify={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Resume intake' })).toBeVisible();
  });

  it('blocks new business work while Project onboarding is pending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([])));
    const project = draftProject();

    render(<AssistPage {...props} selectedProject={project} />);

    expect(await screen.findByRole('status')).toHaveTextContent('Project onboarding pending');
    expect(screen.getByRole('status')).toHaveTextContent('draft');
    expect(screen.getByRole('button', { name: 'New session' })).toBeDisabled();
  });
});
