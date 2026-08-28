import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, LoaderCircle, RefreshCw, Scale, ShieldAlert } from 'lucide-react';
import { ApiError, apiV2, mutateV2, shortHash } from '../../api';
import type { WorkspacePageProps } from '../../workspace';

type Execution = { id: string; status: string; revision: number; current_stage?: string };
type Evaluation = { id: string; generation: number; status: string; requirement_count: number; passed_count: number; score: number; evaluation_sha256: string; evaluation?: { results?: Array<{ requirement_key: string; passed: boolean; blocked: boolean; waived: boolean }> } };
type Waiver = { id: string; requirement_id?: string | null; action: string; reason: string; revision: number };

export function OutcomePage({ projectId, notify, navigate }: WorkspacePageProps) {
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [executionId, setExecutionId] = useState('');
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [waivers, setWaivers] = useState<Waiver[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadExecutions = useCallback(async () => {
    if (!projectId) { setExecutions([]); return; }
    const response = await apiV2<{ executions: Execution[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/executions`);
    const rows = response.data.executions || [];
    setExecutions(rows);
    setExecutionId((current) => rows.some((row) => row.id === current) ? current : rows[0]?.id || '');
  }, [projectId]);

  const loadOutcome = useCallback(async () => {
    if (!executionId) { setEvaluation(null); setWaivers([]); return; }
    const response = await apiV2<{ evaluation: Evaluation | null; waivers: Waiver[] }>(`/api/v2/executions/${encodeURIComponent(executionId)}/outcome`);
    setEvaluation(response.data.evaluation || null); setWaivers(response.data.waivers || []);
  }, [executionId]);

  useEffect(() => { setLoading(true); void loadExecutions().catch(report).finally(() => setLoading(false)); }, [loadExecutions]);
  useEffect(() => { void loadOutcome().catch(report); }, [loadOutcome]);

  const current = useMemo(() => executions.find((row) => row.id === executionId) || null, [executionId, executions]);
  const evaluate = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await mutateV2(`/api/v2/executions/${encodeURIComponent(current.id)}/outcome/evaluate`, {}, 'POST', current.revision);
      await loadOutcome(); notify('Outcome evaluation queued');
    } catch (caught) { report(caught); } finally { setBusy(false); }
  };
  function report(caught: unknown) { const message = caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : 'Outcome request failed'; setError(message); notify(message, 'error'); }

  if (!projectId) return <div className="empty-state"><Scale size={28} /><h2>Select a project</h2><button className="button" onClick={() => navigate('projects')}>Projects</button></div>;
  return <div className="page outcome-page-p9">
    <div className="page-heading"><div><p className="eyebrow">Evaluation ledger</p><h1>Outcome</h1></div><button className="icon-button" title="Refresh Outcome" aria-label="Refresh Outcome" onClick={() => void Promise.all([loadExecutions(), loadOutcome()])}><RefreshCw size={16} /></button></div>
    {error && <div className="state-banner error" role="alert"><ShieldAlert size={16} /><span>{error}</span></div>}
    <div className="workflow-commandbar"><label><span>Execution</span><select value={executionId} onChange={(event) => setExecutionId(event.target.value)}>{executions.map((row) => <option value={row.id} key={row.id}>{shortHash(row.id)} · {row.status}</option>)}</select></label><button className="button primary" disabled={!current || busy} onClick={() => void evaluate()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Scale size={15} />}Evaluate</button></div>
    {loading ? <div className="page-loader"><LoaderCircle className="spin" />Loading Outcome</div> : !current ? <div className="empty-state"><Scale size={28} /><h2>No executions</h2></div> : <div className="outcome-grid-p9">
      <section><div className="section-title"><div><h2>Evaluation</h2><span>{evaluation ? `generation ${evaluation.generation}` : 'not evaluated'}</span></div>{evaluation && <Status value={evaluation.status} />}</div>
        {evaluation ? <dl className="project-facts"><div><dt>Requirements</dt><dd>{evaluation.passed_count}/{evaluation.requirement_count}</dd></div><div><dt>Score</dt><dd>{evaluation.score}</dd></div><div><dt>Digest</dt><dd className="mono">{shortHash(evaluation.evaluation_sha256)}</dd></div><div><dt>Waivers</dt><dd>{waivers.length}</dd></div></dl> : <p className="list-empty">No evaluation generation</p>}
      </section>
      <section><div className="section-title"><div><h2>Requirements</h2><span>{evaluation?.evaluation?.results?.length || 0} results</span></div><CheckCircle2 size={18} /></div>
        <div className="compact-list">{(evaluation?.evaluation?.results || []).map((row) => <div className="compact-row" key={row.requirement_key}><span><strong>{row.requirement_key}</strong><small>{row.waived ? 'waived' : row.blocked ? 'blocked' : row.passed ? 'passed' : 'failed'}</small></span><Status value={row.waived ? 'waived' : row.blocked ? 'blocked' : row.passed ? 'passed' : 'failed'} /></div>)}{!evaluation?.evaluation?.results?.length && <div className="list-empty">No requirement results</div>}</div>
      </section>
    </div>}
  </div>;
}

function Status({ value }: { value: string }) { const tone = ['passed', 'verified', 'waived'].includes(value) ? 'positive' : ['queued', 'running'].includes(value) ? 'working' : ['blocked', 'failed'].includes(value) ? 'negative' : 'neutral'; return <span className={`status ${tone}`}><span />{value}</span>; }
