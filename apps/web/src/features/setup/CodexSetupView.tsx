import { Box, Check, Cpu, LoaderCircle, Play } from 'lucide-react';
import { displayStatus, setupDetailLabel } from '../../components/common/display-labels';
import { CodexBuildProgress } from './CodexBuildProgress';
import { CodexConnectionSetup } from './CodexConnectionSetup';
import { CodexProfileForm } from './CodexProfileForm';
import type { CodexSetupViewModel } from './CodexSetup';

export function CodexSetupView({ model }: { model: CodexSetupViewModel }) {
  const { state } = model;
  return (
    <section className="setup-section">
      <div className="section-title">
        <Cpu size={18} />
        <div>
          <h2>Codex</h2>
          <p>{setupDetailLabel(state.detail) || '等待运行环境验证'}</p>
        </div>
        <span className={`status ${state.ready ? 'ready' : 'pending'}`}>
          {state.ready && <Check size={12} />}
          {displayStatus(state.status)}
        </span>
      </div>
      <CodexRuntimeStage model={model} />
      <CodexConnectionStage model={model} />
      <CodexProfileStage model={model} />
      <CodexProbeStage model={model} />
      <CodexSetupFeedback model={model} />
    </section>
  );
}

function CodexRuntimeStage({ model }: { model: CodexSetupViewModel }) {
  const { deployment, checks, feedback, build } = model;
  return (
    <>
      {!checks.docker_ready && (
        <div className="setup-row">
          <div>
            <strong>Docker 运行环境</strong>
            <span>{deployment?.mode === 'container' ? '预构建执行器镜像当前不可用' : '隔离执行器镜像'}</span>
          </div>
          {deployment?.mode === 'container' ? (
            <span className="status failed">
              <Box size={13} />
              需要重新部署
            </span>
          ) : !build.buildOperation ? (
            <button className="button primary" disabled={feedback.busy} onClick={build.build}>
              <Box size={15} />
              检测并构建
            </button>
          ) : null}
        </div>
      )}
      {build.buildOperation && (
        <CodexBuildProgress
          operation={build.buildOperation}
          connection={build.buildConnection}
          busy={feedback.busy}
          onCancel={build.cancelBuild}
          onCopy={build.copyBuildDiagnostics}
          onRetry={build.build}
        />
      )}
    </>
  );
}

function CodexConnectionStage({ model }: { model: CodexSetupViewModel }) {
  const { checks, deployment, feedback, connection } = model;
  if (checks.authenticated && !connection.needsProfileRepair) return null;
  return (
    <CodexConnectionSetup
      mode={connection.connectionMode}
      runtimeReady={Boolean(checks.docker_ready)}
      repairing={connection.needsProfileRepair}
      busy={feedback.busy}
      sourceAvailability={{
        codex_home: deployment?.mode !== 'container' || deployment.imports.codex_home,
        cc_switch: deployment?.mode !== 'container' || deployment.imports.cc_switch
      }}
      providerChoice={connection.providerChoice}
      customProvider={connection.customProvider}
      baseUrl={connection.baseUrl}
      wireApi={connection.wireApi}
      apiKey={connection.apiKey}
      providerValid={connection.providerValid}
      endpointValid={connection.endpointValid}
      deviceAuth={connection.deviceAuth}
      discovery={connection.discovery}
      onMode={connection.setConnectionMode}
      onProvider={connection.selectProvider}
      onCustomProvider={connection.setCustomProvider}
      onBaseUrl={connection.setBaseUrl}
      onWireApi={connection.setWireApi}
      onApiKey={connection.setApiKey}
      onDevice={connection.device}
      onAuthenticate={connection.authenticate}
      onDiscoveryRefresh={connection.discovery.refresh}
      onDiscoveryImport={connection.discovery.importConfig}
    />
  );
}

function CodexProfileStage({ model }: { model: CodexSetupViewModel }) {
  const { state, checks, feedback, connection, profile } = model;
  if (!checks.authenticated || checks.profile_valid || (state.profile_id && !connection.needsProfileRepair))
    return null;
  return (
    <CodexProfileForm
      repair={connection.needsProfileRepair}
      thirdParty={profile.thirdParty}
      busy={feedback.busy}
      valid={
        profile.authMetadataReady &&
        profile.profileInputValid &&
        (!profile.repairNeedsKey || Boolean(profile.repairApiKey))
      }
      providerChoice={connection.providerChoice}
      customProvider={connection.customProvider}
      baseUrl={connection.baseUrl}
      wireApi={connection.wireApi}
      model={profile.model}
      timeoutMinutes={profile.timeoutMinutes}
      repairNeedsKey={profile.repairNeedsKey}
      repairApiKey={profile.repairApiKey}
      onProvider={connection.selectProvider}
      onCustomProvider={connection.setCustomProvider}
      onBaseUrl={connection.setBaseUrl}
      onWireApi={connection.setWireApi}
      onModel={profile.setModel}
      onTimeoutMinutes={profile.setTimeoutMinutes}
      onRepairApiKey={profile.setRepairApiKey}
      onCreate={profile.createProfile}
      onRepair={profile.repairProfile}
    />
  );
}

function CodexProbeStage({ model }: { model: CodexSetupViewModel }) {
  if (!model.checks.docker_ready || !model.checks.profile_valid || model.checks.probe_ok) return null;
  return (
    <div className="setup-row">
      <div>
        <strong>非写入探针</strong>
        <span>验证当前 Codex 配置、接口地址与隔离挂载</span>
      </div>
      <button className="button primary" disabled={model.feedback.busy} onClick={model.probe}>
        <Play size={15} />
        运行探针
      </button>
    </div>
  );
}

function CodexSetupFeedback({ model }: { model: CodexSetupViewModel }) {
  const { busy, error, errorAction, probeReport } = model.feedback;
  return (
    <>
      {busy && (
        <div className="inline-busy">
          <LoaderCircle className="spin" size={15} />
          正在执行
        </div>
      )}
      {error && (
        <div className="setup-feedback error probe-feedback" role="alert">
          <strong>{error}</strong>
          {errorAction && <span>{errorAction}</span>}
          {probeReport?.checks?.length ? (
            <ol aria-label="探针校验结果">
              {probeReport.checks.map((check) => (
                <li key={check.phase} className={check.status}>
                  <span>{check.label}</span>
                  <b>{check.status === 'passed' ? '已通过' : check.status === 'failed' ? '失败' : '未执行'}</b>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      )}
    </>
  );
}
