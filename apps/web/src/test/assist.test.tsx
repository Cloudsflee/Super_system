import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistPage } from '../features/assist';
import type { Session } from '../features/assist/types';
import type { Project } from '../types';
import type { WorkspacePageProps } from '../workspace';

const projectId = 'prj_assist_ui';
const briefId = 'brief_resource_ui';
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

beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
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
    fireEvent.click(screen.getByRole('button', { name: /新建会话/ }));
    await waitFor(() => expect(mutations[0]).toEqual({
      body: expect.objectContaining({ project_id: projectId, context_pack_id: pack.id, profile_id: profile.id, repository_workspace_id: workspace.id }),
      revision: '0'
    }));
    expect(await screen.findByText('Completed response')).toBeVisible();
    expect(screen.getAllByText('已完成').length).toBeGreaterThan(0);
  });

  it('shows the no-project state without issuing requests', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<AssistPage {...props({ projectId: '', selectedProject: undefined })} />);
    expect(screen.getByRole('heading', { name: '请选择项目以打开 Assist' })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
});

function assistScenario(initialStatus = 'completed') {
  let session: Session = { id: 'assist_existing', project_id: projectId, scope: 'project', scope_id: projectId, title: '第一会话', status: 'active', revision: 2, context_pack_id: pack.id, context_pack_hash: pack.pack_hash, profile_id: profile.id, references: [], turns: [{ id: 'turn_latest', turn_no: 1, status: 'completed', revision: 3, attempt: 1, operation_id: 'op_latest', messages: [{ id: 'message_latest', role: 'assistant', kind: 'response', content: 'Existing response', sequence: 1 }] }] };
  const second = { ...session, id: 'assist_second', title: '第二会话', turns: [] };
  session.turns![0].status = initialStatus;
  const mutations: Array<{ url: string; body: Record<string, unknown>; revision: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const method = options?.method || 'GET';
    if (method !== 'GET') {
      const body = JSON.parse(String(options?.body));
      mutations.push({ url, body, revision: new Headers(options?.headers).get('X-Expected-Revision') });
      if (url.endsWith('/references')) {
        session = { ...session, revision: session.revision + 1, references: [...(session.references || []), { id: `reference_${mutations.length}`, ...body, created_at: '' }] };
        return envelope({ references: session.references });
      }
      return envelope({ operation_id: 'operation_success', status: 'succeeded', revision: 1 });
    }
    if (url.endsWith('/context/packs')) return envelope({ packs: [pack] });
    if (url.endsWith('/api/v2/profiles')) return envelope({ profiles: [profile] });
    if (url.endsWith('/repository-workspaces')) return envelope({ workspaces: [workspace] });
    if (url.includes('/assist/sessions?')) return envelope({ sessions: [session, second] });
    if (url.endsWith('/assist/sessions/assist_existing')) return envelope(session);
    if (url.endsWith('/assist/sessions/assist_second')) return envelope(second);
    if (url.includes('/events?')) return envelope({ events: [], next_cursor: 0 });
    if (url.includes('/terminals?')) return envelope({ terminals: [] });
    if (url.includes('/approvals?')) return envelope({ approvals: [] });
    throw new Error(`Unexpected scenario request ${method} ${url}`);
  }));
  return { mutations, complete: () => { session = { ...session, turns: [{ ...session.turns![0], status: 'completed', messages: [{ id: 'message_completed', role: 'assistant', kind: 'response', content: 'Completion after reopening', sequence: 2 }] }] }; } };
}

it.each(['revision', 'hash', 'both'])('attaches a real Brief ID only on request and detects %s drift', async drift => {
  const { mutations } = assistScenario();
  const assistContext = { route: 'brief' as const, projectId, resourceType: 'brief', resourceId: briefId, revision: 1, contentHash: 'a'.repeat(64), label: '当前 Brief' };
  const view = render(<AssistPage {...props({ assistContext })} />);
  await screen.findByText('Existing response');
  expect(mutations).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '附加当前页面' }));
  await screen.findByText('当前 Brief 已附加');
  expect(mutations[0]).toMatchObject({ revision: '2', body: { reference_type: 'brief', reference_id: briefId, reference_revision: 1, reference_hash: assistContext.contentHash } });
  const next = { ...assistContext, revision: drift === 'hash' ? 1 : 2, contentHash: drift === 'revision' ? assistContext.contentHash : 'b'.repeat(64) };
  view.rerender(<AssistPage {...props({ assistContext: next })} />);
  expect(screen.getByRole('alert')).toHaveTextContent('旧引用已过期');
  expect(mutations).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '附加当前页面' }));
  await waitFor(() => expect(mutations).toHaveLength(2));
  await waitFor(() => expect(screen.queryByText(/旧引用已过期/)).toBeNull());
  expect(mutations[1]).toMatchObject({ revision: '3', body: { reference_id: briefId, reference_revision: next.revision, reference_hash: next.contentHash } });
  fireEvent.click(screen.getByRole('button', { name: '附加当前页面' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '附加当前页面' })).toBeEnabled());
  expect(mutations).toHaveLength(2);
});

it('attaches a Brief review request once and preserves the loaded conversation offline', async () => {
  const { mutations } = assistScenario();
  const pageProps = props({ assistContext: { route: 'brief', projectId, resourceType: 'brief', resourceId: briefId, revision: 1, contentHash: 'a'.repeat(64), label: '当前 Brief' }, assistAttachRequest: 1 });
  const view = render(<AssistPage {...pageProps} surface="drawer" />);
  await screen.findByText('当前 Brief 已附加');
  expect(mutations).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Assist 消息'), { target: { value: 'Offline draft' } });
  view.rerender(<AssistPage {...pageProps} online={false} surface="drawer" />);
  expect(screen.getByText('Existing response')).toBeVisible();
  expect(screen.getByLabelText('Assist 消息')).toHaveValue('Offline draft');
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '在 Terminal 执行' })).toBeDisabled();
  expect(mutations).toHaveLength(1);
});

it('restores the selected session on drawer reopen without creating another session', async () => {
  const { mutations } = assistScenario();
  const first = render(<AssistPage {...props()} surface="drawer" />);
  await screen.findByText('Existing response');
  fireEvent.click(screen.getByRole('button', { name: /第二会话/ }));
  await waitFor(() => expect(sessionStorage.getItem(`aiws:v3:assist-session:${projectId}`)).toBe('assist_second'));
  first.unmount();
  render(<AssistPage {...props()} surface="drawer" />);
  await waitFor(() => expect(screen.getByRole('button', { name: /第二会话/ })).toHaveClass('selected'));
  expect(mutations).toHaveLength(0);
});

it('continues a restored active Turn even after its session event cursor is exhausted', async () => {
  const { mutations, complete } = assistScenario('queued');
  sessionStorage.setItem(`aiws:v3:assist-session:${projectId}`, 'assist_existing');
  render(<AssistPage {...props()} surface="drawer" />);
  await screen.findByText('Existing response');
  complete();
  expect(await screen.findByText('Completion after reopening', {}, { timeout: 3000 })).toBeVisible();
  expect(mutations).toHaveLength(0);
});
