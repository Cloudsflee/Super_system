import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, json } from '../../api/client';
import type {
  QualityReviewPrepare,
  QualityReviewHistory,
  QualityReviewRubric,
  QualityReviewRun,
  QualityReviewSnapshot
} from '../../api/execution-types';
import { useUi } from '../../state/ui';
import { QualityReviewSection } from './QualityReviewSection';
import { scoresForQualityReviewRun, selectedQualityReviewExclusions } from './quality-review-draft';
import type { QualityReviewScores } from './quality-review-view-model';

type ControllerProps = {
  executionId: string;
  enabled: boolean;
  canRun?: boolean;
  canApprove: boolean;
  onRefresh: () => Promise<unknown>;
};

export function QualityReviewController(props: ControllerProps) {
  const queries = useQualityReviewQueries(props.executionId, props.enabled);
  const draft = useQualityReviewDraft(props.executionId, queries.preparation.data, queries.run.data?.run);
  const actions = useQualityReviewActions({ ...props, ...queries, ...draft });
  if (!props.enabled) return null;
  return (
    <QualityReviewSection
      preparation={queries.preparation.data}
      snapshot={queries.run.data}
      history={queries.history.data}
      selectedRunId={queries.activeId}
      canRun={props.canRun ?? props.canApprove}
      canApprove={props.canApprove}
      busy={actions.busy}
      drawerOpen={draft.drawerOpen}
      rubric={draft.rubric}
      included={draft.included}
      exclusions={draft.exclusions}
      scores={draft.scores}
      decisionReason={draft.decisionReason}
      onOpen={() => draft.setDrawerOpen(true)}
      onSelectRun={queries.setRunId}
      onClose={() => draft.setDrawerOpen(false)}
      onStart={() => void actions.start()}
      onCancel={() => void actions.cancel()}
      onIncluded={draft.setIncluded}
      onExclusion={draft.onExclusion}
      onRubric={draft.setRubric}
      onScore={draft.onScore}
      onDecisionReason={draft.setDecisionReason}
      onDecision={() => void actions.decide()}
    />
  );
}

function useQualityReviewQueries(executionId: string, enabled: boolean) {
  const [selection, setSelection] = useState<{ executionId: string; runId: string | null }>(() => ({
    executionId,
    runId: null
  }));
  useEffect(() => setSelection({ executionId, runId: null }), [executionId]);
  const selectedRunId = selection.executionId === executionId ? selection.runId : null;
  const setRunId = (value: string | null) => setSelection({ executionId, runId: value });
  const preparation = useQuery({
    queryKey: ['quality-review-prepare', executionId],
    queryFn: () => api<QualityReviewPrepare>(`/workflow-executions/${executionId}/quality-reviews/prepare`),
    enabled,
    staleTime: 2_000
  });
  const history = useQuery({
    queryKey: ['quality-review-history', executionId],
    queryFn: () => api<QualityReviewHistory>(`/workflow-executions/${executionId}/quality-reviews`),
    enabled,
    refetchInterval: enabled ? 2_000 : false
  });
  const activeId =
    selectedRunId || history.data?.active?.id || history.data?.current?.id || history.data?.latest?.id || null;
  const run = useQuery({
    queryKey: ['quality-review', activeId],
    queryFn: () => api<QualityReviewSnapshot>(`/quality-reviews/${activeId}`),
    enabled: enabled && Boolean(activeId),
    refetchInterval: (query) =>
      ['queued', 'preparing', 'checking', 'reviewing'].includes(query.state.data?.run.status || '') ? 1_000 : false
  });
  return { preparation, history, run, activeId, setRunId };
}

function useQualityReviewDraft(executionId: string, preparation?: QualityReviewPrepare, run?: QualityReviewRun) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rubric, setRubric] = useState<QualityReviewRubric | null>(null);
  const [included, setIncluded] = useState<string[]>([]);
  const [exclusions, setExclusions] = useState<Record<string, string>>({});
  const [scores, setScores] = useState<QualityReviewScores>({});
  const [decisionReason, setDecisionReason] = useState('');
  const scoreRunId = useRef<string | null>(null);
  useEffect(() => {
    setDrawerOpen(false);
    setRubric(null);
    setIncluded([]);
    setExclusions({});
    setScores({});
    setDecisionReason('');
    scoreRunId.current = null;
  }, [executionId]);
  useEffect(() => {
    if (!preparation) return;
    if (preparation.workflow_execution_id !== executionId) return;
    setRubric((current) => current || structuredClone(preparation.default_rubric));
    setIncluded((current) => (current.length ? current : [...preparation.default_included_asset_version_ids]));
  }, [executionId, preparation]);
  useEffect(() => {
    if (!run?.id || !run.rubric) return;
    setRubric(run.rubric);
    setScores((current) => scoresForQualityReviewRun(scoreRunId.current, run, current));
    if (scoreRunId.current !== run.id) setDecisionReason('');
    scoreRunId.current = run.id;
  }, [run?.id, run?.rubric]);
  return {
    drawerOpen,
    setDrawerOpen,
    rubric,
    setRubric,
    included,
    setIncluded,
    exclusions,
    scores,
    decisionReason,
    setDecisionReason,
    onExclusion: (id: string, reason: string) => setExclusions((current) => ({ ...current, [id]: reason })),
    onScore: (id: string, value: { score: string; reason: string }) =>
      setScores((current) => ({ ...current, [id]: value }))
  };
}

