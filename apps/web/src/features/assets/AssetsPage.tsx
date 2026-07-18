import { Boxes, Check, Filter, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, json } from '../../api/client';
import type { AssetRecord } from '../../api/types';
import { FullPageState } from '../../components/common/FullPageState';
import { useUi } from '../../state/ui';
import { useAssistSurface } from '../../components/assist/semantic-actions';

export function AssetsPage() {
  const projectId = useUi((state) => state.activeProjectId);
  const [status, setStatus] = useState('all');
  const [busy, setBusy] = useState('');
  const toast = useUi((state) => state.toast);
  useAssistSurface({ id: 'assets-page', filters: { 'assets.status': { label: '资产状态', elementId: 'assets-status-filter', values: ['all', 'candidate', 'confirmed', 'rejected', 'stale', 'disputed', 'superseded'], set: (value) => setStatus(String(value || 'all')) } } });
  const query = useQuery({ queryKey: ['assets', projectId], queryFn: () => api<AssetRecord[]>(`/assets${projectId ? `?project_id=${projectId}` : ''}`) });
  if (query.isLoading) return <FullPageState title="正在加载资产" />;
  if (query.isError) return <FullPageState title="资产加载失败" detail={query.error.message} retry={query.refetch} />;
  const rows = query.data?.filter((asset) => status === 'all' || asset.status === status) || [];
  async function decide(asset: AssetRecord, action: 'confirm' | 'reject') {
    setBusy(asset.id);
    try { await api(`/asset-candidates/${asset.id}/${action}`, json('POST', undefined, action === 'confirm' ? '确认资产' : '拒绝资产候选')); await query.refetch(); toast(action === 'confirm' ? '资产已确认' : '资产候选已拒绝'); } catch (error) { toast((error as Error).message, 'error'); } finally { setBusy(''); }
  }
  return (
    <section className="data-page"><header className="page-heading"><div><span className="overline">CONFIRMED KNOWLEDGE</span><h1>资产</h1><p>{rows.length} 项可追溯结果</p></div><label className="compact-filter"><Filter size={14} /><select id="assets-status-filter" value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">全部状态</option><option value="candidate">待确认</option><option value="confirmed">已确认</option><option value="rejected">已拒绝</option><option value="stale">已过期</option><option value="disputed">有争议</option><option value="superseded">已取代</option></select></label></header>
      <div className="data-table asset-table"><div className="data-head"><span>名称</span><span>类型</span><span>状态</span><span>更新时间</span><span>操作</span></div>{rows.map((asset) => <div className="data-row" key={asset.id}><span><Boxes size={16} /><strong>{asset.title}</strong></span><span>{asset.type || asset.asset_type}</span><span><i className={`status ${asset.status}`}>{asset.status}</i></span><time>{new Date(asset.updated_at).toLocaleString()}</time><span className="row-actions">{asset.status === 'candidate' ? <><button className="row-icon" aria-label={`拒绝 ${asset.title}`} disabled={busy === asset.id} onClick={() => decide(asset, 'reject')}><X size={15} /></button><button className="row-icon confirm" aria-label={`确认 ${asset.title}`} disabled={busy === asset.id} onClick={() => decide(asset, 'confirm')}><Check size={15} /></button></> : <small>—</small>}</span></div>)}</div>
      {!rows.length && <div className="quiet-empty"><Boxes size={25} /><p>当前筛选下没有资产</p></div>}
    </section>
  );
}
