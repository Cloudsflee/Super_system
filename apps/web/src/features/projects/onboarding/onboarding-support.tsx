import { ArrowRight, CheckCircle2, FileStack, GitBranch, Plus, Trash2 } from 'lucide-react';
import type {
  NodeKind,
  ProjectBriefContent,
  ProjectCodeSource,
  ProjectContextSource,
  ProjectIntakeAnswers,
  ProjectIntakeMode,
  WorkflowDraftNode
} from '../../../api/types';

type AnswerKey = keyof ProjectIntakeAnswers;
export type AnswerDraft = Record<
  | 'goal'
  | 'users'
  | 'features'
  | 'scope_out'
  | 'constraints'
  | 'milestones'
  | 'acceptance_criteria'
  | 'risks'
  | 'open_questions',
  string
>;
export type ContextDraft = { id: string; type: ProjectContextSource['type']; label: string; value: string };

export function StepButton({
  index,
  label,
  active,
  done,
  disabled,
  onClick
}: {
  index: string;
  label: string;
  active: boolean;
  done: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={active ? 'step' : undefined}
      className={active ? 'active' : done ? 'done' : ''}
      disabled={disabled}
      onClick={onClick}
    >
      <i>{done ? <CheckCircle2 size={15} /> : index}</i>
      <span>{label}</span>
    </button>
  );
}

