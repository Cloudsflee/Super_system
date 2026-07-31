import { ArrowLeft, CheckCircle2, LoaderCircle, RefreshCw, UploadCloud } from 'lucide-react';

import type { ProjectBrief, ProjectOnboarding } from '../../../api/types';
import { displayStatus } from '../../../components/common/display-labels';
import { useUi } from '../../../state/ui';
import { BriefWorkspace } from './BriefWorkspace';
import { shortHash } from './onboarding-support';
import type { ProjectOnboardingViewProps } from './ProjectOnboardingPage';

export function OnboardingReviewStage(props: ProjectOnboardingViewProps) {
  const brief = props.brief;
  if (!brief) return null;
  return (
    <section className="onboarding-stage review-stage">
      <ReviewHeading brief={brief} />
      <LastErrorAlert props={props} />
      <ReviewBriefWorkspace props={props} brief={brief} />
      {props.mode === 'existing' && <ImportCard props={props} />}
      <ReviewActions props={props} />
    </section>
  );
}

function ReviewHeading({ brief }: { brief: ProjectBrief }) {
  return (
    <div className="stage-heading">
      <span className="overline">简报第 {brief.version} 版 · 审查</span>
      <h2>审查项目简报与初始工作流</h2>
      <p>确认后将创建独立工作单元并激活项目；功能、里程碑和验收条件继续由项目简报与任务契约管理。</p>
    </div>
  );
}

function LastErrorAlert({ props }: { props: ProjectOnboardingViewProps }) {
  if (!props.data.intake.last_error) return null;
  return (
    <div className="onboarding-alert" role="alert">
      <strong>上次处理失败</strong>
      <span>{props.data.intake.last_error}</span>
      <button className="button secondary" onClick={() => props.onStep('intake')}>
        <RefreshCw size={14} />
        修正输入
      </button>
    </div>
  );
}

function ReviewBriefWorkspace({ props, brief }: { props: ProjectOnboardingViewProps; brief: ProjectBrief }) {
  const ui = useUi(),
    { patchBrief, patchWorkflow, saveTemplate, applyTemplate } = props.briefOperations;
  if (!props.workflowDraft) return null;
  return (
    <BriefWorkspace
      brief={brief}
      workflow={props.workflowDraft}
      templates={props.templates}
      busy={patchBrief.isPending || patchWorkflow.isPending || applyTemplate.isPending || saveTemplate.isPending}
      onBrief={(operations) => applyPatch(patchBrief.mutateAsync, operations)}
      onWorkflow={(operations) => applyPatch(patchWorkflow.mutateAsync, operations)}
      onSaveTemplate={() => saveTemplate.mutate()}
      onApplyTemplate={(template) => applyTemplate.mutate(template)}
      onSearchTemplates={() => {
        ui.setAssist(true);
        window.dispatchEvent(
          new CustomEvent('aiws:assist-prefill', {
            detail: {
              prompt: `请使用已启用网页搜索的 Codex 配置，为“${brief.content.title}”检索 2-3 个权威简报模板，比较发布方、时效、适用性、局限、来源链接和推荐理由。`
            }
          })
        );
      }}
    />
  );
}

function ImportCard({ props }: { props: ProjectOnboardingViewProps }) {
  const importSource = props.intakeOperations.importSource;
  return (
    <section className={`import-card ${props.sourceReady ? 'ready' : ''}`}>
      <div>
        {props.sourceReady ? <CheckCircle2 size={20} /> : <UploadCloud size={20} />}
        <span>
          <strong>{props.sourceReady ? '受管代码副本已就绪' : '导入代码源到受管工作空间'}</strong>
          <small>
            {props.sourceReady
              ? `源哈希 ${shortHash(props.data.project.source_hash)}`
              : '确认外部源只读校验、克隆或复制和落盘结果后才能激活'}
          </small>
        </span>
      </div>
      <ImportStatus value={props.data.imports[0]} />
      {!props.sourceReady && (
        <button
          className="button secondary"
          disabled={importSource.isPending || (!props.sourceValue.trim() && !props.uploadFiles.length)}
          onClick={() => importSource.mutate()}
        >
          {importSource.isPending ? <LoaderCircle className="spin" size={15} /> : <UploadCloud size={15} />}
          {importSource.isPending ? '正在校验并导入' : '开始导入'}
        </button>
      )}
    </section>
  );
}

function ReviewActions({ props }: { props: ProjectOnboardingViewProps }) {
  return (
    <div className="stage-actions">
      <button className="button secondary" onClick={() => props.onStep('intake')}>
        <ArrowLeft size={15} />
        修改简报
      </button>
      <button
        className="button primary"
        disabled={!props.canConfirm || props.confirm.isPending}
        onClick={() => props.confirm.mutate()}
      >
        {props.confirm.isPending ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}
        {props.sourceReady ? '确认简报并激活项目' : '请先完成代码导入'}
      </button>
    </div>
  );
}

function ImportStatus({ value }: { value?: ProjectOnboarding['imports'][number] }) {
  if (!value) return null;
  return (
    <span
      className={`status ${value.status === 'succeeded' ? 'ready' : value.status === 'failed' ? 'failed' : 'pending'}`}
    >
      {displayStatus(value.status)}
      {value.error_code ? ` · ${value.error_code}` : ''}
    </span>
  );
}

async function applyPatch<T>(mutate: (operations: T) => Promise<unknown>, operations: T) {
  try {
    await mutate(operations);
    return true;
  } catch {
    return false;
  }
}
