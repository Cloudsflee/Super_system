import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExecutionStage,
  ExecutionStageCheckpoint,
  TaskExecutionRecord,
  TaskStageSnapshot,
  WorkflowOutcomeSnapshot
} from '../api/types';
import { ContextWorkerStatus } from '../features/context/ContextWorkerStatus';
import { TaskStageTimeline } from '../features/workflow/TaskStageTimeline';
import { WorkflowOutcomePanel } from '../features/workflow/WorkflowOutcomePanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('V2.1 outcome, stage replay and Context worker UI', () => {
  it('creates and revokes an owner waiver with exact requirement IDs and evidence refs', async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({
          url: String(input),
          method: String(init.method || 'GET'),
          body: init.body ? JSON.parse(String(init.body)) : {}
        });
        return response({ ok: true });
      })
    );
    const onRefresh = vi.fn(async () => undefined);
    render(
      <WorkflowOutcomePanel
        executionId="workflow-execution-1"
        value={outcomeFixture()}
        loading={false}
        canApprove
        onRefresh={onRefresh}
      />
    );

    const requirement = screen.getByText('Outbox delivery receipt').closest('label') as HTMLElement;
    fireEvent.click(within(requirement).getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Waiver 理由'), {
      target: { value: 'Owner accepts the documented delivery gap.' }
    });
    fireEvent.change(screen.getByLabelText('证据引用'), {
      target: { value: 'receipt:outbox-pending, fixture:designsignal' }
    });
    fireEvent.click(screen.getByRole('button', { name: '创建 waiver' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(requests[0]).toMatchObject({
      url: expect.stringContaining('/workflow-executions/workflow-execution-1/outcome-waivers'),
      method: 'POST',
      body: {
        requirement_ids: ['requirement-delivery'],
        reason: 'Owner accepts the documented delivery gap.',
        evidence_refs: ['receipt:outbox-pending', 'fixture:designsignal']
      }
    });

    fireEvent.click(screen.getByRole('button', { name: '撤销 waiver' }));
    fireEvent.change(screen.getByLabelText('撤销理由'), { target: { value: 'Evidence superseded' } });
    fireEvent.click(screen.getByRole('button', { name: '确认撤销 waiver' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    expect(requests[1]).toMatchObject({
      url: expect.stringContaining('/workflow-executions/workflow-execution-1/outcome-waivers/waiver-1/revoke'),
      method: 'POST',
      body: { reason: 'Evidence superseded', evidence_refs: [] }
    });
  });

  it('renders all seven stages and replays only the failed Verify checkpoint', async () => {
    const stageSnapshot = stageFixture();
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ url: String(input), method: String(init.method || 'GET') });
        return response(stageSnapshot);
      })
    );
    render(<TaskStageTimeline execution={taskExecutionFixture()} canReplay />);

    expect(await screen.findByText('Preflight')).toBeInTheDocument();
    for (const label of ['Execute', 'Collect', 'Verify', 'Attest', 'Promote', 'Finalize'])
      expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText('verifier_injected_failure')).toBeInTheDocument();
    expect(screen.getByText('/evidence/checks')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '仅重放 Execute 阶段' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '仅重放 Verify 阶段' }));
    await waitFor(() =>
      expect(
        requests.some(
          (item) =>
            item.method === 'POST' && item.url.includes('/task-executions/task-execution-1/stages/verify/replay')
        )
      ).toBe(true)
    );
  });

  it('shows worker heartbeat, backlog, rebuild generation and lease recovery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          schema_version: 'aiws.context_status.v2',
          protocol: 'aiws.system-context.v1',
          pending_jobs: 22,
          failed_jobs: 2,
          active_leases: 1,
          oldest_pending_age_ms: 65_000,
          index_generation: 7,
          automatic_rebuild: 'completed',
          worker: {
            state: 'running',
            holder: 'context-projector:test',
            heartbeat_at: new Date(Date.now() - 2_000).toISOString(),
            worker_thread_id: 3,
            event_loop_lag_ms: 12,
            lease_ms: 30_000,
            batch_size: 25,
            recovered_expired_leases: 4,
            last_error_code: null
          },
          index: {
            state: 'ready',
            snapshot_hash: 'a'.repeat(64),
            node_count: 47,
            rebuilt_at: new Date().toISOString()
          },
          projection: { source_records: 47, projected_records: 47, warnings: 0 },
          failure_metrics: {},
          rebuild: { state: 'completed' }
        })
      )
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ContextWorkerStatus />
      </QueryClientProvider>
    );
    const trigger = await screen.findByRole('button', { name: 'Context worker 状态' });
    fireEvent.click(trigger);
    expect(await screen.findByText('Heartbeat')).toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(screen.getByText('completed · #7')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('12 ms')).toBeInTheDocument();
  });
});

