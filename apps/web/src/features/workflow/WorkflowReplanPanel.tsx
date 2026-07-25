import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitPullRequest, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, json } from '../../api/client';
import { keys } from '../../api/queries';
import type { ChangeProposal, Workflow, WorkflowDraftNode } from '../../api/types';
import { capabilityTagLabel, taskKindLabel } from '../../components/common/display-labels';
import { useUi } from '../../state/ui';

type ReplanNode = WorkflowDraftNode & { dependencies?: Array<{ node_id?: string }>; order_index?: number };
type WorkflowGeneration = {
  id: string;
  project_id: string;
  workflow_id?: string | null;
  mode: 'initial' | 'replan';
  status: string;
  phase: string;
  result_mode?: string | null;
  change_proposal_id?: string | null;
  error_code?: string | null;
  error_detail?: string | null;
  candidate?: { nodes: ReplanNode[]; confidence?: number; decomposition_basis?: string } | null;
  critic?: { approved?: boolean; errors?: Array<{ code: string }> } | null;
  diff?: {
    workflow_id: string;
    from_revision: number;
    current_nodes: ReplanNode[];
    candidate_nodes: ReplanNode[];
  } | null;
};
type GenerationHandle = { generation: WorkflowGeneration; idempotent?: boolean };
type GenerationList = { items: WorkflowGeneration[] };
type ApplyResult = { generation: WorkflowGeneration; proposal: ChangeProposal };
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'superseded']);

export function WorkflowReplanPanel({
  projectId,
  workflow,
  canWrite,
  onClose
}: {
  projectId: string;
  workflow: Workflow;
  canWrite: boolean;
  onClose: () => void;
}) {
  const ui = useUi(),
    client = useQueryClient(),
    [generationId, setGenerationId] = useState<string | null>(null);
  const recent = useQuery({
    queryKey: ['workflow-replan-generations', projectId],
    queryFn: () => api<GenerationList>(`/projects/${projectId}/workflow-draft/generations?limit=20`)
  });
  useEffect(() => {
    if (generationId || !recent.data) return;
    const latest = recent.data.items.find((item) => item.mode === 'replan' && item.workflow_id === workflow.id);
    if (latest) setGenerationId(latest.id);
  }, [generationId, recent.data, workflow.id]);
  const generation = useQuery({
    queryKey: ['workflow-replan-generation', projectId, generationId],
    queryFn: () => api<WorkflowGeneration>(`/projects/${projectId}/workflow-draft/generations/${generationId}`),
    enabled: Boolean(generationId),
    refetchInterval: (query) => (query.state.data && !TERMINAL.has(query.state.data.status) ? 800 : false)
  });
  const start = useMutation({
    mutationFn: () =>
      api<GenerationHandle>(
        `/projects/${projectId}/workflow-draft/generations`,
        json('POST', { mode: 'replan', force: true }, '生成工作流重新规划候选')
      ),
    onSuccess: (result) => {
      setGenerationId(result.generation.id);
      void recent.refetch();
    },
    onError: (error) => ui.toast(error.message, 'error')
  });
  const apply = useMutation({
    mutationFn: () =>
      api<ApplyResult>(
        `/projects/${projectId}/workflow-draft/generations/${generationId}/apply`,
        json(
          'POST',
          { expected_revision: Number(workflow.workflow_revision || workflow.version || 1) },
          '创建工作流重新规划提案'
        )
      ),
    onSuccess: (result) => {
      void generation.refetch();
      void client.invalidateQueries({ queryKey: keys.proposals(projectId) });
      ui.showProposal(result.proposal.id);
      ui.toast('重新规划变更提案已创建');
    },
    onError: (error) => ui.toast(error.message, 'error')
  });
  const value = generation.data || recent.data?.items.find((item) => item.id === generationId);
  const diff = useMemo(() => summarizeDiff(value?.diff), [value?.diff]);
  const error = start.error || generation.error || apply.error;
  return (
    <aside className="workflow-replan-panel" aria-label="工作流重新规划">
      <header>
        <div>
          <span>重新规划审查</span>
          <h2>工作流重新规划</h2>
        </div>
        <button className="icon-button" aria-label="关闭重新规划" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className="workflow-replan-status">
        <span className={`status ${statusTone(value?.status)}`}>{generationStatus(value)}</span>
        {value?.diff && <span>基于 v{value.diff.from_revision}</span>}
        {value?.candidate?.confidence != null && <span>置信度 {Math.round(value.candidate.confidence * 100)}%</span>}
        <button
          className="button secondary"
          disabled={!canWrite || start.isPending || Boolean(value && !TERMINAL.has(value.status))}
          onClick={() => start.mutate()}
        >
          <RefreshCw size={14} />
          {value ? '重新生成' : '生成候选方案'}
        </button>
      </div>
      {error && (
        <div className="workflow-replan-error" role="alert">
          {error.message}
        </div>
      )}
      {value?.diff ? (
        <>
          <div className="workflow-diff-counts" aria-label="重新规划差异摘要">
            <span>
              <strong>{diff.added}</strong>新增
            </span>
            <span>
              <strong>{diff.changed}</strong>修改
            </span>
            <span>
              <strong>{diff.removed}</strong>移除
            </span>
            <span>
              <strong>{diff.kept}</strong>保留
            </span>
          </div>
          <div className="workflow-replan-diff">
            <DiffPane
              title="当前流程"
              nodes={value.diff.current_nodes}
              counterpart={value.diff.candidate_nodes}
              side="current"
            />
            <DiffPane
              title="候选流程"
              nodes={value.diff.candidate_nodes}
              counterpart={value.diff.current_nodes}
              side="candidate"
            />
          </div>
        </>
      ) : (
        <div className="workflow-replan-empty">
          {value && !TERMINAL.has(value.status)
            ? phaseLabel(value.phase)
            : value?.status === 'failed'
              ? value.error_code || '生成失败'
              : '尚无重新规划候选'}
        </div>
      )}
      <footer>
        {value?.change_proposal_id ? (
          <button className="button primary" onClick={() => ui.showProposal(value.change_proposal_id || null)}>
            <GitPullRequest size={15} />
            审查变更提案
          </button>
        ) : (
          <button
            className="button primary"
            disabled={!canWrite || value?.status !== 'completed' || !value.diff || apply.isPending}
            onClick={() => apply.mutate()}
          >
            <GitPullRequest size={15} />
            {apply.isPending ? '创建中' : '创建变更提案'}
          </button>
        )}
      </footer>
    </aside>
  );
}

