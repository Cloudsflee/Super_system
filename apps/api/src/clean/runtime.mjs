import { loadCleanConfig } from './config.mjs';
import { initializeCleanDatabase, CleanNotReadyError } from './database.mjs';
import { RedactionPolicy } from './redaction.mjs';
import { CasStore } from './cas.mjs';
import { EventService } from './events.mjs';
import { OperationService } from './operations.mjs';
import { CleanPlatform } from './platform.mjs';
import { createCleanCommandRegistry } from './registry.mjs';
import { ReceiptService } from './receipts.mjs';
import { canonicalJson } from './canonical.mjs';
import { validateCleanOwnership } from './ownership.mjs';
import { AuthorizationService } from './authorization.mjs';
import { IdentityService } from './identity.mjs';
import { VaultAdapter } from './vault.mjs';
import { createFakeProviderAdapters } from './provider-adapters.mjs';
import { ProjectWorkflowService } from './project-workflow.mjs';
import { CleanContextService } from './context-service.mjs';
import { CleanMcpExchangeService } from './mcp-service.mjs';
import { CleanGatewayService } from './gateway-service.mjs';
import { CleanCommandDispatcher } from './command-dispatcher.mjs';
import { CleanAssistService } from './assist-service.mjs';
import { CleanFilesService } from './files-service.mjs';
import { CleanTerminalService } from './terminal-service.mjs';
import { CleanBridgeService } from './bridge-service.mjs';
import { DeterministicAppServerAdapter, ProcessAppServerAdapter } from './app-server-adapter.mjs';

