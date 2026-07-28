import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskExecutionPanel } from '../features/nodes/TaskExecutionPanel';

describe('V2.0 task effect handoff', () => {
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

  beforeEach(() => {
    requests.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input),
          method = String(init?.method || 'GET').toUpperCase(),
          body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        requests.push({ url, method, body });
        if (url.includes('/task-executions/execution-effects/manual-submit') && method === 'POST')
          return response({ task_execution: details.task_execution });
        if (url.includes('/tasks/task-producer/readiness')) return response(readiness);
        if (url.includes('/task-executions/execution-effects')) return response(details);
        return response({ error: 'not_found' }, 404);
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows concrete effects and routes, then submits a scoped manual effect receipt', async () => {
    const { container } = renderPanel();
    expect(await screen.findByText('Use both evidence versions to constrain the decision.')).toBeInTheDocument();
    expect(screen.getByText('必须产生作用 · decision')).toBeInTheDocument();
    expect(screen.getByText('有效作用 2')).toBeInTheDocument();
    expect(screen.getByText('交付路由 1')).toBeInTheDocument();
    expect(
      screen.getByText('Both evidence versions constrained the final decision and ruled out one option.')
    ).toBeInTheDocument();
    expect(screen.getByText('The Context read verified the current decision boundary.')).toBeInTheDocument();
    expect(screen.getByText('Implement accepted decision · decision_input')).toBeInTheDocument();
    expect(screen.getByText('Constrain implementation to the accepted decision.')).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: '提交并验收' }),
      output = container.querySelector<HTMLTextAreaElement>('#manual-output-decision');
    expect(output).not.toBeNull();
    expect(submit).toBeDisabled();
    fireEvent.change(output!, { target: { value: 'A decision grounded in both evidence versions.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /research_evidence/ }));
    const statement = await screen.findByRole('textbox', { name: /对输出产生的具体作用/ });
    fireEvent.change(statement, {
      target: { value: 'Both evidence versions eliminated the unsupported implementation path.' }
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(
        requests.some(
          (item) => item.url.includes('/task-executions/execution-effects/manual-submit') && item.method === 'POST'
        )
      ).toBe(true)
    );
    const payload = requests.find((item) => item.url.includes('/manual-submit'))?.body;
    expect(payload).toMatchObject({
      outputs: [
        {
          output_key: 'decision',
          payload: {
            payload_kind: 'text',
            media_type: 'text/plain; charset=utf-8',
            content: 'A decision grounded in both evidence versions.',
            files: []
          }
        }
      ],
      input_effects: [
        {
          input_key: 'research_evidence',
          version_ids: ['version-evidence-a', 'version-evidence-b'],
          effect: 'basis',
          output_keys: ['decision'],
          statement: 'Both evidence versions eliminated the unsupported implementation path.',
          evidence_refs: []
        }
      ],
      context_effects: []
    });
    expect(JSON.stringify(payload)).not.toContain('version-optional');
    expect(JSON.stringify(payload)).not.toContain('not_used');
  });

  it('requires explicit acceptance of required v5 effect claims before approving candidate output', async () => {
    const contributionDetails = v5ContributionDetails();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input),
          method = String(init?.method || 'GET').toUpperCase(),
          body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        requests.push({ url, method, body });
        if (url.includes('/task-executions/execution-effects/human-approve') && method === 'POST')
          return response({ task_execution: { ...contributionDetails.task_execution, status: 'completed' } });
        if (url.includes('/tasks/task-producer/readiness')) return response(readiness);
        if (url.includes('/task-executions/execution-effects')) return response(contributionDetails);
        return response({ error: 'not_found' }, 404);
      })
    );

    renderPanel();
    expect(await screen.findByText('作用声明验收')).toBeInTheDocument();
    expect(screen.getAllByText('Research evidence changed the accepted decision.')).toHaveLength(2);
    expect(screen.getAllByText('Current context ruled out the stale alternative.')).toHaveLength(2);
    const approve = screen.getByRole('button', { name: '验收' }),
      requiredClaim = screen.getByRole('checkbox', { name: /research_evidence/ }),
      contextClaim = screen.getByRole('checkbox', { name: /运行上下文/ });
    expect(approve).toBeDisabled();
    fireEvent.click(contextClaim);
    expect(approve).toBeDisabled();
    fireEvent.click(requiredClaim);
    expect(approve).toBeEnabled();
    fireEvent.click(approve);

    await waitFor(() =>
      expect(requests.some((item) => item.url.includes('/human-approve') && item.method === 'POST')).toBe(true)
    );
    expect(requests.find((item) => item.url.includes('/human-approve'))?.body).toMatchObject({
      decision: 'approve',
      accepted_effect_claim_ids: ['ec_context00000000000000000', 'ec_input000000000000000000']
    });
  });

  it('labels a v5 manual submission as candidate output without changing the legacy v4 action', async () => {
    const contributionDetails = v5ContributionDetails();
    contributionDetails.outputs = [];
    contributionDetails.task_execution.input_effects = [];
    contributionDetails.task_execution.context_effects = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/tasks/task-producer/readiness')) return response(readiness);
        if (url.includes('/task-executions/execution-effects')) return response(contributionDetails);
        return response({ error: 'not_found' }, 404);
      })
    );
    renderPanel();
    expect(await screen.findByRole('button', { name: '提交候选输出' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提交并验收' })).not.toBeInTheDocument();
  });
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TaskExecutionPanel taskId="task-producer" />
    </QueryClientProvider>
  );
}

