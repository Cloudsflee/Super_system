import {
  createPrivateKey, createPublicKey, generateKeyPairSync
} from 'node:crypto';
import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import {
  appendAggregate, createOperation, priorResponse, requestHash, requireIdempotency,
  requirePrincipal, requireRevision, assertRevision, saveResponse, time
} from './p5-domain-helpers.mjs';
import {
  RUNNER_RESOURCE_PROFILES, signRunnerJobSpec, verifyRunnerReceipt
} from './runner-protocol.mjs';

const TYPES = new Set(['docker', 'host', 'windows_bridge']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'external_result_unknown']);
const DEFAULT_CAPABILITIES = Object.freeze({
  docker: ['workspace:read', 'workspace:write', 'network:none', 'network:model', 'check:node_test', 'check:git_diff_check'],
  host: ['workspace:read', 'workspace:write', 'network:none', 'check:node_test', 'check:git_diff_check'],
  windows_bridge: ['workspace:read', 'workspace:write', 'network:none', 'check:node_test', 'check:git_diff_check']
});

export class CleanRunnerService {
  constructor({ db, events, operations, authorization, vault, adapters = {}, clock, pollIntervalMs = 10, config = {} } = {}) {
    if (!db || !events || !operations || !authorization || !vault) throw new TypeError('runner_service_dependencies_required');
    this.db = db; this.events = events; this.operations = operations; this.authorization = authorization; this.vault = vault;
    this.adapters = { ...adapters }; this.clock = clock; this.pollIntervalMs = Math.max(1, Number(pollIntervalMs || 10)); this.config = config;
    const identity = serviceIdentity(vault);
    this.servicePrivateKey = identity.privateKey; this.servicePublicKey = identity.publicKey; this.serviceKeyId = identity.keyId;
  }

  listProfiles(_input = {}, principal) {
    requirePrincipal(principal);
    return { profiles: this.db.query('SELECT * FROM runner_profiles WHERE owner_actor_id=? ORDER BY updated_at DESC,id', [principal.actorId]).map(profileView) };
  }

  getProfile(id, principal) { return profileView(this.profileRow(id, principal)); }