function useQualityReviewActions({
  executionId,
  canApprove,
  onRefresh,
  preparation,
  history,
  run,
  activeId,
  setRunId,
  setDrawerOpen,
  rubric,
  included,
  exclusions,
  scores,
  decisionReason
}: ControllerProps & ReturnType<typeof useQualityReviewQueries> & ReturnType<typeof useQualityReviewDraft>) {
  const [busy, setBusy] = useState('');
  const toast = useUi((state) => state.toast);
  const start = async () => {
    if (!rubric) return;
    await runQualityReviewStart({
      executionId,
      rubric,
      included,
      exclusions,
      preparation,
      history,
      onRefresh,
      setRunId,
      setDrawerOpen,
      toast,
      setBusy
    });
  };
  const cancel = async () => {
    const cancellableId = history.data?.active?.id || null;
    if (!cancellableId) return;
    await runQualityReviewCancel({ activeId: cancellableId, history, run, toast, setBusy });
  };
  const decide = async () => {
    if (!canApprove || !activeId || !run.data?.run) return;
    await runQualityReviewDecision({
      activeId,
      current: run.data.run,
      scores,
      decisionReason,
      history,
      run,
      onRefresh,
      toast,
      setBusy
    });
  };
  return { busy, start, cancel, decide };
}

async function runQualityReviewStart({
  executionId,
  rubric,
  included,
  exclusions,
  preparation,
  history,
  onRefresh,
  setRunId,
  setDrawerOpen,
  toast,
  setBusy
}: any) {
  setBusy('quality-start');
  try {
    const excluded_assets = selectedQualityReviewExclusions(included, exclusions);
    const result = await api<QualityReviewSnapshot>(
      `/workflow-executions/${executionId}/quality-reviews`,
      json(
        'POST',
        {
          operation_key: `quality-review-${executionId}-${crypto.randomUUID()}`,
          included_asset_version_ids: included,
          excluded_assets,
          rubric
        },
        '启动 Quality Review'
      )
    );
    setRunId(result.run.id);
    setDrawerOpen(false);
    await Promise.all([preparation.refetch(), history.refetch(), onRefresh()]);
    toast('Quality Review 已启动');
  } catch (requestError) {
    toast((requestError as Error).message, 'error');
  } finally {
    setBusy('');
  }
}

async function runQualityReviewCancel({ activeId, history, run, toast, setBusy }: any) {
  setBusy('quality-cancel');
  try {
    await api(`/quality-reviews/${activeId}/cancel`, json('POST', {}, '取消 Quality Review'));
    await Promise.all([history.refetch(), run.refetch()]);
    toast('Quality Review 已取消');
  } catch (requestError) {
    toast((requestError as Error).message, 'error');
  } finally {
    setBusy('');
  }
}

async function runQualityReviewDecision({
  activeId,
  current,
  scores,
  decisionReason,
  history,
  run,
  onRefresh,
  toast,
  setBusy
}: any) {
  if (!current.report_sha256 || !current.input_snapshot_hash) return;
  setBusy('quality-decision');
  try {
    await api(
      `/quality-reviews/${activeId}/decision`,
      json(
        'POST',
        {
          expected_report_sha256: current.report_sha256,
          expected_input_snapshot_hash: current.input_snapshot_hash,
          dimension_scores: Object.entries(scores as QualityReviewScores).map(([criterion_id, item]) => ({
            criterion_id,
            score: Number(item.score),
            reason: item.reason
          })),
          reason: decisionReason
        },
        '提交 Quality Review 人工裁决'
      )
    );
    await Promise.all([history.refetch(), run.refetch(), onRefresh()]);
    toast('人工裁决已提交，Outcome 已刷新');
  } catch (requestError) {
    toast((requestError as Error).message, 'error');
  } finally {
    setBusy('');
  }
}
