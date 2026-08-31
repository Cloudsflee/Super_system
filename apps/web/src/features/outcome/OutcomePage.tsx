import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, LoaderCircle, RefreshCw, Scale, ShieldAlert } from 'lucide-react';
import { ApiError, apiV2, mutateV2, shortHash } from '../../api';
import type { WorkspacePageProps } from '../../workspace';
import { statusLabel } from '../../i18n';

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
       await loadOutcome(); notify('结果评估已排队');
    } catch (caught) { report(caught); } finally { setBusy(false); }
  };
   function report(caught: unknown) { const message = caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : '结果请求失败'; setError(message); notify(message, 'error'); }

   if (!projectId) return <div className="empty-state"><Scale size={28} /><h2>请选择项目</h2><button className="button" onClick={() => navigate('projects')}>项目</button></div>;
  return <div className="page outcome-page-p9">
     <div className="page-heading"><div><p className="eyebrow">评估账本</p><h1>结果</h1></div><button className="icon-button" title="刷新结果" aria-label="刷新结果" onClick={() => void Promise.all([loadExecutions(), loadOutcome()])}><RefreshCw size={16} /></button></div>
    {error && <div className="state-banner error" role="alert"><ShieldAlert size={16} /><span>{error}</span></div>}
     <div className="workflow-commandbar"><label><span>执行</span><select value={executionId} onChange={(event) => setExecutionId(event.target.value)}>{executions.map((row) => <option value={row.id} key={row.id}>{shortHash(row.id)} · {statusLabel(row.status)}</option>)}</select></label><button className="button primary" disabled={!current || busy} onClick={() => void evaluate()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Scale size={15} />}评估</button></div>
     {loading ? <div className="page-loader"><LoaderCircle className="spin" />正在加载结果</div> : !current ? <div className="empty-state"><Scale size={28} /><h2>暂无执行记录</h2></div> : <div className="outcome-grid-p9">
       <section><div className="section-title"><div><h2>评估</h2><span>{evaluation ? `第 ${evaluation.generation} 代` : '尚未评估'}</span></div>{evaluation && <Status value={evaluation.status} />}</div>
         {evaluation ? <dl className="project-facts"><div><dt>要求</dt><dd>{evaluation.passed_count}/{evaluation.requirement_count}</dd></div><div><dt>评分</dt><dd>{evaluation.score}</dd></div><div><dt>摘要</dt><dd className="mono">{shortHash(evaluation.evaluation_sha256)}</dd></div><div><dt>豁免</dt><dd>{waivers.length}</dd></div></dl> : <p className="list-empty">暂无评估代</p>}
       </section>
       <section><div className="section-title"><div><h2>要求</h2><span>{evaluation?.evaluation?.results?.length || 0} 个结果</span></div><CheckCircle2 size={18} /></div>
         <div className="compact-list">{(evaluation?.evaluation?.results || []).map((row) => <div className="compact-row" key={row.requirement_key}><span><strong>{row.requirement_key}</strong><small>{statusLabel(row.waived ? 'waived' : row.blocked ? 'blocked' : row.passed ? 'passed' : 'failed')}</small></span><Status value={row.waived ? 'waived' : row.blocked ? 'blocked' : row.passed ? 'passed' : 'failed'} /></div>)}{!evaluation?.evaluation?.results?.length && <div className="list-empty">暂无要求结果</div>}</div>
      </section>
    </div>}
  </div>;
}

 function Status({ value }: { value: string }) { const tone = ['passed', 'verified', 'waived'].includes(value) ? 'positive' : ['queued', 'running'].includes(value) ? 'working' : ['blocked', 'failed'].includes(value) ? 'negative' : 'neutral'; return <span className={`status ${tone}`}><span />{statusLabel(value)}</span>; }
