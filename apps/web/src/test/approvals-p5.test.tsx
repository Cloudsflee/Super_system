import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPage } from '../features/approvals';
import type { WorkspacePageProps } from '../workspace';

const projectId = 'project_approval_ui';
const now = '2026-08-20T00:00:00.000Z';
const approval = { id: 'approval_ui', project_id: projectId, assist_turn_id: 'turn_ui', action: 'command.execute', request: { command: 'pnpm test' }, status: 'pending', expires_at: '2099-01-01T00:00:00.000Z', revision: 1, created_at: now };
const input = { id: 'input_ui', project_id: projectId, assist_turn_id: 'turn_ui', prompt_summary: 'Choose a target', input_schema: { type: 'object' }, response: null, status: 'pending', expires_at: '2099-01-01T00:00:00.000Z', revision: 1, created_at: now };
const proposal = { id: 'proposal_ui', project_id: projectId, proposal_type: 'file_change', target_type: 'repository', target_id: 'workspace_ui', target_revision: 2, payload: { path: 'README.md' }, payload_hash: 'a'.repeat(64), status: 'pending', revision: 1, created_at: now };

const calls: Array<{ url: string; body: Record<string, unknown>; revision: string | null }> = [];
const envelope = (data: unknown) => new Response(JSON.stringify({ request_id: 'req_approval_ui', data, meta: { api_version: 'v2' } }), { status: 200, headers: { 'content-type': 'application/json' } });
const props: WorkspacePageProps = {
  projectId, selectedProject: undefined, selectProject: vi.fn(), refreshProjects: vi.fn(async () => undefined),
  notify: vi.fn(), navigate: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => undefined)
};

beforeEach(() => {
  calls.length = 0;
  let approvalStatus = 'pending';
  let inputStatus = 'pending';
  let proposalStatus = 'pending';
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
    const url = String(request);
    const method = options?.method || 'GET';
    if (method !== 'GET') {
      const headers = new Headers(options?.headers);
      calls.push({ url, body: JSON.parse(String(options?.body || '{}')), revision: headers.get('X-Expected-Revision') });
      if (url.endsWith(`/approvals/${approval.id}/decide`)) approvalStatus = 'approved';
      if (url.endsWith(`/user-inputs/${input.id}/answer`)) inputStatus = 'answered';
      if (url.endsWith(`/proposals/${proposal.id}/apply`)) proposalStatus = 'approved';
      return envelope({ operation: { operation_id: 'op_ui', status: 'succeeded', revision: 1 } });
    }
    if (url.startsWith('/api/v2/approvals?')) return envelope({ approvals: [{ ...approval, status: approvalStatus }] });
    if (url.startsWith('/api/v2/user-inputs?')) return envelope({ inputs: [{ ...input, status: inputStatus }] });
    if (url.startsWith('/api/v2/proposals?')) return envelope({ proposals: [{ ...proposal, status: proposalStatus }] });
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('P5 Approval Center', () => {
  it('decides approvals, answers inputs and applies proposals with expected revisions', async () => {
    render(<ApprovalPage {...props} />);
    expect(await screen.findByText('执行命令')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    await waitFor(() => expect(calls[0]).toMatchObject({ url: `/api/v2/approvals/${approval.id}/decide`, body: { decision: 'approved' }, revision: '1' }));

    fireEvent.click(screen.getByRole('tab', { name: /用户输入/ }));
    const response = await screen.findByRole('textbox', { name: `回答：${input.prompt_summary}` });
    fireEvent.change(response, { target: { value: '{"target":"workspace"}' } });
    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    await waitFor(() => expect(calls[1]).toMatchObject({ url: `/api/v2/user-inputs/${input.id}/answer`, body: { response: { target: 'workspace' } }, revision: '1' }));

    fireEvent.click(screen.getByRole('tab', { name: /提案/ }));
    expect(await screen.findByText('file_change')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    await waitFor(() => expect(calls[2]).toMatchObject({ url: `/api/v2/proposals/${proposal.id}/apply`, revision: '1' }));
  });
});
