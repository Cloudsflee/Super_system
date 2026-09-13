import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionPage } from '../features/execution';
import type { WorkspacePageProps } from '../workspace';
import { ExecutionLauncher } from '../features/execution/ExecutionPage';

const projectId = 'project_execution_ui'; const executionId = 'execution_ui';
const baseExecution = { id: executionId, project_id: projectId, status: 'completed', current_stage: 'deliver', generation: 1, revision: 7, workflow_revision: 2, workflow_hash: 'a'.repeat(64), context_pack_hash: 'b'.repeat(64), runner_profile_id: 'runner_ui', task_count: 1, dependency_edge_count: 0, error_code: '', created_at: '2026-08-24T00:00:00.000Z', updated_at: '2026-08-24T00:01:00.000Z', handoff_manifest: { delivery_ready: true, receipts: [{}] } };
const checkpoint = { id: 'checkpoint_ui', generation: 1, stage: 'deliver', stage_ordinal: 7, checkpoint_sha256: 'c'.repeat(64), checkpoint_token: 'checkpoint-token-ui', workspace_sha256: 'd'.repeat(64), pins_sha256: 'e'.repeat(64), created_at: '2026-08-24T00:00:30.000Z' };
const calls: Array<{ url: string; method: string; revision: string | null; body: Record<string, unknown> }> = [];
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ request_id: 'req_execution_ui', data, meta: { api_version: '2' } }), { status, headers: { 'content-type': 'application/json' } });
const props: WorkspacePageProps = { projectId, selectedProject: { id: projectId, name: 'Execution UI', description: '', status: 'active', revision: 9, updated_at: '' }, selectProject: vi.fn(), refreshProjects: vi.fn(async () => undefined), notify: vi.fn(), navigate: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => undefined) };

