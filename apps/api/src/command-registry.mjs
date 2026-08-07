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
    ['execution.evidence.resolve', (input, ctx) => domain.resolveEvidence(input.execution_id, input, ctx)],
    ['review.create', (input, ctx) => domain.createReview(input, ctx)],
    ['review.decide', (input, ctx) => domain.decideReview(input.review_id, input, ctx)],
    ['delivery.create', (input, ctx) => domain.createDelivery(input, ctx)],
    ['delivery.merge', (input, ctx) => domain.mergeDelivery(input.delivery_id, input, ctx)],
    ['delivery.retry', (input, ctx) => domain.retryDelivery(input.delivery_id, input, ctx)],
    ['integration.codex.probe', (input) => domain.probeCodex({ force: input?.force === true })],
    ['integration.github.probe', (input) => domain.probeGithub({ force: input?.force === true })],
    ['credential.create', (input, ctx) => domain.createCredential(input, ctx)],
    ['credential.rotate', (input, ctx) => domain.rotateCredential(input.credential_id, input, ctx)],
    ['credential.revoke', (input, ctx) => domain.revokeCredential(input.credential_id, input, ctx)],
    ['credential.delete', (input, ctx) => domain.deleteCredential(input.credential_id, input, ctx)],
    ['codex_profile.create', (input, ctx) => domain.createCodexProfile(input, ctx)],
    ['codex_profile.update', (input, ctx) => domain.updateCodexProfile(input.profile_id, input, ctx)],
    ['session.create', (input, ctx) => domain.createSession(input, ctx)],
    ['session.revoke', (input, ctx) => domain.revokeSession(input.session_id, input, ctx)],
    ['github_app.create', (input, ctx) => domain.createGithubAppConfig(input, ctx)],
    ['github_installation.create', (input, ctx) => domain.createGithubInstallation(input.app_config_id, input, ctx)],
    ['mcp_client.create', (input, ctx) => domain.createMcpClient(input, ctx)],
    ['mcp_client.revoke', (input, ctx) => domain.revokeMcpClient(input.client_id, input, ctx)],
    ['mcp_scope.request', (input, ctx) => domain.createMcpScopeRequest(input, ctx)],
    ['mcp_scope.grant', (input, ctx) => domain.grantMcpScope(input.request_id, input, ctx)],
    ['mcp_scope.revoke', (input, ctx) => domain.revokeMcpScope(input.grant_id, input, ctx)],
    ['node_contract.create', (input, ctx) => domain.createNodeContract(input.project_id, input, ctx)],
    ['workflow.generate', (input, ctx) => domain.generateWorkflow(input.project_id, input, ctx)],
    ['outcome_requirement.create', (input, ctx) => domain.createOutcomeRequirement(input.project_id, input, ctx)],
    ['outcome.evaluate', (input, ctx) => domain.evaluateOutcome(input.execution_id, input, ctx)],
    ['outcome.waive', (input, ctx) => domain.waiveOutcome(input.execution_id, input, ctx)],
    ['assist_session.create', (input, ctx) => domain.createAssistSession(input, ctx)],
    ['assist_turn.create', (input, ctx) => domain.createAssistTurn(input.session_id, input, ctx)],
    ['assist_session.transition', (input, ctx) => domain.transitionAssistSession(input.session_id, input, ctx)],
    ['change_batch.create', (input, ctx) => domain.createChangeBatch(input, ctx)],
    ['change_batch.apply', (input, ctx) => domain.applyChangeBatch(input.batch_id, input, ctx)],
    ['change_batch.rollback', (input, ctx) => domain.rollbackChangeBatch(input.batch_id, input, ctx)],
    ['attachment.create', (input, ctx) => domain.createAttachment(input.project_id, input, ctx)],
    ['context.rebuild', (input, ctx) => domain.rebuildContextMap(input.project_id, input, ctx)],
    ['context.selection.create', (input, ctx) => domain.createContextSelection(input.project_id, input, ctx)],
    ['quality_review.create', (input, ctx) => domain.createQualityReview(input.project_id, input, ctx)]
  ]);
  const privateCommands = new Set(['credential.create', 'credential.rotate', 'credential.revoke', 'credential.delete']);

  return {
    list() {
      return [...commands.keys()].filter((name) => !privateCommands.has(name)).sort();
    },
    async execute(name, input = {}, ctx = {}) {
      const handler = commands.get(name);
      if (!handler) throw new AppError('unknown_command', `unknown command: ${name}`, { status: 404 });
      return handler(input, ctx);
    }
  };
}
