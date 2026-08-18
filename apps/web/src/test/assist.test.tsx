import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistPage } from '../features/assist';
import type { Project } from '../types';

const projectId = 'prj_assist_ui';
const project = { id: projectId, name: 'Assist UI', description: '', status: 'active', onboarding_state: 'confirmed', revision: 2, confirmed_brief_revision: 1, updated_at: '2026-08-18T00:00:00.000Z' } as Project;
const pack = { id: 'pack_assist_ui', pack_hash: 'a'.repeat(64), source_ids: [], created_at: '2026-08-18T00:00:00.000Z' };

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => vi.restoreAllMocks());
afterEach(() => cleanup());

describe('R6 Assist workspace', () => {
  it('creates a native Pack-bound session and renders immutable turn timeline state', async () => {
    const mutations: Array<Record<string, unknown>> = [];
    const session = { id: 'ast_assist_ui', project_id: projectId, scope: 'project', scope_id: projectId, status: 'active', revision: 2, compatibility: 'native_v6', context_pack_id: pack.id, context_pack_hash: pack.pack_hash, snapshot: { brief_revision: 1, workflow_revision: 2 } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input), method = options?.method || 'GET';
      if (url.endsWith('/context/packs')) return response([pack]);
      if (url.includes('/assist/sessions?')) return response([]);
      if (url.endsWith('/assist/sessions') && method === 'POST') { mutations.push(JSON.parse(String(options?.body))); return response(session, 201); }
      if (url.endsWith(`/assist/sessions/${session.id}`)) return response({ ...session, turns: [{ id: 'atr_assist_ui', turn_no: 1, status: 'completed', revision: 3, attempt: 1, messages: [{ id: 'ams_ui', role: 'assistant', content: 'Completed response' }], snapshots: [{ id: 'ats_q', attempt: 1, revision: 1, status: 'queued', input_hash: 'b'.repeat(64), output_cas_hash: '' }, { id: 'ats_c', attempt: 1, revision: 3, status: 'completed', input_hash: 'b'.repeat(64), output_cas_hash: 'c'.repeat(64) }] }] });
      return response({ events: [], cursor: 0 });
    }));
    render(<AssistPage projectId={projectId} selectedProject={project} notify={vi.fn()} />);
    expect(await screen.findByRole('option', { name: pack.pack_hash.slice(0, 10) })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /New session/ }));
    await waitFor(() => expect(mutations[0]).toMatchObject({ mode: 'native', expected_revision: 0, context_pack_id: pack.id }));
    expect(await screen.findByText('Completed response')).toBeVisible();
    expect(screen.getByText('queued')).toBeVisible();
    expect(screen.getAllByText('completed').length).toBeGreaterThan(0);
  });

  it('shows the no-project state without issuing requests', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<AssistPage projectId="" notify={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Select a project to open Assist' })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
});
