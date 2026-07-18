import { Plus, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { RendererProps } from '../registry';
import { lines, saveWorkspaceData, stringList } from './shared';
import { useUi } from '../../../state/ui';
import { useAssistSurface } from '../../../components/assist/semantic-actions';

export function AnalysisWorkspace({ value, onSaved }: RendererProps) {
  const [options, setOptions] = useState<string[]>(stringList(value.data.options));
  const [decision, setDecision] = useState(String(value.data.decision || ''));
  const [risks, setRisks] = useState(stringList(value.data.risks).join('\n'));
  const toast = useUi((state) => state.toast);
  useAssistSurface({ id: 'analysis-workspace', fields: {
    'analysis.options': { label: '候选方案', set: (input) => setOptions(toArray(input)) },
    'analysis.decision': { label: '决策', elementId: 'analysis-decision', set: (input) => setDecision(String(input ?? '')) },
    'analysis.risks': { label: '风险', elementId: 'analysis-risks', set: (input) => setRisks(toArray(input).join('\n')) }
  } });
  async function save() { try { await saveWorkspaceData(value.node.id, { options, decision, risks: lines(risks) }); await onSaved(); toast('分析记录已保存'); } catch (error) { toast((error as Error).message, 'error'); } }
  return (
    <div className="analysis-workspace"><header className="content-header"><div><span className="overline">OPTIONS & DECISION</span><h2>方案与决策</h2></div><button className="button primary" onClick={save}><Save size={15} />保存</button></header><div className="analysis-columns"><section><div className="subhead"><h3>候选方案</h3><button className="row-icon" aria-label="添加方案" onClick={() => setOptions([...options, ''])}><Plus size={16} /></button></div>{options.map((option, index) => <div className="option-line" key={index}><span>{index + 1}</span><textarea aria-label={`方案 ${index + 1}`} rows={4} value={option} onChange={(e) => setOptions(options.map((item, i) => i === index ? e.target.value : item))} /><button className="row-icon" aria-label="删除方案" onClick={() => setOptions(options.filter((_, i) => i !== index))}><Trash2 size={14} /></button></div>)}</section><section><label>决策<textarea id="analysis-decision" rows={9} value={decision} onChange={(e) => setDecision(e.target.value)} /></label><label>风险<textarea id="analysis-risks" rows={9} value={risks} onChange={(e) => setRisks(e.target.value)} placeholder="每行一项" /></label></section></div></div>
  );
}
function toArray(value: unknown) { return (Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/)).map(String).filter(Boolean); }