function outcomeFixture(): WorkflowOutcomeSnapshot {
  return {
    workflow_execution: {
      id: 'workflow-execution-1',
      status: 'completed',
      completion_status: 'completed_with_gaps',
      release_eligible: false,
      finalization_state: 'completed',
      outcome_summary: {
        total: 2,
        pending: 0,
        satisfied: 1,
        unsatisfied: 1,
        waived: 0,
        error: 0,
        mandatory_gaps: 1,
        optional_gaps: 0
      }
    },
    requirements: [
      {
        id: 'requirement-delivery',
        workflow_execution_id: 'workflow-execution-1',
        contract_requirement_id: 'delivery_receipt',
        source: 'outcome_contract',
        title: 'Outbox delivery receipt',
        description: null,
        mandatory: true,
        scope: 'delivery',
        task_id: null,
        evaluator: 'delivery_receipt',
        expected: { status: 'delivered' },
        waivable: true,
        contract_hash: 'a'.repeat(64),
        order: 0
      },
      {
        id: 'requirement-context',
        workflow_execution_id: 'workflow-execution-1',
        contract_requirement_id: 'context_freshness',
        source: 'outcome_contract',
        title: 'Context freshness',
        description: null,
        mandatory: true,
        scope: 'context',
        task_id: null,
        evaluator: 'context_freshness',
        expected: { current: true },
        waivable: false,
        contract_hash: 'a'.repeat(64),
        order: 1
      }
    ],
    evaluations: [
      {
        id: 'evaluation-delivery',
        requirement_id: 'requirement-delivery',
        status: 'unsatisfied',
        expected: { status: 'delivered' },
        actual: { status: 'pending' },
        evidence_refs: ['receipt:outbox-pending'],
        reason_code: 'delivery_receipt_missing',
        evaluator: 'delivery_receipt',
        evaluator_version: 'aiws.outcome-evaluator.v1',
        waiver_id: null,
        evaluated_at: '2026-07-30T00:00:00.000Z'
      },
      {
        id: 'evaluation-context',
        requirement_id: 'requirement-context',
        status: 'satisfied',
        expected: { current: true },
        actual: { current: true },
        evidence_refs: ['context:current'],
        reason_code: 'context_freshness_satisfied',
        evaluator: 'context_freshness',
        evaluator_version: 'aiws.outcome-evaluator.v1',
        waiver_id: null,
        evaluated_at: '2026-07-30T00:00:00.000Z'
      }
    ],
    waivers: [
      {
        id: 'waiver-1',
        workflow_execution_id: 'workflow-execution-1',
        action: 'grant',
        requirement_ids: ['other-requirement'],
        reason: 'Previously accepted gap',
        evidence_refs: ['receipt:prior'],
        expires_at: '2026-08-01T00:00:00.000Z',
        created_by_user_id: 'owner-1',
        created_at: '2026-07-30T00:00:00.000Z',
        active: true,
        revoked: false,
        expired: false
      }
    ]
  } as WorkflowOutcomeSnapshot;
}

function stageFixture(): TaskStageSnapshot {
  const identity = {
    input_snapshot_hash: 'a'.repeat(64),
    repository_sha: null,
    runner_image_digest: 'aiws-codex-runner@sha256:test',
    policy_hash: 'b'.repeat(64),
    verifier_version: 'deployment_runtime_verifier.v2',
    cas_hash: 'c'.repeat(64)
  };
  return {
    task_execution_id: 'task-execution-1',
    current_stage: 'verify',
    replay_count: 0,
    failure: {
      schema_version: 'aiws.failure_envelope.v1',
      code: 'verifier_injected_failure',
      message: 'Verifier rejected the evidence.',
      stage: 'verify',
      category: 'verifier',
      retryable: false,
      reason_code: 'verifier_injected_failure',
      field_path: '/evidence/checks',
      details: {},
      cause_codes: [],
      occurred_at: '2026-07-30T00:00:03.000Z'
    },
    stages: [
      checkpoint('checkpoint-preflight', 'preflight', 'completed', 1, identity),
      checkpoint('checkpoint-execute', 'execute', 'completed', 2, identity),
      checkpoint('checkpoint-collect', 'collect', 'completed', 3, identity),
      {
        ...checkpoint('checkpoint-verify', 'verify', 'failed', 4, identity),
        failure: {
          schema_version: 'aiws.failure_envelope.v1',
          code: 'verifier_injected_failure',
          message: 'Verifier rejected the evidence.',
          stage: 'verify',
          category: 'verifier',
          retryable: false,
          reason_code: 'verifier_injected_failure',
          field_path: '/evidence/checks',
          details: {},
          cause_codes: [],
          occurred_at: '2026-07-30T00:00:03.000Z'
        }
      }
    ]
  } as TaskStageSnapshot;
}

function checkpoint(
  id: string,
  stage: ExecutionStage,
  status: ExecutionStageCheckpoint['status'],
  sequence: number,
  identity: ExecutionStageCheckpoint['identity']
) {
  return {
    schema_version: 'aiws.execution_checkpoint.v1',
    id,
    workflow_execution_id: 'workflow-execution-1',
    task_execution_id: 'task-execution-1',
    stage,
    sequence,
    attempt: 1,
    status,
    input_hash: 'd'.repeat(64),
    output_hash: status === 'completed' ? 'e'.repeat(64) : null,
    identity,
    cas_refs: [],
    duration_ms: sequence * 125,
    queue_ms: 0,
    failure: null,
    replay_of_checkpoint_id: null,
    started_at: '2026-07-30T00:00:00.000Z',
    completed_at: '2026-07-30T00:00:01.000Z',
    immutable: true
  };
}

function taskExecutionFixture(): TaskExecutionRecord {
  return {
    id: 'task-execution-1',
    workflow_execution_id: 'workflow-execution-1',
    task_id: 'task-1',
    task_revision: 1,
    contract_id: 'contract-1',
    contract_version: 1,
    attempt: 1,
    executor: 'assist',
    status: 'failed',
    current_stage: 'verify',
    replay_count: 0,
    failure: stageFixture().failure
  } as TaskExecutionRecord;
}

function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-aiws-request-id': 'test-request' }
  });
}