const readiness = {
  task_id: 'task-producer',
  workflow_execution_id: 'workflow-execution-effects',
  task_execution_id: 'execution-effects',
  status: 'awaiting_human',
  attempt: 1,
  readiness: { ready: true, reasons: [] }
};

const inputEffect = {
  input_key: 'research_evidence',
  version_ids: ['version-evidence-a', 'version-evidence-b'],
  effect: 'constraint',
  output_keys: ['decision'],
  statement: 'Both evidence versions constrained the final decision and ruled out one option.',
  evidence_refs: []
};

const contextEffect = {
  document_version_id: 'cdv-runtime-read',
  effect: 'verification',
  output_keys: ['decision'],
  statement: 'The Context read verified the current decision boundary.',
  evidence_refs: []
};

const details = {
  task_execution: {
    id: 'execution-effects',
    task_id: 'task-producer',
    project_id: 'project-effects',
    workflow_execution_id: 'workflow-execution-effects',
    contract_id: 'contract-effects',
    status: 'awaiting_human',
    executor: 'manual',
    attempt: 1,
    context_snapshot: { schema_version: 'aiws.task_execution_context.v4' }
  },
  workflow_execution: { id: 'workflow-execution-effects' },
  task: { id: 'task-producer', title: 'Make evidence-backed decision' },
  contract: {
    id: 'contract-effects',
    node_id: 'task-producer',
    version: 1,
    node_goal: 'Make an evidence-backed decision.',
    acceptance_criteria: ['Decision is grounded in evidence.'],
    allowed_tools: [],
    expected_inputs: [],
    expected_outputs: [
      {
        key: 'decision',
        kind: 'asset',
        required: true,
        asset_type: 'DecisionAsset',
        acceptance_criteria: ['Decision is grounded in evidence.'],
        confirmation_policy: 'human',
        handoff: true,
        purpose: 'Provide the constrained decision to implementation.'
      }
    ]
  },
  inputs: [
    {
      key: 'research_evidence',
      source: 'dependency',
      required: true,
      application_policy: 'required',
      purpose: 'Use both evidence versions to constrain the decision.',
      target_output_keys: ['decision'],
      coverage_policy: 'all',
      asset_versions: [
        {
          asset_id: 'asset-evidence-a',
          version_id: 'version-evidence-a',
          title: 'Evidence A',
          content_sha256: 'a'.repeat(64)
        },
        {
          asset_id: 'asset-evidence-b',
          version_id: 'version-evidence-b',
          title: 'Evidence B',
          content_sha256: 'b'.repeat(64)
        }
      ]
    },
    {
      key: 'optional_reference',
      source: 'asset',
      required: true,
      application_policy: 'optional',
      purpose: 'Use only if it changes the decision.',
      target_output_keys: ['decision'],
      coverage_policy: 'all',
      asset_versions: [
        {
          asset_id: 'asset-optional',
          version_id: 'version-optional',
          title: 'Optional reference',
          content_sha256: 'c'.repeat(64)
        }
      ]
    }
  ],
  context_documents: [],
  asset_mounts: [],
  outputs: [],
  pull_request_intent: null,
  handoff: {
    schema_version: 'aiws.task_handoff_diagnostics.v2',
    handoff_status: 'ready',
    required_inputs: [],
    used_inputs: ['version-evidence-a', 'version-evidence-b'],
    not_used_inputs: [],
    missing_dispositions: [],
    input_effect_obligations: [],
    input_effects: [inputEffect],
    context_effects: [contextEffect],
    exported_outputs: [
      {
        output_key: 'decision',
        required: true,
        version_id: 'version-decision',
        route_count: 1,
        effect_count: 2,
        routes: [
          {
            route_type: 'task_input',
            consumer_task_id: 'task-consumer',
            consumer_task_title: 'Implement accepted decision',
            input_key: 'decision_input',
            purpose: 'Constrain implementation to the accepted decision.'
          }
        ]
      }
    ],
    context_used: ['cdv-runtime-read'],
    context_not_used: [],
    semantic_gaps: []
  }
};

