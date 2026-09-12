import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, opaqueId, sha256Hex } from '../canonical.mjs';
import { PlatformError } from '../platform-error.mjs';
import { appendAggregate, assertRevision, createOperation, priorResponse, requestHash, requireIdempotency, requirePrincipal, requireRevision, saveResponse, time } from '../p5-domain-helpers.mjs';
import { GitHubAppAdapter, verifyGitHubWebhook } from './github-adapter.mjs';
import { FilesystemOperationsAdapter } from './artifact-operations.mjs';

const TERMINAL_DELIVERY = new Set(['merged', 'failed', 'cancelled']);
const NON_REPLAYABLE = new Set(['delivery.intent.merge', 'backup.create', 'restore.prepare', 'system.reset.prepare', 'import.cutover', 'cas.gc.apply']);
const SUCCESSFUL_CHECKS = new Set(['success', 'neutral', 'skipped']);

export class CleanP8Service {
  constructor({ db, cas, events, operations, authorization, vault, projectWorkflow = null, githubAdapter = null, operationsAdapter = null, config = {}, clock, bootstrapActorId = 'actor_system_bootstrap' } = {}) {
    if (!db || !cas || !events || !operations || !authorization || !vault) throw new TypeError('p8_service_dependencies_required');
    Object.assign(this, { db, cas, events, operations, authorization, vault, projectWorkflow, config, clock, bootstrapActorId });
    this.github = githubAdapter || new GitHubAppAdapter();
    this.artifacts = operationsAdapter || new FilesystemOperationsAdapter({
      root: path.join(config.home || path.dirname(db.file), 'operations-artifacts'),
      components: { sqlite: db.file, cas: cas.root, vault: config.vaultRoot, workspace: config.workspaceRoot, broker: config.runnerHomeRoot, bridge: config.bridgeStateRoot, parser: config.parserStateRoot }
    });
    this.gcTrashRoot = path.resolve(config.gcTrashRoot || path.join(path.dirname(cas.root), 'trash'));
  }

  ownerInventory() {
    return Object.freeze({
      Delivery: Object.freeze(['delivery_policies', 'deliveries', 'pull_request_intents', 'delivery_events']),
      Deployment: Object.freeze(['deployment_candidates', 'deployment_verifications']),
      Importer: Object.freeze(['import_batches', 'import_checkpoints', 'import_id_map', 'import_conflicts']),
      Operations: Object.freeze(['backup_manifests'])
    });
  }

  listPolicies(projectId, principal) {
    this.#authorize(principal, 'read', projectId, 'delivery');
    return { policies: this.db.query('SELECT * FROM delivery_policies WHERE project_id=? ORDER BY created_at,id', [String(projectId)]).map(view) };
  }

