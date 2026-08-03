import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  QualityReviewPrepare,
  QualityReviewRubric,
  QualityReviewRun,
  QualityReviewSnapshot
} from '../api/execution-types';
import { QualityReviewSection } from '../features/workflow/QualityReviewSection';
import { scoresForQualityReviewRun, selectedQualityReviewExclusions } from '../features/workflow/quality-review-draft';

afterEach(cleanup);

describe('V2.3 Quality Review UI', () => {
  it('submits exclusion reasons only for assets that remain excluded', () => {
    expect(
      selectedQualityReviewExclusions(['asset-a'], {
        'asset-a': '旧排除理由',
        'asset-b': '  可选附件不参与本次评审  ',
        'asset-c': '   '
      })
    ).toEqual([{ asset_version_id: 'asset-b', reason: '可选附件不参与本次评审' }]);
  });

  it('preserves manual input while polling one run and clears it for a new run', () => {
    const current = { coverage: { score: '91', reason: '人工核验结果' } },
      firstRun = qualityRun('run-1', 'awaiting_human'),
      nextRun = qualityRun('run-2', 'awaiting_human');
    expect(scoresForQualityReviewRun('run-1', firstRun, current)).toEqual(current);
    expect(scoresForQualityReviewRun('run-1', nextRun, current)).toEqual({
      coverage: { score: '', reason: '' }
    });
  });

  it('shows the scoring form only while awaiting a human decision', () => {
    const view = renderQualitySection('reviewing');
    expect(screen.queryByText('人工最终评分')).not.toBeInTheDocument();

    view.rerender(section('awaiting_human'));
    expect(screen.getByText('人工最终评分')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();

    view.rerender(section('completed', 'pass'));
    expect(screen.queryByText('人工最终评分')).not.toBeInTheDocument();
    expect(screen.getByText(/人工裁决：/)).toBeInTheDocument();
    expect(screen.getByText('通过')).toBeInTheDocument();
  });

  it('hides a stale awaiting-human decision and offers a new review', () => {
    render(section('awaiting_human', null, true));
    expect(screen.queryByText('人工最终评分')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提交人工裁决' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新评审' })).toBeInTheDocument();
  });
});

function renderQualitySection(status: QualityReviewRun['status']) {
  return render(section(status));
}

function section(status: QualityReviewRun['status'], decision: QualityReviewRun['decision'] = null, stale = false) {
  const run = qualityRun('run-current', status, decision),
    snapshot: QualityReviewSnapshot = { run, report: null, decision: null, events: [] };
  run.stale = stale;
  return (
    <QualityReviewSection
      preparation={preparation(run)}
      snapshot={snapshot}
      history={{
        workflow_execution_id: run.workflow_execution_id,
        active:
          !stale && ['queued', 'preparing', 'checking', 'reviewing', 'awaiting_human'].includes(run.status)
            ? run
            : null,
        current: !stale && run.status === 'completed' ? run : null,
        latest: run,
        items: [run]
      }}
      selectedRunId={run.id}
      canRun
      canApprove
      busy=""
      drawerOpen={false}
      rubric={rubric}
      included={['asset-a']}
      exclusions={{}}
      scores={{}}
      decisionReason=""
      onOpen={vi.fn()}
      onSelectRun={vi.fn()}
      onClose={vi.fn()}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onIncluded={vi.fn()}
      onExclusion={vi.fn()}
      onRubric={vi.fn()}
      onScore={vi.fn()}
      onDecisionReason={vi.fn()}
      onDecision={vi.fn()}
    />
  );
}

const rubric: QualityReviewRubric = {
  schema_version: 'aiws.quality_review_rubric.v1',
  version: 1,
  enabled: true,
  mandatory: true,
  threshold: 80,
  dimensions: [
    {
      id: 'coverage',
      title: '目标与要求覆盖',
      weight: 100,
      enabled: true,
      instructions: '检查目标覆盖。'
    }
  ]
};

function qualityRun(
  id: string,
  status: QualityReviewRun['status'],
  decision: QualityReviewRun['decision'] = null
): QualityReviewRun {
  return {
    id,
    workflow_execution_id: 'execution-quality',
    project_id: 'project-quality',
    status,
    phase: status,
    input_snapshot_hash: 'a'.repeat(64),
    asset_version_ids: ['asset-a'],
    excluded_assets: [],
    rubric,
    rubric_hash: 'b'.repeat(64),
    threshold: 80,
    report_id: status === 'reviewing' ? null : 'report-quality',
    report_sha256: status === 'reviewing' ? null : 'c'.repeat(64),
    decision,
    score: decision ? 92 : null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:01:00.000Z'
  };
}

function preparation(currentRun: QualityReviewRun): QualityReviewPrepare {
  return {
    workflow_execution_id: currentRun.workflow_execution_id,
    enabled: true,
    mandatory: true,
    default_rubric: rubric,
    threshold: 80,
    rubric_hash: currentRun.rubric_hash,
    assets: [],
    out_of_scope_assets: [],
    default_included_asset_version_ids: [],
    reviewer_readiness: {
      status: 'ready',
      ready: true,
      advice_available: true,
      checked_at: '2026-08-01T00:00:00.000Z',
      profile: null,
      checks: Object.fromEntries(
        ['profile', 'image', 'credential', 'probe', 'vision'].map((name) => [
          name,
          {
            status: 'passed',
            ready: true,
            code: null,
            checked_at: '2026-08-01T00:00:00.000Z',
            details: {}
          }
        ])
      ) as QualityReviewPrepare['reviewer_readiness']['checks']
    },
    current_run: currentRun,
    limits: {}
  };
}