beforeEach(() => {
  location.hash = '#/execution';
  calls.length = 0; let execution = { ...baseExecution };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const method = options?.method || 'GET';
    if (method === 'GET' && url === `/api/v2/projects/${projectId}/executions`) return envelope({ executions: [execution] });
    if (method === 'GET' && url === '/api/v2/runners/profiles') return envelope({ profiles: [{ id: 'runner_ui', label: 'Local Host', runner_type: 'host', status: 'ready', revision: 2 }] });
    if (method === 'GET' && url === `/api/v2/executions/${executionId}`) return envelope({ execution });
    if (method === 'GET' && url === `/api/v2/executions/${executionId}/attempts`) return envelope({ attempts: [{ id: 'attempt_ui', task_id: 'inspect', attempt_no: 1, execution_mode: 'read', status: 'succeeded', runner_profile_id: 'runner_ui', stdout_sha256: 'f'.repeat(64), output_sha256: '', error_code: '', updated_at: execution.updated_at }] });
    if (method === 'GET' && url === `/api/v2/executions/${executionId}/checkpoints`) return envelope({ checkpoints: [checkpoint] });
    if (method === 'GET' && url.startsWith(`/api/v2/executions/${executionId}/events`)) return envelope({ events: [{ id: 'event_ui', sequence: 12, type: 'execution.completed', occurred_at: execution.updated_at }, { id: 'event_ui_duplicate', sequence: 12, type: 'execution.completed', occurred_at: execution.updated_at }] });
    const headers = new Headers(options?.headers); const body = JSON.parse(String(options?.body || '{}')) as Record<string, unknown>; calls.push({ url, method, revision: headers.get('X-Expected-Revision'), body });
    if (url.endsWith('/stages/deliver/replay')) { execution = { ...execution, generation: 2, revision: 8, status: 'queued', current_stage: '' }; return envelope({ operation_id: 'op_replay', command_id: 'execution.stage.replay', status: 'queued', revision: 1 }, 202); }
    if (url.endsWith('/replan')) return envelope({ execution: { ...execution, id: 'execution_replanned', status: 'draft', revision: 1 } }, 201);
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('P6 Execution workspace', () => {
  it('renders seven stages, deduplicates events and submits revision-bound replay and replan commands', async () => {
    render(<ExecutionPage {...props} />);
    expect(await screen.findByText('交付 · 第 1 代')).toBeVisible(); expect(screen.getByLabelText('执行阶段').children).toHaveLength(7);
    expect(await screen.findByText('execution.completed')).toBeVisible(); expect(await screen.findByText('inspect')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重放交付' }));
    await waitFor(() => expect(calls[0]).toMatchObject({ url: `/api/v2/executions/${executionId}/stages/deliver/replay`, revision: '7', body: { generation: 1, checkpoint_token: 'checkpoint-token-ui', workspace_hash: 'd'.repeat(64), pins_hash: 'e'.repeat(64) } }));
    expect(await screen.findByRole('button', { name: /草稿 · 第 2 代/ })).toBeVisible();
  });

  it('creates then starts with the returned revision, retaining the Draft after a start failure', async () => {
    const requests: Array<{ url: string; headers: Headers }> = []; let failed = false;
    const navigateProject = vi.fn(); const onError = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!init?.method || init.method === 'GET') return envelope({ execution: { id: 'created', revision: 4, status: 'draft' } });
      requests.push({ url, headers: new Headers(init.headers) });
      if (url.endsWith('/start')) { if (!failed) { failed = true; return new Response(JSON.stringify({ error: { code: 'runner_unavailable', message: 'Runner unavailable' } }), { status: 503 }); } return envelope({ operation_id: 'started', status: 'queued' }); }
      return envelope({ execution: { id: 'created', revision: 4, status: 'draft' } });
    }));
    render(<ExecutionLauncher projectId={projectId} projectRevision={9} confirmed saved dirty={false} runners={[{ id: 'runner_ui', label: 'Host', runner_type: 'host', status: 'ready', revision: 2 }]} packs={[{ id: 'pack_ui', status: 'sealed', pack_hash: 'c'.repeat(64) }]} online busy={false} navigate={props.navigate} navigateProject={navigateProject} onResult={vi.fn()} onError={onError} />);
    fireEvent.click(screen.getByRole('button', { name: '创建并开始执行' }));
    await screen.findByRole('button', { name: '重新启动' });
    expect(requests.map(item => item.url)).toEqual([`/api/v2/projects/${projectId}/executions`, '/api/v2/executions/created/start']);
    expect(requests.map(item => item.headers.get('X-Expected-Revision'))).toEqual(['9', '4']);
    expect(requests.every(item => item.headers.get('Idempotency-Key'))).toBe(true);
    expect(screen.getByText('Draft Execution created 已保留。')).toBeVisible(); expect(navigateProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新启动' }));
    await waitFor(() => expect(location.hash).toBe(`#/projects/${projectId}/execution?execution_id=created`));
    expect(requests.filter(item => item.url.endsWith('/executions'))).toHaveLength(1);
    expect(requests[1].headers.get('Idempotency-Key')).toBe(requests[2].headers.get('Idempotency-Key'));
  });

  it('selects the query Execution and polls only its detail until terminal state', async () => {
    location.hash = `#/projects/${projectId}/execution?execution_id=linked`;
    let detailReads = 0; let listReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const linked = { ...baseExecution, id: 'linked', status: detailReads > 1 ? 'completed' : 'running', current_stage: 'run' };
      if (url.endsWith('/executions')) { listReads++; return envelope({ executions: [baseExecution, linked] }); }
      if (url.endsWith('/profiles')) return envelope({ profiles: [] });
      if (url.endsWith('/executions/linked')) { detailReads++; return envelope({ execution: { ...linked, status: detailReads > 1 ? 'completed' : 'running' } }); }
      if (url.endsWith('/attempts')) return envelope({ attempts: [] });
      if (url.endsWith('/checkpoints')) return envelope({ checkpoints: [] });
      return envelope({ events: [] });
    }));
    render(<ExecutionPage {...props} />);
    await waitFor(() => expect(detailReads).toBe(1));
    await waitFor(() => expect(detailReads).toBe(2), { timeout: 3000 });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1700)); });
    expect(detailReads).toBe(2); expect(listReads).toBe(1);
    expect(screen.getByRole('tab', { name: '证据' })).toBeVisible();
  });

  it('clears detail immediately when switching projects', async () => {
    const view = render(<ExecutionPage {...props} />);
    await screen.findByText('inspect');
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    view.rerender(<ExecutionPage {...props} projectId="other" />);
    expect(screen.queryByText('inspect')).toBeNull(); expect(screen.queryByText('execution.completed')).toBeNull();
  });
});
