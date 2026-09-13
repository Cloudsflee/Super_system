import { useEffect, useRef, useState } from 'react';
import { Check, Plus, Save } from 'lucide-react';
import type { Brief, BriefDraft } from './workflowTypes';

export function briefDraft(brief: Brief | null): BriefDraft {
  const content = brief?.current?.content;
  return { objective: typeof content?.objective === 'string' ? content.objective : '', acceptance: Array.isArray(content?.acceptance) ? content.acceptance.map(String) : [] };
}
export function BriefEditor({ brief, projectRevision, busy, online, intakeReady, onSave, onConfirm, onDirty }: {
  brief: Brief | null; projectRevision: number; busy: boolean; online: boolean; intakeReady: boolean;
  onSave: (draft: BriefDraft, expectedRevision: number) => Promise<Record<string, unknown> | null>;
  onConfirm: () => Promise<Record<string, unknown> | null>; onDirty: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => briefDraft(brief));
  const [dirty, setDirty] = useState(false); const [queued, setQueued] = useState(false);
  const expected = useRef(projectRevision);
  const revision = brief?.current_revision || brief?.current?.revision || 0;
  useEffect(() => { if (!dirty) { setDraft(briefDraft(brief)); expected.current = projectRevision; } }, [brief, dirty, projectRevision]);
  const edit = (value: BriefDraft) => { if (!dirty) expected.current = projectRevision; setDraft(value); setDirty(true); setQueued(false); onDirty(true); };
  const discard = () => { setDraft(briefDraft(brief)); expected.current = projectRevision; setDirty(false); setQueued(false); onDirty(false); };
  const save = async () => {
    const result = await onSave({ ...draft, objective: draft.objective.trim(), acceptance: draft.acceptance.map(item => item.trim()) }, expected.current);
    if (!result) return;
    if (result.queued) { setQueued(true); return; }
    setDirty(false); setQueued(false); onDirty(false);
  };
  const move = (index: number, direction: number) => { const acceptance = [...draft.acceptance]; [acceptance[index], acceptance[index + direction]] = [acceptance[index + direction], acceptance[index]]; edit({ ...draft, acceptance }); };
  const valid = Boolean(draft.objective.trim() && draft.acceptance.every(item => item.trim()));
  const reason = !online ? '恢复连接后可用' : !intakeReady ? '请先完成来源接入' : dirty || queued ? '请先保存修订并完成同步' : !revision || !valid || !draft.acceptance.length ? '确认需要已保存的目标和至少一条非空验收标准' : '';
  return <div className="brief-editor">
    <fieldset disabled={busy}><legend className="sr-only">编辑 Brief</legend>
      <label><span>目标</span><textarea aria-label="目标" required rows={3} value={draft.objective} aria-invalid={!draft.objective.trim()} onChange={event => edit({ ...draft, objective: event.target.value })} /></label>
      {!draft.objective.trim() && <p className="field-error">目标不能为空</p>}
      <fieldset><legend>验收标准</legend>
        {draft.acceptance.map((item, index) => <div key={index} className="brief-criterion"><label><span>验收标准 {index + 1}</span><textarea aria-label={`验收标准 ${index + 1}`} rows={2} value={item} required aria-invalid={!item.trim()} onChange={event => edit({ ...draft, acceptance: draft.acceptance.map((value, ordinal) => ordinal === index ? event.target.value : value) })} />{!item.trim() && <small className="field-error">条目不能为空</small>}</label><div className="row-actions"><button type="button" className="button" aria-label={`上移验收标准 ${index + 1}`} disabled={index === 0} onClick={() => move(index, -1)}>上移</button><button type="button" className="button" aria-label={`下移验收标准 ${index + 1}`} disabled={index === draft.acceptance.length - 1} onClick={() => move(index, 1)}>下移</button><button type="button" className="button" aria-label={`删除验收标准 ${index + 1}`} onClick={() => edit({ ...draft, acceptance: draft.acceptance.filter((_, ordinal) => ordinal !== index) })}>删除</button></div></div>)}
        {!draft.acceptance.length && <p className="field-error">至少添加一条验收标准</p>}
        <button type="button" className="button" onClick={() => edit({ ...draft, acceptance: [...draft.acceptance, ''] })}><Plus size={14} />添加验收标准</button>
      </fieldset>
    </fieldset>
    <div className="revision-note" role="status"><span>当前修订 r{revision}</span><span>已确认 {brief?.confirmed_revision ? `r${brief.confirmed_revision}` : '未确认'}</span><code>{brief?.current?.content_sha256 || '尚无内容哈希'}</code><span>{queued ? '已离线保存，等待同步' : dirty ? '有未保存修改' : '与服务器一致'}</span></div>
    <div className="form-actions"><button className="button" disabled={!valid || busy || queued} onClick={() => void save()}><Save size={15} />保存修订</button><button className="button primary" disabled={Boolean(reason) || busy} onClick={() => void onConfirm()}><Check size={15} />确认修订</button>{dirty && <button className="button" onClick={discard} disabled={busy}>放弃本地修改</button>}</div>
    {reason && <p className="prerequisite-note">{reason}</p>}
  </div>;
}
