import { Save, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, json } from '../../api/client';
import type { QualityReviewRubric } from '../../api/execution-types';
import type { Workflow } from '../../api/types';
import { useUi } from '../../state/ui';
import { RubricEditor } from './QualityReviewDrawer';

export function QualityReviewPolicyEditor({
  workflow,
  canWrite,
  executionActive,
  onRefresh
}: {
  workflow: Workflow;
  canWrite: boolean;
  executionActive: boolean;
  onRefresh: () => void;
}) {
  const policy = workflow.quality_review_policy,
    [enabled, setEnabled] = useState(Boolean(policy?.enabled)),
    [rubric, setRubric] = useState<QualityReviewRubric>(() => policy?.rubric || defaultRubric()),
    [busy, setBusy] = useState(false),
    toast = useUi((state) => state.toast),
    readOnly = !canWrite || executionActive,
    weightTotal = useMemo(
      () => rubric.dimensions.filter((item) => item.enabled).reduce((sum, item) => sum + Number(item.weight), 0),
      [rubric]
    ),
    valid = !enabled || (weightTotal === 100 && rubric.dimensions.some((item) => item.enabled));
  useEffect(() => {
    setEnabled(Boolean(policy?.enabled));
    setRubric(structuredClone(policy?.rubric || defaultRubric()));
  }, [policy?.enabled, policy?.rubric_hash, workflow.id, workflow.workflow_revision]);

  async function save() {
    if (readOnly || !valid) return;
    setBusy(true);
    try {
      await api(
        `/workflows/${workflow.id}/quality-review-policy`,
        json(
          'PUT',
          {
            expected_revision: Number(workflow.workflow_revision || workflow.version || 1),
            enabled,
            rubric: enabled ? { ...rubric, enabled: true, mandatory: true, threshold: 80 } : undefined
          },
          '保存 Quality Review 策略'
        )
      );
      await Promise.resolve(onRefresh());
      toast('Quality Review 策略已保存');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="quality-review-policy" aria-label="Quality Review 策略">
      <PolicyHeader
        enabled={enabled}
        readOnly={readOnly}
        executionActive={executionActive}
        revision={Number(workflow.workflow_revision || workflow.version || 1)}
        onEnabled={setEnabled}
      />
      {enabled && <RubricEditor rubric={rubric} weightTotal={weightTotal} onRubric={setRubric} readOnly={readOnly} />}
      <PolicyFooter visible={canWrite && !executionActive} busy={busy} valid={valid} onSave={() => void save()} />
    </section>
  );
}

function PolicyHeader({
  enabled,
  readOnly,
  executionActive,
  revision,
  onEnabled
}: {
  enabled: boolean;
  readOnly: boolean;
  executionActive: boolean;
  revision: number;
  onEnabled: (value: boolean) => void;
}) {
  return (
    <header>
      <span>
        <ShieldCheck size={14} />
        <strong>Quality Review policy</strong>
      </span>
      <label className="quality-review-policy-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={readOnly}
          onChange={(event) => onEnabled(event.target.checked)}
        />
        <span>{enabled ? '已启用' : '未启用'}</span>
      </label>
      <small>{executionActive ? '当前执行已冻结策略' : `Revision ${revision}`}</small>
    </header>
  );
}

function PolicyFooter({
  visible,
  busy,
  valid,
  onSave
}: {
  visible: boolean;
  busy: boolean;
  valid: boolean;
  onSave: () => void;
}) {
  if (!visible) return null;
  return (
    <footer>
      <button className="button secondary compact" disabled={busy || !valid} onClick={onSave}>
        <Save size={14} />
        {busy ? '保存中…' : '保存策略'}
      </button>
    </footer>
  );
}

function defaultRubric(): QualityReviewRubric {
  return {
    schema_version: 'aiws.quality_review_rubric.v1',
    version: 1,
    enabled: true,
    mandatory: true,
    threshold: 80,
    dimensions: [
      {
        id: 'coverage',
        title: '目标与要求覆盖',
        weight: 25,
        enabled: true,
        instructions: '检查交付内容是否完整覆盖任务目标、验收要求和用户明确约束。'
      },
      {
        id: 'accuracy',
        title: '事实准确性与证据支撑',
        weight: 25,
        enabled: true,
        instructions: '检查事实、数字和结论是否有可追溯证据，区分事实、推断与未知。'
      },
      {
        id: 'depth',
        title: '分析深度、反证与边界',
        weight: 20,
        enabled: true,
        instructions: '检查分析是否呈现反证、替代解释、适用边界、风险和不确定性。'
      },
      {
        id: 'consistency',
        title: '内部一致性',
        weight: 15,
        enabled: true,
        instructions: '检查全文、表格、公式和结论之间没有矛盾，术语和口径保持一致。'
      },
      {
        id: 'clarity',
        title: '表达清晰度与可操作性',
        weight: 15,
        enabled: true,
        instructions: '检查结构、语言、可读性以及读者能否据此采取明确行动。'
      }
    ]
  };
}