export function ContextSources({
  value,
  onChange,
  allowLocalPaths = true,
  relativePaths = false
}: {
  value: ContextDraft[];
  onChange: (next: ContextDraft[]) => void;
  allowLocalPaths?: boolean;
  relativePaths?: boolean;
}) {
  function add() {
    onChange([...value, { id: localId(), type: 'url', label: '', value: '' }]);
  }
  function patch(id: string, update: Partial<ContextDraft>) {
    onChange(value.map((item) => (item.id === id ? { ...item, ...update } : item)));
  }
  return (
    <section className="source-card context-card">
      <header>
        <FileStack size={17} />
        <div>
          <strong>上下文材料</strong>
          <small>
            {allowLocalPaths
              ? `可添加 HTTPS URL、文本或${relativePaths ? '导入根相对路径' : '本机文件路径'}`
              : '可添加 HTTPS URL 或文本'}
          </small>
        </div>
        <button className="row-icon" aria-label="添加上下文材料" onClick={add}>
          <Plus size={15} />
        </button>
      </header>
      {value.map((item) => (
        <div className="context-source" key={item.id}>
          <select
            aria-label="材料类型"
            value={item.type}
            onChange={(event) =>
              patch(item.id, { type: event.target.value as ProjectContextSource['type'], value: '' })
            }
          >
            <option value="url">HTTPS URL</option>
            <option value="text">文本</option>
            {allowLocalPaths && (
              <>
                <option value="file">文件</option>
                <option value="image">图片</option>
                <option value="pdf">PDF</option>
                <option value="docx">DOCX</option>
                <option value="xlsx">XLSX</option>
              </>
            )}
          </select>
          <input
            aria-label="材料名称"
            value={item.label}
            onChange={(event) => patch(item.id, { label: event.target.value })}
            placeholder="名称（可选）"
          />
          {item.type === 'text' ? (
            <textarea
              aria-label="材料内容"
              rows={4}
              value={item.value}
              onChange={(event) => patch(item.id, { value: event.target.value })}
              placeholder="粘贴背景材料"
            />
          ) : (
            <input
              aria-label="材料位置"
              value={item.value}
              onChange={(event) => patch(item.id, { value: event.target.value })}
              placeholder={
                item.type === 'url' ? 'https://…' : relativePaths ? 'team/project/docs/spec.md' : '本机绝对路径'
              }
            />
          )}
          <button
            className="row-icon danger-icon"
            aria-label="移除上下文材料"
            onClick={() => onChange(value.filter((candidate) => candidate.id !== item.id))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {!value.length && (
        <button className="empty-context" onClick={add}>
          <Plus size={15} />
          添加需求文档、设计稿或参考链接
        </button>
      )}
    </section>
  );
}

export function BriefReview({ content }: { content: ProjectBriefContent }) {
  const sections: Array<[string, string[]]> = [
    ['目标用户', content.users],
    ['范围内', content.scope.in],
    ['范围外', content.scope.out],
    ['约束', content.constraints],
    ['里程碑', content.milestones],
    ['验收标准', content.acceptance_criteria],
    ['风险', content.risks],
    ['开放问题', content.open_questions]
  ];
  return (
    <article className="brief-review">
      <header>
        <FileStack size={18} />
        <h3>项目简报</h3>
      </header>
      <section className="brief-goal">
        <span>目标</span>
        <p>{content.goal || '尚未定义'}</p>
      </section>
      {sections.map(([label, items]) => (
        <section key={label}>
          <span>{label}</span>
          {items.length ? (
            <ul>
              {items.map((item, index) => (
                <li key={`${label}-${index}`}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">暂无</p>
          )}
        </section>
      ))}
    </article>
  );
}

export function WorkflowReview({
  value,
  onChange
}: {
  value: WorkflowDraftNode[];
  onChange: (next: WorkflowDraftNode[]) => void;
}) {
  function patch(index: number, update: Partial<WorkflowDraftNode>) {
    onChange(value.map((item, itemIndex) => (itemIndex === index ? { ...item, ...update } : item)));
  }
  return (
    <article className="workflow-review">
      <header>
        <GitBranch size={18} />
        <div>
          <h3>初始工作流</h3>
          <small>{value.length} 个节点 · 按依赖顺序创建</small>
        </div>
      </header>
      <div>
        {value.map((node, index) => (
          <section key={index}>
            <i>{index + 1}</i>
            <div>
              <select
                aria-label={`节点 ${index + 1} 类型`}
                value={node.type}
                onChange={(event) => patch(index, { type: event.target.value as NodeKind })}
              >
                <option value="goal_definition">目标</option>
                <option value="research">调研</option>
                <option value="analysis">分析</option>
                <option value="execution">执行</option>
                <option value="retrospective">复盘</option>
              </select>
              <input
                aria-label={`节点 ${index + 1} 标题`}
                value={node.title}
                onChange={(event) => patch(index, { title: event.target.value })}
              />
              <textarea
                aria-label={`节点 ${index + 1} 目标`}
                rows={3}
                value={node.goal}
                onChange={(event) => patch(index, { goal: event.target.value })}
              />
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}

export function CompletedOnboarding({ title, onOpen }: { title: string; onOpen: () => void }) {
  return (
    <div className="full-state">
      <CheckCircle2 size={30} />
      <h1>{title} 已完成项目引导</h1>
      <p>项目已经激活，可以回到工作流继续协作。</p>
      <button className="button primary" onClick={onOpen}>
        打开工作流
        <ArrowRight size={15} />
      </button>
    </div>
  );
}

export function intakePayload(
  mode: ProjectIntakeMode | null,
  answers: AnswerDraft,
  sourceType: ProjectCodeSource['type'],
  sourceValue: string,
  contexts: ContextDraft[],
  hostImportScope = false
) {
  return {
    mode,
    answers: Object.fromEntries(
      Object.entries(answers).map(([key, value]) => [key, key === 'goal' ? value.trim() : lines(value)])
    ),
    code_source: mode === 'existing' ? codeSource(sourceType, sourceValue, hostImportScope) : null,
    context_sources: contexts.filter((item) => item.value.trim()).map((item) => contextRecord(item, hostImportScope))
  };
}

export function codeSource(type: ProjectCodeSource['type'], value: string, hostImportScope = false): ProjectCodeSource {
  return type === 'github' || type === 'git'
    ? { type, url: value.trim() }
    : { type, path: value.trim(), ...(hostImportScope ? { path_scope: 'host_import_root' as const } : {}) };
}
function contextRecord(item: ContextDraft, hostImportScope = false): ProjectContextSource {
  const base = { type: item.type, label: item.label.trim() || undefined };
  if (item.type === 'url') return { ...base, url: item.value.trim() };
  if (item.type === 'text') return { ...base, text: item.value.trim() };
  return { ...base, path: item.value.trim(), ...(hostImportScope ? { path_scope: 'host_import_root' as const } : {}) };
}
export function contextFromRecord(item: ProjectContextSource, index: number): ContextDraft {
  return {
    id: `context-${index}-${localId()}`,
    type: item.type,
    label: item.label || '',
    value: item.url || item.text || item.path || ''
  };
}
export function toAnswerDraft(value: ProjectIntakeAnswers, fallbackGoal: string): AnswerDraft {
  const record = value as Record<AnswerKey, string | string[] | undefined>;
  return {
    goal: String(value.goal || fallbackGoal || ''),
    users: join(record.users || record.target_users),
    features: join(record.features || record.scope_in),
    scope_out: join(record.scope_out),
    constraints: join(record.constraints),
    milestones: join(record.milestones),
    acceptance_criteria: join(record.acceptance_criteria),
    risks: join(record.risks),
    open_questions: join(record.open_questions)
  };
}
export function emptyAnswers(): AnswerDraft {
  return {
    goal: '',
    users: '',
    features: '',
    scope_out: '',
    constraints: '',
    milestones: '',
    acceptance_criteria: '',
    risks: '',
    open_questions: ''
  };
}
export function shortHash(value?: string | null) {
  return value ? `${value.slice(0, 12)}…` : '已记录';
}
export function hasSavedAnswers(value?: ProjectIntakeAnswers) {
  return Boolean(value && Object.keys(value).length);
}
export function sourcePlaceholder(type: ProjectCodeSource['type'], relative = false) {
  return type === 'github'
    ? 'https://github.com/owner/repository.git'
    : type === 'git'
      ? 'https://git.example.com/team/repository.git'
      : relative
        ? type === 'archive'
          ? 'team/project.tar.gz'
          : 'team/project'
        : type === 'archive'
          ? 'C:\\path\\project.zip'
          : 'C:\\path\\project';
}
function lines(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}
function join(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.join('\n') : String(value || '');
}
function localId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