  createPolicy(projectId, input, principal) {
    this.#authorize(principal, 'approve', projectId, 'delivery');
    const now = time(this.clock);
    const key = requireIdempotency(input.idempotency_key);
    const expected = requireRevision(input.expected_revision, { allowZero: true });
    const project = this.db.get('SELECT id,revision FROM projects WHERE id=?', [String(projectId)]);
    if (!project) throw new PlatformError('project_not_found', 'project not found', {}, 404);
    assertRevision(project, expected);
    const snapshot = { project_id: project.id, name: bounded(input.name, 120, 'policy name'), required_checks: stringArray(input.required_checks, 100), approval_policy: object(input.approval_policy) };
    const requestSha = requestHash(snapshot);
    const id = opaqueId('delivery_policy');
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'delivery.policy.create', idempotencyKey: key, requestHash: requestSha, now });
      if (prior) return prior;
      assertRevision(tx.get('SELECT revision FROM projects WHERE id=?', [project.id]), expected);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'delivery.policy.create', resourceType: 'delivery_policy', resourceId: id, projectId: project.id, requestHash: requestSha, idempotencyKey: key, status: 'succeeded', now });
      tx.run('INSERT INTO delivery_policies(id,project_id,name,required_checks_json,approval_policy_json,snapshot_sha256,revision,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,1,?,?)', [id, project.id, snapshot.name, canonicalJson(snapshot.required_checks), canonicalJson(snapshot.approval_policy), requestSha, now, principal.actorId]);
      const row = tx.get('SELECT * FROM delivery_policies WHERE id=?', [id]);
      appendAggregate(this.events, tx, aggregate(row, operation.id, principal.actorId, project.id, 'delivery.policy.created', now, 'delivery_policy'));
      const response = { policy: view(row), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'delivery.policy.create', idempotencyKey: key, requestHash: requestSha, response, operationId: operation.id, status: 201, now });
      return response;
    });
  }

  async listGithubRepositories(profileId, input, principal) {
    const profile = this.#githubProfile(profileId, principal);
    return this.#withGithubLease(profile, async (auth, config) => {
      const result = await this.github.listRepositories(auth, { cursor: input.cursor || null, limit: input.limit || 50 });
      const origin = String(config.origin_repository || '').toLowerCase();
      const fixture = String(config.fixture_repository || '').toLowerCase();
      if (origin && fixture && origin === fixture) throw new PlatformError('github_fixture_not_isolated', 'GitHub fixture repository must differ from origin', {}, 409);
      return { repositories: (result.repositories || []).map(publicRepository), next_cursor: result.next_cursor || null };
    });
  }

  listDeliveries(input, principal) {
    const projectId = String(input.project_id || '');
    this.#authorize(principal, 'read', projectId, 'delivery');
    const params = [projectId];
    const status = input.status ? ' AND status=?' : '';
    if (input.status) params.push(String(input.status));
    params.push(limit(input.limit, 500));
    return { deliveries: this.db.query(`SELECT * FROM deliveries WHERE project_id=?${status} ORDER BY created_at DESC,id LIMIT ?`, params).map(view) };
  }

  getDelivery(id, principal) {
    const row = this.#delivery(id, principal, 'read');
    return {
      delivery: view(row),
      intents: this.db.query('SELECT * FROM pull_request_intents WHERE delivery_id=? ORDER BY generation,id', [row.id]).map(view),
      events: this.db.query('SELECT id,intent_id,external_receipt_sha256,event_type,payload_sha256,created_at FROM delivery_events WHERE delivery_id=? ORDER BY created_at,id', [row.id]).map(view)
    };
  }

  submit(input, principal) {
    requirePrincipal(principal);
    const execution = this.db.get('SELECT * FROM executions WHERE id=?', [String(input.execution_id || '')]);
    if (!execution) throw new PlatformError('execution_not_found', 'execution not found', {}, 404);
    this.#authorize(principal, 'run', execution.project_id, 'delivery');
    const expected = requireRevision(input.expected_revision);
    assertRevision(execution, expected);
    const key = requireIdempotency(input.idempotency_key);
    const policy = this.db.get('SELECT * FROM delivery_policies WHERE id=? AND project_id=?', [String(input.policy_id || ''), execution.project_id]);
    const target = this.db.get('SELECT t.* FROM repository_targets t JOIN repository_connections c ON c.id=t.connection_id WHERE t.id=? AND c.project_id=?', [String(input.repository_target_id || ''), execution.project_id]);
    const outcome = this.db.get("SELECT * FROM outcome_evaluations WHERE execution_id=? AND status IN ('passed','waived') ORDER BY generation DESC LIMIT 1", [execution.id]);
    const handoff = execution.handoff_manifest_sha256 || execution.input_sha256 || '';
    const evidence = this.db.get('SELECT digest_sha256 FROM digests WHERE execution_id=? ORDER BY created_at DESC LIMIT 1', [execution.id]);
    if (!policy || !target || !outcome || !isHash(handoff) || !evidence) throw new PlatformError('delivery_gate_blocked', 'delivery requires policy, target, handoff, evidence and passed or waived outcome', {}, 409);
    const now = time(this.clock);
    const generation = Number(this.db.get('SELECT COALESCE(MAX(generation),0)+1 AS n FROM deliveries WHERE project_id=?', [execution.project_id]).n);
    const id = opaqueId('delivery');
    const targetHead = String(target.expected_head_sha || input.target_head_sha || '');
    if (targetHead.length < 7) throw new PlatformError('target_head_required', 'repository target head is required', {}, 409);
    const snapshot = { execution_id: execution.id, execution_revision: expected, policy_sha256: policy.snapshot_sha256, target_id: target.id, target_head_sha: targetHead, handoff_sha256: handoff, evidence_sha256: evidence.digest_sha256, outcome_sha256: outcome.evaluation_sha256 };
    const requestSha = requestHash(snapshot);
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'delivery.submit', idempotencyKey: key, requestHash: requestSha, now });
      if (prior) return prior;
      assertRevision(tx.get('SELECT revision FROM executions WHERE id=?', [execution.id]), expected);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'delivery.submit', resourceType: 'delivery', resourceId: id, projectId: execution.project_id, requestHash: requestSha, idempotencyKey: key, status: 'queued', now });
      tx.run(`INSERT INTO deliveries(id,project_id,execution_id,policy_id,repository_target_id,operation_id,retry_of_delivery_id,generation,handoff_sha256,evidence_sha256,outcome_sha256,target_head_sha,branch_name,status,revision,created_at,updated_at,completed_at,created_by_actor_id) VALUES(?,?,?,?,?,?,NULL,?,?,?,?,?,?,'queued',1,?,?,NULL,?)`, [id, execution.project_id, execution.id, policy.id, target.id, operation.id, generation, handoff, evidence.digest_sha256, outcome.evaluation_sha256, targetHead, `aiws/deliveries/${id}`, now, now, principal.actorId]);
      const row = tx.get('SELECT * FROM deliveries WHERE id=?', [id]);
      const event = appendAggregate(this.events, tx, aggregate(row, operation.id, principal.actorId, execution.project_id, 'delivery.queued', now, 'delivery'));
      this.#projectDeliveryEvent(tx, row.id, event, null, '', now);
      const response = { delivery: view(row), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'delivery.submit', idempotencyKey: key, requestHash: requestSha, response, operationId: operation.id, status: 202, now });
      return response;
    });
  }

  async createIntent(deliveryId, action, input, principal) {
    const delivery = this.#delivery(deliveryId, principal, action === 'merge' ? 'approve' : 'run');
    const expected = requireRevision(input.expected_revision);
    const key = requireIdempotency(input.idempotency_key);
    const commandId = action === 'create_draft' ? 'delivery.intent.create' : action === 'mark_ready' ? 'delivery.intent.ready' : action === 'merge' ? 'delivery.intent.merge' : 'delivery.reconcile';
    const stableRequest = { delivery_id: delivery.id, action, expected_revision: expected, input: Object.fromEntries(Object.entries(input).filter(([field]) => field !== 'idempotency_key')) };
    const stableRequestHash = requestHash(stableRequest);
    const earlyReplay = await this.db.withTransaction((tx) => priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: stableRequestHash, now: time(this.clock) }));
    if (earlyReplay) return earlyReplay;
    assertRevision(delivery, expected);
    this.#assertIntentState(delivery, action);
    const priorIntent = this.db.get('SELECT * FROM pull_request_intents WHERE delivery_id=? ORDER BY generation DESC LIMIT 1', [delivery.id]);
    const policy = this.db.get('SELECT * FROM delivery_policies WHERE id=?', [delivery.policy_id]);
    const approval = ['mark_ready', 'merge'].includes(action) ? this.#requireApproval(input.approval_id, action === 'merge' ? 'delivery.merge' : 'delivery.ready', principal, delivery.project_id, { delivery_id: delivery.id }) : null;
    const patchSha = action === 'create_draft' ? String(input.patch_sha256 || '') : String(priorIntent?.patch_sha256 || '');
    const casSha = action === 'create_draft' ? String(input.patch_cas_sha256 || '') : String(priorIntent?.patch_cas_sha256 || '');
    if (!isHash(patchSha) || !this.db.get("SELECT sha256 FROM cas_objects WHERE sha256=? AND status='active'", [casSha])) throw new PlatformError('patch_evidence_required', 'intent requires a registered CAS patch', {}, 422);
    const now = time(this.clock);
    const generation = Number(this.db.get('SELECT COALESCE(MAX(generation),0)+1 AS n FROM pull_request_intents WHERE delivery_id=?', [delivery.id]).n);
    const requiredChecks = stringArray(input.required_checks ?? parseJson(priorIntent?.required_checks_json, parseJson(policy?.required_checks_json, [])), 100);
    const body = { delivery_id: delivery.id, generation, action, patch_sha256: patchSha, patch_cas_sha256: casSha, base_sha: String(input.base_sha || priorIntent?.base_sha || delivery.target_head_sha), head_sha: String(input.head_sha || priorIntent?.head_sha || ''), required_checks: requiredChecks, approval_sha256: approval?.request_sha256 || String(input.approval_sha256 || sha256Hex(canonicalJson({ actor_id: principal.actorId, action }))) };
    if (body.base_sha.length < 7 || body.head_sha.length < 7 || !isHash(body.approval_sha256)) throw new PlatformError('delivery_intent_invalid', 'delivery intent hashes are invalid', {}, 422);
    if (action === 'merge' && (String(input.expected_base_sha) !== body.base_sha || String(input.expected_head_sha) !== body.head_sha)) throw new PlatformError('revision_conflict', 'merge SHA pins do not match the immutable intent', {}, 409);
    const intentHash = requestHash(body);
    const id = opaqueId('pr_intent');
    const queued = await this.db.withTransaction((tx) => {
      const replay = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: stableRequestHash, now });
      if (replay) return replay;
      const current = tx.get('SELECT * FROM deliveries WHERE id=?', [delivery.id]);
      assertRevision(current, expected);
      this.#assertIntentState(current, action);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'pull_request_intent', resourceId: id, projectId: delivery.project_id, requestHash: stableRequestHash, idempotencyKey: key, status: 'queued', now });
      tx.run(`INSERT INTO pull_request_intents(id,delivery_id,generation,action,prior_intent_id,patch_cas_sha256,patch_sha256,base_sha,head_sha,required_checks_json,approval_sha256,remote_ref_digest,status,intent_sha256,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,'','pending',?,?,?)`, [id, delivery.id, generation, action, priorIntent?.id || null, casSha, patchSha, body.base_sha, body.head_sha, canonicalJson(requiredChecks), body.approval_sha256, intentHash, now, principal.actorId]);
      const intent = tx.get('SELECT * FROM pull_request_intents WHERE id=?', [id]);
      const intentEvent = appendAggregate(this.events, tx, aggregate(intent, operation.id, principal.actorId, delivery.project_id, `delivery.intent.${action}`, now, 'pull_request_intent', 1));
      this.#projectDeliveryEvent(tx, delivery.id, intentEvent, intent.id, '', now);
      const dispatchStatus = action === 'merge' ? 'merging' : action === 'reconcile' ? 'needs_reconcile' : 'preparing';
      tx.run('UPDATE deliveries SET status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?', [dispatchStatus, now, current.id, current.revision], 1);
      const dispatched = tx.get('SELECT * FROM deliveries WHERE id=?', [current.id]);
      const deliveryEvent = appendAggregate(this.events, tx, aggregate(dispatched, operation.id, principal.actorId, delivery.project_id, 'delivery.external.dispatched', now, 'delivery'));
      this.#projectDeliveryEvent(tx, delivery.id, deliveryEvent, intent.id, '', now);
      const response = { intent: view(intent), delivery: view(dispatched), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: stableRequestHash, response, operationId: operation.id, status: 202, now });
      return response;
    });
    if (queued.replayed) return queued;
    try {
      const external = await this.#executeIntent(delivery.id, id, principal);
      return await this.#settleIntent(delivery.id, id, queued.operation.operation_id, external.status, external.receipt, principal, null);
    } catch (error) {
      const unknown = error?.code === 'external_result_unknown';
      await this.#settleIntent(delivery.id, id, queued.operation.operation_id, unknown ? 'needs_reconcile' : 'failed', { error_code: String(error?.code || 'github_request_failed') }, principal, String(error?.code || 'github_request_failed'));
      throw error;
    }
  }

  async receiveGithubWebhook(rawBody, headers = {}) {
    const payloadHash = sha256Hex(rawBody);
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { throw new PlatformError('schema_invalid', 'GitHub webhook body is invalid', {}, 400); }
    const branch = String(payload?.pull_request?.head?.ref || payload?.check_suite?.head_branch || '');
    const deliveryId = String(payload?.delivery_id || branch.match(/^aiws\/deliveries\/(.+)$/)?.[1] || '');
    const delivery = this.db.get('SELECT * FROM deliveries WHERE id=?', [deliveryId]);
    if (!delivery) throw new PlatformError('delivery_not_found', 'delivery not found', {}, 404);
    const context = this.#repositoryContext(delivery, null);
    const fullName = String(payload?.repository?.full_name || '');
    if (fullName && fullName.toLowerCase() !== context.repository.toLowerCase()) throw new PlatformError('github_repository_mismatch', 'GitHub webhook repository does not match delivery target', {}, 403);
    const valid = await this.#withGithubLease(context.profile, async (_auth, _config, webhookSecret) => webhookSecret.length > 0 && verifyGitHubWebhook(rawBody, headers['x-hub-signature-256'], webhookSecret));
    if (!valid) throw new PlatformError('github_signature_invalid', 'GitHub webhook signature is invalid', {}, 401);
    const eventType = bounded(headers['x-github-event'], 120, 'GitHub event');
    const deliveryGuid = bounded(headers['x-github-delivery'], 200, 'GitHub delivery id');
    const idempotencyKey = `github-${sha256Hex(deliveryGuid).slice(0, 40)}`;
    const requestSha = requestHash({ delivery_id: delivery.id, event: eventType, delivery_guid_sha256: sha256Hex(deliveryGuid), payload_sha256: payloadHash });
    const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: this.bootstrapActorId, commandId: 'github.webhook.receive', idempotencyKey, requestHash: requestSha, now });
      if (prior) return { ...prior, duplicate: true };
      const current = tx.get('SELECT * FROM deliveries WHERE id=?', [delivery.id]);
      const status = webhookStatus(eventType, payload, current.status);
      const changed = status !== current.status;
      if (changed) tx.run("UPDATE deliveries SET status=?,revision=revision+1,updated_at=?,completed_at=CASE WHEN ?='merged' THEN ? ELSE completed_at END WHERE id=? AND revision=?", [status, now, status, now, current.id, current.revision], 1);
      const next = changed ? tx.get('SELECT * FROM deliveries WHERE id=?', [current.id]) : current;
      const receipt = webhookReceipt(payload);
      const receiptHash = sha256Hex(canonicalJson(receipt));
      const event = appendAggregate(this.events, tx, { ...aggregate(next, current.operation_id, this.bootstrapActorId, current.project_id, 'delivery.webhook.received', now, 'delivery'), data: { delivery_id: current.id, event: eventType, delivery_guid_sha256: sha256Hex(deliveryGuid), external_receipt: receipt }, allowSameRevision: !changed });
      this.#projectDeliveryEvent(tx, current.id, event, null, receiptHash, now);
      if (changed && status === 'merged' && receipt.merge_sha) this.#synchronizeBaseline(tx, current, receipt.merge_sha, this.bootstrapActorId, now, current.operation_id);
      const response = { accepted: true, duplicate: false, delivery_id: current.id, event_id: event.id, status };
      saveResponse(this.operations, tx, { actorId: this.bootstrapActorId, commandId: 'github.webhook.receive', idempotencyKey, requestHash: requestSha, response, operationId: current.operation_id, status: 202, now });
      return response;
    });
  }

  getDeployment(_input, principal) {
    this.#assertOwnerSession(principal);
    const active = this.db.get("SELECT * FROM deployment_candidates WHERE status='verified' ORDER BY updated_at DESC,id LIMIT 1");
    return { active: view(active), candidates: this.db.query('SELECT * FROM deployment_candidates ORDER BY created_at DESC,id LIMIT 100').map(view) };
  }

  getDeploymentCandidate(id, principal) {
    this.#assertOwnerSession(principal);
    const candidate = this.db.get('SELECT * FROM deployment_candidates WHERE id=?', [String(id)]);
    if (!candidate) throw new PlatformError('deployment_candidate_not_found', 'deployment candidate not found', {}, 404);
    return { candidate: view(candidate), verifications: this.db.query('SELECT * FROM deployment_verifications WHERE candidate_id=? ORDER BY created_at,id', [candidate.id]).map(view) };
  }

  createDeploymentCandidate(input, principal) {
    const approval = this.#requireApproval(input.approval_id, 'deployment.create', principal, null);
    const expected = requireRevision(input.expected_revision, { allowZero: true });
    if (expected !== 0) throw new PlatformError('revision_conflict', 'new deployment candidate requires revision 0', { actual_revision: 0 }, 409);
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const generation = Number(this.db.get('SELECT COALESCE(MAX(generation),0)+1 AS n FROM deployment_candidates').n);
    const snapshot = { app_digest: hash(input.app_digest), broker_digest: hash(input.broker_digest), runner_digest: hash(input.runner_digest), parser_digest: hash(input.parser_digest), bridge_identity: bounded(input.bridge_identity, 512, 'bridge identity'), sbom_sha256: hash(input.sbom_sha256), source_tree_sha256: hash(input.source_tree_sha256), lockfile_sha256: hash(input.lockfile_sha256), gate_fingerprint: hash(input.gate_fingerprint), compose_sha256: hash(input.compose_sha256), volume_manifest: object(input.volume_manifest), approval_sha256: approval.request_sha256 };
    const candidateHash = requestHash(snapshot);
    const id = opaqueId('deployment_candidate');
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'deployment.candidate.create', idempotencyKey: key, requestHash: candidateHash, now });
      if (prior) return prior;
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'deployment.candidate.create', resourceType: 'deployment_candidate', resourceId: id, projectId: approval.project_id, requestHash: candidateHash, idempotencyKey: key, status: 'succeeded', now });
      tx.run(`INSERT INTO deployment_candidates(id,retry_of_candidate_id,generation,app_digest,broker_digest,runner_digest,parser_digest,bridge_identity,sbom_sha256,source_tree_sha256,lockfile_sha256,gate_fingerprint,compose_sha256,volume_manifest_json,candidate_sha256,status,revision,created_at,updated_at,created_by_actor_id) VALUES(?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,'candidate',1,?,?,?)`, [id, generation, snapshot.app_digest, snapshot.broker_digest, snapshot.runner_digest, snapshot.parser_digest, snapshot.bridge_identity, snapshot.sbom_sha256, snapshot.source_tree_sha256, snapshot.lockfile_sha256, snapshot.gate_fingerprint, snapshot.compose_sha256, canonicalJson(snapshot.volume_manifest), candidateHash, now, now, principal.actorId]);
      const row = tx.get('SELECT * FROM deployment_candidates WHERE id=?', [id]);
      appendAggregate(this.events, tx, aggregate(row, operation.id, principal.actorId, approval.project_id, 'deployment.candidate.created', now, 'deployment_candidate'));
      const response = { candidate: view(row), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'deployment.candidate.create', idempotencyKey: key, requestHash: candidateHash, response, operationId: operation.id, status: 201, now });
      return response;
    });
  }

  async verifyDeployment(candidateId, input, principal) {
    const candidate = this.db.get('SELECT * FROM deployment_candidates WHERE id=?', [String(candidateId)]);
    if (!candidate) throw new PlatformError('deployment_candidate_not_found', 'deployment candidate not found', {}, 404);
    const approval = this.#requireApproval(input.approval_id, 'deployment.verify', principal, null, { candidate_id: candidate.id });
    const expected = requireRevision(input.expected_revision);
    assertRevision(candidate, expected);
    const key = requireIdempotency(input.idempotency_key);
    const checks = array(input.checks).slice(0, 100).map(object);
    const viewports = array(input.viewport_evidence).slice(0, 20).map(object);
    const snapshot = { candidate_id: candidate.id, candidate_sha256: candidate.candidate_sha256, checks, viewport_evidence: viewports, volume_manifest_sha256: hash(input.volume_manifest_sha256), approval_sha256: approval.request_sha256 };
    const requestSha = requestHash(snapshot);
    const now = time(this.clock);
    const queued = await this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'deployment.verify', idempotencyKey: key, requestHash: requestSha, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM deployment_candidates WHERE id=?', [candidate.id]);
      assertRevision(current, expected);
      if (!['candidate', 'needs_reconcile'].includes(current.status)) throw new PlatformError('state_conflict', 'deployment candidate is not verifiable', { status: current.status }, 409);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'deployment.verify', resourceType: 'deployment_candidate', resourceId: candidate.id, projectId: approval.project_id, requestHash: requestSha, idempotencyKey: key, status: 'queued', now });
      tx.run("UPDATE deployment_candidates SET status='verifying',revision=revision+1,updated_at=? WHERE id=? AND revision=?", [now, current.id, current.revision], 1);
      const row = tx.get('SELECT * FROM deployment_candidates WHERE id=?', [current.id]);
      appendAggregate(this.events, tx, aggregate(row, operation.id, principal.actorId, approval.project_id, 'deployment.verification.queued', now, 'deployment_candidate'));
      const response = { candidate: view(row), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'deployment.verify', idempotencyKey: key, requestHash: requestSha, response, operationId: operation.id, status: 202, now });
      return response;
    });
    if (queued.replayed) return queued;
    await this.#transitionOperation(queued.operation.operation_id, 'running', principal.actorId, approval.project_id);
    const passed = checks.length > 0 && checks.every((item) => item.passed === true || item.status === 'passed');
    const receipt = { candidate_sha256: candidate.candidate_sha256, checks, viewport_evidence: viewports, volume_manifest_sha256: snapshot.volume_manifest_sha256, status: passed ? 'passed' : 'failed' };
    const receiptHash = requestHash(receipt);
    const completedAt = time(this.clock);
    await this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM deployment_candidates WHERE id=?', [candidate.id]);
      const verificationId = opaqueId('deployment_verification');
      tx.run('INSERT INTO deployment_verifications(id,candidate_id,operation_id,checks_json,viewport_evidence_json,volume_manifest_sha256,receipt_sha256,status,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?)', [verificationId, current.id, queued.operation.operation_id, canonicalJson(checks), canonicalJson(viewports), snapshot.volume_manifest_sha256, receiptHash, passed ? 'passed' : 'failed', completedAt, principal.actorId]);
      tx.run('UPDATE deployment_candidates SET status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?', [passed ? 'verified' : 'failed', completedAt, current.id, current.revision], 1);
      const next = tx.get('SELECT * FROM deployment_candidates WHERE id=?', [current.id]);
      appendAggregate(this.events, tx, { ...aggregate(next, queued.operation.operation_id, principal.actorId, approval.project_id, passed ? 'deployment.verified' : 'deployment.failed', completedAt, 'deployment_candidate'), data: { candidate_id: next.id, receipt_sha256: receiptHash, status: receipt.status } });
      this.#transitionOperationInTransaction(tx, queued.operation.operation_id, passed ? 'succeeded' : 'failed', principal.actorId, approval.project_id, passed ? { verification_id: verificationId, receipt_sha256: receiptHash } : {}, passed ? null : 'deployment_verification_failed', completedAt);
    });
    return { candidate: view(this.db.get('SELECT * FROM deployment_candidates WHERE id=?', [candidate.id])), verification: view(this.db.get('SELECT * FROM deployment_verifications WHERE candidate_id=? ORDER BY created_at DESC LIMIT 1', [candidate.id])), operation: this.operations.summary(queued.operation.operation_id) };
  }

  listBackups(input, principal) {
    this.#assertOwnerSession(principal);
    return { backups: this.db.query('SELECT * FROM backup_manifests ORDER BY created_at DESC,id LIMIT ?', [limit(input.limit, 500)]).map(view) };
  }

  async createBackup(input, principal) {
    const approval = this.#requireApproval(input.approval_id, 'backup.create', principal, null);
    const expected = requireRevision(input.expected_revision, { allowZero: true });
    if (expected !== 0) throw new PlatformError('revision_conflict', 'backup creation requires revision 0', { actual_revision: 0 }, 409);
    const key = requireIdempotency(input.idempotency_key);
    const id = opaqueId('backup');
    const requestSha = requestHash({ retention_class: input.retention_class, components: object(input.components), approval_sha256: approval.request_sha256 });
    const operation = await this.operations.create({ actorId: principal.actorId, commandId: 'backup.create', kind: 'backup.create', resourceType: 'backup_manifest', resourceId: id, projectId: approval.project_id, requestHash: requestSha, request: { backup_id: id }, idempotencyKey: key, status: 'queued' });
    if (operation.replayed) return { operation };
    await this.#transitionOperation(operation.operation_id, 'running', principal.actorId, approval.project_id);
    try {
      this.db.exec('PRAGMA wal_checkpoint(FULL)');
      const now = time(this.clock);
      const manifest = await this.artifacts.createBackup({ backupId: id, createdAt: now });
      const sqliteHash = manifest.components?.sqlite?.sha256 || sha256Hex('');
      const manifestHash = hash(manifest.manifest_sha256);
      await this.db.withTransaction((tx) => {
        tx.run('INSERT INTO backup_manifests(id,operation_id,source_user_version,sqlite_sha256,components_json,manifest_sha256,retention_class,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?)', [id, operation.operation_id, 8, sqliteHash, canonicalJson(manifest.components || {}), manifestHash, input.retention_class, now, principal.actorId]);
        this.#transitionOperationInTransaction(tx, operation.operation_id, 'succeeded', principal.actorId, approval.project_id, { backup_id: id, manifest_sha256: manifestHash }, null, now);
      });
      return { backup: view(this.db.get('SELECT * FROM backup_manifests WHERE id=?', [id])), operation: this.operations.summary(operation.operation_id) };
    } catch (error) {
      await this.#failOperation(operation.operation_id, principal.actorId, approval.project_id, error);
      throw error;
    }
  }

  async prepareRestore(input, principal) {
    const approval = this.#requireApproval(input.approval_id, 'restore.prepare', principal, null, { backup_id: String(input.backup_id) });
    const backup = this.db.get('SELECT * FROM backup_manifests WHERE id=?', [String(input.backup_id)]);
    if (!backup) throw new PlatformError('backup_not_found', 'backup not found', {}, 404);
    return this.#runArtifactOperation('restore.prepare', 'restore', backup.id, input, principal, approval, () => this.artifacts.prepareRestore({ backupId: backup.id, targetVolumeRef: input.target_volume_ref, preparedAt: time(this.clock) }));
  }

  async prepareReset(input, principal) {
    const approval = this.#requireApproval(input.approval_id, 'system.reset.prepare', principal, null);
    return this.#runArtifactOperation('system.reset.prepare', 'system_reset', String(input.target_volume_ref), input, principal, approval, () => this.artifacts.prepareReset({ targetVolumeRef: input.target_volume_ref, preserveBackups: input.preserve_backups, preparedAt: time(this.clock) }));
  }

  listImports(input, principal) {
    this.#assertOwnerSession(principal);
    const params = [];
    const where = input.status ? 'WHERE status=?' : '';
    if (input.status) params.push(String(input.status));
    params.push(limit(input.limit, 500));
    return { imports: this.db.query(`SELECT * FROM import_batches ${where} ORDER BY created_at DESC,id LIMIT ?`, params).map(view) };
  }

  getImport(id, principal) {
    this.#assertOwnerSession(principal);
    const batch = this.db.get('SELECT * FROM import_batches WHERE id=?', [String(id)]);
    if (!batch) throw new PlatformError('import_not_found', 'sealed import batch not found', {}, 404);
    return { import: view(batch), checkpoints: this.db.query('SELECT * FROM import_checkpoints WHERE batch_id=? ORDER BY fsynced_at,id', [batch.id]).map(view), conflicts: this.db.query('SELECT * FROM import_conflicts WHERE batch_id=? ORDER BY created_at,id', [batch.id]).map(view), id_map_count: Number(this.db.get('SELECT COUNT(*) AS count FROM import_id_map WHERE batch_id=?', [batch.id]).count) };
  }

  listOperations(input, principal) {
    requirePrincipal(principal);
    const clauses = [];
    const params = [];
    if (input.project_id) { this.#authorize(principal, 'read', input.project_id, 'operation'); clauses.push('project_id=?'); params.push(String(input.project_id)); }
    else if (!this.#isGlobalOwner(principal)) { clauses.push('actor_id=?'); params.push(principal.actorId); }
    if (input.status) { clauses.push('status=?'); params.push(String(input.status)); }
    params.push(limit(input.limit, 500));
    return { operations: this.db.query(`SELECT * FROM operations ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC,id LIMIT ?`, params).map((row) => this.operations.view(row)) };
  }

  replayOperation(id, input, principal) {
    requirePrincipal(principal);
    const row = this.db.get('SELECT * FROM operations WHERE id=?', [String(id)]);
    if (!row) throw new PlatformError('operation_not_found', 'operation not found', {}, 404);
    if (row.project_id) this.#authorize(principal, 'run', row.project_id, 'operation');
    else this.#assertOwnerSession(principal);
    if (row.actor_id !== principal.actorId && !this.#isGlobalOwner(principal)) throw new PlatformError('permission_denied', 'operation belongs to another actor', {}, 403);
    assertRevision(row, requireRevision(input.expected_revision));
    if (NON_REPLAYABLE.has(row.command_id)) throw new PlatformError('operation_reconcile_required', 'operation requires reconcile rather than replay', { command_id: row.command_id }, 409);
    return this.operations.retry(row.id, { actorId: principal.actorId, idempotencyKey: requireIdempotency(input.idempotency_key), requestHash: requestHash({ replay_of: row.id, expected_revision: Number(row.revision) }) });
  }

  gcPlan(input, principal) {
    this.#assertOwnerSession(principal);
    requireIdempotency(input.idempotency_key);
    requireRevision(input.expected_revision, { allowZero: true });
    const cutoff = input.cutoff || new Date(Date.now() - 30 * 86400000).toISOString();
    const maximum = limit(input.limit, 1000);
    const protectedReferences = this.#protectedCasReferences();
    const candidates = this.db.query("SELECT sha256,byte_length FROM cas_objects WHERE created_at<? AND status='active' AND tombstoned_at IS NULL ORDER BY created_at,sha256", [cutoff]).filter((row) => !protectedReferences.has(row.sha256)).slice(0, maximum);
    const protectedHash = sha256Hex(canonicalJson([...protectedReferences].sort()));
    const body = { cutoff, candidates: candidates.map((row) => row.sha256), protected_references_sha256: protectedHash, count: candidates.length };
    return { plan: { ...body, plan_sha256: sha256Hex(canonicalJson(body)) } };
  }

  async gcApply(input, principal) {
    const approval = this.#requireApproval(input.approval_id, 'cas.gc.apply', principal, null);
    requireRevision(input.expected_revision, { allowZero: true });
    const key = requireIdempotency(input.idempotency_key);
    const plan = object(input.plan);
    const body = { cutoff: plan.cutoff, candidates: array(plan.candidates), protected_references_sha256: plan.protected_references_sha256, count: Number(plan.count) };
    if (sha256Hex(canonicalJson(body)) !== plan.plan_sha256) throw new PlatformError('gc_plan_invalid', 'GC plan hash mismatch', {}, 422);
    const currentProtected = this.#protectedCasReferences();
    if (sha256Hex(canonicalJson([...currentProtected].sort())) !== plan.protected_references_sha256) throw new PlatformError('gc_plan_stale', 'GC protected reference set changed', {}, 409);
    const now = time(this.clock);
    const requestSha = requestHash({ plan_sha256: plan.plan_sha256, approval_sha256: approval.request_sha256 });
    const initial = await this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'cas.gc.apply', idempotencyKey: key, requestHash: requestSha, now });
      if (prior) return prior;
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'cas.gc.apply', resourceType: 'cas_gc', resourceId: plan.plan_sha256, projectId: approval.project_id, requestHash: requestSha, idempotencyKey: key, status: 'succeeded', now });
      const tombstoned = [];
      for (const sha of body.candidates.slice(0, 1000)) {
        if (currentProtected.has(sha)) throw new PlatformError('gc_plan_stale', 'GC candidate became protected', { sha256: sha }, 409);
        const result = tx.run("UPDATE cas_objects SET status='tombstoned',tombstoned_at=? WHERE sha256=? AND status='active' AND tombstoned_at IS NULL", [now, sha]);
        if (Number(result.changes || 0) === 1) tombstoned.push(sha);
      }
      const response = { receipt: { plan_sha256: plan.plan_sha256, tombstoned, moved_to_trash: [], pending_reconcile: tombstoned, status: 'committed', applied_at: now }, operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'cas.gc.apply', idempotencyKey: key, requestHash: requestSha, response, operationId: operation.id, status: 200, now });
      return response;
    });
    if (initial.replayed) return initial;
    const moved = this.#moveTombstones(initial.receipt.tombstoned, plan.plan_sha256);
    const response = { ...initial, receipt: { ...initial.receipt, moved_to_trash: moved, pending_reconcile: initial.receipt.tombstoned.filter((sha) => !moved.includes(sha)), status: moved.length === initial.receipt.tombstoned.length ? 'applied' : 'needs_reconcile' } };
    await this.db.withTransaction((tx) => saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'cas.gc.apply', idempotencyKey: key, requestHash: requestSha, response, operationId: initial.operation.operation_id, status: 200, now: time(this.clock) }));
    return response;
  }

  rollbackGc(planSha256) {
    const root = path.join(this.gcTrashRoot, hash(planSha256));
    if (!fs.existsSync(root)) return { restored: [], missing: [] };
    const restored = [];
    const missing = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !isHash(entry.name)) continue;
      const source = path.join(root, entry.name);
      const target = this.cas.fileFor(entry.name);
      if (sha256Hex(fs.readFileSync(source)) !== entry.name) { missing.push(entry.name); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(target)) fs.renameSync(source, target);
      this.db.run("UPDATE cas_objects SET status='active',tombstoned_at=NULL WHERE sha256=?", [entry.name]);
      restored.push(entry.name);
    }
    this.cas.createManifest();
    return { restored, missing };
  }

  async recoverPending() {
    const now = time(this.clock);
    const rows = this.db.query("SELECT * FROM deliveries WHERE status IN ('preparing','merging')");
    for (const row of rows) {
      await this.db.withTransaction((tx) => {
        const current = tx.get('SELECT * FROM deliveries WHERE id=?', [row.id]);
        if (!current || !['preparing', 'merging'].includes(current.status)) return;
        tx.run("UPDATE deliveries SET status='needs_reconcile',revision=revision+1,updated_at=? WHERE id=? AND revision=?", [now, current.id, current.revision], 1);
        const next = tx.get('SELECT * FROM deliveries WHERE id=?', [current.id]);
        const event = appendAggregate(this.events, tx, aggregate(next, current.operation_id, current.created_by_actor_id, current.project_id, 'delivery.restart.needs_reconcile', now, 'delivery'));
        this.#projectDeliveryEvent(tx, current.id, event, null, '', now);
        const operationRows = tx.query(`SELECT DISTINCT o.* FROM operations o JOIN events e ON e.operation_id=o.id JOIN delivery_events de ON de.event_id=e.id WHERE de.delivery_id=? AND o.status IN ('queued','running')`, [current.id]);
        for (const operation of operationRows) this.#transitionOperationInTransaction(tx, operation.id, 'failed', operation.actor_id, operation.project_id, {}, 'external_result_unknown', now);
      });
    }
    this.#reconcileTombstones();
    return { deliveries: rows.length };
  }

  async #executeIntent(deliveryId, intentId, principal) {
    const delivery = this.db.get('SELECT * FROM deliveries WHERE id=?', [deliveryId]);
    const intent = this.db.get('SELECT * FROM pull_request_intents WHERE id=?', [intentId]);
    const context = this.#repositoryContext(delivery, principal);
    const requiredChecks = parseJson(intent.required_checks_json, []);
    return this.#withGithubLease(context.profile, async (auth) => {
      if (intent.action === 'create_draft') {
        if (typeof this.github.createBranch === 'function') await this.github.createBranch(auth, { repository: context.repository, branch: delivery.branch_name, baseSha: intent.base_sha, headSha: intent.head_sha });
        const receipt = await this.github.createDraft(auth, { repository: context.repository, deliveryId: delivery.id, title: `Delivery ${delivery.generation}`, body: `Evidence ${delivery.evidence_sha256}`, head: delivery.branch_name, headSha: intent.head_sha, base: context.target.branch, baseSha: intent.base_sha });
        if (!receipt.number || (receipt.base_sha && receipt.base_sha !== intent.base_sha) || (receipt.head_sha && receipt.head_sha !== intent.head_sha)) throw new PlatformError('github_receipt_mismatch', 'GitHub Draft PR receipt does not match pinned SHAs', {}, 409);
        return { status: 'draft_pr', receipt };
      }
      const pull = this.#latestPullReceipt(delivery.id);
      if (intent.action === 'mark_ready' || intent.action === 'merge') {
        if (!pull?.number) throw new PlatformError('github_pull_request_missing', 'delivery has no confirmed pull request', {}, 409);
        const checks = await this.github.checks(auth, { repository: context.repository, ref: intent.head_sha, requiredChecks });
        assertChecks(requiredChecks, checks, intent.head_sha);
        if (intent.action === 'mark_ready') return { status: 'ready', receipt: { ...(await this.github.markReady(auth, { repository: context.repository, pullNumber: pull.number })), checks } };
        const receipt = await this.github.merge(auth, { repository: context.repository, pullNumber: pull.number, headSha: intent.head_sha, method: 'squash' });
        if (!receipt.merged || !receipt.sha) throw new PlatformError('github_merge_rejected', 'GitHub did not merge the pull request', {}, 409);
        return { status: 'merged', receipt: { ...receipt, number: pull.number, base_sha: intent.base_sha, head_sha: intent.head_sha, checks } };
      }
      const receipt = await this.github.reconcile(auth, { repository: context.repository, pullNumber: pull?.number || null, head: delivery.branch_name, headSha: intent.head_sha });
      const status = receipt.merged ? 'merged' : receipt.state === 'open' && receipt.draft ? 'draft_pr' : receipt.state === 'open' ? 'ready' : 'failed';
      return { status, receipt };
    });
  }

  #settleIntent(deliveryId, intentId, operationId, status, receipt, principal, errorCode) {
    const now = time(this.clock);
    const receiptHash = sha256Hex(canonicalJson(receipt));
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM deliveries WHERE id=?', [deliveryId]);
      if (!current) throw new PlatformError('delivery_not_found', 'delivery not found', {}, 404);
      if (TERMINAL_DELIVERY.has(current.status) && current.status !== status) throw new PlatformError('state_conflict', 'terminal delivery is immutable', { status: current.status }, 409);
      tx.run("UPDATE deliveries SET status=?,revision=revision+1,updated_at=?,completed_at=CASE WHEN ? IN ('merged','failed','cancelled') THEN ? ELSE NULL END WHERE id=? AND revision=?", [status, now, status, now, current.id, current.revision], 1);
      const next = tx.get('SELECT * FROM deliveries WHERE id=?', [current.id]);
      this.#transitionOperationInTransaction(tx, operationId, errorCode ? 'failed' : 'succeeded', principal.actorId, current.project_id, errorCode ? {} : { delivery_id: current.id, status, external_receipt_sha256: receiptHash }, errorCode, now);
      this.#transitionDeliveryRootInTransaction(tx, current.operation_id, status, current.created_by_actor_id, current.project_id, receiptHash, errorCode, now);
      const event = appendAggregate(this.events, tx, { ...aggregate(next, operationId, principal.actorId, current.project_id, `delivery.${status}`, now, 'delivery'), data: { delivery_id: current.id, intent_id: intentId, status, external_receipt_sha256: receiptHash, external_receipt: receipt } });
      this.#projectDeliveryEvent(tx, current.id, event, intentId, receiptHash, now);
      if (status === 'merged' && receipt.sha) this.#synchronizeBaseline(tx, current, receipt.sha, principal.actorId, now, operationId);
      const response = { delivery: view(next), intent: view(tx.get('SELECT * FROM pull_request_intents WHERE id=?', [intentId])), operation: this.operations.summary(operationId) };
      const idempotency = tx.get('SELECT actor_id,command_id,idempotency_key,request_hash FROM idempotency_keys WHERE operation_id=?', [operationId]);
      if (idempotency) saveResponse(this.operations, tx, { actorId: idempotency.actor_id, commandId: idempotency.command_id, idempotencyKey: idempotency.idempotency_key, requestHash: idempotency.request_hash, response, operationId, status: 202, now });
      return response;
    });
  }

  #transitionDeliveryRootInTransaction(tx, operationId, deliveryStatus, actorId, projectId, receiptHash, errorCode, now) {
    let operation = tx.get('SELECT * FROM operations WHERE id=?', [operationId]);
    if (!operation || ['succeeded', 'failed', 'cancelled', 'expired'].includes(operation.status)) return;
    if (operation.status === 'queued' || operation.status === 'accepted' || operation.status === 'paused') {
      const target = operation.status === 'accepted' ? 'queued' : 'running';
      this.operations.transitionInTransaction(tx, operation.id, target, { expectedRevision: Number(operation.revision), actorId, projectId }, now);
      operation = tx.get('SELECT * FROM operations WHERE id=?', [operation.id]);
      if (target === 'queued') { this.operations.transitionInTransaction(tx, operation.id, 'running', { expectedRevision: Number(operation.revision), actorId, projectId }, now); operation = tx.get('SELECT * FROM operations WHERE id=?', [operation.id]); }
    }
    if (deliveryStatus === 'merged') this.operations.transitionInTransaction(tx, operation.id, 'succeeded', { expectedRevision: Number(operation.revision), actorId, projectId, result: { delivery_status: deliveryStatus, external_receipt_sha256: receiptHash } }, now);
    else if (deliveryStatus === 'failed' || deliveryStatus === 'needs_reconcile') this.operations.transitionInTransaction(tx, operation.id, 'failed', { expectedRevision: Number(operation.revision), actorId, projectId, errorCode: errorCode || (deliveryStatus === 'needs_reconcile' ? 'external_result_unknown' : 'delivery_failed') }, now);
  }

  #transitionOperation(operationId, target, actorId, projectId, result = {}, errorCode = null) {
    return this.db.withTransaction((tx) => this.#transitionOperationInTransaction(tx, operationId, target, actorId, projectId, result, errorCode, time(this.clock)));
  }

  #transitionOperationInTransaction(tx, operationId, target, actorId, projectId, result = {}, errorCode = null, now = time(this.clock)) {
    let current = tx.get('SELECT * FROM operations WHERE id=?', [operationId]);
    if (!current) return null;
    if (target === 'succeeded' || target === 'failed') {
      if (current.status === 'queued' || current.status === 'accepted' || current.status === 'paused') {
        const first = current.status === 'accepted' ? 'queued' : 'running';
        this.operations.transitionInTransaction(tx, current.id, first, { expectedRevision: Number(current.revision), actorId, projectId }, now);
        current = tx.get('SELECT * FROM operations WHERE id=?', [current.id]);
        if (first === 'queued') { this.operations.transitionInTransaction(tx, current.id, 'running', { expectedRevision: Number(current.revision), actorId, projectId }, now); current = tx.get('SELECT * FROM operations WHERE id=?', [current.id]); }
      }
    }
    if (current.status === target) return current;
    return this.operations.transitionInTransaction(tx, current.id, target, { expectedRevision: Number(current.revision), actorId, projectId, result, errorCode: errorCode || undefined }, now);
  }

  async #failOperation(operationId, actorId, projectId, error) {
    try { await this.#transitionOperation(operationId, 'failed', actorId, projectId, {}, String(error?.code || 'operation_failed')); } catch { /* primary failure is preserved */ }
  }

  async #runArtifactOperation(commandId, resourceType, resourceId, input, principal, approval, execute) {
    requireRevision(input.expected_revision, { allowZero: true });
    const key = requireIdempotency(input.idempotency_key);
    const requestSha = requestHash({ resource_id: resourceId, target_volume_ref: input.target_volume_ref, approval_sha256: approval.request_sha256 });
    const operation = await this.operations.create({ actorId: principal.actorId, commandId, kind: commandId, resourceType, resourceId, projectId: approval.project_id, requestHash: requestSha, request: { resource_id: resourceId }, idempotencyKey: key, status: 'queued' });
    if (operation.replayed) return { operation };
    await this.#transitionOperation(operation.operation_id, 'running', principal.actorId, approval.project_id);
    try {
      const receipt = await execute();
      await this.#transitionOperation(operation.operation_id, 'succeeded', principal.actorId, approval.project_id, receipt);
      return { [resourceType === 'restore' ? 'restore' : 'reset']: receipt, operation: this.operations.summary(operation.operation_id) };
    } catch (error) {
      await this.#failOperation(operation.operation_id, principal.actorId, approval.project_id, error);
      throw error;
    }
  }

  #repositoryContext(delivery, principal) {
    const row = this.db.get(`SELECT t.*,c.project_id,c.credential_ref_id,c.source_locator,c.metadata_json AS connection_metadata_json FROM repository_targets t JOIN repository_connections c ON c.id=t.connection_id WHERE t.id=?`, [delivery.repository_target_id]);
    if (!row || row.project_id !== delivery.project_id) throw new PlatformError('repository_target_missing', 'repository target is unavailable', {}, 409);
    const metadata = parseJson(row.connection_metadata_json, {});
    const profileId = metadata.github_profile_id || metadata.profile_id;
    let profile = profileId ? this.db.get("SELECT * FROM provider_profiles WHERE id=? AND provider='github'", [String(profileId)]) : null;
    if (!profile && row.credential_ref_id) profile = this.db.get("SELECT * FROM provider_profiles WHERE credential_ref_id=? AND provider='github' ORDER BY updated_at DESC,id LIMIT 1", [row.credential_ref_id]);
    if (!profile) throw new PlatformError('github_profile_required', 'GitHub provider profile is required', {}, 409);
    if (principal && profile.owner_actor_id !== principal.actorId) throw new PlatformError('permission_denied', 'GitHub profile belongs to another actor', {}, 403);
    return { target: row, profile, repository: repositoryName(metadata.repository_full_name || row.source_locator || row.remote_ref || row.name) };
  }

  #githubProfile(profileId, principal) {
    requirePrincipal(principal);
    const row = this.db.get("SELECT * FROM provider_profiles WHERE id=? AND provider='github' AND owner_actor_id=?", [String(profileId), principal.actorId]);
    if (!row) throw new PlatformError('github_profile_not_found', 'GitHub profile not found', {}, 404);
    if (row.status !== 'available') throw new PlatformError('github_profile_unavailable', 'GitHub profile is unavailable', {}, 409);
    return row;
  }

  async #withGithubLease(profile, callback) {
    const credential = this.db.get("SELECT * FROM credential_refs WHERE id=? AND provider='github' AND owner_actor_id=?", [profile.credential_ref_id, profile.owner_actor_id]);
    if (!credential || credential.status !== 'active' || !String(credential.external_ref).startsWith('vault:')) throw new PlatformError('credential_rebind_required', 'GitHub credential must be rebound', {}, 409);
    const lease = Buffer.from(this.vault.read(credential.external_ref));
    let privateKey = lease;
    let webhookSecret = Buffer.alloc(0);
    let secondary = null;
    const config = parseJson(profile.config_json, {});
    let bundle = {};
    try {
      try { bundle = JSON.parse(lease.toString('utf8')); } catch { bundle = {}; }
      if (bundle.private_key) privateKey = Buffer.from(String(bundle.private_key), 'utf8');
      if (config.webhook_secret_ref) { secondary = Buffer.from(this.vault.read(config.webhook_secret_ref)); webhookSecret = secondary; }
      else if (bundle.webhook_secret) webhookSecret = Buffer.from(String(bundle.webhook_secret), 'utf8');
      const auth = { appId: config.app_id || bundle.app_id, installationId: config.installation_id || bundle.installation_id, privateKey };
      if (!auth.appId || !auth.installationId) throw new PlatformError('github_app_identity_missing', 'GitHub App and Installation identity are required', {}, 409);
      return await callback(auth, config, webhookSecret);
    } finally {
      if (privateKey !== lease) privateKey.fill(0);
      if (webhookSecret.length && webhookSecret !== secondary) webhookSecret.fill(0);
      secondary?.fill(0);
      lease.fill(0);
    }
  }

  #latestPullReceipt(deliveryId) {
    const rows = this.db.query(`SELECT e.data_json FROM delivery_events de JOIN events e ON e.id=de.event_id WHERE de.delivery_id=? AND de.external_receipt_sha256<>'' ORDER BY e.sequence DESC`, [deliveryId]);
    for (const row of rows) { const receipt = parseJson(row.data_json, {})?.external_receipt; if (receipt?.number) return receipt; }
    return null;
  }

  #delivery(id, principal, action) {
    const row = this.db.get('SELECT * FROM deliveries WHERE id=?', [String(id)]);
    if (!row) throw new PlatformError('delivery_not_found', 'delivery not found', {}, 404);
    this.#authorize(principal, action, row.project_id, 'delivery');
    return row;
  }

  #assertIntentState(delivery, action) {
    const allowed = { create_draft: new Set(['queued', 'needs_reconcile']), mark_ready: new Set(['draft_pr']), merge: new Set(['ready']), reconcile: new Set(['needs_reconcile']) };
    if (!allowed[action]?.has(delivery.status)) throw new PlatformError('state_conflict', 'delivery action is invalid for its current state', { action, status: delivery.status }, 409);
  }

  #authorize(principal, action, projectId, resource) { this.authorization.assert(requirePrincipal(principal), action, String(projectId), { resource }); }

  #assertOwnerSession(principal, projectId = null) {
    requirePrincipal(principal);
    const session = this.db.get('SELECT * FROM sessions WHERE id=?', [String(principal.sessionId || '')]);
    const now = Date.parse(time(this.clock));
    if (!session || session.revoked_at || session.subject_actor_id !== principal.actorId || session.effective_actor_id !== principal.actorId || Date.parse(session.expires_at) <= now) throw new PlatformError('owner_session_required', 'an active owner session is required', {}, 403);
    const owner = projectId == null
      ? this.db.get("SELECT 1 AS ok FROM team_memberships WHERE actor_id=? AND status='active' AND role='owner' LIMIT 1", [principal.actorId])
      : this.db.get("SELECT 1 AS ok FROM projects p LEFT JOIN project_memberships m ON m.project_id=p.id AND m.actor_id=? AND m.status='active' AND m.role='owner' WHERE p.id=? AND (p.owner_actor_id=? OR m.id IS NOT NULL) LIMIT 1", [principal.actorId, String(projectId), principal.actorId]);
    if (!owner) throw new PlatformError('owner_session_required', 'an active owner session is required', {}, 403);
    return session;
  }

  #isGlobalOwner(principal) { try { this.#assertOwnerSession(principal); return true; } catch { return false; } }

  #requireApproval(approvalId, action, principal, projectId = null, binding = null) {
    this.#assertOwnerSession(principal, projectId);
    const row = this.db.get('SELECT * FROM runtime_approvals WHERE id=?', [String(approvalId || '')]);
    if (!row || row.status !== 'approved' || row.action !== action || row.decision_actor_id !== principal.actorId) throw new PlatformError('approval_required', `an approved ${action} receipt is required`, {}, 403);
    if (projectId != null && row.project_id !== String(projectId)) throw new PlatformError('approval_scope_mismatch', 'approval project does not match the resource', {}, 409);
    if (Date.parse(row.expires_at) <= Date.parse(time(this.clock))) throw new PlatformError('approval_expired', 'approval receipt expired', {}, 409);
    if (binding) { const request = parseJson(row.request_json, {}); for (const [key, value] of Object.entries(binding)) if (request[key] != null && String(request[key]) !== String(value)) throw new PlatformError('approval_scope_mismatch', 'approval receipt does not match the resource', { field: key }, 409); }
    return row;
  }

  #projectDeliveryEvent(tx, deliveryId, event, intentId, receiptHash, now) {
    tx.run('INSERT INTO delivery_events(id,delivery_id,event_id,intent_id,external_receipt_sha256,event_type,payload_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)', [opaqueId('delivery_event'), deliveryId, event.id, intentId || null, receiptHash || '', event.type, String(event.data_sha256 || '').replace(/^sha256:/, ''), now]);
  }

  #synchronizeBaseline(tx, delivery, mergeSha, actorId, now, operationId) {
    const owner = this.projectWorkflow?.repositoryService;
    if (!owner?.synchronizeBaselineInTransaction) throw new PlatformError('repository_owner_unavailable', 'Repository baseline owner is unavailable', {}, 503);
    owner.synchronizeBaselineInTransaction(tx, delivery.repository_target_id, { projectId: delivery.project_id, expectedHeadSha: mergeSha, operationId, actorId, now });
  }

  #protectedCasReferences() {
    const values = new Set();
    const references = [
      'SELECT cas_sha256 AS sha FROM asset_blobs',
      'SELECT cas_sha256 AS sha FROM receipt_manifests WHERE cas_sha256 IS NOT NULL',
      'SELECT payload_cas_hash AS sha FROM context_packs',
      'SELECT content_cas_hash AS sha FROM assist_messages',
      'SELECT content_cas_hash AS sha FROM attachments',
      'SELECT preview_cas_hash AS sha FROM attachments WHERE preview_cas_hash IS NOT NULL',
      'SELECT patch_cas_hash AS sha FROM file_change_batches',
      'SELECT before_cas_hash AS sha FROM file_change_items WHERE before_cas_hash IS NOT NULL',
      'SELECT after_cas_hash AS sha FROM file_change_items WHERE after_cas_hash IS NOT NULL',
      'SELECT undo_payload_cas_hash AS sha FROM semantic_proposals WHERE undo_payload_cas_hash IS NOT NULL',
      'SELECT chunk_cas_hash AS sha FROM terminal_events WHERE chunk_cas_hash IS NOT NULL',
      'SELECT ref_hash AS sha FROM execution_inputs',
      'SELECT patch_cas_sha256 AS sha FROM pull_request_intents'
    ];
    for (const sql of references) {
      try { for (const row of this.db.query(sql)) if (isHash(row.sha)) values.add(String(row.sha).toLowerCase()); } catch { /* older clean fixtures may omit a later phase table */ }
    }
    for (const row of this.db.query('SELECT components_json FROM backup_manifests')) collectHashes(parseJson(row.components_json, {}), values);
    for (const row of this.db.query('SELECT volume_manifest_json FROM deployment_candidates')) collectHashes(parseJson(row.volume_manifest_json, {}), values);
    return values;
  }

  #moveTombstones(hashes, planSha256) {
    const root = path.join(this.gcTrashRoot, hash(planSha256));
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const moved = [];
    for (const sha of hashes) {
      const source = this.cas.fileFor(sha);
      const target = path.join(root, hash(sha));
      try {
        if (fs.existsSync(target)) { if (sha256Hex(fs.readFileSync(target)) !== sha) throw new Error('trash_hash_mismatch'); if (fs.existsSync(source)) fs.rmSync(source); moved.push(sha); continue; }
        if (!fs.existsSync(source)) continue;
        if (sha256Hex(fs.readFileSync(source)) !== sha) throw new Error('cas_hash_mismatch');
        fs.renameSync(source, target);
        moved.push(sha);
      } catch { /* committed tombstones are reconciled on restart */ }
    }
    this.cas.createManifest();
    return moved;
  }

  #reconcileTombstones() {
    const rows = this.db.query("SELECT sha256 FROM cas_objects WHERE status='tombstoned' ORDER BY sha256");
    return rows.length ? this.#moveTombstones(rows.map((row) => row.sha256), sha256Hex(canonicalJson({ recovery: true }))) : [];
  }
}

