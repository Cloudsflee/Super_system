import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { loadCleanConfig } from './config.mjs';
import { initializeCleanDatabase, CleanNotReadyError } from './database.mjs';
import { RedactionPolicy } from './redaction.mjs';
import { CasStore } from './cas.mjs';
import { EventService } from './events.mjs';
import { OperationService } from './operations.mjs';
import { CleanPlatform } from './platform.mjs';
import { createCleanCommandRegistry } from './registry.mjs';
import { ReceiptService } from './receipts.mjs';
import { canonicalJson, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import { validateCleanOwnership } from './ownership.mjs';
import { AuthorizationService } from './authorization.mjs';
import { IdentityService } from './identity.mjs';
import { VaultAdapter } from './vault.mjs';
import { createFakeProviderAdapters, createRealProviderAdapters } from './provider-adapters.mjs';
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
import { CleanRunnerService } from './runner-service.mjs';
import { CleanExecutionService } from './execution-service.mjs';
import { BrokerRunnerAdapter, BridgeJobAdapter, DeterministicRunnerAdapter, HostRunnerAdapter } from './runner-adapters.mjs';
import { CleanEvidenceService } from './evidence-service.mjs';
import { CleanParserService } from './parser-service.mjs';
import { CleanQualityService, DeterministicQualityAdviceAdapter, ProcessQualityAdviceAdapter } from './quality-service.mjs';
import { CleanOutcomeEvaluationService } from './outcome-evaluation-service.mjs';
import { BrokerParserAdapter, DeterministicParserAdapter } from './parser-adapters.mjs';
import { P7_PARSER_IMAGE_DIGEST } from './migrations/007-evidence-quality-parser-outcome.mjs';
import { P10_PARSER_IMAGE_DIGEST } from './migrations/009-final-business-parity-governance.mjs';
import { CleanP8Service } from './p8-service.mjs';
import { CleanP10Service } from './p10-service.mjs';
import { CleanLocalSetupService } from './local-setup-service.mjs';
import { CleanGithubSetupService } from './github-setup-service.mjs';
import { ProcessWorkflowGenerator, ProcessWorkflowCritic, LocalGitRepositoryAdapter } from './workflow-adapters.mjs';
import { GithubRepositoryAdapter, RepositoryAdapterRouter } from './github-repository-adapter.mjs';
import { GitHubAppAdapter, DeterministicGitHubAdapter } from './p8/github-adapter.mjs';

export function createCleanRuntime(options = {}) {
  const config = options.config || loadCleanConfig(options.env || process.env);
  const targetVersion = targetVersionFromOptions(options);
  const runtimePhase = runtimePhaseFromOptions(options, targetVersion);
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
  const providerAdapters = options.providerAdapters || (targetVersion >= 9 && config.providerMode !== 'deterministic'
    ? createRealProviderAdapters({ config, fetchImpl: options.fetchImpl })
    : createFakeProviderAdapters());
  const identity = new IdentityService({ db, events, operations, policy, bootstrapActorId: initialized.metadata.bootstrap_actor_id, sessionSecret: options.sessionSecret || config.sessionSecret, authorization, vault, clock: options.now || undefined, projectScopeResolver, providerAdapters });
  const workflowGenerator = options.generator || (targetVersion >= 9 && config.providerMode !== 'deterministic' ? new ProcessWorkflowGenerator({ config, credentialResolver: (input) => input.provider_profile_id && input.principal_actor_id ? identity.leaseProviderCredential(input.provider_profile_id, { actorId: input.principal_actor_id }) : null }) : null);
  const workflowCritic = options.critic || (targetVersion >= 9 && config.providerMode !== 'deterministic' ? new ProcessWorkflowCritic({ generator: workflowGenerator }) : null);
  // One transport instance is shared by P8 Delivery, P10 deletion and the
  // Repository adapter. This keeps JWT/token exchange and error semantics in
  // one owner while the resolver below enforces actor/Vault boundaries.
  const githubTransport = options.githubAdapter || options.githubTransport || (config.providerMode === 'deterministic' ? new DeterministicGitHubAdapter() : new GitHubAppAdapter({ fetchImpl: options.fetchImpl }));
  const resolveGithubAuth = (profileId, principal) => {
    const actorId = String(principal?.actorId || principal?.actor_id || '').trim();
    if (!actorId) throw new PlatformError('authentication_required', 'active session proof is required', {}, 401);
    const profile = db.get("SELECT * FROM provider_profiles WHERE id=?", [String(profileId)]);
    if (!profile) throw new PlatformError('github_profile_not_found', 'GitHub provider profile is not available', {}, 404);
    if (String(profile.owner_actor_id) !== actorId) throw new PlatformError('permission_denied', 'GitHub provider profile belongs to another actor', {}, 403);
    if (String(profile.provider || '').toLowerCase() !== 'github') throw new PlatformError('github_profile_unavailable', 'GitHub provider profile is unavailable', {}, 409);
    if (profile.status !== 'available' || profile.lifecycle_status === 'disabled') throw new PlatformError('github_profile_unavailable', 'GitHub provider profile is unavailable', {}, 409);
    const credential = db.get("SELECT * FROM credential_refs WHERE id=? AND owner_actor_id=?", [profile.credential_ref_id, actorId]);
    if (!credential || credential.provider !== 'github' || credential.status !== 'active' || !String(credential.external_ref || '').startsWith('vault:')) {
      throw new PlatformError('credential_rebind_required', 'GitHub credential must be rebound', {}, 409);
    }
    let lease;
    try {
      lease = Buffer.from(vault.read(credential.external_ref));
    } catch {
      throw new PlatformError('credential_rebind_required', 'GitHub credential lease is unavailable', {}, 409);
    }
    let privateKey = null;
    try {
      const bundle = parseGithubCredentialBundle(lease);
      const configValue = parseProfileConfig(profile.config_json);
      privateKey = Buffer.from(String(bundle.private_key || bundle.privateKey || bundle.key || ''), 'utf8');
      const appId = String(configValue.app_id || configValue.appId || bundle.app_id || bundle.appId || '').trim();
      const installationId = String(configValue.installation_id || configValue.installationId || bundle.installation_id || bundle.installationId || '').trim();
      if (!privateKey.length || !appId || !installationId) throw new PlatformError('github_app_identity_missing', 'GitHub App and Installation identity are required', {}, 409);
      const auth = { appId, installationId, privateKey };
      // Keep the historical resolver return shape (`appId`, `installationId`,
      // `privateKey`) while attaching non-enumerable policy context for the
      // Repository adapter's second, defensive validation.
      Object.defineProperties(auth, {
        profile: { value: { owner_actor_id: profile.owner_actor_id, provider: profile.provider, status: profile.status, lifecycle_status: profile.lifecycle_status }, enumerable: false },
        credential: { value: { status: credential.status, external_ref: credential.external_ref }, enumerable: false }
      });
      return auth;
    } catch (error) {
      privateKey?.fill(0);
      if (error instanceof PlatformError) throw error;
      throw new PlatformError('github_app_identity_missing', 'GitHub App credential bundle is invalid', {}, 409);
    } finally {
      lease.fill(0);
    }
  };
  const repositoryAdapter = options.repositoryAdapter || (targetVersion >= 9 && config.providerMode !== 'deterministic'
    ? new RepositoryAdapterRouter({ local: new LocalGitRepositoryAdapter({ vault, maxBytes: config.repositoryMaxBytes || 100 * 1024 * 1024 }), github: new GithubRepositoryAdapter({ githubTransport, authResolver: resolveGithubAuth, vault, maxFiles: config.repositoryMaxFiles || 10_000, maxBytes: config.repositoryMaxBytes || 100 * 1024 * 1024 }) })
    : null);
  const projectWorkflow = targetVersion >= 3 ? new ProjectWorkflowService({ db, events, operations, policy, authorization, clock: options.now || undefined, repositoryAdapter, identity, cas, config, generator: workflowGenerator, critic: workflowCritic }) : null;
  const registry = createCleanCommandRegistry({ targetVersion, runtimePhase });
  // Files owns all host-workspace reads.  Construct it before Context so a
  // file-backed source can only cross that owner boundary.
  const files = targetVersion >= 5 ? new CleanFilesService({ db, cas, events, operations, authorization, projectWorkflow, clock: options.now || undefined, bootstrapActorId: initialized.metadata.bootstrap_actor_id, config }) : null;
  const context = targetVersion >= 4 ? new CleanContextService({ db, cas, events, operations, authorization, policy, files, clock: options.now || undefined, bootstrapActorId: initialized.metadata.bootstrap_actor_id, config }) : null;
  const mcp = targetVersion >= 4 ? new CleanMcpExchangeService({ db, context, operations, authorization, registry, policy, clock: options.now || undefined, pepper: options.mcpPepper || config.mcpPepper, bootstrapActorId: initialized.metadata.bootstrap_actor_id }) : null;
  const gateway = targetVersion >= 4 ? new CleanGatewayService({ db, policy, clock: options.now || undefined, secret: options.gatewaySecret || config.gatewaySecret, gatewayId: options.gatewayId || config.gatewayId || 'gateway-local' }) : null;
  const assistProvider = targetVersion >= 5
    ? (options.providerAdapter || createAssistProvider(options, config))
    : null;
  const assist = targetVersion >= 5 ? new CleanAssistService({ db, cas, events, operations, authorization, vault, clock: options.now || undefined, providerAdapter: assistProvider, providerAdapters: options.providerAdapters || {}, bootstrapActorId: initialized.metadata.bootstrap_actor_id, config }) : null;
  const terminal = targetVersion >= 5 ? new CleanTerminalService({ db, cas, events, operations, authorization, projectWorkflow, clock: options.now || undefined, config, pty: options.pty }) : null;
  const bridge = targetVersion >= 5 ? new CleanBridgeService({ db, events, operations, authorization, vault, clock: options.now || undefined, adapter: options.bridgeAdapter, config }) : null;
  const runnerAdapters = targetVersion >= 6 ? createRunnerAdapters({ options, config, bridge, db, vault }) : null;
  const runner = targetVersion >= 6 ? new CleanRunnerService({ db, events, operations, authorization, vault, cas, adapters: runnerAdapters, clock: options.now || undefined, pollIntervalMs: options.runnerPollIntervalMs || config.runnerPollIntervalMs, config }) : null;
  const execution = targetVersion >= 6 ? new CleanExecutionService({ db, events, operations, authorization, runner, projectWorkflow, assist, cas, clock: options.now || undefined, config, sleep: options.runnerSleep, retryDelays: options.runnerRetryDelays }) : null;
  const evidence = targetVersion >= 7 ? new CleanEvidenceService({ db, cas, events, operations, authorization, files, clock: options.now || undefined, config, bootstrapActorId: initialized.metadata.bootstrap_actor_id }) : null;
  const parserAdapter = targetVersion >= 7 ? createParserAdapter(options, config, targetVersion) : null;
  const parser = targetVersion >= 7 ? new CleanParserService({ db, cas, events, operations, authorization, evidence, adapter: parserAdapter, clock: options.now || undefined, pollIntervalMs: options.parserPollIntervalMs || config.parserPollIntervalMs, sleep: options.parserSleep, retryDelays: options.parserRetryDelays, serviceIdentity: options.parserServiceIdentity, bootstrapActorId: initialized.metadata.bootstrap_actor_id }) : null;
  const qualityAdviceAdapter = targetVersion >= 9
    ? (options.qualityAdviceAdapter || (config.providerMode === 'deterministic' ? new DeterministicQualityAdviceAdapter() : new ProcessQualityAdviceAdapter({ command: config.providerCommand, timeoutMs: config.providerTimeoutMs, homeRoot: config.providerHomeRoot })))
    : null;
  const quality = targetVersion >= 7 ? new CleanQualityService({ db, cas, events, operations, authorization, evidence, vault, adviceAdapter: qualityAdviceAdapter, clock: options.now || undefined, bootstrapActorId: initialized.metadata.bootstrap_actor_id }) : null;
  const outcomeEvaluation = targetVersion >= 7 ? new CleanOutcomeEvaluationService({ db, events, operations, authorization, clock: options.now || undefined, bootstrapActorId: initialized.metadata.bootstrap_actor_id }) : null;
  if (execution && evidence) execution.checkEvidence = evidence;
  const p8Service = targetVersion >= 8 ? new CleanP8Service({ db, cas, events, operations, authorization, vault, projectWorkflow, githubAdapter: githubTransport, operationsAdapter: options.operationsAdapter, config, clock: options.now || undefined, bootstrapActorId: initialized.metadata.bootstrap_actor_id }) : null;
  const p10Service = targetVersion >= 9 ? new CleanP10Service({ db, cas, events, operations, authorization, vault, assist, githubAdapter: p8Service?.github || githubTransport, repositoryDeletionAdapter: options.repositoryDeletionAdapter, clock: options.now || undefined }) : null;
  const localSetup = targetVersion >= 9 ? new CleanLocalSetupService({ config, db, identity, operations, clock: options.now || undefined, deviceLoginRunner: options.deviceLoginRunner, spawnImpl: options.deviceLoginSpawn }) : null;
  const githubSetup = targetVersion >= 9 ? new CleanGithubSetupService({ config, identity, vault, p8Service, fetchImpl: options.githubSetupFetch || options.fetchImpl, clock: options.now || undefined }) : null;
  const dispatcher = targetVersion >= 4 ? new CleanCommandDispatcher({ registry, context, mcp, gateway, projectWorkflow, operations, events, identity, assist, files, terminal, bridge, runner, execution, evidence, parser, quality, outcomeEvaluation, p8Service, p10Service, localSetup, githubSetup }) : null;
  if (mcp) mcp.dispatcher = dispatcher;
  const recovery = (async () => {
    const identityResult = await identity.recoverPending();
    const projectResult = await (projectWorkflow?.recoverPending?.() || 0);
    const contextResult = await (context?.recover() || 0);
    const assistResult = await (assist?.recoverPending?.() || 0);
    const filesResult = await (files?.recoverPending?.() || 0);
    const terminalResult = await (terminal?.recoverPending?.() || 0);
    const bridgeResult = await (bridge?.recoverPending?.() || 0);
    const executionResult = await (execution?.recoverPending?.() || 0);
    const evidenceResult = await (evidence?.recoverPending?.() || 0);
    const parserResult = await (parser?.recoverPending?.() || 0);
    const qualityResult = await (quality?.recoverPending?.() || 0);
    const outcomeResult = await (outcomeEvaluation?.recoverPending?.() || 0);
    const p8Result = await (p8Service?.recoverPending?.() || 0);
    const p10Result = await (p10Service?.recoverPending?.() || 0);
    const localSetupResult = await (localSetup?.recover?.() || 0);
    return [identityResult, projectResult, contextResult, assistResult, filesResult, terminalResult, bridgeResult, executionResult, evidenceResult, parserResult, qualityResult, outcomeResult, p8Result, p10Result, localSetupResult];
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
    runner,
    execution,
    evidence,
    parser,
    parserAdapter,
    quality,
    outcomeEvaluation,
    p8Service,
    p10Service,
    localSetup,
    githubSetup,
    githubTransport,
    repositoryAdapter,
    resolveGithubAuth,
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
    runtimePhase,
    p2: true,
    p3: targetVersion >= 3,
    p4: targetVersion >= 4,
    p5: targetVersion >= 5,
    p6: targetVersion >= 6,
    p7: targetVersion >= 7,
    p8: targetVersion >= 8,
    p9: runtimePhase >= 9,
    p10: runtimePhase >= 10,
    health() {
      return { runtime: 'v3-clean', runtime_phase: this.runtimePhase, ready: this.ready, readiness_reason: this.readinessReason, readiness_receipt: this.readinessReceipt, schema_family: this.metadata.family, user_version: this.metadata.user_version, cas_manifest: this.casManifest || null, p2: this.p2, p3: this.p3, p4: this.p4, p5: this.p5, p6: this.p6, p7: this.p7, p8: this.p8, p9: this.p9, p10: this.p10 };
    },
    close() {
      const localSetupClose = this.localSetup?.close?.();
      this.terminal?.close?.();
      this.evidence?.close?.();
      this.outcomeEvaluation?.close?.();
      const providerClose = this.assist?.close?.();
      this.db.close();
      return Promise.all([Promise.resolve(providerClose), Promise.resolve(localSetupClose)]).then(() => undefined);
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
  const targetVersion = targetVersionFromOptions(options);
  const runtimePhase = runtimePhaseFromOptions(options, targetVersion);
  const registry = createCleanCommandRegistry({ targetVersion, runtimePhase });
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
    runner: null,
    execution: null,
    evidence: null,
    parser: null,
    parserAdapter: null,
    quality: null,
    outcomeEvaluation: null,
    p8Service: null,
    p10Service: null,
    localSetup: null,
    githubSetup: null,
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
    runtimePhase,
    p2: false,
    p3: false,
    p4: false,
    p5: false,
    p6: false,
    p7: false,
    p8: false,
    p9: false,
    p10: false,
    health() {
      return { runtime: 'v3-clean', runtime_phase: this.runtimePhase, ready: false, readiness_reason: this.readinessReason, readiness_receipt: this.readinessReceipt, schema_family: this.metadata.family, user_version: this.metadata.user_version, cas_manifest: null, p2: false, p3: false, p4: false, p5: false, p6: false, p7: false, p8: false, p9: false, p10: false };
    },
    close() {}
  };
}

export function readinessEnvelope(runtime) {
  return JSON.parse(canonicalJson(runtime.health()));
}

function createRunnerAdapters({ options, config, bridge, db, vault }) {
  if (options.runnerAdapters) return options.runnerAdapters;
  const bridgeJobs = bridge ? new BridgeJobAdapter({
    bridgeAdapter: bridge.adapter,
    leaseForProfile(profile) {
      const device = db.get('SELECT * FROM bridge_devices WHERE id=?', [String(profile?.bridge_device_id || '')]);
      if (!device || device.status !== 'paired') throw new CleanNotReadyError('paired Windows Bridge device is unavailable', { reason: 'bridge_unavailable' });
      return { secretRef: device.shared_secret_ref, secret: vault.read(device.shared_secret_ref) };
    }
  }) : null;
  return {
    host: options.hostRunnerAdapter || (config.providerMode === 'deterministic' ? new DeterministicRunnerAdapter({ type: 'host', clock: options.now || undefined }) : new HostRunnerAdapter({ homeRoot: config.runnerHomeRoot, clock: options.now || undefined, identity: hostIdentity(vault) })),
    docker: options.dockerRunnerAdapter || new BrokerRunnerAdapter({ baseUrl: config.runnerBrokerUrl, secret: config.runnerBrokerSecret, clock: options.runnerClock }),
    ...(bridgeJobs ? { windows_bridge: options.bridgeRunnerAdapter || bridgeJobs } : {})
  };
}

function createParserAdapter(options, config, targetVersion) {
  if (options.parserAdapter) return options.parserAdapter;
  if (config.parserBrokerUrl) return new BrokerParserAdapter({ baseUrl: config.parserBrokerUrl, secret: config.parserBrokerSecret, clock: options.parserClock });
  const phaseDigest = Number(targetVersion) >= 9 ? P10_PARSER_IMAGE_DIGEST : P7_PARSER_IMAGE_DIGEST;
  const configuredDigest = config.parserImageDigest && config.parserImageDigest !== P7_PARSER_IMAGE_DIGEST ? config.parserImageDigest : phaseDigest;
  return new DeterministicParserAdapter({ clock: options.parserClock || options.now || undefined, execute: options.parserExecute, identity: options.parserWorkerIdentity, imageDigest: configuredDigest });
}

function parseProfileConfig(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseGithubCredentialBundle(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bundle_object_required');
    return parsed;
  } catch {
    // A Vault credential may deliberately contain only a PEM key while App
    // and installation identifiers remain profile metadata.
    if (/-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----/.test(text)) return { private_key: text };
    throw new Error('github_bundle_invalid');
  }
}

function targetVersionFromOptions(options = {}) {
  if (options.targetVersion != null || options.schemaVersion != null) return Number(options.targetVersion ?? options.schemaVersion);
  if (options.p10 || options.phase === 'p10' || options.cleanPhase === 'p10' || Number(options.runtimePhase) >= 10) return 9;
  if (options.p9 || options.phase === 'p9' || options.cleanPhase === 'p9' || Number(options.runtimePhase) >= 9) return 8;
  for (const version of [8, 7, 6, 5, 4, 3]) if (options[`p${version}`] || options.phase === `p${version}` || options.cleanPhase === `p${version}`) return version;
  return 2;
}

function runtimePhaseFromOptions(options = {}, targetVersion = targetVersionFromOptions(options)) {
  if (options.runtimePhase != null) return Number(options.runtimePhase);
  for (const phase of [10, 9, 8, 7, 6, 5, 4, 3, 2]) {
    if (options[`p${phase}`] || options.phase === `p${phase}` || options.cleanPhase === `p${phase}`) return phase;
  }
  return Number(targetVersion);
}
function hostIdentity(vault) {
  const ref = 'host-runner-signing-v1';
  if (!vault.has(ref)) {
    const identity = generateKeyPairSync('ed25519'); const bytes = Buffer.from(identity.privateKey.export({type:'pkcs8',format:'pem'}));
    try { vault.put(ref,bytes); } finally { bytes.fill(0); }
  }
  const bytes = vault.read(ref);
  try { const privateKey = createPrivateKey(bytes); return {privateKey,publicKey:createPublicKey(privateKey)}; } finally { bytes.fill(0); }
}
