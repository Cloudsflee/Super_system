import { assertCleanV2 } from '@aiws/contracts/clean-v2';
import { PlatformError } from './platform-error.mjs';

/** Shared P4 command boundary used by REST, MCP HTTP, stdio and Gateway. */
export class CleanCommandDispatcher {
  constructor({ registry, context, mcp, gateway, projectWorkflow, operations, events } = {}) {
    if (!registry || !context || !mcp || !operations || !events) throw new TypeError('clean_dispatcher_dependencies_required');
    this.registry = registry;
    this.context = context;
    this.mcp = mcp;
    this.gateway = gateway;
    this.projectWorkflow = projectWorkflow;
    this.operations = operations;
    this.events = events;
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

  async dispatch(name, args = {}, principal) {
    const entry = this.entryFor(name);
    if (!entry) throw new PlatformError('unknown_command', `unknown Clean command: ${String(name || '')}`, {}, 404);
    const input = normalizeInput(entry.command_id, args);
    assertCleanV2(entry.input_schema, input);
    const result = await this.handlers.get(entry.command_id)(args, principal);
    assertCleanV2(entry.output_schema, result);
    return { command_id: entry.command_id, command_version: entry.version, result };
  }

  inventory() {
    return [...this.handlers.keys()].sort().map((commandId) => ({
      command_id: commandId,
      exposed: this.exposed.has(commandId),
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
    return this.operations.get(operationId, { actorId: actorOf(principal), projectId: value?.job?.project_id || value?.project_id || null });
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