function aggregate(row, operationId, actorId, projectId, type, now, aggregateType = null, revision = null) { return { aggregateType: aggregateType || tableType(row), aggregateId: row.id, revision: Number(revision || row.revision || row.generation || 1), operationId, actorId, projectId, type, data: { id: row.id }, payload: view(row), now }; }
function tableType(row) { if (row.intent_sha256) return 'pull_request_intent'; if (row.snapshot_sha256) return 'delivery_policy'; return 'delivery'; }
function view(row) { if (!row) return null; const value = { ...row }; for (const key of Object.keys(value)) if (key.endsWith('_json')) { value[key.slice(0, -5)] = parseJson(value[key], null); delete value[key]; } return value; }
function parseJson(value, fallback = null) { try { return JSON.parse(String(value)); } catch { return fallback; } }
function array(value) { return Array.isArray(value) ? value : []; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function stringArray(value, maximum) { const values = array(value).map((item) => bounded(item, 160, 'list item')); if (values.length > maximum || new Set(values).size !== values.length) throw new PlatformError('validation_failed', 'list is invalid', {}, 422); return values; }
function bounded(value, maximum, label) { const result = String(value || '').trim(); if (!result || result.length > maximum) throw new PlatformError('validation_failed', `${label} is invalid`, {}, 422); return result; }
function isHash(value) { return /^[a-f0-9]{64}$/i.test(String(value || '')); }
function hash(value) { const result = String(value || '').replace(/^sha256:/, '').toLowerCase(); if (!isHash(result)) throw new PlatformError('validation_failed', 'SHA-256 digest is invalid', {}, 422); return result; }
function limit(value, maximum) { const result = value == null ? Math.min(100, maximum) : Number(value); if (!Number.isInteger(result) || result < 1 || result > maximum) throw new PlatformError('validation_failed', 'limit is invalid', {}, 422); return result; }
function repositoryName(value) { const text = String(value || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/^git@github\.com:/i, '').replace(/\.git$/i, ''); if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) throw new PlatformError('github_repository_invalid', 'GitHub repository target is invalid', {}, 422); return text; }
function publicRepository(value = {}) { return { id: Number(value.id || 0), full_name: String(value.full_name || ''), owner: String(value.owner || ''), name: String(value.name || ''), default_branch: String(value.default_branch || ''), private: value.private === true, archived: value.archived === true, permissions: object(value.permissions) }; }
function assertChecks(required, actual, headSha) { const byName = new Map(array(actual).map((item) => [String(item.name), item])); for (const name of required) { const check = byName.get(name); if (!check || check.status !== 'completed' || !SUCCESSFUL_CHECKS.has(String(check.conclusion)) || (check.head_sha && check.head_sha !== headSha)) throw new PlatformError('delivery_checks_blocked', 'required delivery checks have not passed', { check: name }, 409); } }
function webhookStatus(eventType, payload, current) { if (TERMINAL_DELIVERY.has(current)) return current; if (eventType === 'pull_request') { if (payload.action === 'closed' && payload.pull_request?.merged) return 'merged'; if (payload.pull_request?.state === 'open' && payload.pull_request?.draft) return rank(current) > rank('draft_pr') ? current : 'draft_pr'; if (payload.pull_request?.state === 'open') return rank(current) > rank('ready') ? current : 'ready'; if (payload.pull_request?.state === 'closed') return 'failed'; } return current; }
function rank(status) { return ({ queued: 0, preparing: 1, draft_pr: 2, ready: 3, merging: 4, needs_reconcile: 4, merged: 5, failed: 5, cancelled: 5 })[status] ?? 0; }
function webhookReceipt(payload) { const pull = payload?.pull_request || {}; return { number: Number(pull.number || 0), state: String(pull.state || ''), draft: pull.draft === true, merged: pull.merged === true, base_sha: String(pull.base?.sha || ''), head_sha: String(pull.head?.sha || ''), merge_sha: pull.merge_commit_sha || null, updated_at: pull.updated_at || null }; }
function collectHashes(value, output) { if (typeof value === 'string' && isHash(value)) output.add(value.toLowerCase()); else if (Array.isArray(value)) for (const item of value) collectHashes(item, output); else if (value && typeof value === 'object') for (const item of Object.values(value)) collectHashes(item, output); }
