import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DeliveryPage } from '../features/delivery';
import { OutcomePage } from '../features/outcome';
import type { WorkspacePageProps } from '../workspace';

const props: WorkspacePageProps = { projectId: 'project-p9', selectedProject: undefined, selectProject: vi.fn(), refreshProjects: vi.fn(), notify: vi.fn(), navigate: vi.fn(), setupReady: true, refreshSetup: vi.fn() };
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ request_id: 'req-p9-workflow', data, meta: { api_version: '2' } }), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('renders Outcome generations and queues evaluation through API v2', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method || 'GET'; calls.push({ url, method });
    if (url.endsWith('/executions')) return envelope({ executions: [{ id: 'execution-p9', status: 'completed', revision: 7, current_stage: 'deliver' }] });
    if (url.endsWith('/outcome/evaluate')) return envelope({ operation_id: 'operation-evaluate', status: 'queued', revision: 1 }, 202);
    if (url.endsWith('/outcome')) return envelope({ evaluation: { id: 'evaluation-p9', generation: 3, status: 'blocked', requirement_count: 2, passed_count: 1, score: 50, evaluation_sha256: 'a'.repeat(64), evaluation: { results: [{ requirement_key: 'tests', passed: true, blocked: false, waived: false }, { requirement_key: 'review', passed: false, blocked: true, waived: false }] } }, waivers: [] });
    return envelope({});
  }));
  render(<OutcomePage {...props} />);
  expect(await screen.findByText('1/2')).toBeVisible();
  expect(screen.getByText('review')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Evaluate' }));
  await waitFor(() => expect(calls.some((call) => call.url.endsWith('/outcome/evaluate') && call.method === 'POST')).toBe(true));
  expect(calls.every((call) => !call.url.includes('/api/v1/'))).toBe(true);
});

it('renders Delivery policies, unknown result reconciliation and submit controls through API v2', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method || 'GET'; calls.push({ url, method });
    if (url.endsWith('/delivery-policies')) return method === 'POST' ? envelope({ policy: { id: 'policy-p9' } }, 201) : envelope({ policies: [{ id: 'policy-p9', name: 'Protected main', status: 'active', revision: 1, required_checks: ['ci'] }] });
    if (url.startsWith('/api/v2/deliveries/') && url.endsWith('/reconcile')) return envelope({ operation_id: 'operation-reconcile', status: 'queued', revision: 1 }, 202);
    if (url === '/api/v2/deliveries') return envelope({ operation_id: 'operation-delivery', status: 'queued', revision: 1 }, 202);
    if (url.startsWith('/api/v2/deliveries?')) return envelope({ deliveries: [{ id: 'delivery-p9', status: 'needs_reconcile', revision: 3, execution_id: 'execution-p9', branch_name: 'aiws/p9', target_head_sha: 'b'.repeat(40) }] });
    if (url.endsWith('/executions')) return envelope({ executions: [{ id: 'execution-p9', status: 'completed', revision: 7, handoff_manifest: { delivery_ready: true } }] });
    if (url.endsWith('/repository-connections')) return envelope({ connections: [{ id: 'connection-p9' }] });
    if (url.endsWith('/targets')) return envelope({ targets: [{ id: 'target-p9', expected_head_sha: 'b'.repeat(40) }] });
    return envelope({});
  }));
  render(<DeliveryPage {...props} />);
  expect(await screen.findByText('External result unknown')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));
  await waitFor(() => expect(calls.some((call) => call.url.endsWith('/reconcile') && call.method === 'POST')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(calls.some((call) => call.url === '/api/v2/deliveries' && call.method === 'POST')).toBe(true));
  expect(calls.every((call) => !call.url.includes('/api/v1/'))).toBe(true);
});
