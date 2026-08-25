import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionPage } from '../features/execution';
import type { WorkspacePageProps } from '../workspace';

const projectId = 'project_execution_p7_ui'; const executionId = 'execution_p7_ui'; const assetId = 'asset_p7_ui'; const reviewId = 'quality_review_ui';
const execution = { id: executionId, project_id: projectId, status: 'completed', current_stage: 'deliver', generation: 1, revision: 7, workflow_revision: 2, workflow_hash: 'a'.repeat(64), context_pack_hash: 'b'.repeat(64), runner_profile_id: 'runner_ui', task_count: 1, dependency_edge_count: 0, error_code: '', created_at: '2026-08-24T00:00:00.000Z', updated_at: '2026-08-24T00:01:00.000Z', handoff_manifest: { delivery_ready: true } };
const evidence = { assets: [{ id: assetId, logical_name: 'verified-result.json', asset_kind: 'execution_output', status: 'active', current_version: 1 }], traces: [{ id: 'trace_ui', trace_type: 'execution.capture', payload_sha256: 'c'.repeat(64), created_at: execution.updated_at }], digests: [{ id: 'digest_ui', digest_type: 'workspace', digest_sha256: 'd'.repeat(64), created_at: execution.updated_at }], test_results: [{ id: 'test_ui', check_id: 'pnpm-test', status: 'passed', duration_ms: 22, output_sha256: 'e'.repeat(64) }], code_changes: [{ id: 'change_ui', relative_path: 'src/result.ts', change_kind: 'modified', before_sha256: 'f'.repeat(64), after_sha256: '1'.repeat(64) }] };
let review = { id: reviewId, status: 'awaiting_human', attempt_no: 1, asset_ids: [assetId], asset_count: 1, input_sha256: '2'.repeat(64), rubric: { dimensions: [{ key: 'correctness', label: 'Correctness', enabled: true, weight: 60 }, { key: 'evidence', label: 'Evidence', enabled: true, weight: 40 }], threshold: 80 }, rubric_sha256: '3'.repeat(64), threshold: 80, report_id: 'quality_report_ui', report_sha256: '4'.repeat(64), human_review: null as null | { decision: string; weighted_score: number; decision_sha256: string; reasoning: string }, error_code: '', revision: 4, updated_at: execution.updated_at };
let waivers: unknown[] = [];
const calls: Array<{ url: string; method: string; revision: string | null; body: Record<string, unknown> }> = [];
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ request_id: 'req_execution_p7_ui', data, meta: { api_version: '2' } }), { status, headers: { 'content-type': 'application/json' } });
const props: WorkspacePageProps = { projectId, selectedProject: { id: projectId, name: 'Execution P7 UI', description: '', status: 'active', revision: 9, updated_at: '' }, selectProject: vi.fn(), refreshProjects: vi.fn(async () => undefined), notify: vi.fn(), navigate: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => undefined) };

