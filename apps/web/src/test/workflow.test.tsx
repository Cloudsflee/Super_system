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

beforeEach(() => {
  location.hash = '/workflow';
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/v1/setup')) return new Response(JSON.stringify({ status: 'ready', complete: true, revision: 1 }), { status: 200 });
    if (url.endsWith('/api/v1/projects')) return new Response(JSON.stringify([{ ...project, brief: undefined, workflow: undefined }]), { status: 200 });
    if (url.endsWith('/api/v1/projects/prj_test')) return new Response(JSON.stringify(project), { status: 200 });
    if (url.includes('/context/sources') || url.includes('/context/packs')) return new Response('[]', { status: 200 });
    return new Response('{}', { status: 200 });
  }));
});

describe('workflow inspector', () => {
  it('changes task details on click while hover only highlights topology', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Workflow' });
    const inspect = await screen.findByRole('button', { name: /Inspect repository/ });
    const write = await screen.findByRole('button', { name: /Write change/ });
    fireEvent.click(inspect);
    await waitFor(() => expect(screen.getByDisplayValue('Inspect repository')).toBeVisible());
    fireEvent.mouseEnter(write);
    expect(screen.getByDisplayValue('Inspect repository')).toBeVisible();
    fireEvent.mouseLeave(write);
    fireEvent.click(write);
    await waitFor(() => expect(screen.getByDisplayValue('Write change')).toBeVisible());
  });
});
