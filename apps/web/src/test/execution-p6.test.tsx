import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionPage } from '../features/execution';
import type { WorkspacePageProps } from '../workspace';

const projectId = 'project_execution_ui'; const executionId = 'execution_ui';
const baseExecution = { id: executionId, project_id: projectId, status: 'completed', current_stage: 'deliver', generation: 1, revision: 7, workflow_revision: 2, workflow_hash: 'a'.repeat(64), context_pack_hash: 'b'.repeat(64), runner_profile_id: 'runner_ui', task_count: 1, dependency_edge_count: 0, error_code: '', created_at: '2026-08-24T00:00:00.000Z', updated_at: '2026-08-24T00:01:00.000Z', handoff_manifest: { delivery_ready: true, receipts: [{}] } };
const checkpoint = { id: 'checkpoint_ui', generation: 1, stage: 'deliver', stage_ordinal: 7, checkpoint_sha256: 'c'.repeat(64), checkpoint_token: 'checkpoint-token-ui', workspace_sha256: 'd'.repeat(64), pins_sha256: 'e'.repeat(64), created_at: '2026-08-24T00:00:30.000Z' };
const calls: Array<{ url: string; method: string; revision: string | null; body: Record<string, unknown> }> = [];
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ request_id: 'req_execution_ui', data, meta: { api_version: '2' } }), { status, headers: { 'content-type': 'application/json' } });
const props: WorkspacePageProps = { projectId, selectedProject: { id: projectId, name: 'Execution UI', description: '', status: 'active', revision: 9, updated_at: '' }, selectProject: vi.fn(), refreshProjects: vi.fn(async () => undefined), notify: vi.fn(), navigate: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => undefined) };

beforeEach(() => {
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
});
