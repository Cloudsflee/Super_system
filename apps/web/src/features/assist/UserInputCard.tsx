import { KeyRound, Send } from 'lucide-react';
import { useState } from 'react';
import type { RuntimeUserInput } from '../../api/types';

export function UserInputCard({ item, busy, onRespond }: { item: RuntimeUserInput; busy: boolean; onRespond: (answers: Record<string, { answers: string[] }>) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}), [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const answerFor = (id: string) => answers[id] === '__other__' ? otherAnswers[id] || '' : answers[id] || '';
  if (item.status !== 'pending') return <article className="native-input-card resolved"><strong>Codex 问题 · {item.status}</strong></article>;
  return <article className="native-input-card">
    <header><KeyRound size={14} /><div><strong>Codex 需要你的输入</strong>{item.auto_resolution_ms != null && <small>{item.auto_resolution_ms} ms 后自动跳过</small>}</div></header>
    {item.questions.map((question) => <fieldset key={question.id}>
      <legend>{question.header}</legend><p>{question.question}</p>
      {question.options?.length ? <div className="native-input-options">
        {question.options.map((option) => <label key={option.label}><input type="radio" name={`${item.id}-${question.id}`} checked={answers[question.id] === option.label} onChange={() => setAnswers((value) => ({ ...value, [question.id]: option.label }))} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}
        {question.isOther && <><label><input type="radio" name={`${item.id}-${question.id}`} checked={answers[question.id] === '__other__'} onChange={() => setAnswers((value) => ({ ...value, [question.id]: '__other__' }))} /><span><strong>其他</strong><small>输入自定义回答</small></span></label>{answers[question.id] === '__other__' && <input aria-label={`${question.header} 其他回答`} autoComplete="off" value={otherAnswers[question.id] || ''} onChange={(event) => setOtherAnswers((value) => ({ ...value, [question.id]: event.target.value }))} />}</>}
      </div> : <input type={question.isSecret ? 'password' : 'text'} autoComplete="off" value={answers[question.id] || ''} onChange={(event) => setAnswers((value) => ({ ...value, [question.id]: event.target.value }))} />}
    </fieldset>)}
    <button className="button primary" disabled={busy || item.questions.some((question) => !answerFor(question.id))} onClick={() => onRespond(Object.fromEntries(item.questions.map((question) => [question.id, { answers: [answerFor(question.id)] }])))}><Send size={13} />提交回答</button>
  </article>;
}
