import { Box, Check, KeyRound, Layers3 } from 'lucide-react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, json } from '../../api/client';
import { keys, useDeployment, useSetup } from '../../api/queries';
import { FullPageState } from '../../components/common/FullPageState';
import { GithubSetup } from './GithubSetup';
import { CodexSetup } from './CodexSetup';
import { OperationDiagnosticsButton } from '../../operations/OperationFeedback';
import { setupDetailLabel } from '../../components/common/display-labels';

export function SetupPage() {
  const setup = useSetup();
  const deployment = useDeployment();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [callbackError, setCallbackError] = useState('');
  const [busy, setBusy] = useState(false);
  const processedCallback = useRef('');
  useEffect(() => {
    const search = new URLSearchParams(location.search),
      code = search.get('code'),
      installationId = search.get('installation_id');
    const callbackKey = installationId
      ? `installation:${installationId}`
      : code
        ? `manifest:${code}:${search.get('state') || ''}`
        : '';
    if (callbackKey && processedCallback.current === callbackKey) return;
    if (callbackKey) processedCallback.current = callbackKey;
    if (installationId) {
      api('/github/installations/setup', json('POST', { installation_id: installationId }, '完成 GitHub App 安装回调'))
        .then(async () => {
          await client.invalidateQueries({ queryKey: keys.setup });
          navigate('/setup', { replace: true });
        })
        .catch((error) => setCallbackError(error.message));
      return;
    }
    if (!code) return;
    const state = search.get('state') || localStorage.getItem('aiws-github-manifest-state');
    api('/github/manifest/callback', json('POST', { code, state }, '完成 GitHub 应用清单回调'))
      .then(async () => {
        localStorage.removeItem('aiws-github-manifest-state');
        await client.invalidateQueries({ queryKey: keys.setup });
        navigate('/setup', { replace: true });
      })
      .catch((error) => setCallbackError(error.message));
  }, [location.search, client, navigate]);
  if (setup.isLoading) return <FullPageState title="正在读取配置" />;
  if (setup.isError || !setup.data)
    return <FullPageState title="无法读取配置" detail={setup.error?.message} retry={setup.refetch} />;
  if (setup.data.complete) return <Navigate to="/projects" replace />;
  const refresh = () => client.invalidateQueries({ queryKey: keys.setup });

  async function setMode(mode: 'hosted' | 'byo') {
    setBusy(true);
    setCallbackError('');
    try {
      await api('/setup/mode', json('PUT', { mode }, '更新运行模式'));
      await refresh();
    } catch (error) {
      setCallbackError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function finish() {
    setBusy(true);
    setCallbackError('');
    try {
      await api('/setup/complete', json('POST', undefined, '完成工作区配置'));
      await refresh();
      navigate((location.state as { from?: string } | null)?.from || '/', { replace: true });
    } catch (error) {
      setCallbackError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="setup-page">
      <aside className="setup-rail">
        <div className="setup-brand">
          <span>AW</span>
          <div>
            <strong>AI 工作空间</strong>
            <small>首次配置</small>
          </div>
        </div>
        <ol>
          <Step label="运行模式" done={Boolean(setup.data.mode)} active={!setup.data.mode} />
          <Step
            label="GitHub"
            done={setup.data.steps.github.ready}
            active={Boolean(setup.data.mode) && !setup.data.steps.github.ready}
          />
          <Step
            label="Codex"
            done={setup.data.steps.codex.ready}
            active={setup.data.steps.github.ready && !setup.data.steps.codex.ready}
          />
        </ol>
        <div className="setup-security">
          <KeyRound size={16} />
          <span>凭据保存在本地凭据库</span>
        </div>
      </aside>
      <section className="setup-main">
        <header className="setup-header">
          <div>
            <span className="overline">工作空间配置</span>
            <h1>连接工作环境</h1>
            <p>GitHub 与 Codex 验证完成后进入工作空间。</p>
          </div>
          <OperationDiagnosticsButton />
        </header>
        <section className="setup-section">
          <div className="section-title">
            <Box size={18} />
            <div>
              <h2>部署环境</h2>
              <p>
                {deployment.data?.mode === 'container' ? '容器 · Docker 数据卷 · 套接字执行器' : '主机开发 · 本地目录'}
              </p>
            </div>
            <span
              className={`status ${deployment.data?.storage?.ready && deployment.data?.docker?.ready ? 'ready' : 'pending'}`}
            >
              {deployment.data?.storage?.ready && deployment.data?.docker?.ready ? '已就绪' : '检查中'}
            </span>
          </div>
          {deployment.data?.mode === 'container' && (
            <div className="deployment-flags">
              <span>
                Codex 导入 <b>{deployment.data.imports.codex_home ? '可用' : '未挂载'}</b>
              </span>
              <span>
                cc-switch <b>{deployment.data.imports.cc_switch ? '可用' : '未挂载'}</b>
              </span>
              <span>
                项目导入根 <b>{deployment.data.imports.projects_root ? '相对路径' : '未配置'}</b>
              </span>
            </div>
          )}
        </section>
        <section className="setup-section">
          <div className="section-title">
            <Layers3 size={18} />
            <div>
              <h2>运行模式</h2>
              <p>选择 GitHub App 的所有权方式</p>
            </div>
          </div>
          <div className="segmented" role="group" aria-label="运行模式">
            <button
              disabled={busy}
              className={setup.data.mode === 'hosted' ? 'active' : ''}
              onClick={() => setMode('hosted')}
            >
              平台托管
            </button>
            <button
              disabled={busy}
              className={setup.data.mode === 'byo' ? 'active' : ''}
              onClick={() => setMode('byo')}
            >
              自有 GitHub App
            </button>
          </div>
        </section>
        {setup.data.mode && <GithubSetup mode={setup.data.mode} state={setup.data.steps.github} onChange={refresh} />}
        {setup.data.steps.github.ready && (
          <CodexSetup state={setup.data.steps.codex} onChange={refresh} deployment={deployment.data} />
        )}
        <footer className="setup-footer">
          <div>
            {callbackError && <span>{callbackError}</span>}
            {setup.data.reasons.map((reason) => (
              <span key={reason}>{setupDetailLabel(reason)}</span>
            ))}
          </div>
          <button className="button primary" disabled={busy || !setup.data.can_complete} onClick={finish}>
            <Check size={16} />
            完成配置
          </button>
        </footer>
      </section>
    </main>
  );
}

function Step({ label, done, active }: { label: string; done: boolean; active: boolean }) {
  return (
    <li className={active ? 'active' : ''}>
      <span>{done ? <Check size={13} /> : null}</span>
      <strong>{label}</strong>
    </li>
  );
}
