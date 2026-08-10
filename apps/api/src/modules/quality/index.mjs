import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'quality',
  dependencies: ['platform', 'evidence'],
  tables: ['reviews', 'review_decisions', 'test_results', 'quality_review_runs', 'quality_review_reports', 'quality_review_events'],
  commands: ['review.create', 'review.decide', 'quality_review.create'],
  events: ['review.created', 'review.decided', 'quality.review.completed']
});