function DiffPane({
  title,
  nodes,
  counterpart,
  side
}: {
  title: string;
  nodes: ReplanNode[];
  counterpart: ReplanNode[];
  side: 'current' | 'candidate';
}) {
  const other = new Map(counterpart.map((item) => [item.id, item]));
  return (
    <section>
      <header>
        <strong>{title}</strong>
        <span>{nodes.length} 节点</span>
      </header>
      <div>
        {nodes.map((node) => {
          const match = other.get(node.id),
            state = !match ? (side === 'current' ? 'removed' : 'added') : sameNode(node, match) ? 'kept' : 'changed';
          return (
            <article key={node.id} className={state}>
              <span>{node.role === 'workstream' ? '成果' : phaseLabelForNode(node)}</span>
              <strong>{node.title}</strong>
              <small>{diffLabel(state)}</small>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function summarizeDiff(diff?: WorkflowGeneration['diff']) {
  if (!diff) return { added: 0, changed: 0, removed: 0, kept: 0 };
  const current = new Map(diff.current_nodes.map((item) => [item.id, item])),
    candidate = new Map(diff.candidate_nodes.map((item) => [item.id, item]));
  let added = 0,
    changed = 0,
    removed = 0,
    kept = 0;
  for (const [id, node] of candidate) {
    const before = current.get(id);
    if (!before) added++;
    else if (sameNode(before, node)) kept++;
    else changed++;
  }
  for (const id of current.keys()) if (!candidate.has(id)) removed++;
  return { added, changed, removed, kept };
}

function sameNode(left: ReplanNode, right: ReplanNode) {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}
function comparable(node: ReplanNode) {
  return {
    role: node.role,
    parent_node_id: node.parent_node_id || null,
    title: node.title,
    goal: node.goal,
    outcome: node.outcome || null,
    task_kind: node.task_kind || null,
    execution_mode: node.execution_mode || null,
    acceptance_criteria: node.acceptance_criteria || [],
    capability_tags: node.capability_tags || [],
    input_slots: node.input_slots || [],
    output_slots: node.output_slots || [],
    dependency_ids: [
      ...(node.dependency_ids || node.dependencies?.map((item) => item.node_id).filter(Boolean) || [])
    ].sort()
  };
}
function generationStatus(value?: WorkflowGeneration) {
  if (!value) return '未生成';
  return (
    (
      {
        queued: '排队中',
        running: '生成中',
        completed: '可审阅',
        failed: '生成失败',
        cancelled: '已取消',
        superseded: '已过期'
      } as Record<string, string>
    )[value.status] || '处理中'
  );
}
function statusTone(value?: string) {
  return value === 'completed' ? 'completed' : value === 'failed' ? 'failed' : value || 'pending';
}
function phaseLabel(value?: string) {
  return (
    (
      { queued: '正在排队', generating: '正在生成候选', critiquing: '正在校验质量', completed: '候选已就绪' } as Record<
        string,
        string
      >
    )[value || ''] || '处理中'
  );
}
function phaseLabelForNode(node: ReplanNode) {
  return node.capability_tags?.[0] ? capabilityTagLabel(node.capability_tags[0]) : taskKindLabel(node.task_kind);
}
function diffLabel(value: string) {
  return (
    ({ added: '新增', changed: '修改', removed: '移除', kept: '保留' } as Record<string, string>)[value] || '已变更'
  );
}