function v5ContributionDetails() {
  const criterionId = 'ac_decision_criterion',
    inputClaimId = 'ec_input000000000000000000',
    contextClaimId = 'ec_context00000000000000000',
    input = {
      ...details.inputs[0],
      contribution: {
        schema_version: 'aiws.input_contribution.v1',
        id: 'ic_research_evidence',
        effect: 'basis',
        expected_effect: 'Research evidence changes the accepted decision.',
        target_output_keys: ['decision'],
        target_criterion_ids: [criterionId],
        origin: 'declared'
      }
    },
    inputClaim = {
      claim_id: inputClaimId,
      input_key: 'research_evidence',
      version_ids: ['version-evidence-a', 'version-evidence-b'],
      contribution_id: 'ic_research_evidence',
      effect: 'basis',
      output_keys: ['decision'],
      criterion_ids: [criterionId],
      verification_status: 'structurally_verified',
      source_receipts: ['asset_version:version-evidence-a', 'asset_version:version-evidence-b'],
      statement: 'Research evidence changed the accepted decision.',
      evidence_refs: []
    },
    contextClaim = {
      claim_id: contextClaimId,
      document_version_id: 'cdv-runtime-read',
      effect: 'verification',
      output_keys: ['decision'],
      criterion_ids: [criterionId],
      verification_status: 'structurally_verified',
      source_receipts: ['context_read:csel-runtime:cdv-runtime-read'],
      statement: 'Current context ruled out the stale alternative.',
      evidence_refs: []
    };
  return {
    ...structuredClone(details),
    task_execution: {
      ...structuredClone(details.task_execution),
      context_snapshot: { schema_version: 'aiws.task_execution_context.v5' },
      effects_schema_version: 'aiws.task_effects.v2',
      input_effects: [inputClaim],
      context_effects: [contextClaim],
      accepted_effect_claim_ids: [],
      accepted_contribution_ids: [],
      output_bindings: []
    },
    contract: {
      ...structuredClone(details.contract),
      expected_outputs: [
        {
          ...structuredClone(details.contract.expected_outputs[0]),
          acceptance_criterion_ids: [criterionId]
        }
      ]
    },
    inputs: [input],
    context_documents: [
      {
        node_id: 'ctx-runtime',
        document_version_id: 'cdv-runtime-read',
        content_sha256: 'd'.repeat(64),
        title: '运行上下文',
        required: false,
        consumption_policy: 'available'
      }
    ],
    outputs: [
      {
        key: 'decision',
        asset_id: 'asset-decision',
        version_id: 'version-decision',
        asset_type: 'DecisionAsset',
        content_sha256: 'e'.repeat(64),
        confirmation_policy: 'human',
        bound: false,
        asset: {
          id: 'asset-decision',
          title: 'Evidence-backed decision',
          status: 'candidate'
        },
        version: {
          id: 'version-decision',
          asset_id: 'asset-decision',
          content_sha256: 'e'.repeat(64),
          manifest: { metadata: {} }
        }
      }
    ],
    handoff: {
      ...structuredClone(details.handoff),
      schema_version: 'aiws.task_handoff_diagnostics.v4',
      input_effects: [inputClaim],
      context_effects: [contextClaim],
      contribution_statuses: [
        {
          contribution_id: 'ic_research_evidence',
          status: 'structurally_verified',
          output_keys: ['decision'],
          criterion_ids: [criterionId],
          version_ids: ['version-evidence-a', 'version-evidence-b'],
          claim_ids: [inputClaimId],
          accepted_claim_ids: [],
          accepted_criterion_ids: [],
          missing_criterion_ids: [criterionId],
          source_receipts: inputClaim.source_receipts,
          evidence_refs: []
        }
      ],
      effect_claim_statuses: []
    }
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
