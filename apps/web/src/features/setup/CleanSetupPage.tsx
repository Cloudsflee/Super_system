import { useEffect, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, ShieldCheck } from 'lucide-react';
import { ApiError, apiV2, mutateV2 } from '../../api';
import type { WorkspacePageProps } from '../../workspace';

type CleanSetupState = { needs_setup: boolean; actor_count: number; bootstrap_actor_id?: string };

export function CleanSetupPage({ refreshSetup, notify }: WorkspacePageProps) {
  const [state, setState] = useState<CleanSetupState | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [teamName, setTeamName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  const load = async () => {
    try {
      const response = await apiV2<CleanSetupState>('/api/v2/setup');
      setState(response.data);
      setFailure('');
    } catch (error) {
       setFailure(error instanceof Error ? error.message : '系统配置请求失败');
    }
  };
  useEffect(() => { void load(); }, []);

  const complete = async (event: FormEvent) => {
    event.preventDefault();
    if (!displayName.trim() || !teamName.trim()) return;
    setBusy(true);
    setFailure('');
    try {
      const response = await mutateV2<{ replayed?: boolean }>('/api/v2/setup', { display_name: displayName.trim(), team_name: teamName.trim(), expected_revision: 0 }, 'POST', 0);
      setState({ needs_setup: false, actor_count: 1 });
       notify(response.data?.replayed ? '系统配置已重放' : '系统配置已完成');
      await refreshSetup();
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
       setFailure(apiError?.message || (error instanceof Error ? error.message : '系统配置失败'));
    } finally { setBusy(false); }
  };

  if (!state) return <div className="page-loader"><LoaderCircle className="spin" size={18} />正在加载系统配置</div>;
  if (!state.needs_setup) return <div className="page clean-setup-page"><div className="page-heading"><div><p className="eyebrow">本地会话</p><h1>系统配置</h1></div><span className="status positive"><span /><Check size={13} />已就绪</span></div><section className="panel setup-complete-panel"><ShieldCheck size={28} /><div><h2>工作区已就绪</h2><p className="muted-copy">会话凭证由浏览器 Cookie 持有。</p></div></section></div>;
  return <div className="page clean-setup-page"><div className="page-heading"><div><p className="eyebrow">本地会话</p><h1>系统配置</h1><span className="muted-copy">创建本地所有者与团队。</span></div></div><section className="panel setup-form-panel"><form onSubmit={complete}><label><span>显示名称</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required /></label><label><span>团队名称</span><input value={teamName} onChange={(event) => setTeamName(event.target.value)} required /></label>{failure && <div className="state-banner error" role="alert">{failure}</div>}<button className="button primary" disabled={busy || !displayName.trim() || !teamName.trim()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}完成配置</button></form></section></div>;
}
