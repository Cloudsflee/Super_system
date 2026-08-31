import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityAccessPage } from '../features/identity';

function envelope(data: unknown, meta: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ request_id: 'req_test', data, meta: { api_version: '2', ...meta } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const props = { projectId: '', selectProject: vi.fn(), refreshProjects: vi.fn(async () => {}), notify: vi.fn(), navigate: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => {}) };

describe('IdentityAccessPage', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('renders a loading state while v2 data is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<IdentityAccessPage {...props} />);
    expect(screen.getByTestId('identity-loading')).toBeInTheDocument();
  });

  it('loads only v2 resources and updates the account with its revision', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      calls.push(`${options?.method || 'GET'} ${url}`);
      if (url.endsWith('/account')) return envelope({ account: { id: 'actor_user_1', kind: 'user', display_name: 'Owner', status: 'active', revision: 2 } });
      if (url.endsWith('/actors')) return envelope({ actors: [{ id: 'actor_user_1', kind: 'user', display_name: 'Owner', status: 'active', revision: 2 }] });
      if (url.endsWith('/teams')) return envelope({ teams: [{ id: 'team_1', name: 'Team', status: 'active', revision: 1 }] });
      if (url.endsWith('/credentials')) return envelope({ credentials: [] });
      if (url.endsWith('/profiles')) return envelope({ profiles: [] });
      return envelope({});
    }));
    render(<IdentityAccessPage {...props} />);
    await waitFor(() => expect(screen.getByText('身份与团队')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(calls.some((call) => call.startsWith('PATCH /api/v2/account'))).toBe(true));
    expect(calls.every((call) => !call.includes('/api/v1/'))).toBe(true);
  });

  it('shows denied state for a rejected v2 session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'permission_denied', message: 'Denied', retryable: false, details: {} } }), { status: 403, headers: { 'content-type': 'application/json' } })));
    render(<IdentityAccessPage {...props} />);
    await waitFor(() => expect(screen.getByTestId('identity-denied')).toBeInTheDocument());
    expect(screen.getByText('访问被拒绝')).toBeInTheDocument();
  });

  it('surfaces revision conflict and rebind-required responses', async () => {
    let probe = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (options?.method === 'POST' && url.includes('/probe')) {
        probe = true;
        return new Response(JSON.stringify({ error: { code: 'rebind_required', message: 'Rebind required', retryable: false, details: { credential_ref_id: 'cred_1' } } }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      if (options?.method === 'PATCH') return new Response(JSON.stringify({ error: { code: 'revision_conflict', message: 'Changed', retryable: true, details: { actual_revision: 4 } } }), { status: 409, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/account')) return envelope({ account: { id: 'actor_user_1', kind: 'user', display_name: 'Owner', status: 'active', revision: 2 } });
      if (url.endsWith('/actors')) return envelope({ actors: [] });
      if (url.endsWith('/teams')) return envelope({ teams: [] });
      if (url.endsWith('/credentials')) return envelope({ credentials: [{ id: 'cred_1', provider: 'codex', status: 'active', external_ref: 'opaque', revision: 1 }] });
      if (url.endsWith('/profiles')) return envelope({ profiles: [{ id: 'profile_1', provider: 'codex', label: 'Default', status: 'available', revision: 1, credential_ref_id: 'cred_1' }] });
      return envelope({});
    }));
    render(<IdentityAccessPage {...props} />);
    await waitFor(() => expect(screen.getByText('身份与团队')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByTestId('identity-conflict')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /Profile/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /探测 Default/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /探测 Default/ }));
    await waitFor(() => expect(screen.getByTestId('identity-rebind')).toBeInTheDocument());
    expect(probe).toBe(true);
  });

  it('loads, creates, and edits project ACL rules with the correct revision', async () => {
    const mutations: Array<{ body: Record<string, unknown>; revision: string | null }> = [];
    const aclEntry = {
      id: 'acl_1', project_id: 'project_alpha', principal_actor_id: 'actor_service_1', principal_team_id: null,
      resource: '*', action: 'read', effect: 'allow', policy_revision: 7, revision: 3
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/account')) return envelope({ account: { id: 'actor_user_1', kind: 'user', display_name: 'Owner', status: 'active', revision: 2 } });
      if (url.endsWith('/actors')) return envelope({ actors: [
        { id: 'actor_user_1', kind: 'user', display_name: 'Owner', status: 'active', revision: 2 },
        { id: 'actor_service_1', kind: 'service', display_name: 'Build service', status: 'active', revision: 1 }
      ] });
      if (url.endsWith('/teams')) return envelope({ teams: [{ id: 'team_1', name: 'Team', status: 'active', revision: 1 }] });
      if (url.endsWith('/credentials')) return envelope({ credentials: [] });
      if (url.endsWith('/profiles')) return envelope({ profiles: [] });
      if (url.endsWith('/teams/team_1/memberships')) return envelope({ memberships: [] });
      if (url.endsWith('/projects/project_alpha/permissions') && options?.method === 'POST') {
        mutations.push({
          body: JSON.parse(String(options.body || '{}')) as Record<string, unknown>,
          revision: new Headers(options.headers).get('X-Expected-Revision')
        });
        return envelope({ entry: aclEntry, operation: { id: 'op_acl', status: 'succeeded' } });
      }
      if (url.endsWith('/projects/project_alpha/permissions')) return envelope({ entries: [aclEntry] }, { resource_revision: 7 });
      return envelope({});
    }));

    render(<IdentityAccessPage {...props} projectId="project_alpha" />);
    await waitFor(() => expect(screen.getByText('身份与团队')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /权限/ }));
    await waitFor(() => expect(screen.getByText('允许 · 读取')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('主体'), { target: { value: 'actor_service_1' } });
    fireEvent.change(screen.getByLabelText('效果'), { target: { value: 'deny' } });
    fireEvent.click(screen.getByRole('button', { name: '添加规则' }));
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0].revision).toBe('7');
    expect(mutations[0].body).toMatchObject({ principal_actor_id: 'actor_service_1', effect: 'deny' });

    fireEvent.click(screen.getByRole('button', { name: '编辑权限 acl_1' }));
    fireEvent.change(screen.getByLabelText('动作'), { target: { value: 'write' } });
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }));
    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations[1].revision).toBe('3');
    expect(mutations[1].body).toMatchObject({ id: 'acl_1', action: 'write' });
  });

  it('shows empty and denied project permission states', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/account')) return envelope({ account: { id: 'actor_user_1', kind: 'user', display_name: 'Owner', status: 'active', revision: 2 } });
      if (url.endsWith('/actors')) return envelope({ actors: [] });
      if (url.endsWith('/teams')) return envelope({ teams: [] });
      if (url.endsWith('/credentials')) return envelope({ credentials: [] });
      if (url.endsWith('/profiles')) return envelope({ profiles: [] });
      if (url.endsWith('/projects/project_denied/permissions')) {
        return new Response(JSON.stringify({ error: { code: 'permission_denied', message: 'Project denied', retryable: false, details: {} } }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/projects/') && url.endsWith('/permissions')) return envelope({ entries: [] }, { resource_revision: 0 });
      return envelope({});
    }));

    render(<IdentityAccessPage {...props} projectId="project_empty" />);
    await waitFor(() => expect(screen.getByText('身份与团队')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /权限/ }));
    await waitFor(() => expect(screen.getByTestId('permissions-empty')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('项目 ID'), { target: { value: 'project_denied' } });
    await waitFor(() => expect(screen.getByTestId('permissions-denied')).toBeInTheDocument());
    expect(screen.getByText('Project denied')).toBeInTheDocument();
  });
});
