import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitPullRequestDraft, LoaderCircle, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { ApiError, apiV2, mutateV2, shortHash } from '../../api';
import type { WorkspacePageProps } from '../../workspace';

type Policy = { id: string; name: string; status: string; revision: number; required_checks: string[] };
type Delivery = { id: string; status: string; revision: number; execution_id: string; branch_name?: string; target_head_sha?: string; error_code?: string };
type Execution = { id: string; status: string; revision: number; handoff_manifest?: { delivery_ready?: boolean } };

export function DeliveryPage({ projectId, notify, navigate }: WorkspacePageProps) {
  const [policies, setPolicies] = useState<Policy[]>([]); const [deliveries, setDeliveries] = useState<Delivery[]>([]); const [executions, setExecutions] = useState<Execution[]>([]);
  const [policyId, setPolicyId] = useState(''); const [executionId, setExecutionId] = useState(''); const [targetId, setTargetId] = useState(''); const [targetSha, setTargetSha] = useState('a'.repeat(40));
  const [policyName, setPolicyName] = useState('Protected main'); const [checks, setChecks] = useState('ci'); const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!projectId) return;
    const [policy, delivery, execution, connections] = await Promise.all([
      apiV2<{ policies: Policy[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/delivery-policies`),
      apiV2<{ deliveries: Delivery[] }>(`/api/v2/deliveries?project_id=${encodeURIComponent(projectId)}`),
      apiV2<{ executions: Execution[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/executions`),
      apiV2<{ connections: Array<{ id: string }> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/repository-connections`)
    ]);
    const targets = connections.data.connections[0] ? await apiV2<{ targets: Array<{ id: string; expected_head_sha?: string }> }>(`/api/v2/repository-connections/${encodeURIComponent(connections.data.connections[0].id)}/targets`) : null;
    setPolicies(policy.data.policies || []); setDeliveries(delivery.data.deliveries || []); setExecutions(execution.data.executions || []);
    setPolicyId((current) => policy.data.policies.some((row) => row.id === current) ? current : policy.data.policies[0]?.id || '');
    setExecutionId((current) => execution.data.executions.some((row) => row.id === current) ? current : execution.data.executions.find((row) => row.handoff_manifest?.delivery_ready)?.id || execution.data.executions[0]?.id || '');
    if (targets?.data.targets[0]) { setTargetId(targets.data.targets[0].id); setTargetSha(targets.data.targets[0].expected_head_sha || 'a'.repeat(40)); }
  }, [projectId]);
  useEffect(() => { void load().catch(report); }, [load]);
  const selectedExecution = useMemo(() => executions.find((row) => row.id === executionId), [executionId, executions]);
  const createPolicy = async () => run('policy', async () => { await mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/delivery-policies`, { name: policyName, required_checks: checks.split(',').map((item) => item.trim()).filter(Boolean), approval_policy: { merge: 'owner' } }, 'POST', 0); });
  const submit = async () => run('submit', async () => { await mutateV2('/api/v2/deliveries', { execution_id: executionId, policy_id: policyId, repository_target_id: targetId, target_head_sha: targetSha }, 'POST', selectedExecution?.revision); });
  const reconcile = async (delivery: Delivery) => run(`reconcile:${delivery.id}`, async () => { await mutateV2(`/api/v2/deliveries/${encodeURIComponent(delivery.id)}/reconcile`, {}, 'POST', delivery.revision); });
  async function run(key: string, action: () => Promise<void>) { setBusy(key); setError(''); try { await action(); await load(); notify('Delivery command accepted'); } catch (caught) { report(caught); } finally { setBusy(''); } }
  function report(caught: unknown) { const message = caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : 'Delivery request failed'; setError(message); notify(message, 'error'); }
  if (!projectId) return <div className="empty-state"><GitPullRequestDraft size={28} /><h2>Select a project</h2><button className="button" onClick={() => navigate('projects')}>Projects</button></div>;
  return <div className="page delivery-page-p9"><div className="page-heading"><div><p className="eyebrow">GitHub delivery</p><h1>Delivery</h1></div><button className="icon-button" title="Refresh Delivery" aria-label="Refresh Delivery" onClick={() => void load()}><RefreshCw size={16} /></button></div>
    {error && <div className="state-banner error" role="alert"><ShieldAlert size={16} /><span>{error}</span></div>}
    <div className="delivery-controls-p9"><section><div className="section-title"><div><h2>Policy</h2><span>{policies.length} policies</span></div></div><label><span>Name</span><input value={policyName} onChange={(event) => setPolicyName(event.target.value)} /></label><label><span>Required checks</span><input value={checks} onChange={(event) => setChecks(event.target.value)} /></label><button className="button" disabled={busy === 'policy'} onClick={() => void createPolicy()}><Plus size={15} />Create policy</button></section>
      <section><div className="section-title"><div><h2>Submit</h2><span>Delivery-ready handoff</span></div></div><label><span>Execution</span><select value={executionId} onChange={(event) => setExecutionId(event.target.value)}>{executions.map((row) => <option key={row.id} value={row.id}>{shortHash(row.id)} · {row.status}</option>)}</select></label><label><span>Policy</span><select value={policyId} onChange={(event) => setPolicyId(event.target.value)}>{policies.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><button className="button primary" disabled={!executionId || !policyId || !targetId || busy === 'submit'} onClick={() => void submit()}>{busy === 'submit' ? <LoaderCircle className="spin" size={15} /> : <GitPullRequestDraft size={15} />}Submit</button></section>
    </div><section className="delivery-list-p9"><div className="section-title"><div><h2>Deliveries</h2><span>{deliveries.length} records</span></div></div>{deliveries.map((row) => <div className="operation-row-p8" key={row.id}><span><strong>{row.branch_name || shortHash(row.id)}</strong><small>{row.status === 'needs_reconcile' ? 'External result unknown' : shortHash(row.target_head_sha || row.execution_id)}</small></span><div className="operation-row-tail-p8"><Status value={row.status} />{row.status === 'needs_reconcile' && <button className="button" disabled={busy === `reconcile:${row.id}`} onClick={() => void reconcile(row)}>Reconcile</button>}</div></div>)}{!deliveries.length && <p className="list-empty">No deliveries</p>}</section>
  </div>;
}
function Status({ value }: { value: string }) { const tone = ['merged', 'ready', 'draft_pr'].includes(value) ? 'positive' : ['queued', 'running'].includes(value) ? 'working' : ['failed', 'needs_reconcile'].includes(value) ? 'negative' : 'neutral'; return <span className={`status ${tone}`}><span />{value.replaceAll('_', ' ')}</span>; }
