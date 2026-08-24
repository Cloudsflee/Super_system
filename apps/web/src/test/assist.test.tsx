import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistPage } from '../features/assist';
import type { Project } from '../types';
import type { WorkspacePageProps } from '../workspace';

const projectId = 'prj_assist_ui';
const project = { id: projectId, name: 'Assist UI', description: '', status: 'active', onboarding_state: 'confirmed', revision: 2, confirmed_brief_revision: 1, updated_at: '2026-08-18T00:00:00.000Z' } as Project;
const pack = { id: 'pack_assist_ui', pack_hash: 'a'.repeat(64), status: 'sealed' };
const profile = { id: 'profile_assist_ui', label: 'Codex local', provider: 'codex', status: 'available', revision: 1 };
const workspace = { id: 'workspace_assist_ui', status: 'ready', revision: 2 };

const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ request_id: 'req_assist_ui', data, meta: { api_version: 'v2' } }), { status, headers: { 'content-type': 'application/json' } });
const props = (overrides: Partial<WorkspacePageProps> = {}): WorkspacePageProps => ({
  projectId,
  selectedProject: project,
  selectProject: vi.fn(),
  refreshProjects: vi.fn(async () => undefined),
  notify: vi.fn(),
  navigate: vi.fn(),
  setupReady: true,
  refreshSetup: vi.fn(async () => undefined),
  ...overrides
});

beforeEach(() => vi.restoreAllMocks());
afterEach(() => cleanup());

describe('P5 Assist workspace', () => {
  it('creates a Pack-bound v2 session and renders the immutable turn timeline', async () => {
    const mutations: Array<{ body: Record<string, unknown>; revision: string | null }> = [];
    let created = false;
    const session = {
      id: 'assist_session_ui', project_id: projectId, scope: 'project', scope_id: projectId,
      status: 'active', revision: 2, context_pack_id: pack.id, context_pack_hash: pack.pack_hash,
      profile_id: profile.id
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      const method = options?.method || 'GET';
      if (url.endsWith(`/projects/${projectId}/context/packs`)) return envelope({ packs: [pack] });
      if (url.endsWith('/api/v2/profiles')) return envelope({ profiles: [profile] });
      if (url.endsWith(`/projects/${projectId}/repository-workspaces`)) return envelope({ workspaces: [workspace] });
      if (url.includes('/api/v2/assist/sessions?')) return envelope({ sessions: created ? [session] : [] });
      if (url.endsWith('/api/v2/assist/sessions') && method === 'POST') {
        created = true;
        const headers = new Headers(options?.headers);
        mutations.push({ body: JSON.parse(String(options?.body)), revision: headers.get('X-Expected-Revision') });
        return envelope({ session, operation: { operation_id: 'op_session', status: 'succeeded', revision: 1 } }, 201);
      }
      if (url.endsWith(`/api/v2/assist/sessions/${session.id}`)) return envelope({
        ...session,
        goal: null,
        references: [],
        turns: [{
          id: 'assist_turn_ui', turn_no: 1, status: 'completed', revision: 3, attempt: 1,
          operation_id: 'op_turn_ui', messages: [{ id: 'assist_message_ui', role: 'assistant', kind: 'response', sequence: 1, content: 'Completed response' }]
        }]
      });
      if (url.includes(`/api/v2/assist/sessions/${session.id}/events`)) return envelope({ events: [], next_cursor: 0, terminal: false });
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    render(<AssistPage {...props()} />);
    expect(await screen.findByRole('option', { name: pack.pack_hash.slice(0, 10) })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /New session/ }));
    await waitFor(() => expect(mutations[0]).toEqual({
      body: expect.objectContaining({ project_id: projectId, context_pack_id: pack.id, profile_id: profile.id, repository_workspace_id: workspace.id }),
      revision: '0'
    }));
    expect(await screen.findByText('Completed response')).toBeVisible();
    expect(screen.getAllByText('completed').length).toBeGreaterThan(0);
  });

  it('shows the no-project state without issuing requests', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<AssistPage {...props({ projectId: '', selectedProject: undefined })} />);
    expect(screen.getByRole('heading', { name: 'Select a project to open Assist' })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
});
