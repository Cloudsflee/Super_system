import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertTriangle, Check, CircleAlert, GitBranch, LoaderCircle, Play, Plus, RefreshCw,
  RotateCcw, Save, ShieldAlert, Square, Workflow as WorkflowIcon
} from 'lucide-react';
import { ApiError, apiV2, mutateOfflineV2, mutateV2 } from '../../api';
import type { WorkspacePageProps } from '../../workspace';
import { WorkflowWorkbench } from './WorkflowCanvas';
import { commandLabel, errorCodeLabel, kindLabel, statusLabel } from '../../i18n';

type Section = 'overview' | 'intake' | 'brief' | 'repository' | 'workflow';
type LoadState = 'loading' | 'ready' | 'empty' | 'denied' | 'error';
type P3Project = {
  id: string;
  team_id?: string;
  owner_actor_id?: string;
  name: string;
  description?: string;
  status: string;
  onboarding_state?: string;
  current_brief_revision?: number;
  confirmed_brief_revision?: number | null;
  confirmed_brief_hash?: string;
  current_workflow_revision?: number;
  revision: number;
  updated_at?: string;
};
type Intake = {
  id: string;
  project_id: string;
  status: string;
  mode: 'brainstorm' | 'existing';
  source_kind?: string;
  source_revision?: string;
  source_hash?: string;
  error_code?: string;
  attempt?: number;
  revision: number;
  operation_id?: string | null;
};
type Brief = {
  id?: string;
  project_id: string;
  status?: string;
  current_revision?: number;
  confirmed_revision?: number | null;
  confirmed_hash?: string;
  revision?: number;
  current?: { revision: number; content?: Record<string, unknown>; content_sha256?: string } | null;
};
type RepositoryConnection = {
  id: string;
  project_id: string;
  provider?: string;
  source_kind?: string;
  source_revision?: string;
  source_hash?: string;
  status: string;
  read_only?: boolean;
  revision: number;
};
type RepositoryTarget = {
  id: string;
  connection_id: string;
  name?: string;
  source_locator?: string;
  remote_ref?: string;
  expected_head_sha?: string;
  revision: number;
};
type RepositoryDeletionIntent = {
  id: string;
  status: string;
  revision: number;
  target_full_name?: string;
  expected_head_sha?: string;
  error_code?: string | null;
};
type RepositoryLine = { id: string; status: string; source_revision?: string; source_hash?: string; revision: number; fault_code?: string };
type Workflow = { id: string; project_id: string; status: string; current_revision: number; revision: number; current?: { graph?: Record<string, unknown>; graph_sha256?: string } | null };
type Generation = { id: string; phase: string; revision: number; attempt?: number; error_code?: string; proposal_id?: string | null; critic_receipt_id?: string | null; candidate?: Record<string, unknown>; critic?: { status?: string; issues?: Array<{ code?: string; message?: string; node_id?: string }> } | null; proposal?: { candidate?: Record<string, unknown>; status?: string; proposal_hash?: string } | null };
type Requirement = { id: string; requirement_key: string; workflow_revision: number; revision: number; rubric?: Record<string, unknown> };

const sections: Array<{ id: Section; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'intake', label: '来源接入' },
  { id: 'brief', label: 'Brief' },
  { id: 'repository', label: '代码仓库' },
  { id: 'workflow', label: '工作流' }
];

function Status({ value }: { value?: string }) {
  const status = value || 'unknown';
  const tone = ['ready', 'active', 'confirmed', 'applied', 'passed'].includes(status)
    ? 'positive' : ['queued', 'running', 'processing', 'critic_pending', 'proposed'].includes(status)
      ? 'working' : ['failed', 'cancelled', 'rejected', 'stale', 'faulted', 'archived'].includes(status) ? 'negative' : 'neutral';
  return <span className={`status ${tone}`}><span />{statusLabel(status)}</span>;
}

