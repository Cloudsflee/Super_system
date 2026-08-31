import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, Check, GitPullRequestDraft, LoaderCircle, Play, RefreshCw, RotateCcw, ServerCog, ShieldAlert, Trash2 } from 'lucide-react';
import { apiV2, mutateV2, shortHash } from '../../api';
import type { WorkspacePageProps } from '../../workspace';
import { commandLabel, errorCodeLabel, kindLabel, statusLabel } from '../../i18n';

type Delivery = { id: string; branch_name: string; status: string; target_head_sha: string; revision: number; updated_at?: string };
type Operation = { operation_id: string; command_id: string; status: string; revision: number; error_code?: string; parent_operation_id?: string | null; reconciliation_state?: string };
type ImportBatch = { id: string; status: string; revision: number; target_sha256?: string; conflict_count?: number };
type Candidate = { id: string; status: string; revision: number; app_digest: string; candidate_sha256: string };
type Backup = { id: string; source_user_version: number; manifest_sha256: string; retention_class: string; created_at: string };
type GcPlan = { count: number; plan_sha256: string; candidates: string[] };
type Interaction = { id: string; action?: string; question?: string; status?: string; decision?: string; operation_id?: string; revision: number };

const NON_REPLAYABLE = new Set(['delivery.intent.merge', 'backup.create', 'restore.prepare', 'system.reset.prepare', 'import.cutover', 'cas.gc.apply']);

