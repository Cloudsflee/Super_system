import { useEffect } from 'react';
import type { ProjectCodeSource, ProjectIntakeMode, ProjectOnboarding } from '../../../api/types';
import {
  contextFromRecord,
  hasSavedAnswers,
  toAnswerDraft,
  type AnswerDraft,
  type ContextDraft
} from './onboarding-support';

type HydrationOptions = {
  localPathAvailable: boolean;
  sourceType: ProjectCodeSource['type'];
  data?: ProjectOnboarding;
  hydrated: { current: string };
  setSourceType: (value: ProjectCodeSource['type']) => void;
  setSourceValue: (value: string) => void;
  setMode: (value: ProjectIntakeMode | null) => void;
  setAnswers: (value: AnswerDraft) => void;
  setUploadFiles: (value: File[]) => void;
  setContexts: (value: ContextDraft[]) => void;
  setStep: (value: 'mode' | 'intake' | 'review') => void;
};

export function useProjectOnboardingHydration(options: HydrationOptions) {
  useEffect(() => {
    if (!options.localPathAvailable && options.sourceType === 'local_git') {
      options.setSourceType('github');
      options.setSourceValue('');
    }
  }, [options.localPathAvailable, options.sourceType]);
  useEffect(() => {
    hydrateOnboarding(options);
  }, [options.data]);
}

function hydrateOnboarding(options: HydrationOptions) {
  const value = options.data;
  if (!value) return;
  const signature = `${value.project.id}:${value.intake?.revision ?? 0}`;
  if (options.hydrated.current === signature) return;
  options.hydrated.current = signature;
  const intakeMode = value.intake?.mode ?? null,
    source = onboardingSource(value);
  options.setMode(intakeMode);
  options.setAnswers(toAnswerDraft(value.intake?.answers ?? {}, onboardingGoal(value)));
  options.setSourceType(source.type);
  options.setSourceValue(source.value);
  options.setUploadFiles([]);
  options.setContexts((value.intake?.context_sources ?? []).map((item, index) => contextFromRecord(item, index)));
  options.setStep(onboardingStep(value, intakeMode));
}

function onboardingSource(value: ProjectOnboarding) {
  const source = value.intake?.code_source;
  if (!source) return { type: 'github' as const, value: '' };
  return { type: source.type, value: firstText(source.path, source.url, source.repository_url) };
}

function firstText(...values: Array<string | null | undefined>) {
  return values.find(Boolean) ?? '';
}

function onboardingGoal(value: ProjectOnboarding) {
  return firstText(value.brief?.content.goal, value.project.goal);
}

function onboardingStep(value: ProjectOnboarding, mode: ProjectIntakeMode | null) {
  if (!mode) return 'mode';
  return value.brief && hasSavedAnswers(value.intake?.answers) ? 'review' : 'intake';
}
