import { assertCleanV2 } from '@aiws/contracts/clean-v2';
import { PlatformError } from './platform-error.mjs';

/** Shared P4 command boundary used by REST, MCP HTTP, stdio and Gateway. */
export class CleanCommandDispatcher {
  constructor({ registry, context, mcp, gateway, projectWorkflow, operations, events, identity = null, assist = null, files = null, terminal = null, bridge = null, runner = null, execution = null, evidence = null, parser = null, quality = null, outcomeEvaluation = null, p8Service = null, p10Service = null } = {}) {
    if (!registry || !context || !mcp || !operations || !events) throw new TypeError('clean_dispatcher_dependencies_required');
    this.registry = registry;
    this.context = context;
    this.mcp = mcp;
    this.gateway = gateway;
    this.projectWorkflow = projectWorkflow;
    this.operations = operations;
    this.events = events;
    this.identity = identity;
    this.assist = assist;
    this.files = files;
    this.terminal = terminal;
    this.bridge = bridge;
    this.runner = runner;
    this.execution = execution;
    this.evidence = evidence;
    this.parser = parser;
    this.quality = quality;
    this.outcomeEvaluation = outcomeEvaluation;
    this.p8Service = p8Service;
    this.p10Service = p10Service;
    this.handlers = new Map();
    this.exposed = new Set();
    this.#registerHandlers();
    this.#validateInventory();
  }

