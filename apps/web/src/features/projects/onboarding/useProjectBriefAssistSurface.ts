import { useRef } from 'react';
import { useAssistSurface } from '../../../components/assist/semantic-actions';
import type { AnswerDraft } from './onboarding-support';

export function useProjectBriefAssistSurface(
  projectId: string | undefined,
  answers: AnswerDraft,
  setField: (key: keyof AnswerDraft, value: unknown) => void,
  persist: (value: AnswerDraft) => void | Promise<void>
) {
  const current = useRef(answers);
  current.current = answers;
  useAssistSurface({
    id: `project-onboarding-${projectId || 'unknown'}`,
    fields: {
      'brief.goal': control('核心目标', 'brief-goal', 'goal'),
      'brief.users': control('目标用户', 'brief-users', 'users'),
      'brief.features': control('范围内功能', 'brief-features', 'features'),
      'brief.scope_in': control('范围内功能', 'brief-features', 'features'),
      'brief.scope_out': control('范围外事项', 'brief-scope-out', 'scope_out'),
      'brief.constraints': control('约束', 'brief-constraints', 'constraints'),
      'brief.milestones': control('里程碑', 'brief-milestones', 'milestones'),
      'brief.acceptance_criteria': control('验收标准', 'brief-acceptance-criteria', 'acceptance_criteria'),
      'brief.risks': control('风险', 'brief-risks', 'risks'),
      'brief.open_questions': control('开放问题', 'brief-open-questions', 'open_questions')
    }
  });

  function control(label: string, elementId: string, key: keyof AnswerDraft) {
    return {
      label,
      elementId,
      set: (value: unknown) => {
        const text = Array.isArray(value) ? value.map(String).join('\n') : String(value ?? '');
        current.current = { ...current.current, [key]: text };
        setField(key, text);
      },
      persist: () => persist(current.current)
    };
  }
}