  async createProfile(input = {}, principal) {
    requirePrincipal(principal); const key = requireIdempotency(input.idempotency_key); const expected = requireRevision(input.expected_revision ?? 0, { allowZero: true });
    if (expected !== 0) throw new PlatformError('revision_conflict', 'runner profile collection revision has changed', { expected_revision: expected, actual_revision: 0 }, 409);
    const type = String(input.runner_type || 'host'); if (!TYPES.has(type)) throw new PlatformError('schema_invalid', 'runner type is invalid', {}, 422);
    const label = bounded(input.label || `${type} runner`, 160, true); const imageDigest = normalizeDigest(input.image_digest, type);
    const endpointRef = endpointReference(input.endpoint_ref || ''); const bridgeDeviceId = input.bridge_device_id == null ? null : String(input.bridge_device_id);
    if (type === 'windows_bridge' && !bridgeDeviceId) throw new PlatformError('schema_invalid', 'Windows Bridge profile requires a paired device', {}, 422);
    if (bridgeDeviceId) {
      const device = this.db.get('SELECT actor_id,status FROM bridge_devices WHERE id=?', [bridgeDeviceId]);
      if (!device || device.actor_id !== principal.actorId || device.status !== 'paired') throw new PlatformError('bridge_unavailable', 'paired Windows Bridge device is unavailable', {}, 409);
    }
    const capabilities = normalizeCapabilities(input.capabilities, type); const limits = normalizeLimits(input.limits);
    const id = opaqueId('runner_profile'); const now = time(this.clock);
    const hash = requestHash({ label, runner_type: type, endpoint_ref: endpointRef, image_digest: imageDigest, bridge_device_id: bridgeDeviceId, capabilities, limits });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'runner.profile.create', idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const capabilityJson = canonicalJson(capabilities); const limitsJson = canonicalJson(limits);
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'runner.profile.create', resourceType: 'runner_profile', resourceId: id, requestHash: hash, status: 'succeeded', now });
      tx.run(`INSERT INTO runner_profiles(id,owner_actor_id,label,runner_type,endpoint_ref,image_digest,bridge_device_id,capabilities_json,capabilities_sha256,limits_json,limits_sha256,identity_public_key,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'','unprobed',1,?,?,?,?)`, [id, principal.actorId, label, type, endpointRef, imageDigest, bridgeDeviceId, capabilityJson, sha256Hex(capabilityJson), limitsJson, sha256Hex(limitsJson), now, now, principal.actorId, principal.actorId]);
      appendAggregate(this.events, tx, { aggregateType: 'runner_profile', aggregateId: id, revision: 1, operationId: op.id, actorId: principal.actorId, type: 'runner_profile.created', data: { profile_id: id, runner_type: type }, payload: profilePayload(tx.get('SELECT * FROM runner_profiles WHERE id=?', [id])), now });
      this.operations.linkInTransaction(tx, op.id, [['runner_profile', id]], now);
      const response = { profile: profileView(tx.get('SELECT * FROM runner_profiles WHERE id=?', [id])), operation: this.operations.summary(op) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'runner.profile.create', idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 201, now }); return response;
    });
  }

  async updateProfile(id, input = {}, principal) {
    const row = this.profileRow(id, principal); const expected = requireRevision(input.expected_revision); const key = requireIdempotency(input.idempotency_key);
    const label = input.label == null ? row.label : bounded(input.label, 160, true); const endpointRef = input.endpoint_ref == null ? row.endpoint_ref : endpointReference(input.endpoint_ref);
    const imageDigest = input.image_digest == null ? row.image_digest : normalizeDigest(input.image_digest, row.runner_type);
    const capabilities = input.capabilities == null ? JSON.parse(row.capabilities_json) : normalizeCapabilities(input.capabilities, row.runner_type);
    const limits = input.limits == null ? JSON.parse(row.limits_json) : normalizeLimits(input.limits); const now = time(this.clock);
    const hash = requestHash({ profile_id: row.id, expected_revision: expected, label, endpoint_ref: endpointRef, image_digest: imageDigest, capabilities, limits });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'runner.profile.update', idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get('SELECT * FROM runner_profiles WHERE id=?', [row.id]); assertRevision(current, expected);
      if (current.status === 'disabled') throw new PlatformError('state_conflict', 'disabled runner profile is immutable', {}, 409);
      const capabilityJson = canonicalJson(capabilities); const limitsJson = canonicalJson(limits); const next = expected + 1;
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'runner.profile.update', resourceType: 'runner_profile', resourceId: row.id, requestHash: hash, status: 'succeeded', now });
      tx.run("UPDATE runner_profiles SET label=?,endpoint_ref=?,image_digest=?,capabilities_json=?,capabilities_sha256=?,limits_json=?,limits_sha256=?,status='unprobed',identity_public_key='',last_probe_at=NULL,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [label, endpointRef, imageDigest, capabilityJson, sha256Hex(capabilityJson), limitsJson, sha256Hex(limitsJson), next, now, principal.actorId, row.id, expected], 1);
      appendAggregate(this.events, tx, { aggregateType: 'runner_profile', aggregateId: row.id, revision: next, operationId: op.id, actorId: principal.actorId, type: 'runner_profile.updated', data: { profile_id: row.id }, payload: profilePayload(tx.get('SELECT * FROM runner_profiles WHERE id=?', [row.id])), now });
      const response = { profile: profileView(tx.get('SELECT * FROM runner_profiles WHERE id=?', [row.id])), operation: this.operations.summary(op) }; saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'runner.profile.update', idempotencyKey: key, requestHash: hash, response, operationId: op.id, now }); return response;
    });
  }

  async probeProfile(id, input = {}, principal) {
    const row = this.profileRow(id, principal); const expected = requireRevision(input.expected_revision); const key = requireIdempotency(input.idempotency_key); const now = time(this.clock);
    const hash = requestHash({ profile_id: row.id, expected_revision: expected });
    const response = await this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'runner.profile.probe', idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get('SELECT * FROM runner_profiles WHERE id=?', [row.id]); assertRevision(current, expected); if (current.status === 'disabled') throw new PlatformError('state_conflict', 'runner profile is disabled', {}, 409);
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'runner.profile.probe', resourceType: 'runner_profile', resourceId: row.id, projectId: null, requestHash: hash, idempotencyKey: `op-${key}`, status: 'queued', now });
      tx.run("UPDATE runner_profiles SET status='probing',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, principal.actorId, row.id, expected], 1);
      appendAggregate(this.events, tx, { aggregateType: 'runner_profile', aggregateId: row.id, revision: expected + 1, operationId: op.id, actorId: principal.actorId, type: 'runner_profile.probe_queued', data: { profile_id: row.id }, payload: profilePayload(tx.get('SELECT * FROM runner_profiles WHERE id=?', [row.id])), now });
      this.operations.linkInTransaction(tx, op.id, [['runner_profile', row.id]], now);
      const value = { profile: profileView(tx.get('SELECT * FROM runner_profiles WHERE id=?', [row.id])), operation: this.operations.summary(op) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'runner.profile.probe', idempotencyKey: key, requestHash: hash, response: value, operationId: op.id, status: 202, now });
      tx.afterCommit(() => queueMicrotask(() => this.runProbe(row.id, op.id, principal.actorId).catch(() => undefined)));
      return value;
    });
    return response;
  }

  async runProbe(profileId, operationId, actorId) {
    let op = this.operations.get(operationId); if (op.status === 'queued') op = await this.operations.start(operationId, { expectedRevision: op.revision, actorId });
    const row = this.db.get('SELECT * FROM runner_profiles WHERE id=?', [profileId]); const adapter = this.adapterFor(row);
    try {
      const probe = await adapter.probe(profileView(row)); const publicKey = String(probe.identity_public_key || '');
      if (!publicKey) throw new PlatformError('runner_identity_missing', 'runner probe did not return an identity', {}, 503);
      createPublicKey(publicKey);
      return this.db.withTransaction((tx) => {
        const current = tx.get('SELECT * FROM runner_profiles WHERE id=?', [profileId]); const now = time(this.clock); const next = Number(current.revision) + 1;
        tx.run("UPDATE runner_profiles SET status='ready',identity_public_key=?,last_probe_at=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [publicKey, now, next, now, actorId, profileId, current.revision], 1);
        appendAggregate(this.events, tx, { aggregateType: 'runner_profile', aggregateId: profileId, revision: next, operationId, actorId, type: 'runner_profile.probed', data: { profile_id: profileId, status: 'ready', capabilities: probe.capabilities || [] }, payload: profilePayload(tx.get('SELECT * FROM runner_profiles WHERE id=?', [profileId])), now });
        const currentOp = tx.get('SELECT revision FROM operations WHERE id=?', [operationId]); return this.operations.transitionInTransaction(tx, operationId, 'succeeded', { expectedRevision: currentOp.revision, actorId, result: { profile_id: profileId, status: 'ready' } }, now);
      });
    } catch (error) {
      await this.db.withTransaction((tx) => {
        const current = tx.get('SELECT * FROM runner_profiles WHERE id=?', [profileId]); const now = time(this.clock); const next = Number(current.revision) + 1;
        tx.run("UPDATE runner_profiles SET status='unavailable',last_probe_at=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, next, now, actorId, profileId, current.revision], 1);
        appendAggregate(this.events, tx, { aggregateType: 'runner_profile', aggregateId: profileId, revision: next, operationId, actorId, type: 'runner_profile.probe_failed', data: { profile_id: profileId, error_code: String(error?.code || 'runner_unavailable') }, payload: profilePayload(tx.get('SELECT * FROM runner_profiles WHERE id=?', [profileId])), now });
        const currentOp = tx.get('SELECT revision,status FROM operations WHERE id=?', [operationId]); if (!TERMINAL.has(currentOp.status)) this.operations.transitionInTransaction(tx, operationId, 'failed', { expectedRevision: currentOp.revision, actorId, errorCode: String(error?.code || 'runner_unavailable') }, now);
      });
      throw error;
    }
  }

  async disableProfile(id, input = {}, principal) {
    const row = this.profileRow(id, principal); const expected = requireRevision(input.expected_revision); const key = requireIdempotency(input.idempotency_key); const now = time(this.clock);
    const hash = requestHash({ profile_id: row.id, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'runner.profile.disable', idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get('SELECT * FROM runner_profiles WHERE id=?', [row.id]); assertRevision(current, expected); const active = tx.get("SELECT count(*) AS count FROM task_attempts WHERE runner_profile_id=? AND status IN ('leased','running')", [row.id]); if (Number(active.count)) throw new PlatformError('runner_busy', 'runner profile has active jobs', {}, 409);
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'runner.profile.disable', resourceType: 'runner_profile', resourceId: row.id, requestHash: hash, status: 'succeeded', now }); const next = expected + 1;
      tx.run("UPDATE runner_profiles SET status='disabled',revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [next, now, principal.actorId, row.id, expected], 1);
      appendAggregate(this.events, tx, { aggregateType: 'runner_profile', aggregateId: row.id, revision: next, operationId: op.id, actorId: principal.actorId, type: 'runner_profile.disabled', data: { profile_id: row.id }, payload: profilePayload(tx.get('SELECT * FROM runner_profiles WHERE id=?', [row.id])), now });
      const response = { profile: profileView(tx.get('SELECT * FROM runner_profiles WHERE id=?', [row.id])), operation: this.operations.summary(op) }; saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'runner.profile.disable', idempotencyKey: key, requestHash: hash, response, operationId: op.id, now }); return response;
    });
  }

  profileForExecution(id, principal, projectId) {
    const row = this.profileRow(id, principal); this.authorization.assert(principal, 'run', String(projectId), { runner_profile_id: row.id });
    if (row.status !== 'ready') throw new PlatformError('runner_unavailable', 'runner profile is not ready', { status: row.status }, 409);
    return row;
  }

  createJobSpecInTransaction(tx, { execution, attempt, task, profile, inputRefs = [], workspaceHash, contextPackHash, now, actorId }) {
    const id = opaqueId('job_spec'); const deadlineAt = new Date(Math.min(Date.parse(now) + 15 * 60 * 1000, Date.parse(now) + Math.max(1, Number(task.deadline_seconds || 900)) * 1000)).toISOString();
    const profileHash = profileSnapshotHash(profile); const checkIds = Array.isArray(task.check_ids) ? task.check_ids : [];
    const capabilities = [...new Set(['workspace:read', task.mode === 'write' ? 'workspace:write' : null, 'network:none', ...checkIds.map((check) => `check:${check}`)].filter(Boolean))].sort();
    const value = {
      schema_version: 'runner.job-spec.v2', job_spec_id: id, execution_ref: execution.id, generation: Number(execution.generation), task_ref: String(task.id), attempt: Number(attempt.attempt_no),
      runner_profile_ref: profile.id, runner_profile_revision: Number(profile.revision), runner_profile_hash: profileHash,
      image_digest: profile.image_digest || '', deadline_at: deadlineAt, capabilities, resource_profile: task.resource_profile || 'light', execution_mode: task.mode || 'read',
      input_refs: inputRefs.map((item) => ({ type: item.input_type || item.type, ref: item.ref_id || item.ref, revision: Number(item.ref_revision ?? item.revision ?? 0), hash: item.ref_hash || item.hash })),
      input_paths: Array.isArray(task.input_paths) ? task.input_paths : [], output_paths: Array.isArray(task.output_paths) ? task.output_paths : [], check_ids: checkIds,
      workspace_ref: execution.repository_workspace_id, workspace_hash: workspaceHash, context_pack_ref: execution.context_pack_id, context_pack_hash: contextPackHash,
      service_key_id: this.serviceKeyId, created_at: now
    };
    const signed = signRunnerJobSpec(value, this.servicePrivateKey, { now: Date.parse(now), expectedImageDigest: profile.image_digest || null });
    tx.run('INSERT INTO job_specs(id,execution_id,task_attempt_id,runner_profile_id,schema_version,spec_json,spec_sha256,service_key_id,signature,deadline_at,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [id, execution.id, attempt.id, profile.id, signed.spec.schema_version, signed.spec_json, signed.spec_sha256, this.serviceKeyId, signed.signature, deadlineAt, now, actorId]);
    tx.run('UPDATE task_attempts SET job_spec_id=?,updated_at=? WHERE id=? AND revision=?', [id, now, attempt.id, attempt.revision], 1);
    return signed;
  }

  async runSignedJob(signed, profile, context = {}) {
    const adapter = this.adapterFor(profile); const submitted = await adapter.submit(signed.spec, { ...context, profile: profileView(profile), specHash: signed.spec_sha256, specSignature: signed.signature, servicePublicKey: this.servicePublicKey });
    const jobId = String(submitted?.job_id || ''); if (!jobId) throw new PlatformError('runner_submit_invalid', 'runner did not return a job reference', {}, 503);
    await context.onSubmitted?.({ job_id: jobId, status: String(submitted.status || 'queued') });
    let current = submitted; let priorStatus = String(current.status || '');
    while (!TERMINAL.has(String(current.status || ''))) {
      if (Date.now() >= Date.parse(signed.spec.deadline_at)) { await adapter.cancel(jobId, { profile: profileView(profile) }).catch(() => undefined); throw new PlatformError('runner_deadline_exceeded', 'runner job exceeded its deadline', {}, 504); }
      await delay(this.pollIntervalMs); current = await adapter.status(jobId, { profile: profileView(profile) });
      if (String(current.status || '') !== priorStatus) { priorStatus = String(current.status || ''); await context.onStatus?.({ job_id: jobId, status: priorStatus }); }
      if (current.status === 'unknown') return { job_id: jobId, status: 'external_result_unknown' };
    }
    return this.verifyJobResult(current, signed, profile, jobId);
  }

  async reconcileJob(attempt, profile) {
    const specRow = this.db.get('SELECT * FROM job_specs WHERE id=? AND task_attempt_id=?', [attempt.job_spec_id, attempt.id]);
    if (!specRow || !attempt.lease_id) return { job_id: attempt.lease_id || '', status: 'external_result_unknown' };
    const signed = { spec: JSON.parse(specRow.spec_json), spec_json: specRow.spec_json, spec_sha256: specRow.spec_sha256, signature: specRow.signature };
    const current = await this.adapterFor(profile).status(attempt.lease_id, { profile: profileView(profile) });
    if (current.status === 'unknown') return { job_id: attempt.lease_id, status: 'external_result_unknown' };
    if (!TERMINAL.has(String(current.status || ''))) return { job_id: attempt.lease_id, status: String(current.status || 'running') };
    return this.verifyJobResult(current, signed, profile, attempt.lease_id);
  }

  verifyJobResult(current, signed, profile, jobId) {
    if (current.status === 'external_result_unknown' || current.status === 'unknown' || !current.receipt) return { job_id: jobId, status: 'external_result_unknown' };
    const signer = String(current.signer_public_key || ''); if (!signer || signer.trim() !== String(profile.identity_public_key || '').trim()) throw new PlatformError('runner_identity_mismatch', 'runner receipt identity differs from the probed profile', {}, 409);
    const verified = verifyRunnerReceipt(current.receipt, current.signature, signer, { expectedJobSpecId: signed.spec.job_spec_id, expectedJobSpecHash: signed.spec_sha256 });
    return { job_id: jobId, status: verified.receipt.status, ...verified, signature: current.signature, signer_public_key: signer };
  }

  persistReceiptInTransaction(tx, { attempt, profile, result, now }) {
    if (result.status === 'external_result_unknown') return null;
    const id = result.receipt.receipt_id;
    tx.run(`INSERT INTO runner_receipts(id,job_spec_id,task_attempt_id,runner_profile_id,schema_version,receipt_json,receipt_sha256,signer_public_key,signature,status,exit_code,stdout_sha256,stderr_sha256,output_sha256,stdout_bytes,stderr_bytes,output_bytes,started_at,finished_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, result.receipt.job_spec_id, attempt.id, profile.id, result.receipt.schema_version, result.receipt_json, result.receipt_sha256, result.signer_public_key, result.signature, result.receipt.status, result.receipt.exit_code, result.receipt.stdout_sha256, result.receipt.stderr_sha256, result.receipt.output_sha256, result.receipt.stdout_bytes, result.receipt.stderr_bytes, result.receipt.output_bytes, result.receipt.started_at, result.receipt.finished_at, now]);
    return id;
  }

  adapterFor(profile) { const adapter = this.adapters[String(profile.runner_type || '')]; if (!adapter) throw new PlatformError('runner_unavailable', 'runner adapter is not configured', { runner_type: profile.runner_type }, 503); return adapter; }

  profileRow(id, principal) {
    requirePrincipal(principal); const row = this.db.get('SELECT * FROM runner_profiles WHERE id=?', [String(id)]);
    if (!row) throw new PlatformError('not_found', 'runner profile not found', {}, 404);
    if (row.owner_actor_id !== principal.actorId) throw new PlatformError('permission_denied', 'runner profile belongs to another actor', {}, 403);
    return row;
  }
}

export function profileSnapshotHash(row) { return sha256Hex(canonicalJson(profilePayload(row))); }

function profilePayload(row) { return { id: row.id, owner_actor_id: row.owner_actor_id, label: row.label, runner_type: row.runner_type, endpoint_ref: row.endpoint_ref, image_digest: row.image_digest, bridge_device_id: row.bridge_device_id || null, capabilities: JSON.parse(row.capabilities_json || '[]'), limits: JSON.parse(row.limits_json || '{}'), identity_public_key_sha256: row.identity_public_key ? sha256Hex(row.identity_public_key) : '', status: row.status, revision: Number(row.revision) }; }
function profileView(row) { const value = profilePayload(row); return { ...value, identity_public_key: row.identity_public_key || '', last_probe_at: row.last_probe_at || null, created_at: row.created_at, updated_at: row.updated_at, profile_hash: sha256Hex(canonicalJson(value)) }; }

function serviceIdentity(vault) {
  const ref = 'runner-service-ed25519-v1'; let bytes;
  if (vault.has(ref)) bytes = vault.read(ref);
  else { const generated = generateKeyPairSync('ed25519'); bytes = Buffer.from(generated.privateKey.export({ type: 'pkcs8', format: 'pem' })); vault.put(ref, bytes); bytes.fill(0); bytes = vault.read(ref); }
  try {
    const privateKey = createPrivateKey(bytes); const publicKeyObject = createPublicKey(privateKey); const publicKey = publicKeyObject.export({ type: 'spki', format: 'pem' }).toString();
    return { privateKey, publicKey, keyId: `runner-key-${sha256Hex(publicKey).slice(0, 24)}` };
  } finally { bytes.fill(0); }
}

function normalizeCapabilities(value, type) { const defaults = DEFAULT_CAPABILITIES[type]; if (value == null) return [...defaults]; if (!Array.isArray(value) || value.length > 16) throw new PlatformError('schema_invalid', 'runner capabilities are invalid', {}, 422); const result = [...new Set(value.map(String))].sort(); if (result.some((item) => !defaults.includes(item))) throw new PlatformError('runner_capability_denied', 'runner capability is outside the adapter allowlist', {}, 422); return result; }
function normalizeLimits(value) { if (value == null) return RUNNER_RESOURCE_PROFILES; const json = canonicalJson(value); if (json !== canonicalJson(RUNNER_RESOURCE_PROFILES)) throw new PlatformError('runner_resource_profile_invalid', 'runner limits must use the fixed resource profiles', {}, 422); return RUNNER_RESOURCE_PROFILES; }
function normalizeDigest(value, type) { const digest = String(value || '').toLowerCase(); if (type === 'docker' && !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new PlatformError('runner_digest_invalid', 'Docker runner requires a fixed image digest', {}, 422); if (type !== 'docker' && digest) throw new PlatformError('runner_digest_invalid', 'only Docker runner profiles bind an image digest', {}, 422); return digest; }
function bounded(value, max, required = false) { const text = String(value ?? ''); if ((required && !text.trim()) || text.length > max || /[\0\r\n]/.test(text)) throw new PlatformError('schema_invalid', 'runner profile field is invalid', {}, 422); return text; }
function endpointReference(value) { const text = String(value || ''); if (text && !/^[A-Za-z][A-Za-z0-9._~-]{0,159}$/.test(text)) throw new PlatformError('runner_endpoint_ref_invalid', 'runner endpoint must be an opaque reference', {}, 422); return text; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
