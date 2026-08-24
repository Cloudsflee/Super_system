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
      setFailure(error instanceof Error ? error.message : 'Setup request failed');
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
      notify(`Setup ${response.data?.replayed ? 'replayed' : 'completed'}`);
      await refreshSetup();
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      setFailure(apiError?.message || (error instanceof Error ? error.message : 'Setup failed'));
    } finally { setBusy(false); }
  };

  if (!state) return <div className="page-loader"><LoaderCircle className="spin" size={18} />Loading setup</div>;
  if (!state.needs_setup) return <div className="page clean-setup-page"><div className="page-heading"><div><p className="eyebrow">V3-Clean session</p><h1>Setup</h1></div><span className="status positive"><span /><Check size={13} />Ready</span></div><section className="panel setup-complete-panel"><ShieldCheck size={28} /><div><h2>Workspace is ready</h2><p className="muted-copy">The session proof is held by the browser cookie.</p></div></section></div>;
  return <div className="page clean-setup-page"><div className="page-heading"><div><p className="eyebrow">V3-Clean session</p><h1>Setup</h1><span className="muted-copy">Create the local owner and team.</span></div></div><section className="panel setup-form-panel"><form onSubmit={complete}><label><span>Display name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required /></label><label><span>Team name</span><input value={teamName} onChange={(event) => setTeamName(event.target.value)} required /></label>{failure && <div className="state-banner error" role="alert">{failure}</div>}<button className="button primary" disabled={busy || !displayName.trim() || !teamName.trim()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Complete setup</button></form></section></div>;
}
