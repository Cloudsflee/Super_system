import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';

function envelope(data: unknown, status = 200) {
  return new Response(JSON.stringify({ request_id: 'req_p9_setup', data, meta: { api_version: '2' } }), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  sessionStorage.clear();
  location.hash = '#/projects';
});

it('gates all workspace routes on Clean setup and resumes the requested workflow over v2', async () => {
  let complete = false;
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const method = options?.method || 'GET'; calls.push(`${method} ${url}`);
    if (url.endsWith('/api/v2/setup') && method === 'GET') return envelope({ needs_setup: !complete, actor_count: complete ? 1 : 0, bootstrap_actor_id: complete ? 'actor_clean' : 'actor_system_bootstrap' });
    if (url.endsWith('/api/v2/setup') && method === 'POST') { complete = true; return envelope({ actor: { id: 'actor_clean' }, team: { id: 'team_clean' }, membership: {}, session: {}, operation: {} }, 201); }
    if (url.endsWith('/api/v2/projects')) return envelope({ projects: [] });
    if (url.includes('/api/v2/events')) return envelope({ events: [], project_id: 'none', next_cursor: 'cursor', cursor_sequence: 0, has_more: false });
    return envelope({});
  }));

  render(<App />);
  await screen.findByLabelText('Display name');
  expect(location.hash).toBe('#/setup');
  expect(calls.some((call) => call.endsWith('/api/v2/projects'))).toBe(false);
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Clean owner' } });
  fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'Clean team' } });
  fireEvent.click(screen.getByRole('button', { name: 'Complete setup' }));
  await waitFor(() => expect(calls.some((call) => call.endsWith('/api/v2/projects'))).toBe(true));
  expect(calls.every((call) => !call.includes('/api/v1/'))).toBe(true);
});