function PanelTitle({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return <div className="section-title"><div><h2>{title}</h2>{meta && <span>{meta}</span>}</div>{action}</div>;
}

function ErrorState({ state, message, onRetry }: { state: LoadState; message: string; onRetry: () => void }) {
  if (state === 'denied') return <div className="state-banner denied" data-testid="project-workflow-denied"><ShieldAlert size={18} /><span>{message || '没有项目访问权限'}</span></div>;
  if (state === 'error') return <div className="state-banner error" role="alert"><CircleAlert size={18} /><span>{message || '项目请求失败'}</span><button className="icon-button" title="重试" aria-label="重试" onClick={onRetry}><RefreshCw size={15} /></button></div>;
  return null;
}

function unwrap<T>(envelope: { data: T }): T { return envelope.data; }

export function ProjectWorkflowPage({ projectId, selectedProject, selectProject, refreshProjects, notify, setupReady, navigate, navigateProject, initialSection }: WorkspacePageProps & { initialSection?: Section }) {
  const [section, setSection] = useState<Section>(initialSection || 'overview');
  useEffect(() => { if (initialSection) setSection(initialSection); }, [initialSection]);
  const [projects, setProjects] = useState<P3Project[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [project, setProject] = useState<P3Project | null>(null);
  const [intake, setIntake] = useState<Intake | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [connections, setConnections] = useState<RepositoryConnection[]>([]);
  const [targets, setTargets] = useState<RepositoryTarget[]>([]);
  const [lines, setLines] = useState<RepositoryLine[]>([]);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [providerProfileId, setProviderProfileId] = useState('');
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState('');
  const [busy, setBusy] = useState('');
  const [operationId, setOperationId] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const selectedId = projectId || selectedProject?.id || '';
  const offlineScope = useMemo(() => ({
    actorId: sessionStorage.getItem('aiws:v3:actor-id') || project?.owner_actor_id || 'session-actor',
    teamId: project?.team_id || 'default-team',
    projectId: selectedId
  }), [project?.owner_actor_id, project?.team_id, selectedId]);
  const [intakeMode, setIntakeMode] = useState<'brainstorm' | 'existing'>('brainstorm');
  const [sourceLocator, setSourceLocator] = useState('fixture/project-source');
  const [objective, setObjective] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [repositoryLocator, setRepositoryLocator] = useState('fixture/project-repository');
  const [workflowGraph, setWorkflowGraph] = useState('{"nodes":[]}');
  const [workflowDensity, setWorkflowDensity] = useState<'compact' | 'comfortable'>('comfortable');
  const [requirementKey, setRequirementKey] = useState('');
  const [deletionIntent, setDeletionIntent] = useState<{ id: string; status: string; revision: number; blockers?: Array<{ domain?: string }> } | null>(null);
  const [deletionName, setDeletionName] = useState('');
  const [repositoryDeletionIntent, setRepositoryDeletionIntent] = useState<RepositoryDeletionIntent | null>(null);
  const [repositoryDeletionName, setRepositoryDeletionName] = useState('');
  const [repositoryDeletionHead, setRepositoryDeletionHead] = useState('');
  useEffect(() => { setDeletionIntent(null); setRepositoryDeletionIntent(null); setTargets([]); }, [selectedId]);

  const loadProjects = useCallback(async () => {
    const result = await apiV2<{ projects: P3Project[] }>(`/api/v2/projects?include_archived=${showArchived ? 'true' : 'false'}`);
    setProjects(unwrap(result).projects || []);
  }, [showArchived]);

  const restoreDeletionIntent = useCallback(async (id: string) => {
    if (!id) { setDeletionIntent(null); return; }
    try {
      const operations = await apiV2<{ operations?: Array<{ command_id?: string; resource_type?: string; resource_id?: string; created_at?: string }> }>(`/api/v2/operations?project_id=${encodeURIComponent(id)}`);
      const candidate = (operations.data.operations || [])
        .filter((item) => item.resource_type === 'project_deletion_intent' && item.resource_id)
        .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')))[0];
      if (!candidate?.resource_id) { setDeletionIntent(null); return; }
      const intent = await apiV2<{ intent?: { id: string; status: string; revision: number; blockers?: Array<{ domain?: string }> } }>(`/api/v2/project-deletion-intents/${encodeURIComponent(candidate.resource_id)}`);
      setDeletionIntent(intent.data.intent || null);
    } catch {
      // Deletion intent visibility is best-effort during the normal project
      // refresh; the authoritative mutation still reports conflicts inline.
    }
  }, []);

  const restoreRepositoryDeletionIntent = useCallback(async (id: string) => {
    if (!id) { setRepositoryDeletionIntent(null); return; }
    try {
      const operations = await apiV2<{ operations?: Array<{ resource_type?: string; resource_id?: string; created_at?: string }> }>(`/api/v2/operations?project_id=${encodeURIComponent(id)}`);
      const candidate = (operations.data.operations || [])
        .filter((item) => item.resource_type === 'repository_deletion_intent' && item.resource_id)
        .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')))[0];
      if (!candidate?.resource_id) { setRepositoryDeletionIntent(null); return; }
      const intent = await apiV2<{ intent?: RepositoryDeletionIntent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(candidate.resource_id)}`);
      setRepositoryDeletionIntent(intent.data.intent || null);
      if (intent.data.intent?.target_full_name) setRepositoryDeletionName(intent.data.intent.target_full_name);
      if (intent.data.intent?.expected_head_sha) setRepositoryDeletionHead(intent.data.intent.expected_head_sha);
    } catch {
      // Intent recovery is advisory; the server remains authoritative for
      // snapshot and revision checks on every destructive action.
    }
  }, []);

  const loadRepositoryTargets = useCallback(async (rows: RepositoryConnection[], project: string) => {
    const connection = rows[0];
    if (!connection || !project) { setTargets([]); setRepositoryDeletionIntent(null); return; }
    try {
      const result = await apiV2<{ targets?: RepositoryTarget[] }>(`/api/v2/repository-connections/${encodeURIComponent(connection.id)}/targets`);
      const next = result.data.targets || [];
      setTargets(next);
      const target = next[0];
      if (target) {
        setRepositoryDeletionName((current) => current || target.source_locator || target.remote_ref || target.name || '');
        setRepositoryDeletionHead((current) => current || target.expected_head_sha || '');
      }
      await restoreRepositoryDeletionIntent(project);
    } catch {
      setTargets([]);
    }
  }, [restoreRepositoryDeletionIntent]);

  const enrichLatestGeneration = useCallback(async (rows: Generation[]) => {
    const latest = rows[0];
    if (!latest) return;
    try {
      const result = await apiV2<{ generation?: Generation; critic?: Generation['critic']; proposal?: Generation['proposal'] }>(`/api/v2/workflow-generations/${encodeURIComponent(latest.id)}`);
      const detail = result.data;
      if (detail.generation) setGenerations((current) => current.map((item) => item.id === latest.id ? { ...item, ...detail.generation, critic: detail.critic || null, proposal: detail.proposal || null } : item));
    } catch { /* list data remains usable when an expanded read is unavailable */ }
  }, []);

  const loadProject = useCallback(async () => {
    setLoadState('loading');
    setMessage('');
    try {
      if (!selectedId) {
        await loadProjects();
        setProject(null); setIntake(null); setBrief(null); setConnections([]); setTargets([]); setLines([]); setWorkflow(null); setGenerations([]); setRequirements([]);
        setDeletionIntent(null); setRepositoryDeletionIntent(null);
        setLoadState('empty');
        return;
      }
      await loadProjects();
      const [detail, intakeResult, briefResult, connectionResult, lineResult, workflowResult, generationResult, requirementResult] = await Promise.all([
        apiV2<{ project: P3Project; intake?: Intake; brief?: Brief; workflow?: Workflow }>(`/api/v2/projects/${encodeURIComponent(selectedId)}`),
        apiV2<{ intake: Intake }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/intake`),
        apiV2<{ briefs: Brief[] }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/briefs`),
        apiV2<{ connections: RepositoryConnection[] }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/repository-connections`),
        apiV2<{ lines: RepositoryLine[] }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/repository-lines`),
        apiV2<{ workflow: Workflow }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/workflow-draft`),
        apiV2<{ generations: Generation[] }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/workflow-generations`),
        apiV2<{ requirements: Requirement[] }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/outcome-requirements`)
      ]);
      const detailData = unwrap(detail);
      const projectData = detailData.project || detailData as unknown as P3Project;
      setProject(projectData);
      setProjectName(projectData.name || '');
      setProjectDescription(projectData.description || '');
      setIntake(unwrap(intakeResult).intake || detailData.intake || null);
      const briefs = unwrap(briefResult).briefs || [];
      setBrief((detailData.brief as Brief | undefined) || briefs[0] || null);
      setConnections(unwrap(connectionResult).connections || []);
      const nextConnections = unwrap(connectionResult).connections || [];
      void loadRepositoryTargets(nextConnections, selectedId);
      setLines(unwrap(lineResult).lines || []);
      setWorkflow(unwrap(workflowResult).workflow || detailData.workflow || null);
      const generationRows = unwrap(generationResult).generations || [];
      setGenerations(generationRows);
      void enrichLatestGeneration(generationRows);
      setRequirements(unwrap(requirementResult).requirements || []);
      void restoreDeletionIntent(selectedId);
      const loadedGraph = (unwrap(workflowResult).workflow || detailData.workflow)?.current?.graph;
      if (loadedGraph && typeof loadedGraph === 'object') setWorkflowGraph(JSON.stringify(loadedGraph, null, 2));
      const content = (detailData.brief as Brief | undefined)?.current?.content || briefs[0]?.current?.content;
      setObjective(typeof content?.objective === 'string' ? content.objective : '');
      setAcceptance(Array.isArray(content?.acceptance) ? content.acceptance.join('\n') : '');
      setLoadState('ready');
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      setMessage(apiError?.message || (error instanceof Error ? error.message : '项目请求失败'));
      setLoadState(apiError?.status === 403 ? 'denied' : 'error');
    }
  }, [enrichLatestGeneration, loadProjects, loadRepositoryTargets, restoreDeletionIntent, selectedId]);

  useEffect(() => { if (setupReady !== false) void loadProject(); }, [loadProject, setupReady]);

  const runMutation = useCallback(async (label: string, action: () => Promise<{ data: Record<string, unknown> } | { queued: true; record: unknown }>, refresh = true) => {
    setBusy(label); setConflict(''); setMessage('');
    try {
      const response = await action();
      if ('queued' in response) {
        notify(`${commandLabel(label)}已离线保存`);
        return {};
      }
      const data = response.data || {};
      const operation = (data.operation || {}) as { operation_id?: string; id?: string };
      if (operation.operation_id || operation.id) setOperationId(operation.operation_id || operation.id || '');
      if (refresh) await loadProject();
      notify(`${commandLabel(label)}已提交`);
      return data;
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.code === 'revision_conflict' || apiError?.status === 409) setConflict(apiError.message || '版本已变化，请重新加载后重试。');
      else if (apiError?.code === 'source_drift') setMessage(apiError.message || '检测到源版本漂移，请对账后重试。');
      else setMessage(apiError?.message || (error instanceof Error ? error.message : `${commandLabel(label)}失败`));
      notify(apiError?.message || `${commandLabel(label)}失败`, 'error');
      return null;
    } finally { setBusy(''); }
  }, [loadProject, notify]);

  const createProject = async (event: FormEvent) => {
    event.preventDefault();
    if (!newName.trim()) return;
    const result = await runMutation('Project', () => mutateV2('/api/v2/projects', { name: newName.trim(), description: newDescription, metadata: {} }, 'POST', 0), false);
    if (result?.project) {
      const created = result.project as P3Project;
      setNewName(''); setNewDescription('');
      await refreshProjects();
      await loadProjects();
      selectProject(created.id);
      navigateProject?.(created.id, 'onboarding');
    }
  };

  const updateProject = () => runMutation('Project', () => mutateOfflineV2(`/api/v2/projects/${encodeURIComponent(selectedId)}`, {
    name: projectName.trim(), description: projectDescription, metadata: {}
  }, 'PATCH', { command: 'project.update', scope: offlineScope, aggregateKey: `project:${selectedId}`, expectedRevision: project?.revision }));
  const archiveProject = (item: P3Project) => runMutation('Archive project', () => mutateV2(`/api/v2/projects/${encodeURIComponent(item.id)}/archive`, {}, 'POST', item.revision));
  const restoreProject = (item: P3Project) => runMutation('Restore project', () => mutateV2(`/api/v2/projects/${encodeURIComponent(item.id)}/restore`, {}, 'POST', item.revision));
  const prepareDeletion = () => runMutation('Prepare deletion', async () => { const result = await mutateV2<{ intent: { id: string; status: string; revision: number; blockers?: Array<{ domain?: string }> } }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/deletion-intents`, { target_name: deletionName.trim() || project?.name || '' }, 'POST', project?.revision); setDeletionIntent(result.data.intent); return result; });
  const confirmDeletion = () => deletionIntent && runMutation('Confirm deletion', async () => { const result = await mutateV2<{ intent: typeof deletionIntent }>(`/api/v2/project-deletion-intents/${encodeURIComponent(deletionIntent.id)}/confirm`, { target_name: deletionName.trim() || project?.name || '' }, 'POST', deletionIntent.revision); setDeletionIntent(result.data.intent); return result; });
  const executeDeletion = () => deletionIntent && runMutation('Execute deletion', async () => { const result = await mutateV2<{ intent: typeof deletionIntent }>(`/api/v2/project-deletion-intents/${encodeURIComponent(deletionIntent.id)}/execute`, {}, 'POST', deletionIntent.revision); setDeletionIntent(result.data.intent); return result; });

  const prepareRepositoryDeletion = () => {
    const target = targets[0];
    if (!target) return Promise.resolve(null);
    return runMutation('Prepare repository deletion', async () => {
      const result = await mutateV2<{ intent: RepositoryDeletionIntent }>(`/api/v2/repository-targets/${encodeURIComponent(target.id)}/deletion-intents`, {
        target_full_name: repositoryDeletionName.trim(), expected_head_sha: repositoryDeletionHead.trim()
      }, 'POST', target.revision);
      setRepositoryDeletionIntent(result.data.intent);
      return result;
    });
  };
  const confirmRepositoryDeletion = (role: 'creator' | 'owner') => repositoryDeletionIntent && runMutation(`Repository ${role} confirmation`, async () => {
    const path = role === 'creator' ? 'creator-confirm' : 'owner-confirm';
    const result = await mutateV2<{ intent: RepositoryDeletionIntent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(repositoryDeletionIntent.id)}/${path}`, {
      target_full_name: repositoryDeletionName.trim(), expected_head_sha: repositoryDeletionHead.trim()
    }, 'POST', repositoryDeletionIntent.revision);
    setRepositoryDeletionIntent(result.data.intent);
    return result;
  });
  const executeRepositoryDeletion = () => repositoryDeletionIntent && runMutation('Execute repository deletion', async () => {
    const result = await mutateV2<{ intent: RepositoryDeletionIntent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(repositoryDeletionIntent.id)}/execute`, {}, 'POST', repositoryDeletionIntent.revision);
    setRepositoryDeletionIntent(result.data.intent);
    return result;
  });
  const reconcileRepositoryDeletion = () => repositoryDeletionIntent && runMutation('Reconcile repository deletion', async () => {
    const result = await mutateV2<{ intent: RepositoryDeletionIntent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(repositoryDeletionIntent.id)}/reconcile`, {}, 'POST', repositoryDeletionIntent.revision);
    setRepositoryDeletionIntent(result.data.intent);
    return result;
  });
  const cancelRepositoryDeletion = () => repositoryDeletionIntent && runMutation('Cancel repository deletion', async () => {
    const result = await mutateV2<{ intent: RepositoryDeletionIntent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(repositoryDeletionIntent.id)}/cancel`, {}, 'POST', repositoryDeletionIntent.revision);
    setRepositoryDeletionIntent(result.data.intent);
    return result;
  });

  const submitIntake = () => runMutation('Intake', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/intake`, {
    mode: intakeMode,
    source: intakeMode === 'existing' ? { kind: 'fixture', locator: sourceLocator, revision: 'fixture-r1', hash: 'a'.repeat(64) } : {},
    content: {},
  }, 'POST', project?.revision));

  const retryIntake = () => runMutation('Retry intake', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/intake/retry`, {}, 'POST', intake?.revision));
  const cancelIntake = () => runMutation('Cancel intake', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/intake/cancel`, {}, 'POST', intake?.revision));

  const saveBrief = () => runMutation('Brief', () => mutateOfflineV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/briefs`, {
    content: { objective: objective.trim(), constraints: [], acceptance: acceptance.split('\n').map((line) => line.trim()).filter(Boolean) },
    objective: objective.trim(), constraints: [], acceptance: acceptance.split('\n').map((line) => line.trim()).filter(Boolean), template: 'default'
  }, 'POST', { command: 'brief.create', scope: offlineScope, aggregateKey: `project:${selectedId}:brief`, expectedRevision: project?.revision }));

  const confirmBrief = () => {
    const revision = brief?.current_revision || brief?.current?.revision || 0;
    return runMutation('Confirm brief', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/briefs/${revision}/confirm`, { brief_revision: revision }, 'POST', project?.revision));
  };

  const connectRepository = () => runMutation('Repository', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/repository-connections`, {
    provider: 'fixture', source_kind: 'fixture', source_locator: repositoryLocator, source_revision: 'fixture-r1', source_hash: 'a'.repeat(64), branch: 'main', read_only: true
  }, 'POST', project?.revision));

  const reviseWorkflow = () => {
    let graph: Record<string, unknown> = {};
    try { graph = JSON.parse(workflowGraph) as Record<string, unknown>; } catch { setMessage('Workflow 图谱必须是有效 JSON。'); return Promise.resolve(null); }
    return runMutation('Workflow', () => mutateOfflineV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/workflow-draft`, { graph, nodes: Array.isArray(graph.nodes) ? graph.nodes : [], layout: {} }, 'POST', { command: 'workflow.revise', scope: offlineScope, aggregateKey: `project:${selectedId}:workflow`, expectedRevision: workflow?.revision }));
  };

  const startGeneration = (mode: 'initial' | 'replan' = 'initial') => runMutation('Generation', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/workflow-generations`, { mode, candidate: {}, provider: 'server', ...(providerProfileId ? { provider_profile_id: providerProfileId } : {}) }, 'POST', project?.revision));
  const evaluateCritic = (generation: Generation) => runMutation('Critic', () => mutateV2(`/api/v2/workflow-generations/${encodeURIComponent(generation.id)}/critic`, {}, 'POST', generation.revision));
  const retryGeneration = (generation: Generation) => runMutation('Retry generation', () => mutateV2(`/api/v2/workflow-generations/${encodeURIComponent(generation.id)}/retry`, {}, 'POST', generation.revision));
  const cancelGeneration = (generation: Generation) => runMutation('Cancel generation', () => mutateV2(`/api/v2/workflow-generations/${encodeURIComponent(generation.id)}/cancel`, {}, 'POST', generation.revision));
  const applyProposal = (generation: Generation) => generation.proposal_id
    ? runMutation('Apply proposal', () => mutateV2(`/api/v2/workflow-proposals/${encodeURIComponent(generation.proposal_id || '')}/apply`, {}, 'POST', generation.revision))
    : Promise.resolve(null);
  const createRequirement = () => runMutation('Requirement', () => mutateOfflineV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/outcome-requirements`, { requirement_key: requirementKey.trim(), rubric: {}, workflow_revision: workflow?.current_revision || 0 }, 'POST', { command: 'outcome.requirement.create', scope: offlineScope, aggregateKey: `project:${selectedId}:outcome`, expectedRevision: project?.revision }));

  const currentGeneration = useMemo(() => generations[0] || null, [generations]);
  const workflowInitialView = /\/nodes?(?:\/|$)/.test(window.location.hash) ? 'nodes' : /\/workstreams?(?:\/|$)/.test(window.location.hash) ? 'workstreams' : 'canvas';
  const openProjectRoute = (target: 'workflow' | 'execution' | 'outcome' | 'delivery') => {
    if (navigateProject) navigateProject(selectedId, target);
    else navigate(target);
  };

  if (loadState === 'loading') return <div className="page-loader" data-testid="project-workflow-loading"><LoaderCircle className="spin" size={18} />正在加载项目工作区</div>;
  if (loadState === 'empty' || (!project && !selectedId)) return <div className="page project-workflow-page"><div className="page-heading"><div><p className="eyebrow">项目工作区</p><h1>项目</h1></div></div><div className="empty-state" data-testid="project-workflow-empty"><GitBranch size={30} /><h2>创建第一个项目</h2><form className="project-create-form" onSubmit={createProject}><label><span>项目名称</span><input aria-label="项目名称" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="项目名称" required /></label><label><span>项目说明</span><input aria-label="项目说明" value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="简短说明" /></label><button className="button primary" disabled={busy === 'Project'}><Plus size={15} />创建项目</button></form></div></div>;

  return <div className="page project-workflow-page">
    <div className="page-heading project-workflow-heading"><div><p className="eyebrow">项目工作区</p><h1>{project?.name || selectedProject?.name || '项目'}</h1><span className="mono project-id">{project?.id || selectedId}</span></div><div className="project-workflow-actions"><nav className="project-route-links" aria-label="项目工具"><button type="button" className={section === 'workflow' ? 'active' : ''} onClick={() => openProjectRoute('workflow')}>工作流</button><button type="button" onClick={() => openProjectRoute('execution')}>执行</button><button type="button" onClick={() => openProjectRoute('outcome')}>结果</button><button type="button" onClick={() => openProjectRoute('delivery')}>交付</button></nav><Status value={project?.status} /><button className="icon-button" title="刷新项目" aria-label="刷新项目" onClick={() => void loadProject()}><RefreshCw size={17} /></button></div></div>
    {conflict && <div className="state-banner conflict" data-testid="project-workflow-conflict"><AlertTriangle size={18} /><span>{conflict}</span><button className="button" onClick={() => void loadProject()}>重新加载</button></div>}
    <ErrorState state={loadState} message={message} onRetry={() => void loadProject()} />
    {operationId && <div className="operation-strip" data-testid="project-workflow-operation"><LoaderCircle className="spin" size={15} /><span>操作已排队</span><code>{operationId}</code><button className="icon-button" title="关闭操作提示" aria-label="关闭操作提示" onClick={() => setOperationId('')}><Check size={15} /></button></div>}
    <div className="project-workflow-tabs" role="tablist" aria-label="项目工作流视图">{sections.map((item) => <button key={item.id} role="tab" aria-selected={section === item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}>{item.label}</button>)}</div>

    {section === 'overview' && <div className="project-workflow-grid">
      <section className="panel"><PanelTitle title="项目状态" meta={`修订 ${project?.revision || 0}`} /><dl className="project-facts"><div><dt>团队</dt><dd className="mono">{project?.team_id || '由 ACL 解析'}</dd></div><div><dt>引导状态</dt><dd><Status value={project?.onboarding_state} /></dd></div><div><dt>Brief</dt><dd>r{project?.current_brief_revision || 0} {project?.confirmed_brief_revision ? `· 已确认 r${project.confirmed_brief_revision}` : ''}</dd></div><div><dt>Workflow</dt><dd>r{project?.current_workflow_revision || workflow?.current_revision || 0}</dd></div></dl><div className="project-edit-grid"><label><span>名称</span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><label><span>说明</span><input value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} /></label><button className="button" disabled={!projectName.trim() || busy === 'Project'} onClick={() => void updateProject()}><Save size={15} />保存</button></div></section>
      <section className="panel"><PanelTitle title="项目列表" meta={`${projects.length} 个可见项目`} action={<button className="button" onClick={() => setShowArchived((value) => !value)}>{showArchived ? '隐藏归档项目' : '显示归档项目'}</button>} /><div className="compact-list">{projects.map((item) => <div key={item.id} className={`compact-row ${item.id === selectedId ? 'selected' : ''}`}><span><strong>{item.name}</strong><small className="mono">{item.id} · r{item.revision}</small></span><Status value={item.status} /><div className="row-actions">{item.status === 'archived' ? <button className="icon-button" title="恢复项目" aria-label={`恢复项目 ${item.name}`} onClick={() => void restoreProject(item)}><RefreshCw size={14} /></button> : <button className="icon-button" title="归档项目" aria-label={`归档项目 ${item.name}`} onClick={() => void archiveProject(item)}><Square size={14} /></button>}</div></div>)}{!projects.length && <div className="list-empty">暂无可见项目</div>}</div></section>
      <section className="panel"><PanelTitle title="结果要求" meta={`${requirements.length} 条规则`} /><div className="compact-list">{requirements.map((item) => <div key={item.id} className="compact-row"><span><strong>{item.requirement_key}</strong><small>Workflow r{item.workflow_revision} · r{item.revision}</small></span></div>)}{!requirements.length && <div className="list-empty">暂无结果要求</div>}</div><form className="inline-form" onSubmit={(event) => { event.preventDefault(); void createRequirement(); }}><label><span>要求标识</span><input value={requirementKey} onChange={(event) => setRequirementKey(event.target.value)} placeholder="acceptance.core" required /></label><button className="button" disabled={busy === 'Requirement'}><Plus size={15} />添加</button></form></section>
    </div>}
    {section === 'overview' && <section className="panel project-lifecycle-panel"><PanelTitle title="项目生命周期" meta={project?.status === 'archived' ? '已归档项目可从项目列表恢复' : '归档项目或准备删除意图'} /><div className="form-actions"><button className="button" disabled={!project || project.status === 'archived' || Boolean(busy)} onClick={() => project && void archiveProject(project)}><Square size={15} />归档</button><button className="button" disabled={!project || project.status !== 'archived' || Boolean(busy)} onClick={() => project && void restoreProject(project)}><RefreshCw size={15} />恢复</button></div><div className="deletion-intent-form"><label><span>项目完整名称</span><input value={deletionName} onChange={(event) => setDeletionName(event.target.value)} placeholder={project?.name || '项目名称'} /></label><button className="button" disabled={!project || !deletionName.trim() || Boolean(busy)} onClick={() => void prepareDeletion()}><ShieldAlert size={15} />准备删除</button></div>{deletionIntent && <div className="deletion-intent-state"><Status value={deletionIntent.status} /><span>意图 {deletionIntent.id} · r{deletionIntent.revision}</span>{deletionIntent.blockers?.length ? <small>阻塞项：{deletionIntent.blockers.map((item) => item.domain).join('、')}</small> : null}<div className="form-actions">{deletionIntent.status === 'prepared' && <button className="button" onClick={() => void confirmDeletion()}><Check size={15} />确认</button>}{deletionIntent.status === 'ready' && <button className="button danger" onClick={() => void executeDeletion()}><ShieldAlert size={15} />执行</button>}</div></div>}</section>}

    {section === 'intake' && <section className="panel"><PanelTitle title="来源接入" meta={`修订 ${intake?.revision || 0} · 尝试 ${intake?.attempt || 0}`} /><div className="workflow-status-line"><Status value={intake?.status} />{intake?.error_code && <span className="fault-text"><CircleAlert size={14} />{errorCodeLabel(intake.error_code)}</span>}</div>{intake?.status === 'failed' && intake.error_code === 'source_drift' && <div className="state-banner error" data-testid="project-workflow-drift"><CircleAlert size={16} /><span>{message || '检测到源版本漂移，请对账后重试。'}</span></div>}<div className="segmented" role="group" aria-label="来源接入模式"><button className={intakeMode === 'brainstorm' ? 'active' : ''} onClick={() => setIntakeMode('brainstorm')}>从零构思</button><button className={intakeMode === 'existing' ? 'active' : ''} onClick={() => setIntakeMode('existing')}>已有来源</button></div>{intakeMode === 'existing' && <label><span>来源地址</span><input value={sourceLocator} onChange={(event) => setSourceLocator(event.target.value)} /></label>}<div className="form-actions"><button className="button primary" disabled={Boolean(busy) || ['processing', 'submitted'].includes(intake?.status || '')} onClick={() => void (intake?.status === 'failed' ? retryIntake() : submitIntake())}>{intake?.status === 'failed' ? <RotateCcw size={15} /> : <Play size={15} />}{intake?.status === 'failed' ? '重试接入' : '提交接入'}</button>{['processing', 'submitted'].includes(intake?.status || '') && <button className="button" disabled={Boolean(busy)} onClick={() => void cancelIntake()}><Square size={15} />取消</button>}</div></section>}

    {section === 'brief' && <section className="panel"><PanelTitle title="Brief 修订" meta={`项目修订 ${project?.revision || 0}`} /><label><span>目标</span><textarea rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="填写可衡量的目标" /></label><label><span>验收标准</span><textarea rows={4} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} placeholder="每行填写一条标准" /></label><div className="form-actions"><button className="button" disabled={!objective.trim() || Boolean(busy)} onClick={() => void saveBrief()}><Save size={15} />保存修订</button><button className="button primary" disabled={!brief || !(brief.current_revision || brief.current?.revision) || Boolean(busy)} onClick={() => void confirmBrief()}><Check size={15} />确认修订</button></div>{brief && <div className="revision-note"><span>当前修订</span><strong>r{brief.current_revision || brief.current?.revision || 0}</strong><Status value={brief.status} /></div>}</section>}

    {section === 'repository' && <div className="project-workflow-grid"><section className="panel"><PanelTitle title="代码仓库连接" meta={`${connections.length} 个连接`} /><div className="compact-list">{connections.map((connection) => <div className="compact-row" key={connection.id}><span><strong>{kindLabel(connection.provider || 'fixture')}</strong><small>{kindLabel(connection.source_kind)} · {connection.source_revision || '未版本化'} · r{connection.revision}</small></span><Status value={connection.status} /></div>)}{!connections.length && <div className="list-empty">暂无代码仓库连接</div>}</div><form className="inline-form" onSubmit={(event) => { event.preventDefault(); void connectRepository(); }}><label><span>来源地址</span><input value={repositoryLocator} onChange={(event) => setRepositoryLocator(event.target.value)} required /></label><button className="button primary" disabled={busy === 'Repository'}><GitBranch size={15} />连接代码仓库</button></form></section><section className="panel"><PanelTitle title="仓库分支" meta={`${lines.length} 条分支`} /><div className="compact-list">{lines.map((line) => <div className="compact-row" key={line.id}><span><strong>{line.id}</strong><small>{line.source_revision || '未知'} · r{line.revision}{line.fault_code ? ` · ${errorCodeLabel(line.fault_code)}` : ''}</small></span><Status value={line.status} /></div>)}{!lines.length && <div className="list-empty">连接仓库后显示分支</div>}</div></section><RepositoryDeletionPanel targets={targets} intent={repositoryDeletionIntent} name={repositoryDeletionName} head={repositoryDeletionHead} setName={setRepositoryDeletionName} setHead={setRepositoryDeletionHead} onPrepare={() => void prepareRepositoryDeletion()} onCreatorConfirm={() => void confirmRepositoryDeletion('creator')} onOwnerConfirm={() => void confirmRepositoryDeletion('owner')} onExecute={() => void executeRepositoryDeletion()} onReconcile={() => void reconcileRepositoryDeletion()} onCancel={() => void cancelRepositoryDeletion()} busy={busy} /></div>}

    {section === 'workflow' && <div className="project-workflow-grid"><section className="panel workflow-editor"><PanelTitle title="工作流草稿" meta={`修订 ${workflow?.revision || 0} · 图谱 ${workflow?.current?.graph_sha256?.slice(0, 10) || '未提交'}`} /><WorkflowWorkbench graph={(workflow?.current?.graph || {}) as Record<string, unknown>} initialView={workflowInitialView} onViewContext={() => navigateProject?.(selectedId, 'context')} onReplan={() => void startGeneration('replan')} /><label>Codex Profile ID<input aria-label="Codex Profile ID" value={providerProfileId} onChange={(event) => setProviderProfileId(event.target.value)} /></label><label className="workflow-json-editor"><span>图谱 JSON</span><textarea rows={7} value={workflowGraph} onChange={(event) => setWorkflowGraph(event.target.value)} spellCheck={false} /></label><div className="form-actions"><button className="button" disabled={Boolean(busy)} onClick={() => void reviseWorkflow()}><Save size={15} />保存草稿</button><button className="button primary" disabled={Boolean(busy)} onClick={() => void startGeneration()}><WorkflowIcon size={15} />生成候选</button></div></section><section className="panel"><PanelTitle title="生成与服务端 Critic" meta={`${generations.length} 次尝试`} /><div className="compact-list">{generations.map((generation) => <div className="compact-row" key={generation.id}><span><strong>{statusLabel(generation.phase)}</strong><small className="mono">{generation.id} · 第 {generation.attempt || 1} 次 · r{generation.revision}</small></span><Status value={generation.phase} /><div className="row-actions">{generation.phase === 'critic_pending' && <button className="icon-button" title="执行 Critic" aria-label={`执行 Critic ${generation.id}`} onClick={() => void evaluateCritic(generation)}><Check size={14} /></button>}{generation.phase === 'failed' && <button className="icon-button" title="重试生成" aria-label={`重试生成 ${generation.id}`} onClick={() => void retryGeneration(generation)}><RotateCcw size={14} /></button>}{['queued', 'running', 'critic_pending'].includes(generation.phase) && <button className="icon-button" title="取消生成" aria-label={`取消生成 ${generation.id}`} onClick={() => void cancelGeneration(generation)}><Square size={14} /></button>}{generation.proposal_id && generation.phase === 'proposed' && <button className="icon-button" title="应用提案" aria-label={`应用提案 ${generation.id}`} onClick={() => void applyProposal(generation)}><Check size={14} /></button>}</div>{generation.critic?.issues?.length ? <div className="critic-issues" data-testid={`critic-issues-${generation.id}`}>{generation.critic.issues.map((issue, index) => <span key={`${issue.code || 'issue'}-${index}`}>{issue.message || errorCodeLabel(issue.code || 'unknown')}{issue.node_id ? ` · ${issue.node_id}` : ''}</span>)}</div> : null}{generation.proposal && <div className="proposal-diff" data-testid={`proposal-diff-${generation.id}`}><strong>提案差异</strong><small>{statusLabel(generation.proposal.status || 'pending')} · {generation.proposal.proposal_hash || '等待哈希'}</small><pre tabIndex={0} role="region" aria-label="Workflow 提案 JSON">{JSON.stringify(generation.proposal.candidate || generation.candidate || {}, null, 2)}</pre></div>}</div>)}{!generations.length && <div className="list-empty">暂无生成尝试</div>}</div>{currentGeneration?.error_code && <div className="state-banner error"><AlertTriangle size={16} /><span>{errorCodeLabel(currentGeneration.error_code)}</span></div>}</section></div>}
  </div>;
}

