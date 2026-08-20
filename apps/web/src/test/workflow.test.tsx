import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

const project = {
  id: 'prj_test', name: 'Test project', description: '', status: 'active', revision: 1, updated_at: '2026-08-06T00:00:00.000Z',
  brief: { project_id: 'prj_test', revision: 1, content_hash: 'a'.repeat(64), content: { objective: 'Test objective', acceptance: [] }, created_at: '2026-08-06T00:00:00.000Z' },
  workflow: { project_id: 'prj_test', revision: 1, name: 'Test workflow', graph_hash: 'b'.repeat(64), created_at: '2026-08-06T00:00:00.000Z', tasks: [
    { id: 'inspect', title: 'Inspect repository', level: 1, deps: [], mode: 'read', inputs: [], outputs: ['analysis.md'] },
    { id: 'write', title: 'Write change', level: 2, deps: ['inspect'], mode: 'write', inputs: ['analysis.md'], outputs: ['change.diff'] }
  ] }
};

function envelope(data: unknown, status = 200) {
  return new Response(JSON.stringify({ request_id: 'req_clean_workflow', data, meta: { api_version: '2' } }), {
    status, headers: { 'content-type': 'application/json' }
  });
}

beforeEach(() => {
  location.hash = '/workflow';
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v2/setup')) return envelope({ needs_setup: false, actor_count: 1 });
    if (url.endsWith('/api/v2/projects') && (options?.method || 'GET') === 'GET') return envelope({ projects: [{ ...project, brief: undefined, workflow: undefined }] });
    if (url.endsWith('/api/v2/projects/prj_test')) return envelope({ project });
    if (url.endsWith('/intake')) return envelope({ intake: null });
    if (url.endsWith('/briefs')) return envelope({ briefs: [] });
    if (url.endsWith('/repository-connections')) return envelope({ connections: [] });
    if (url.endsWith('/repository-lines')) return envelope({ lines: [] });
    if (url.endsWith('/workflow-draft')) return envelope({ workflow: project.workflow });
    if (url.endsWith('/workflow-generations')) return envelope({ generations: [] });
    if (url.endsWith('/outcome-requirements')) return envelope({ requirements: [] });
    return envelope({});
  }));
});

describe('workflow inspector', () => {
  it('loads the Clean workflow surface and keeps its graph controls on v2', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Test project' });
    expect(screen.getByText('Workflow draft')).toBeVisible();
    const graph = screen.getByLabelText('Graph JSON');
    fireEvent.change(graph, { target: { value: '{"nodes":[{"id":"inspect"}]}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByDisplayValue('{"nodes":[{"id":"inspect"}]}')).toBeVisible());
  });
});