beforeEach(() => {
  calls.length = 0; waivers = []; review = { ...review, status: 'awaiting_human', human_review: null, revision: 4 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const method = options?.method || 'GET';
    if (method === 'GET' && url === `/api/v2/projects/${projectId}/executions`) return envelope({ executions: [execution] });
    if (method === 'GET' && url === '/api/v2/runners/profiles') return envelope({ profiles: [{ id: 'runner_ui', label: 'Local Host', runner_type: 'host', status: 'ready', revision: 2 }] });
    if (method === 'GET' && url === `/api/v2/executions/${executionId}`) return envelope({ execution });
    if (method === 'GET' && url === `/api/v2/executions/${executionId}/attempts`) return envelope({ attempts: [] });
    if (method === 'GET' && url === `/api/v2/executions/${executionId}/checkpoints`) return envelope({ checkpoints: [] });
    if (method === 'GET' && url.startsWith(`/api/v2/executions/${executionId}/events`)) return envelope({ events: [] });
    if (method === 'GET' && url === `/api/v2/executions/${executionId}/evidence`) return envelope(evidence);
    if (method === 'GET' && url === `/api/v2/executions/${executionId}/quality-reviews`) return envelope({ quality_reviews: [review] });
    if (method === 'GET' && url === `/api/v2/quality-reviews/${reviewId}`) return envelope({ quality_review: review });
    if (method === 'GET' && url === `/api/v2/quality-reviews/${reviewId}/report`) return envelope({ report: { deterministic_checks: [{ asset_id: assetId, active: true, current: true, cas_verified: true }], suggestions: [], anchors: [{ asset_id: assetId, version_id: 'version_ui', offset: 0, length: 20, content_sha256: '5'.repeat(64) }], anchor_count: 1, report_sha256: review.report_sha256 } });
    if (method === 'GET' && url === `/api/v2/executions/${executionId}/outcome`) return envelope({ evaluation: { id: 'evaluation_ui', generation: 3, status: waivers.length ? 'waived' : 'blocked', requirement_count: 1, passed_count: 0, score: 0, evaluation: { results: [{ requirement_id: 'requirement_ui', requirement_key: 'tests-pass', evaluator: 'test_pass', passed: false, blocked: true, waived: Boolean(waivers.length), actual: { total: 0 }, expected: {} }] }, evaluation_sha256: '6'.repeat(64), created_at: execution.updated_at }, waivers });
    const headers = new Headers(options?.headers); const body = JSON.parse(String(options?.body || '{}')) as Record<string, unknown>; calls.push({ url, method, revision: headers.get('X-Expected-Revision'), body });
    if (url.endsWith('/decision')) { review = { ...review, status: 'completed', revision: 5, human_review: { decision: String(body.decision), weighted_score: 80, decision_sha256: '7'.repeat(64), reasoning: String(body.reasoning) } }; return envelope({ quality_review: review }); }
    if (url.endsWith('/outcome/waivers')) { waivers = [{ id: 'waiver_ui', requirement_id: body.requirement_id || null, action: 'grant', revokes_waiver_id: null, reason: body.reason, waiver_sha256: '8'.repeat(64), expires_at: null, revision: 1, created_at: execution.updated_at }]; return envelope({ waiver: waivers[0] }, 201); }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('P7 Execution Evidence, Quality and Outcome views', () => {
  it('loads evidence and records complete human scoring plus a revision-bound waiver', async () => {
    render(<ExecutionPage {...props} />);
    expect(await screen.findByText('deliver · generation 1')).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: 'Evidence' }));
    expect(await screen.findByText('verified-result.json')).toBeVisible();
    expect(screen.getByText('pnpm-test')).toBeVisible();
    expect(screen.getByText('src/result.ts')).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: 'Quality' }));
    expect(await screen.findByText('CAS verified · current')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Correctness reasoning'), { target: { value: 'checks pass' } });
    fireEvent.change(screen.getByLabelText('Evidence reasoning'), { target: { value: 'hashes verified' } });
    fireEvent.change(screen.getByText('Decision reasoning').parentElement!.querySelector('textarea')!, { target: { value: 'reviewed against pinned hashes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record decision' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/decision') && call.revision === '4' && Array.isArray(call.body.dimensions) && call.body.dimensions.length === 2)).toBe(true));

    fireEvent.click(screen.getByRole('tab', { name: 'Outcome' }));
    expect(await screen.findAllByText('tests-pass')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Waiver requirement'), { target: { value: 'requirement_ui' } });
    fireEvent.change(screen.getByLabelText('Waiver reason'), { target: { value: 'accepted bounded gap' } });
    fireEvent.click(screen.getByRole('button', { name: 'Waive' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/outcome/waivers') && call.revision === '7' && call.body.requirement_id === 'requirement_ui')).toBe(true));
    expect(await screen.findByText(/accepted bounded gap/)).toBeVisible();
  });
});
