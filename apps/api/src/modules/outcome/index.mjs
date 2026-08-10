import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'outcome',
  dependencies: ['platform', 'execution', 'quality'],
  tables: ['outcome_requirements', 'outcome_evaluations', 'outcome_waivers'],
  commands: ['outcome_requirement.create', 'outcome.evaluate', 'outcome.waive'],
  events: ['outcome_requirement.created', 'outcome.evaluated', 'outcome.waived']
});