export function createCleanRuntime(options = {}) {
  const config = options.config || loadCleanConfig(options.env || process.env);
  const targetVersion = Number(options.targetVersion || options.schemaVersion || (options.p5 || options.phase === 'p5' || options.cleanPhase === 'p5' ? 5 : (options.p4 || options.phase === 'p4' || options.cleanPhase === 'p4' ? 4 : (options.p3 || options.phase === 'p3' || options.cleanPhase === 'p3' ? 3 : 2))));
  const vaultMasterKey = options.vaultMasterKey || config.vaultMasterKey;
  if (typeof vaultMasterKey !== 'string' || vaultMasterKey.length < 16) throw new CleanNotReadyError('credential vault key is required', { reason: 'vault_key_missing', schema_family: 'v3-clean' });
  let initialized;
  try {
    initialized = initializeCleanDatabase({ file: options.databaseFile || config.databaseFile, options: { receiptRoot: options.receiptRoot || config.receiptRoot, runtimeBuild: config.runtimeBuild, bootstrapActorId: options.bootstrapActorId, failAt: options.failAt, now: options.now, targetVersion, projectScopeResolver: options.projectScopeResolver } });
  } catch (error) {
    if (error instanceof CleanNotReadyError) throw error;
    throw error;
  }
  const db = initialized.database;
  const projectScopeResolver = targetVersion >= 3
    ? (projectId, resource = {}) => Boolean(db.get('SELECT 1 AS ok FROM projects WHERE id=?', [String(projectId)])) && (typeof options.projectScopeResolver !== 'function' || options.projectScopeResolver(String(projectId), resource) !== false)
    : options.projectScopeResolver;
  const policy = options.policy || new RedactionPolicy();
  const events = new EventService({ db, policy, cursorSecret: config.cursorSecret, clock: options.now || undefined });
  const authorization = new AuthorizationService({ db, projectScopeResolver, clock: options.now || undefined });
  const platform = new CleanPlatform({ db, events, policy, bootstrapActorId: initialized.metadata.bootstrap_actor_id, authorize: authorization ? (context) => authorization.authorize(context, context.action, context.projectId, context.resource).allowed : null });
  const operations = new OperationService({ db, events, policy, bootstrapActorId: initialized.metadata.bootstrap_actor_id, clock: options.now || undefined });
  // The event service is the shared ledger coordinator.  Domain compatibility
  // adapters receive the same OperationService instance rather than issuing
  // inline operation SQL of their own.
  events.operations = operations;
  db.__cleanOperations = operations;
  platform.operations = operations;
  const cas = new CasStore({ root: options.casRoot || config.casRoot, db, policy });
  const receipts = new ReceiptService({ platform });
  const vault = new VaultAdapter({ root: options.vaultRoot || config.vaultRoot, masterKey: vaultMasterKey });
  const identity = new IdentityService({ db, events, operations, policy, bootstrapActorId: initialized.metadata.bootstrap_actor_id, sessionSecret: options.sessionSecret || config.sessionSecret, authorization, vault, clock: options.now || undefined, projectScopeResolver, providerAdapters: options.providerAdapters || createFakeProviderAdapters() });
  const projectWorkflow = targetVersion >= 3 ? new ProjectWorkflowService({ db, events, operations, policy, authorization, clock: options.now || undefined, repositoryAdapter: options.repositoryAdapter, generator: options.generator, critic: options.critic }) : null;
  const registry = createCleanCommandRegistry({ targetVersion });
  const context = targetVersion >= 4 ? new CleanContextService({ db, cas, events, operations, authorization, policy, clock: options.now || undefined, bootstrapActorId: initialized.metadata.bootstrap_actor_id }) : null;
  const mcp = targetVersion >= 4 ? new CleanMcpExchangeService({ db, context, operations, authorization, registry, policy, clock: options.now || undefined, pepper: options.mcpPepper || config.mcpPepper, bootstrapActorId: initialized.metadata.bootstrap_actor_id }) : null;
  const gateway = targetVersion >= 4 ? new CleanGatewayService({ db, policy, clock: options.now || undefined, secret: options.gatewaySecret || config.gatewaySecret, gatewayId: options.gatewayId || config.gatewayId || 'gateway-local' }) : null;
  const assistProvider = targetVersion >= 5
    ? (options.providerAdapter || createAssistProvider(options, config))
    : null;
  const assist = targetVersion >= 5 ? new CleanAssistService({ db, cas, events, operations, authorization, vault, clock: options.now || undefined, providerAdapter: assistProvider, providerAdapters: options.providerAdapters || {}, bootstrapActorId: initialized.metadata.bootstrap_actor_id, config }) : null;
  const files = targetVersion >= 5 ? new CleanFilesService({ db, cas, events, operations, authorization, projectWorkflow, clock: options.now || undefined, bootstrapActorId: initialized.metadata.bootstrap_actor_id, config }) : null;
  const terminal = targetVersion >= 5 ? new CleanTerminalService({ db, cas, events, operations, authorization, projectWorkflow, clock: options.now || undefined, config, pty: options.pty }) : null;
  const bridge = targetVersion >= 5 ? new CleanBridgeService({ db, events, operations, authorization, vault, clock: options.now || undefined, adapter: options.bridgeAdapter, config }) : null;
  const dispatcher = targetVersion >= 4 ? new CleanCommandDispatcher({ registry, context, mcp, gateway, projectWorkflow, operations, events, assist, files, terminal, bridge }) : null;
  if (mcp) mcp.dispatcher = dispatcher;
  const recovery = (async () => {
    const identityResult = await identity.recoverPending();
    const projectResult = await (projectWorkflow?.recoverPending?.() || 0);
    const contextResult = await (context?.recover() || 0);
    const assistResult = await (assist?.recoverPending?.() || 0);
    const filesResult = await (files?.recoverPending?.() || 0);
    const terminalResult = await (terminal?.recoverPending?.() || 0);
    const bridgeResult = await (bridge?.recoverPending?.() || 0);
    return [identityResult, projectResult, contextResult, assistResult, filesResult, terminalResult, bridgeResult];
  })();
  events.authorize = (context) => authorization.authorize({ actorId: context.actorId, effectiveActorId: context.actorId, scopes: ['*'] }, 'read', context.projectId, { events: context.events }).allowed;
  let casManifest;
  let ready = false;
  let readinessReason = null;
  try {
    casManifest = cas.verifyManifest(options.casManifest || null);
    ready = true;
  } catch (error) {
    readinessReason = String(error?.code || error?.message || 'cas_manifest_invalid');
  }
  const existingRetired = db.get("SELECT id FROM receipt_manifests WHERE kind='route.retired' ORDER BY created_at,id LIMIT 1");
  const retiredRouteReceipt = existingRetired?.id || platform.createReceipt({ kind: 'route.retired', payload: { code: 'route_retired', importer_command: 'import.inspect', schema_family: 'v3-clean' }, status: 'verified' }).receipt_id;
  const readinessReceipt = ready ? null : platform.createReceipt({ kind: 'startup.not_ready', payload: { reason: readinessReason, schema_family: 'v3-clean' }, status: 'failed' }).receipt_id;
  const ownership = validateCleanOwnership({
    tables: db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name),
    registry
  });
  if (!ownership.valid) {
    db.close();
    throw new CleanNotReadyError('clean ownership manifest is invalid', { reason: 'ownership_mismatch', ownership });
  }
  const runtime = {
    config,
    db,
    database: db,
    metadata: initialized.metadata,
    integrity: initialized.integrity,
    policy,
    events,
    platform,
    operations,
    cas,
    receipts,
    identity,
    projectWorkflow,
    context,
    mcp,
    gateway,
    assist,
    files,
    terminal,
    bridge,
    dispatcher,
    project: projectWorkflow,
    repository: projectWorkflow,
    workflow: projectWorkflow,
    authorization,
    vault,
    recovery,
    casManifest,
    registry,
    ownership,
    retiredRouteReceipt,
    readinessReceipt,
    ready,
    readinessReason,
    runtime: 'v3-clean',
    apiVersion: '2',
    p2: true,
    p3: targetVersion >= 3,
    p4: targetVersion >= 4,
    p5: targetVersion >= 5,
    health() {
      return { runtime: 'v3-clean', ready: this.ready, readiness_reason: this.readinessReason, readiness_receipt: this.readinessReceipt, schema_family: this.metadata.family, user_version: this.metadata.user_version, cas_manifest: this.casManifest || null, p2: this.p2, p3: this.p3, p4: this.p4, p5: this.p5 };
    },
    close() {
      this.terminal?.close?.();
      const providerClose = this.assist?.close?.();
      this.db.close();
      return Promise.resolve(providerClose);
    }
  };
  runtime.ready = false;
  runtime.recovery = Promise.resolve(recovery).then((result) => {
    runtime.ready = !readinessReason;
    return result;
  }).catch((error) => {
    runtime.ready = false;
    runtime.readinessReason = String(error?.code || 'recovery_failed');
    throw error;
  });
  return runtime;
}