  tools() {
    return [...this.exposed].map((commandId) => {
      const entry = this.registry.get(commandId);
      return {
        name: entry.mcp.name,
        command_id: entry.command_id,
        mapping: entry.mcp.mapping,
        description: `${entry.owner} ${entry.command_id}`,
        input_schema: entry.input_schema,
        output_schema: entry.output_schema
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  entryFor(name) {
    const value = String(name || '');
    return this.registry.entries.find((entry) => this.handlers.has(entry.command_id) && (
      entry.command_id === value || entry.mcp.name === value || entry.command_id.replaceAll('.', '_') === value
    )) || null;
  }

  async dispatch(name, args = {}, principal, options = {}) {
    const entry = this.entryFor(name);
    if (!entry) throw new PlatformError('unknown_command', `unknown Clean command: ${String(name || '')}`, {}, 404);
    const transport = String(options.transport || 'internal');
    if (!['internal', 'rest', 'web', 'mcp', 'gateway'].includes(transport)) {
      throw new PlatformError('transport_invalid', 'Clean command transport is invalid', { transport }, 400);
    }
    if (transport !== 'internal' && Array.isArray(entry.transport_allowlist) && !entry.transport_allowlist.includes(transport)) {
      throw new PlatformError('transport_not_allowed', 'Clean command is not available on this transport', { command_id: entry.command_id, transport }, 403);
    }
    const input = normalizeInput(entry.command_id, args);
    assertCleanV2(entry.input_schema, input);
    let result = await this.handlers.get(entry.command_id)(args, principal);
    // Keep domain adapters ergonomic for direct callers while exposing the
    // registered receipt shape consistently to every transport.
    if (entry.command_id === 'assist.session.create' && result && result.id && !result.session) {
      result = { session: result, operation: null };
    }
    assertCleanV2(entry.output_schema, result);
    return { command_id: entry.command_id, command_version: entry.version, result };
  }

  inventory() {
    return [...this.handlers.keys()].sort().map((commandId) => ({
      command_id: commandId,
      exposed: this.exposed.has(commandId),
      transport_allowlist: [...(this.registry.get(commandId)?.transport_allowlist || ['rest', 'web', 'mcp', 'gateway'])],
      handler: 'CleanCommandDispatcher'
    }));
  }

  #add(commandId, handler, { exposed = true } = {}) {
    if (this.handlers.has(commandId)) throw new Error(`dispatcher_duplicate_handler:${commandId}`);
    this.handlers.set(commandId, handler);
    if (exposed) this.exposed.add(commandId);
  }

  #registerHandlers() {
    const add = (id, handler, options) => this.#add(id, handler, options);
    add('context.source.list', (args, principal) => ({ sources: this.context.listSources(args.project_id, principal, args.q || args.query || '') }));
    add('context.source.create', (args, principal) => this.context.createSource(args.project_id, args, principal));
    add('context.map', (args, principal) => this.context.map(args.project_id, principal));
    add('context.search', (args, principal) => ({ results: this.context.search(args.project_id, principal, args.q || args.query || '', args) }));
    add('context.read', (args, principal) => this.context.read(args.project_id, args.node_id, principal, args));
    add('context.node.get', (args, principal) => this.context.read(args.project_id, args.node_id, principal, args));
    add('context.node.versions', (args, principal) => ({ versions: this.context.versions(args.project_id, args.node_id, principal) }));
    add('context.policy.get', (args, principal) => this.context.policy(args.project_id, principal));
    add('context.policy.update', (args, principal) => this.context.updatePolicy(args.project_id, args, principal));
    add('context.selection.list', (args, principal) => ({ selections: this.context.listSelections(args.project_id, principal) }));
    add('context.selection.create', (args, principal) => this.context.createSelection(args.project_id, args, principal));
    add('context.pack.list', (args, principal) => ({ packs: this.context.listPacks(args.project_id, principal) }));
    add('context.pack.get', (args, principal) => this.context.getPack(args.project_id, args.pack_id, principal));
    add('context.pack.create', (args, principal) => this.context.createPack(args.project_id, args, principal));
    add('context.projection.status', (args, principal) => this.context.status(args.project_id, principal));
    add('context.projection.rebuild', async (args, principal) => this.#operationResult(await this.context.rebuild(args.project_id, args, principal), principal));
    add('context.projection.jobs', (args, principal) => ({ jobs: this.context.jobs(args.project_id, principal) }));
    add('context.projection.job', (args, principal) => this.context.job(args.project_id, args.job_id, principal));
    add('context.projection.events', (args, principal) => this.context.eventsForJob(args.project_id, args.job_id, principal, args.cursor || 0, args.limit || 500));
    add('context.projection.cancel', async (args, principal) => this.#operationResult(await this.context.cancel(args.project_id, args.job_id, args, principal), principal));
    add('context.projection.retry', async (args, principal) => this.#operationResult(await this.context.retry(args.project_id, args.job_id, args, principal), principal));
    add('mcp.tools.list', () => ({ tools: this.tools() }), { exposed: false });
    add('mcp.client.list', (args, principal) => ({ clients: this.mcp.listClients(principal, args.project_id) }));
    add('mcp.client.create', (args, principal) => this.mcp.createClient(args, principal));
    add('mcp.client.revoke', (args, principal) => this.mcp.revokeClient(args.client_id || args.id, args, principal));
    add('exchange.request.list', (args, principal) => ({ requests: this.mcp.listExchangeRequests(args.project_id, principal) }));
    add('exchange.request.create', (args, principal) => this.mcp.createExchangeRequest(args, principal));
    add('exchange.request.approve', (args, principal) => this.mcp.approveExchange(args.request_id || args.id, args, principal));
    add('exchange.request.reject', (args, principal) => this.mcp.rejectExchange(args.request_id || args.id, args, principal));
    add('exchange.grant.list', (args, principal) => ({ grants: this.mcp.listGrants(args.project_id, principal) }));
    add('exchange.grant.revoke', (args, principal) => this.mcp.revokeGrant(args.grant_id || args.id, args, principal));
    add('exchange.grant.pack.create', (args, principal) => this.mcp.createGrantPack(args.grant_id || args.id, args, principal));
    add('gateway.receipt.get', (args) => this.gateway.receipt(args.id), { exposed: false });
    add('project.get', (args, principal) => this.projectWorkflow.getProject(args.id, principal));
    add('operations.get', (args, principal) => this.operations.get(args.id, { actorId: actorOf(principal), projectId: args.project_id || null }));
    add('operations.events', (args, principal) => {
      const operation = this.operations.get(args.operation_id, { actorId: actorOf(principal), projectId: args.project_id || null });
      return this.events.replay({ actorId: actorOf(principal), projectId: operation.project_id, operationId: operation.operation_id, cursor: args.cursor || 0, limit: args.limit || 500 });
    });
    if (this.assist && this.files && this.terminal && this.bridge) this.#registerP5Handlers(add);
    if (this.runner && this.execution) this.#registerP6Handlers(add);
    if (this.evidence && this.parser && this.quality && this.outcomeEvaluation) this.#registerP7Handlers(add);
    if (this.p8Service) this.#registerP8Handlers(add);
    if (this.p10Service && this.identity) this.#registerP10Handlers(add);
  }

  #registerP10Handlers(add) {
    const bind = (id, handler) => add(id, handler, { exposed: this.registry.get(id)?.mcp?.exposed === true });
    bind('profile.update', (args, principal) => this.identity.updateProfile(args.id, args, principal));
    bind('profile.disable', (args, principal) => this.identity.disableProfile(args.id, args, principal));
    bind('profile.enable', (args, principal) => this.identity.enableProfile(args.id, args, principal));
    bind('brief.template.list', (args, principal) => this.p10Service.listBriefTemplates(args, principal));
    bind('brief.template.create', (args, principal) => this.p10Service.createBriefTemplate(args, principal));
    bind('brief.template.update', (args, principal) => this.p10Service.updateBriefTemplate(args.id, args, principal));
    bind('brief.template.archive', (args, principal) => this.p10Service.archiveBriefTemplate(args.id, args, principal));
    bind('project.deletion.prepare', (args, principal) => this.p10Service.prepareProjectDeletion(args.id, args, principal));
    bind('project.deletion.get', (args, principal) => this.p10Service.getProjectDeletion(args.id, principal));
    bind('project.deletion.confirm', (args, principal) => this.p10Service.confirmProjectDeletion(args.id, args, principal));
    bind('project.deletion.execute', (args, principal) => this.p10Service.executeProjectDeletion(args.id, args, principal));
    bind('project.deletion.cancel', (args, principal) => this.p10Service.cancelProjectDeletion(args.id, args, principal));
    bind('repository.deletion.prepare', (args, principal) => this.p10Service.prepareRepositoryDeletion(args.id, args, principal));
    bind('repository.deletion.get', (args, principal) => this.p10Service.getRepositoryDeletion(args.id, principal));
    bind('repository.deletion.creator_confirm', (args, principal) => this.p10Service.confirmRepositoryDeletion(args.id, 'creator', args, principal));
    bind('repository.deletion.owner_confirm', (args, principal) => this.p10Service.confirmRepositoryDeletion(args.id, 'owner', args, principal));
    bind('repository.deletion.execute', (args, principal) => this.p10Service.executeRepositoryDeletion(args.id, args, principal));
    bind('repository.deletion.reconcile', (args, principal) => this.p10Service.reconcileRepositoryDeletion(args.id, args, principal));
    bind('repository.deletion.cancel', (args, principal) => this.p10Service.cancelRepositoryDeletion(args.id, args, principal));
    bind('assist.session.metadata', (args, principal) => this.p10Service.updateAssistSession(args.id, args, principal));
    bind('assist.session.archive', (args, principal) => this.p10Service.archiveAssistSession(args.id || args.session_id, args, principal));
    bind('assist.session.restore', (args, principal) => this.p10Service.restoreAssistSession(args.id || args.session_id, args, principal));
    bind('assist.session.delete', (args, principal) => this.p10Service.deleteAssistSession(args.id || args.session_id, args, principal));
    bind('assist.session.restore_deleted', (args, principal) => this.p10Service.restoreDeletedAssistSession(args.id || args.session_id, args, principal));
    bind('assist.session.fork', (args, principal) => this.p10Service.forkAssistSession(args.id, args, principal));
    bind('assist.session.side_thread', (args, principal) => this.p10Service.forkAssistSession(args.id, args, principal, 'side_thread'));
    bind('assist.configuration.create', (args, principal) => this.p10Service.createAssistConfiguration(args.id, args, principal));
    bind('assist.review.comments', (args, principal) => this.p10Service.listAssistReviewComments(args.id, principal));
    bind('assist.review.comment', (args, principal) => this.p10Service.createAssistReviewComment(args.id, args, principal));
    bind('assist.review.request_changes', (args, principal) => this.p10Service.createAssistReviewComment(args.id, args, principal, 'request_changes'));
    bind('quality.policy.get', (args, principal) => this.quality.policy(args.id, principal));
    bind('quality.policy.update', (args, principal) => this.quality.updatePolicy(args.id, args, principal));
    bind('quality.prepare', (args, principal) => this.quality.prepare(args.id, args, principal));
    bind('quality.advice.get', (args, principal) => this.quality.advice(args.id, principal));
  }

  #registerP5Handlers(add) {
    const exposed = (id) => ({ exposed: this.registry.get(id)?.mcp?.exposed === true });
    const bind = (id, handler) => add(id, handler, exposed(id));

    bind('assist.session.list', (args, principal) => this.assist.listSessions(args, principal));
    bind('assist.session.create', (args, principal) => this.assist.createSession(args, principal));
    bind('assist.session.get', (args, principal) => this.assist.getSession(args.id || args.session_id, principal));
    bind('assist.turn.create', (args, principal) => this.assist.createTurn(args, principal));
    bind('assist.session.events', (args, principal) => this.assist.listEvents(args.id || args.session_id, args, principal));
    bind('assist.goal.get', (args, principal) => this.assist.getGoal(args.id || args.session_id, principal));
    bind('assist.goal.update', (args, principal) => this.assist.updateGoal(args.id || args.session_id, args, principal));
    bind('assist.reference.list', (args, principal) => this.assist.listReferences(args.id || args.session_id, principal));
    bind('assist.reference.create', (args, principal) => this.assist.createReference(args.id || args.session_id, args, principal));
    bind('assist.session.pause', (args, principal) => this.assist.pauseSession(args.id || args.session_id, args, principal));
    bind('assist.session.resume', (args, principal) => this.assist.resumeSession(args.id || args.session_id, args, principal));
    bind('assist.session.cancel', (args, principal) => this.assist.cancelSession(args.id || args.session_id, args, principal));
    bind('assist.turn.retry', (args, principal) => this.assist.retryTurn(args.id || args.turn_id, args, principal));
    bind('assist.turn.cancel', (args, principal) => this.assist.cancelTurn(args.id || args.turn_id, args, principal));
    bind('assist.turn.steer', (args, principal) => this.assist.steerTurn(args.id || args.turn_id, args, principal));
    bind('assist.turn.interrupt', (args, principal) => this.assist.interruptTurn(args.id || args.turn_id, args, principal));
    bind('assist.turn.follow-ups', (args, principal) => this.assist.steerTurn(args.id || args.turn_id, args, principal, 'assist.turn.follow-ups'));

    bind('file.list', (args, principal) => this.files.listFiles(args.project_id, args, principal));
    bind('file.get', (args, principal) => this.files.getFile(args.project_id, args.file_id || args.id, args, principal));
    bind('attachment.list', (args, principal) => this.files.listAttachments(args.project_id, args, principal));
    bind('attachment.create', (args, principal) => this.files.createAttachment(args, principal));
    bind('attachment.content', (args, principal) => this.files.attachmentContent(args.id || args.attachment_id, principal));
    bind('attachment.preview', (args, principal) => this.files.attachmentContent(args.id || args.attachment_id, principal, { preview: true }));
    bind('attachment.delete', (args, principal) => this.files.deleteAttachment(args.id || args.attachment_id, args, principal));
    bind('change.batch.list', (args, principal) => this.files.listBatches(args.project_id, principal));
    bind('change.batch.create', (args, principal) => this.files.createBatch(args, principal));
    bind('change.batch.review', (args, principal) => this.files.reviewBatch(args.id || args.batch_id, principal));
    bind('change.batch.approve', (args, principal) => this.files.approveBatch(args.id || args.batch_id, args, principal));
    bind('change.batch.apply', (args, principal) => this.files.applyBatch(args.id || args.batch_id, args, principal));
    bind('change.batch.undo', (args, principal) => this.files.undoBatch(args.id || args.batch_id, args, principal));

    bind('approval.list', (args, principal) => this.assist.listApprovals(args, principal));
    bind('approval.create', (args, principal) => this.assist.createApproval(args, principal));
    bind('approval.decide', (args, principal) => this.assist.decideApproval(args.id || args.approval_id, args, principal));
    bind('user.input.list', (args, principal) => this.assist.listInputs(args, principal));
    bind('user.input.create', (args, principal) => this.assist.createInput(args, principal));
    bind('user.input.answer', (args, principal) => this.assist.answerInput(args.id || args.input_id, args, principal));
    bind('user.input.cancel', (args, principal) => this.assist.cancelInput(args.id || args.input_id, args, principal));
    bind('proposal.list', (args, principal) => this.assist.listProposals(args, principal));
    bind('proposal.create', (args, principal) => this.assist.createProposal(args, principal));
    bind('proposal.apply', (args, principal) => this.assist.mutateProposal(args.id || args.proposal_id, 'apply', args, principal));
    bind('proposal.reject', (args, principal) => this.assist.mutateProposal(args.id || args.proposal_id, 'reject', args, principal));
    bind('proposal.undo', (args, principal) => this.assist.mutateProposal(args.id || args.proposal_id, 'undo', args, principal));

    bind('terminal.capabilities', () => this.terminal.capabilities());
    bind('terminal.list', (args, principal) => this.terminal.list(args, principal));
    bind('terminal.open', (args, principal) => this.terminal.open(args, principal));
    bind('terminal.get', (args, principal) => this.terminal.get(args.id || args.terminal_id, principal));
    bind('terminal.events', (args, principal) => this.terminal.eventsFor(args.id || args.terminal_id, args, principal));
    bind('terminal.ws', (args, principal) => this.terminal.get(args.id || args.terminal_id, principal));
    bind('terminal.resize', (args, principal) => this.terminal.resize(args.id || args.terminal_id, args, principal));
    bind('terminal.signal', (args, principal) => this.terminal.signal(args.id || args.terminal_id, args, principal));
    bind('terminal.stop', (args, principal) => this.terminal.stop(args.id || args.terminal_id, args, principal));

    bind('bridge.device.list', (args, principal) => this.bridge.list(args, principal));
    bind('bridge.pair', (args, principal) => this.bridge.pair(args, principal));
    bind('bridge.device.probe', (args, principal) => this.bridge.probe(args.id || args.device_id, args, principal));
    bind('bridge.device.rotate', (args, principal) => this.bridge.rotate(args.id || args.device_id, args, principal));
    bind('bridge.device.revoke', (args, principal) => this.bridge.revoke(args.id || args.device_id, args, principal));
    bind('bridge.transfer.list', (args, principal) => this.bridge.listTransfers(args.id || args.device_id, args, principal));
    bind('bridge.transfer.create', (args, principal) => this.bridge.createTransfer(args.id || args.device_id, args, principal));
  }

  #registerP6Handlers(add) {
    const exposed = (id) => ({ exposed: this.registry.get(id)?.mcp?.exposed === true });
    const bind = (id, handler) => add(id, handler, exposed(id));
    bind('runner.profile.list', (args, principal) => this.runner.listProfiles(args, principal));
    bind('runner.profile.create', (args, principal) => this.runner.createProfile(args, principal));
    bind('runner.profile.get', (args, principal) => ({ profile: this.runner.getProfile(args.profile_id || args.id, principal) }));
    bind('runner.profile.update', (args, principal) => this.runner.updateProfile(args.profile_id || args.id, args, principal));
    bind('runner.profile.probe', async (args, principal) => this.#operationResult(await this.runner.probeProfile(args.profile_id || args.id, args, principal), principal));
    bind('runner.profile.disable', (args, principal) => this.runner.disableProfile(args.profile_id || args.id, args, principal));

    bind('execution.list', (args, principal) => this.execution.list(args.project_id, args, principal));
    bind('execution.create', (args, principal) => this.execution.create(args.project_id, args, principal));
    bind('execution.get', (args, principal) => ({ execution: this.execution.get(args.execution_id || args.id, principal) }));
    bind('execution.events', (args, principal) => this.execution.eventsFor(args.execution_id || args.id, args, principal));
    bind('execution.attempts', (args, principal) => this.execution.attemptsFor(args.execution_id || args.id, args, principal));
    bind('execution.checkpoints', (args, principal) => this.execution.checkpointsFor(args.execution_id || args.id, args, principal));
    bind('execution.start', async (args, principal) => this.#operationResult(await this.execution.start(args.execution_id || args.id, args, principal), principal));
    bind('execution.pause', (args, principal) => this.execution.pause(args.execution_id || args.id, args, principal));
    bind('execution.resume', async (args, principal) => this.#operationResult(await this.execution.resume(args.execution_id || args.id, args, principal), principal));
    bind('execution.cancel', (args, principal) => this.execution.cancel(args.execution_id || args.id, args, principal));
    bind('execution.replan', (args, principal) => this.execution.replan(args.execution_id || args.id, args, principal));
    bind('execution.stage.replay', async (args, principal) => this.#operationResult(await this.execution.replayStage(args.execution_id || args.id, args.stage, args, principal), principal));
  }

  #registerP7Handlers(add) {
    const exposed = (id) => ({ exposed: this.registry.get(id)?.mcp?.exposed === true });
    const bind = (id, handler) => add(id, handler, exposed(id));

    bind('parser.format.list', (args, principal) => this.parser.listFormats(args, principal));
    bind('parser.run.start', async (args, principal) => this.#operationResult(await this.parser.start(args.asset_id, args.version_id, args, principal), principal));
    bind('parser.run.get', (args, principal) => this.parser.get(args.parser_run_id, principal));
    bind('parser.run.retry', async (args, principal) => this.#operationResult(await this.parser.retry(args.parser_run_id, args, principal), principal));
    bind('parser.run.cancel', (args, principal) => this.parser.cancel(args.parser_run_id, args, principal));

    bind('asset.list', (args, principal) => this.evidence.listAssets(args.project_id, args, principal));
    bind('asset.capture', (args, principal) => this.evidence.capture(args, principal));
    bind('asset.get', (args, principal) => this.evidence.getAsset(args.asset_id, principal));
    bind('asset.version.list', (args, principal) => this.evidence.listVersions(args.asset_id, principal));
    bind('asset.content', (args, principal) => this.evidence.content(args.asset_id, args.version_id, principal));
    bind('asset.relation.list', (args, principal) => this.evidence.listRelations(args.asset_id, principal));
    bind('asset.relation.create', (args, principal) => this.evidence.createRelation(args.asset_id, args, principal));
    bind('asset.attestation.list', (args, principal) => this.evidence.listAttestations(args.asset_id, principal));
    bind('asset.attest', (args, principal) => this.evidence.attest(args.asset_id, args, principal));
    bind('asset.tombstone', (args, principal) => this.evidence.tombstone(args.asset_id, args, principal));
    bind('evidence.execution.get', (args, principal) => this.evidence.executionEvidence(args.execution_id, principal));
    bind('evidence.trace.list', (args, principal) => this.evidence.listTraces(args.execution_id, principal));
    bind('evidence.digest.list', (args, principal) => this.evidence.listDigests(args.execution_id, principal));
    bind('evidence.test-result.list', (args, principal) => this.evidence.listTestResults(args.execution_id, principal));
    bind('evidence.code-change.list', (args, principal) => this.evidence.listCodeChanges(args.execution_id, principal));

    bind('quality.list', (args, principal) => this.quality.list(args.execution_id, args, principal));
    bind('quality.start', async (args, principal) => this.#operationResult(await this.quality.start(args.execution_id, args, principal), principal));
    bind('quality.get', (args, principal) => this.quality.get(args.quality_review_id, principal));
    bind('quality.events', (args, principal) => this.quality.eventsFor(args.quality_review_id, args, principal));
    bind('quality.report.get', (args, principal) => this.quality.report(args.quality_review_id, principal));
    bind('quality.decision', (args, principal) => this.quality.decision(args.quality_review_id, args, principal));
    bind('quality.cancel', (args, principal) => this.quality.cancel(args.quality_review_id, args, principal));
    bind('quality.retry', async (args, principal) => this.#operationResult(await this.quality.retry(args.quality_review_id, args, principal), principal));

    bind('outcome.get', (args, principal) => this.outcomeEvaluation.get(args.execution_id, principal));
    bind('outcome.evaluate', async (args, principal) => this.#operationResult(await this.outcomeEvaluation.evaluate(args.execution_id, args, principal), principal));
    bind('outcome.waiver.create', (args, principal) => this.outcomeEvaluation.createWaiver(args.execution_id, args, principal));
    bind('outcome.waiver.revoke', (args, principal) => this.outcomeEvaluation.revokeWaiver(args.waiver_id, args, principal));
  }

  #registerP8Handlers(add) {
    const bind = (id, handler) => add(id, handler, { exposed: this.registry.get(id)?.mcp?.exposed === true });
    bind('delivery.policy.list', (args, principal) => this.p8Service.listPolicies(args.project_id, principal));
    bind('delivery.policy.create', (args, principal) => this.p8Service.createPolicy(args.project_id, args, principal));
    bind('github.repository.list', (args, principal) => this.p8Service.listGithubRepositories(args.profile_id, args, principal));
    bind('delivery.list', (args, principal) => this.p8Service.listDeliveries(args, principal));
    bind('delivery.get', (args, principal) => this.p8Service.getDelivery(args.delivery_id || args.id, principal));
    bind('delivery.submit', async (args, principal) => this.#operationResult(await this.p8Service.submit(args, principal), principal));
    bind('delivery.intent.create', async (args, principal) => this.#operationResult(await this.p8Service.createIntent(args.delivery_id || args.id, 'create_draft', args, principal), principal));
    bind('delivery.intent.ready', async (args, principal) => this.#operationResult(await this.p8Service.createIntent(args.delivery_id || args.id, 'mark_ready', args, principal), principal));
    bind('delivery.intent.merge', async (args, principal) => this.#operationResult(await this.p8Service.createIntent(args.delivery_id || args.id, 'merge', args, principal), principal));
    bind('delivery.reconcile', async (args, principal) => this.#operationResult(await this.p8Service.createIntent(args.delivery_id || args.id, 'reconcile', args, principal), principal));
    bind('deployment.get', (args, principal) => this.p8Service.getDeployment(args, principal));
    bind('deployment.candidate.get', (args, principal) => this.p8Service.getDeploymentCandidate(args.candidate_id || args.id, principal));
    bind('deployment.candidate.create', (args, principal) => this.p8Service.createDeploymentCandidate(args, principal));
    bind('deployment.verify', async (args, principal) => this.#operationResult(await this.p8Service.verifyDeployment(args.candidate_id || args.id, args, principal), principal));
    bind('backup.list', (args, principal) => this.p8Service.listBackups(args, principal));
    bind('backup.create', async (args, principal) => this.#operationResult(await this.p8Service.createBackup(args, principal), principal));
    bind('restore.prepare', async (args, principal) => this.#operationResult(await this.p8Service.prepareRestore(args, principal), principal));
    bind('system.reset.prepare', async (args, principal) => this.#operationResult(await this.p8Service.prepareReset(args, principal), principal));
    bind('import.list', (args, principal) => this.p8Service.listImports(args, principal));
    bind('import.get', (args, principal) => this.p8Service.getImport(args.import_id || args.id, principal));
    bind('operations.list', (args, principal) => this.p8Service.listOperations(args, principal));
    bind('operations.replay', async (args, principal) => this.#operationResult(await this.p8Service.replayOperation(args.operation_id || args.id, args, principal), principal));
    bind('cas.gc.plan', (args, principal) => this.p8Service.gcPlan(args, principal));
    bind('cas.gc.apply', (args, principal) => this.p8Service.gcApply(args, principal));
  }

  #validateInventory() {
    for (const commandId of this.handlers.keys()) {
      if (!this.registry.get(commandId)) throw new Error(`dispatcher_orphan_handler:${commandId}`);
    }
    for (const commandId of this.exposed) {
      const entry = this.registry.get(commandId);
      if (!entry?.mcp?.name) throw new Error(`dispatcher_exposed_mapping_missing:${commandId}`);
    }
  }

  #operationResult(value, principal) {
    const operationId = value?.operation?.operation_id || value?.operation_id;
    if (!operationId) throw new PlatformError('operation_required', 'long-running command did not return an operation', {}, 500);
    return this.operations.get(operationId, { actorId: actorOf(principal), projectId: value?.job?.project_id || value?.parser_run?.project_id || value?.quality_review?.project_id || value?.evaluation?.project_id || value?.project_id || null });
  }
}

function normalizeInput(commandId, value) {
  const args = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  if (commandId === 'project.get') return { id: String(args.id || args.project_id || '') };
  if (commandId === 'operations.get') return { id: String(args.id || args.operation_id || '') };
  if (commandId === 'operations.events') return {
    format: 'json',
    ...(args.cursor != null ? { cursor: String(args.cursor) } : {}),
    ...(args.limit != null ? { limit: Number(args.limit) } : {})
  };
  return args;
}

function actorOf(principal) {
  return String(principal?.effectiveActorId || principal?.actorId || '');
}