export function OperationsPage({ projectId, notify }: WorkspacePageProps) {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [imports, setImports] = useState<ImportBatch[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [approvals, setApprovals] = useState<Interaction[]>([]);
  const [inputs, setInputs] = useState<Interaction[]>([]);
  const [health, setHealth] = useState('unknown');
  const [gcPlan, setGcPlan] = useState<GcPlan | null>(null);
  const [targetVolumeRef, setTargetVolumeRef] = useState('isolated-runtime');
  const [preserveBackups, setPreserveBackups] = useState(true);
  const [fault, setFault] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [delivery, operation, batches, deployment, backup, approval, input, ready] = await Promise.all([
        apiV2<{ deliveries: Delivery[] }>(`/api/v2/deliveries?project_id=${encodeURIComponent(projectId)}`),
        apiV2<{ operations: Operation[] }>(`/api/v2/operations?project_id=${encodeURIComponent(projectId)}`),
        apiV2<{ imports: ImportBatch[] }>('/api/v2/imports'),
        apiV2<{ active: Candidate | null; candidates: Candidate[] }>('/api/v2/system/deployment'),
        apiV2<{ backups: Backup[] }>('/api/v2/backups'),
        apiV2<{ approvals: Interaction[] }>(`/api/v2/approvals?project_id=${encodeURIComponent(projectId)}`),
        apiV2<{ inputs: Interaction[] }>(`/api/v2/user-inputs?project_id=${encodeURIComponent(projectId)}`),
        fetch('/readyz', { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) }))
      ]);
      setDeliveries(delivery.data.deliveries || []);
      setOperations(operation.data.operations || []);
      setImports(batches.data.imports || []);
      setCandidates(deployment.data.candidates || []);
      setBackups(backup.data.backups || []);
      setApprovals(approval.data.approvals || []);
      setInputs(input.data.inputs || []);
      setHealth(ready.ok && String((ready.body as { data?: { status?: string } }).data?.status || '') === 'ready' ? 'ready' : 'failed');
      setFault('');
    } catch (error) {
       const message = error instanceof Error ? error.message : '运维请求失败';
      setFault(message);
      notify(message, 'error');
    } finally { setLoading(false); }
  }, [notify, projectId]);

  useEffect(() => { void load(); }, [load]);

  const reconcile = async (delivery: Delivery) => run(`delivery:${delivery.id}`, async () => {
    await mutateV2(`/api/v2/deliveries/${encodeURIComponent(delivery.id)}/reconcile`, {}, 'POST', { expectedRevision: delivery.revision });
     notify('交付对账已完成');
    await load();
  });

  const replay = async (operation: Operation) => run(`operation:${operation.operation_id}`, async () => {
    await mutateV2(`/api/v2/operations/${encodeURIComponent(operation.operation_id)}/replay`, {}, 'POST', { expectedRevision: operation.revision });
     notify('操作重放已排队');
    await load();
  });

  const planGc = async () => run('gc', async () => {
    const response = await mutateV2<{ plan: GcPlan }>('/api/v2/cas/gc/plan', { limit: 1000 }, 'POST', { expectedRevision: 0 });
    setGcPlan(response.data.plan);
     notify('CAS GC 计划已创建');
  });

  const approved = (action: string, requestMatch?: (value: Interaction) => boolean) => approvals.find((item) => item.action === action && (item.decision || item.status) === 'approved' && (!requestMatch || requestMatch(item)));
  const createBackup = async () => run('backup-create', async () => {
    const approval = approved('backup.create');
     if (!approval) throw new Error('需要已批准的 backup.create 请求');
    await mutateV2('/api/v2/backups', { approval_id: approval.id, retention_class: 'standard', components: {} }, 'POST', 0);
    await load();
  });
  const prepareRestore = async (backup: Backup) => run(`restore:${backup.id}`, async () => {
    const approval = approved('restore.prepare', (item) => String((item as Interaction & { request?: { backup_id?: string } }).request?.backup_id || '') === backup.id) || approved('restore.prepare');
     if (!approval) throw new Error('需要已批准的 restore.prepare 请求');
    await mutateV2('/api/v2/restore/prepare', { backup_id: backup.id, approval_id: approval.id, target_volume_ref: targetVolumeRef }, 'POST', 0);
    await load();
  });
  const prepareReset = async () => run('reset', async () => {
    const approval = approved('system.reset.prepare');
     if (!approval) throw new Error('需要已批准的 system.reset.prepare 请求');
    await mutateV2('/api/v2/system/reset/prepare', { approval_id: approval.id, target_volume_ref: targetVolumeRef, preserve_backups: preserveBackups }, 'POST', 0);
    await load();
  });
  const applyGc = async () => run('gc-apply', async () => {
    if (!gcPlan) return;
    const approval = approved('cas.gc.apply');
     if (!approval) throw new Error('需要已批准的 cas.gc.apply 请求');
    await mutateV2('/api/v2/cas/gc/apply', { approval_id: approval.id, plan: gcPlan }, 'POST', 0);
    await load();
  });

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try { await action(); }
       catch (error) { const message = error instanceof Error ? error.message : '操作失败'; setFault(message); notify(message, 'error'); }
    finally { setBusy(''); }
  };

   if (!projectId) return <div className="empty-state"><ServerCog size={26} /><h2>未选择项目</h2></div>;

  return <div className="page operations-page-p8">
    <div className="page-heading operations-heading-p8">
       <div><p className="eyebrow">运行时控制</p><h1>运维</h1></div>
       <button className="icon-button" aria-label="刷新运维" title="刷新运维" disabled={loading} onClick={() => void load()}>{loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button>
    </div>
    {fault && <div className="execution-fault" role="alert"><ShieldAlert size={16} /><span>{fault}</span></div>}
     <div className="operations-summary-p8" aria-label="运维概览">
       <Metric label="交付" value={deliveries.length} />
       <Metric label="活跃操作" value={operations.filter((item) => ['accepted', 'queued', 'running', 'paused'].includes(item.status)).length} />
       <Metric label="候选" value={candidates.length} />
       <Metric label="备份" value={backups.length} />
       <Metric label="导入批次" value={imports.length} />
       <Metric label="人工队列" value={approvals.filter((item) => (item.decision || item.status) === 'pending').length + inputs.filter((item) => item.status === 'pending').length} />
    </div>
    <div className="operations-grid-p8">
       <section aria-labelledby="delivery-heading"><SectionHeading id="delivery-heading" title="交付" icon={<GitPullRequestDraft size={18} />} />
         {deliveries.map((item) => <Row key={item.id} title={item.branch_name} detail={item.status === 'needs_reconcile' ? '外部结果未知' : shortHash(item.target_head_sha)} status={item.status} action={item.status === 'needs_reconcile' ? <IconAction label="对账交付" busy={busy === `delivery:${item.id}`} icon={<RefreshCw size={15} />} onClick={() => void reconcile(item)} /> : null} />)}
         {!loading && !deliveries.length && <p className="list-empty">暂无交付</p>}
       </section>
       <section aria-labelledby="deployment-heading"><SectionHeading id="deployment-heading" title="部署" icon={<ServerCog size={18} />} />
         {candidates.map((item) => <Row key={item.id} title={shortHash(item.app_digest)} detail={shortHash(item.candidate_sha256)} status={item.status} />)}
         {!loading && !candidates.length && <p className="list-empty">暂无候选</p>}
       </section>
       <section aria-labelledby="backup-heading"><SectionHeading id="backup-heading" title="备份与恢复" icon={<ArchiveRestore size={18} />} action={<div className="row-actions"><IconAction label="创建备份" busy={busy === 'backup-create'} icon={<ArchiveRestore size={15} />} onClick={() => void createBackup()} /><IconAction label="准备重置" busy={busy === 'reset'} icon={<RotateCcw size={15} />} onClick={() => void prepareReset()} /></div>} />
         <div className="operations-recovery-form"><label><span>目标卷引用</span><input value={targetVolumeRef} onChange={(event) => setTargetVolumeRef(event.target.value)} pattern="[A-Za-z][A-Za-z0-9._~-]{0,255}" maxLength={256} /></label><label className="checkbox-line"><input type="checkbox" checked={preserveBackups} onChange={(event) => setPreserveBackups(event.target.checked)} /><span>保留备份</span></label></div>
         {backups.map((item) => <Row key={item.id} title={shortHash(item.manifest_sha256)} detail={`schema v${item.source_user_version} · ${kindLabel(item.retention_class)}`} status="verified" action={<IconAction label={`准备恢复 ${shortHash(item.id)}`} busy={busy === `restore:${item.id}`} icon={<ArchiveRestore size={15} />} onClick={() => void prepareRestore(item)} />} />)}
         {!loading && !backups.length && <p className="list-empty">暂无备份</p>}
       </section>
       <section aria-labelledby="operation-heading"><SectionHeading id="operation-heading" title="操作溯源" icon={<RotateCcw size={18} />} />
         {operations.map((item) => <Row key={item.operation_id} title={commandLabel(item.command_id)} detail={item.error_code ? errorCodeLabel(item.error_code) : (item.parent_operation_id ? `重试自 ${shortHash(item.parent_operation_id)}` : item.reconciliation_state === 'unknown' ? '外部结果未知' : shortHash(item.operation_id))} status={item.status} action={item.status === 'failed' && !NON_REPLAYABLE.has(item.command_id) ? <IconAction label="重放操作" busy={busy === `operation:${item.operation_id}`} icon={<Play size={15} />} onClick={() => void replay(item)} /> : null} />)}
         {!loading && !operations.length && <p className="list-empty">暂无操作</p>}
       </section>
       <section aria-labelledby="import-heading"><SectionHeading id="import-heading" title="导入批次" />
         {imports.map((item) => <Row key={item.id} title={shortHash(item.target_sha256 || item.id)} detail={item.status === 'blocked' ? `导入已阻塞 · ${item.conflict_count || 0} 个冲突` : `修订 ${item.revision}`} status={item.status} />)}
         {!loading && !imports.length && <p className="list-empty">暂无导入批次</p>}
       </section>
       <section aria-labelledby="gc-heading"><SectionHeading id="gc-heading" title="CAS GC" icon={<Trash2 size={18} />} action={<div className="row-actions"><IconAction label="创建 GC 计划" busy={busy === 'gc'} icon={<Play size={15} />} onClick={() => void planGc()} />{gcPlan && <IconAction label="应用 GC 计划" busy={busy === 'gc-apply'} icon={<Check size={15} />} onClick={() => void applyGc()} />}</div>} />
         {gcPlan ? <Row title={shortHash(gcPlan.plan_sha256)} detail={`${gcPlan.count} 个候选`} status="planned" /> : <p className="list-empty">暂无活动计划</p>}
       </section>
       <section aria-labelledby="human-heading"><SectionHeading id="human-heading" title="人工队列" icon={<ShieldAlert size={18} />} />
         {approvals.map((item) => <Row key={item.id} title={commandLabel(item.action || 'Approval')} detail={item.operation_id ? `操作 ${shortHash(item.operation_id)}` : `修订 ${item.revision}`} status={item.decision || item.status || 'pending'} />)}
         {inputs.map((item) => <Row key={item.id} title={item.question || '人工输入'} detail={item.operation_id ? `操作 ${shortHash(item.operation_id)}` : `修订 ${item.revision}`} status={item.status || 'pending'} />)}
         {!loading && !approvals.length && !inputs.length && <p className="list-empty">暂无待处理交互</p>}
       </section>
       <section aria-labelledby="health-heading"><SectionHeading id="health-heading" title="健康状态" icon={<ServerCog size={18} />} />
         <Row title="系统运行时" detail={health === 'ready' ? '数据结构与依赖已就绪' : '健康检查失败'} status={health} />
      </section>
    </div>
  </div>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function SectionHeading({ id, title, icon, action }: { id: string; title: string; icon?: React.ReactNode; action?: React.ReactNode }) { return <div className="section-title"><div>{icon}<h2 id={id}>{title}</h2></div>{action}</div>; }
function Row({ title, detail, status, action }: { title: string; detail: string; status: string; action?: React.ReactNode }) { return <div className="operation-row-p8"><span><strong>{title}</strong><small>{detail}</small></span><div className="operation-row-tail-p8"><Status value={status} />{action}</div></div>; }
function IconAction({ label, icon, busy, onClick }: { label: string; icon: React.ReactNode; busy: boolean; onClick: () => void }) { return <button className="icon-button compact-icon-p8" aria-label={label} title={label} disabled={busy} onClick={onClick}>{busy ? <LoaderCircle className="spin" size={15} /> : icon}</button>; }
function Status({ value }: { value: string }) { const tone = ['merged', 'verified', 'passed', 'ready', 'sealed', 'succeeded'].includes(value) ? 'positive' : ['accepted', 'queued', 'running', 'candidate', 'planned', 'verifying'].includes(value) ? 'working' : ['failed', 'blocked', 'needs_reconcile', 'unknown'].includes(value) ? 'negative' : 'neutral'; return <span className={`status ${tone}`}><span />{statusLabel(value)}</span>; }