function createAssistProvider(options, config) {
  const mode = String(options.providerMode || config.providerMode || 'process').toLowerCase();
  if (mode === 'deterministic') return new DeterministicAppServerAdapter(options.providerOptions || {});
  return new ProcessAppServerAdapter({
    command: options.providerCommand || config.providerCommand || 'codex',
    args: options.providerArgs || ['app-server', '--stdio'],
    timeoutMs: options.providerTimeoutMs || config.providerTimeoutMs || 30_000,
    env: options.providerEnv || process.env,
    homeRoot: options.providerHomeRoot || config.providerHomeRoot
  });
}

// A process-level startup failure still needs to expose /livez and /readyz.
// The degraded object deliberately has no repository, operation, or CAS
// service, so a not-ready process cannot accidentally accept business writes.
export function createNotReadyRuntime(options = {}, failure = null) {
  const config = options.config || loadCleanConfig(options.env || process.env);
  const policy = options.policy || new RedactionPolicy();
  const targetVersion = Number(options.targetVersion || options.schemaVersion || (options.p5 || options.phase === 'p5' || options.cleanPhase === 'p5' ? 5 : (options.p4 || options.phase === 'p4' || options.cleanPhase === 'p4' ? 4 : (options.p3 || options.phase === 'p3' || options.cleanPhase === 'p3' ? 3 : 2))));
  const registry = createCleanCommandRegistry({ targetVersion });
  const details = failure?.details && typeof failure.details === 'object' ? failure.details : {};
  const reason = String(details.reason || failure?.code || 'startup_failed');
  const metadata = Object.freeze({
    family: String(details.schema_family || 'v3-clean'),
    baseline_id: '001-clean-baseline',
    user_version: Number(details.actual_version || 0),
    bootstrap_actor_id: options.bootstrapActorId || 'actor_system_bootstrap'
  });
  return {
    config,
    db: null,
    database: null,
    metadata,
    integrity: null,
    policy,
    events: null,
    platform: null,
    operations: null,
    cas: null,
    receipts: null,
    identity: null,
    projectWorkflow: null,
    context: null,
    mcp: null,
    gateway: null,
    assist: null,
    files: null,
    terminal: null,
    bridge: null,
    dispatcher: null,
    project: null,
    repository: null,
    workflow: null,
    authorization: null,
    vault: null,
    recovery: Promise.resolve([]),
    registry,
    ownership: { valid: true, degraded: true },
    casManifest: null,
    retiredRouteReceipt: details.receipt_reference || null,
    readinessReceipt: details.receipt_reference || null,
    ready: false,
    readinessReason: reason,
    runtime: 'v3-clean',
    apiVersion: '2',
    p2: false,
    p3: false,
    p4: false,
    p5: false,
    health() {
      return { runtime: 'v3-clean', ready: false, readiness_reason: this.readinessReason, readiness_receipt: this.readinessReceipt, schema_family: this.metadata.family, user_version: this.metadata.user_version, cas_manifest: null, p2: false, p3: false, p4: false, p5: false };
    },
    close() {}
  };
}

export function readinessEnvelope(runtime) {
  return JSON.parse(canonicalJson(runtime.health()));
}