export function ProjectPage(props: WorkspacePageProps) { return <ProjectWorkflowPage {...props} />; }
export function CleanWorkflowPage(props: WorkspacePageProps) { return <ProjectWorkflowPage {...props} />; }

export function RepositoryDeletionPanel({ targets, intent, name, head, setName, setHead, onPrepare, onCreatorConfirm, onOwnerConfirm, onExecute, onReconcile, onCancel, busy }: {
  targets: RepositoryTarget[];
  intent: RepositoryDeletionIntent | null;
  name: string;
  head: string;
  setName: (value: string) => void;
  setHead: (value: string) => void;
  onPrepare: () => void;
  onCreatorConfirm: () => void;
  onOwnerConfirm: () => void;
  onExecute: () => void;
  onReconcile: () => void;
  onCancel: () => void;
  busy: string;
}) {
  const target = targets[0];
  return <section className="panel repository-deletion-panel">
    <PanelTitle title="代码仓库删除" meta={target ? `目标修订 ${target.revision}` : '需要只读目标元数据'} />
    {!target ? <div className="list-empty">暂无可用的仓库目标</div> : <>
      <label><span>完整名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={target.source_locator || target.remote_ref || target.name || 'owner/repository'} /></label>
      <label><span>预期 HEAD</span><input className="mono" value={head} onChange={(event) => setHead(event.target.value)} placeholder={target.expected_head_sha || '提交 SHA'} /></label>
      {!intent && <button className="button danger" disabled={!name.trim() || !head.trim() || Boolean(busy)} onClick={onPrepare}><ShieldAlert size={15} />准备删除意图</button>}
      {intent && <div className="repository-deletion-state"><div className="workflow-status-line"><Status value={intent.status} /><span className="mono">{intent.id} · r{intent.revision}</span></div><small>远程删除需要两个相互独立的会话确认。</small><div className="form-actions">{intent.status === 'prepared' && <button className="button" disabled={Boolean(busy)} onClick={onCreatorConfirm}><Check size={14} />创建者确认</button>}{intent.status === 'creator_confirmed' && <button className="button" disabled={Boolean(busy)} onClick={onOwnerConfirm}><ShieldAlert size={14} />所有者确认</button>}{intent.status === 'ready' && <button className="button danger" disabled={Boolean(busy)} onClick={onExecute}><ShieldAlert size={14} />执行删除</button>}{['needs_reconcile', 'failed'].includes(intent.status) && <button className="button" disabled={Boolean(busy)} onClick={onReconcile}><RotateCcw size={14} />重新对账</button>}{!['completed', 'cancelled'].includes(intent.status) && <button className="icon-button" title="取消删除意图" aria-label="取消删除意图" disabled={Boolean(busy)} onClick={onCancel}><Square size={14} /></button>}</div>{intent.error_code && <div className="fault-text"><CircleAlert size={14} />{errorCodeLabel(intent.error_code)}</div>}</div>}
    </>}
  </section>;
}
