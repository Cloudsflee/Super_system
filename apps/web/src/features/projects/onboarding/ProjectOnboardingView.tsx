import { ArrowLeft, ArrowRight, BrainCircuit, CheckCircle2, FileStack, FolderGit2, LoaderCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { displayStatus } from '../../../components/common/display-labels';
import type { ProjectCodeSource } from '../../../api/types';
import { ContextSources, StepButton, sourcePlaceholder, type AnswerDraft } from './onboarding-support';
import { OnboardingReviewStage } from './OnboardingReviewStage';
import type { ProjectOnboardingViewProps } from './ProjectOnboardingPage';

const listFields: Array<{ key: Exclude<keyof AnswerDraft, 'goal'>; label: string; hint: string }> = [
  { key: 'users', label: '目标用户', hint: '每行一个用户群体' },
  { key: 'features', label: '范围内功能', hint: '每行一个核心功能或交付项' },
  { key: 'scope_out', label: '范围外事项', hint: '本版本明确不做的内容' },
  { key: 'constraints', label: '约束', hint: '技术、时间、合规或资源约束' },
  { key: 'milestones', label: '里程碑', hint: '每行一个可检查的阶段' },
  { key: 'acceptance_criteria', label: '验收标准', hint: '每行一条可验证标准' },
  { key: 'risks', label: '风险', hint: '已知风险或关键假设' },
  { key: 'open_questions', label: '开放问题', hint: '仍需确认的问题' }
];

export function ProjectOnboardingView(props: ProjectOnboardingViewProps) {
  const navigate = useNavigate();
  return (
    <section className="onboarding-page">
      <header className="onboarding-header">
        <button className="icon-button" aria-label="返回项目" onClick={() => navigate('/projects')}>
          <ArrowLeft size={18} />
        </button>
        <div>
          <span className="overline">项目引导 · 草稿</span>
          <h1>{props.data.project.title}</h1>
          <p>确认简报和初始工作流后才会激活。所有代码将进入 AIWS 受管副本。</p>
        </div>
        <span className="status pending">{displayStatus(props.data.project.status)}</span>
      </header>
      <OnboardingSteps {...props} />
      <div className="onboarding-content">
        {props.step === 'mode' && <OnboardingModeStage {...props} />}
        {props.step === 'intake' && <OnboardingIntakeStage {...props} />}
        {props.step === 'review' && props.brief && <OnboardingReviewStage {...props} />}
      </div>
    </section>
  );
}

function OnboardingSteps(props: ProjectOnboardingViewProps) {
  return (
    <nav className="onboarding-steps" aria-label="项目引导步骤">
      <StepButton
        index="1"
        label="选择起点"
        active={props.step === 'mode'}
        done={Boolean(props.mode)}
        onClick={() => props.onStep('mode')}
      />
      <StepButton
        index="2"
        label="补充简报"
        active={props.step === 'intake'}
        done={Boolean(props.brief && props.mode)}
        disabled={!props.mode}
        onClick={() => props.onStep('intake')}
      />
      <StepButton
        index="3"
        label="审查并激活"
        active={props.step === 'review'}
        done={false}
        disabled={!props.brief || !props.mode || !props.answersSaved}
        onClick={() => props.onStep('review')}
      />
    </nav>
  );
}

function OnboardingModeStage(props: ProjectOnboardingViewProps) {
  const operation = props.intakeOperations.chooseMode;
  return (
    <section className="onboarding-stage mode-stage">
      <div className="stage-heading">
        <span className="overline">选择起点</span>
        <h2>这个项目从哪里开始？</h2>
        <p>选择会立即保存，刷新页面后仍可继续。</p>
      </div>
      <div className="mode-cards">
        <button
          className={props.mode === 'brainstorm' ? 'selected' : ''}
          disabled={operation.isPending}
          onClick={() => operation.mutate('brainstorm')}
        >
          <BrainCircuit size={25} />
          <strong>从 0 头脑风暴</strong>
          <span>通过目标、用户、范围和验收问题形成第一版项目简报。</span>
          <i>不需要现有代码</i>
        </button>
        <button
          className={props.mode === 'existing' ? 'selected' : ''}
          disabled={operation.isPending}
          onClick={() => operation.mutate('existing')}
        >
          <FolderGit2 size={25} />
          <strong>基于已有项目</strong>
          <span>导入 GitHub、Git 地址、本地目录、Git 仓库或归档的只读副本。</span>
          <i>外部源不会被修改</i>
        </button>
      </div>
      {operation.isPending && (
        <div className="inline-progress">
          <LoaderCircle className="spin" size={16} />
          正在保存选择
        </div>
      )}
    </section>
  );
}

function OnboardingIntakeStage(props: ProjectOnboardingViewProps) {
  const saveIntake = props.intakeOperations.saveIntake;
  return (
    <section className="onboarding-stage intake-stage">
      <div className="stage-heading">
        <span className="overline">项目信息收集</span>
        <h2>{props.mode === 'existing' ? '描述项目并选择代码源' : '建立可验证的项目简报'}</h2>
        <p>不知道的内容可先留在开放问题中，之后可以生成新版本。</p>
      </div>
      <div className="intake-grid">
        <div className="answer-form">
          <label>
            核心目标
            <textarea
              id="brief-goal"
              rows={5}
              value={props.answers.goal}
              onChange={(event) => props.onAnswers({ ...props.answers, goal: event.target.value })}
              placeholder="希望为谁解决什么问题，最终交付什么可验证结果？"
            />
          </label>
          {listFields.map((field) => (
            <label key={field.key}>
              {field.label}
              <textarea
                id={`brief-${field.key.replaceAll('_', '-')}`}
                rows={field.key === 'features' || field.key === 'acceptance_criteria' ? 5 : 3}
                value={props.answers[field.key]}
                onChange={(event) => props.onAnswers({ ...props.answers, [field.key]: event.target.value })}
                placeholder={field.hint}
              />
            </label>
          ))}
        </div>
        <aside className="intake-sources">
          {props.mode === 'existing' && <CodeSourceCard {...props} />}
          <ContextSources
            value={props.contexts}
            onChange={props.onContexts}
            allowLocalPaths={props.localPathAvailable}
            relativePaths={props.relativeImports}
          />
        </aside>
      </div>
      <div className="stage-actions">
        <button className="button secondary" onClick={() => props.onStep('mode')}>
          <ArrowLeft size={15} />
          返回
        </button>
        <button
          className="button primary"
          disabled={!props.canSave || saveIntake.isPending}
          onClick={() => saveIntake.mutate()}
        >
          {saveIntake.isPending ? <LoaderCircle className="spin" size={15} /> : <FileStack size={15} />}
          保存并生成简报
          <ArrowRight size={15} />
        </button>
      </div>
    </section>
  );
}

function CodeSourceCard(props: ProjectOnboardingViewProps) {
  return (
    <section className="source-card">
      <header>
        <FolderGit2 size={17} />
        <div>
          <strong>代码源</strong>
          <small>只读扫描后克隆或复制到受管工作空间</small>
        </div>
      </header>
      <label>
        来源类型
        <select
          value={props.sourceType}
          onChange={(event) => {
            props.onSourceType(event.target.value as ProjectCodeSource['type']);
            props.onSourceValue('');
            props.onUploadFiles([]);
          }}
        >
          {props.sourceEntries.map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {(props.sourceType === 'github' || props.sourceType === 'git' || props.localPathAvailable) && (
        <label>
          {props.sourceType === 'github' || props.sourceType === 'git'
            ? '代码仓库地址'
            : props.relativeImports
              ? '导入根下的相对路径'
              : '本机绝对路径'}
          <input
            value={props.sourceValue}
            onChange={(event) => props.onSourceValue(event.target.value)}
            placeholder={sourcePlaceholder(props.sourceType, props.relativeImports)}
          />
        </label>
      )}
      {['local_directory', 'archive'].includes(props.sourceType) && (
        <label>
          或从浏览器上传
          <input
            type="file"
            multiple={props.sourceType === 'local_directory'}
            accept={props.sourceType === 'archive' ? '.zip,.tar,.tgz,.gz' : undefined}
            {...(props.sourceType === 'local_directory' ? { webkitdirectory: '', directory: '' } : {})}
            onChange={(event) => {
              const files = [...(event.target.files || [])];
              props.onUploadFiles(files);
              if (files[0]) props.onSourceValue(files[0].webkitRelativePath || files[0].name);
            }}
          />
          <small>
            {props.uploadFiles.length ? `已选择 ${props.uploadFiles.length} 个文件` : '上传内容同样先进入暂存区校验'}
          </small>
        </label>
      )}
      <p>
        <CheckCircle2 size={13} />
        不会原地修改或删除外部目录和远端代码仓库。
      </p>
    </section>
  );
}
