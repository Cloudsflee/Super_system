import { Save } from 'lucide-react';
import { useState } from 'react';
import type { RendererProps } from '../registry';
import { lines, saveWorkspaceData, stringList } from './shared';
import { useUi } from '../../../state/ui';
import { useAssistSurface } from '../../../components/assist/semantic-actions';

export function GoalWorkspace({ value, onSaved }: RendererProps) {
  const data = value.data;
  const [scope, setScope] = useState(String(data.scope || value.node.goal || ''));
  const [criteria, setCriteria] = useState(stringList(data.success_criteria).join('\n'));
  const [questions, setQuestions] = useState(stringList(data.questions || value.workspace.open_questions).join('\n'));
  const [busy, setBusy] = useState(false);
  const toast = useUi((state) => state.toast);
  useAssistSurface({ id: 'goal-workspace', fields: {
    'goal.scope': { label: '目标范围', elementId: 'goal-scope', set: (input) => setScope(String(input ?? '')) },
    'goal.success_criteria': { label: '成功标准', elementId: 'goal-success-criteria', set: (input) => setCriteria(toText(input)) },
    'goal.questions': { label: '待确认问题', elementId: 'goal-questions', set: (input) => setQuestions(toText(input)) }
  } });
  async function save() { setBusy(true); try { await saveWorkspaceData(value.node.id, { scope, success_criteria: lines(criteria), questions: lines(questions) }); await onSaved(); toast('目标工作区已保存'); } catch (error) { toast((error as Error).message, 'error'); } finally { setBusy(false); } }
  return (
    <div className="structured-workspace">
      <section className="editor-main"><header><div><span className="overline">SCOPE</span><h2>范围与成功标准</h2></div><button className="button primary" disabled={busy || !scope.trim()} onClick={save}><Save size={15} />保存</button></header><label>目标范围<textarea id="goal-scope" rows={8} value={scope} onChange={(e) => setScope(e.target.value)} /></label><label>成功标准<textarea id="goal-success-criteria" rows={8} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="每行一项" /></label></section>
      <aside className="editor-side"><span className="overline">OPEN QUESTIONS</span><h2>待确认问题</h2><textarea id="goal-questions" aria-label="待确认问题" rows={18} value={questions} onChange={(e) => setQuestions(e.target.value)} placeholder="每行一个问题" /></aside>
    </div>
  );
}
function toText(value: unknown) { return Array.isArray(value) ? value.map(String).join('\n') : String(value ?? ''); }
