import { AppError } from './errors.mjs';

export function createCommandRegistry(domain) {
  const commands = new Map([
    ['project.create', (input, ctx) => domain.createProject(input, ctx)],
    ['project.update', (input, ctx) => domain.updateProject(input.project_id, input, ctx)],
    ['brief.create', (input, ctx) => domain.createBrief(input.project_id, input, ctx)],
    ['workflow.create', (input, ctx) => domain.createWorkflow(input.project_id, input, ctx)],
    ['context.source.create', (input, ctx) => domain.createContextSource(input.project_id, input, ctx)],
    ['context.pack.create', (input, ctx) => domain.createContextPack(input.project_id, input, ctx)],
    ['asset.create', (input, ctx) => domain.createAsset(input.project_id, input, ctx)],
    ['execution.create', (input, ctx) => domain.createExecution(input.project_id, input, ctx)],
    ['execution.start', (input, ctx) => domain.startExecution(input.execution_id, input, ctx)],
    ['execution.cancel', (input, ctx) => domain.cancelExecution(input.execution_id, input, ctx)],
    ['review.create', (input, ctx) => domain.createReview(input, ctx)],
    ['review.decide', (input, ctx) => domain.decideReview(input.review_id, input, ctx)],
    ['delivery.create', (input, ctx) => domain.createDelivery(input, ctx)],
    ['delivery.merge', (input, ctx) => domain.mergeDelivery(input.delivery_id, input, ctx)]
  ]);

  return {
    list() {
      return [...commands.keys()].sort();
    },
    async execute(name, input = {}, ctx = {}) {
      const handler = commands.get(name);
      if (!handler) throw new AppError('unknown_command', `unknown command: ${name}`, { status: 404 });
      return handler(input, ctx);
    }
  };
}
