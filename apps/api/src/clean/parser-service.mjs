import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import {
  appendAggregate, assertRevision, createOperation, priorResponse, requestHash,
  requireIdempotency, requirePrincipal, requireRevision, saveResponse, time
} from './p5-domain-helpers.mjs';
import {
  signParserJob, validateParserOutputs, verifyParserReceipt
} from './parser-protocol.mjs';
import { DEFAULT_PARSER_LIMITS } from './parser-limits.mjs';

const TERMINAL = new Set(['parsed', 'unsupported', 'invalid', 'resource_exceeded', 'failed', 'cancelled', 'external_result_unknown']);
const TRANSIENT = new Set(['parser_unavailable', 'parser_spawn_failed', 'parser_worker_failed', 'parser_deadline_exceeded', 'transient_failure']);

export class CleanParserService {
  constructor({ db, cas, events, operations, authorization, evidence, adapter, clock, pollIntervalMs = 25, sleep = null, retryDelays = [1000, 4000], serviceIdentity = null, bootstrapActorId = 'actor_system_bootstrap' } = {}) {
    if (!db || !cas || !events || !operations || !authorization || !evidence || !adapter) throw new TypeError('parser_service_dependencies_required');
    this.db = db;
    this.cas = cas;
    this.events = events;
    this.operations = operations;
    this.authorization = authorization;
    this.evidence = evidence;
    this.adapter = adapter;
    this.clock = clock;
    this.pollIntervalMs = Math.max(1, Number(pollIntervalMs) || 25);
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retryDelays = retryDelays;
    this.identity = serviceIdentity || generateKeyPairSync('ed25519');
    this.bootstrapActorId = bootstrapActorId;
    this.active = new Set();
  }

  listFormats(input = {}, principal) {
    requirePrincipal(principal);
    const clauses = [];
    const params = [];
    for (const [column, key] of [['format_key', 'format_key'], ['family', 'family'], ['status', 'status']]) {
      if (input[key]) { clauses.push(`${column}=?`); params.push(String(input[key])); }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return { formats: this.db.query(`SELECT * FROM parser_formats ${where} ORDER BY family,format_key`, params).map(formatView) };
  }

  get(id, principal) {
    return { parser_run: runView(this.runRow(id, principal, 'read')) };
  }

  async start(assetId, versionId, input = {}, principal) {
    requirePrincipal(principal);
    const source = this.sourceRows(assetId, versionId);
    this.authorization.assert(principal, 'run', source.asset.project_id, { resource: 'parser' });
    const expected = requireRevision(input.expected_revision); assertRevision(source.asset, expected);
    const key = requireIdempotency(input.idempotency_key);
    return this.createRun({ source, input, principal, commandId: 'parser.run.start', idempotencyKey: key, attemptNo: 1, retryOf: null, parentOperationId: null });
  }

  async retry(id, input = {}, principal) {
    const row = this.runRow(id, principal, 'run');
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    if (!TERMINAL.has(row.status)) throw new PlatformError('state_conflict', 'parser run is not terminal', { status: row.status }, 409);
    if (Number(row.attempt_no) >= 3) throw new PlatformError('parser_retry_exhausted', 'parser retry limit reached', {}, 409);
    const sourceVersion = this.db.get('SELECT * FROM asset_versions WHERE id=?', [row.source_asset_version_id]);
    const sourceAsset = this.db.get('SELECT * FROM assets WHERE id=?', [sourceVersion.asset_id]);
    const source = { asset: sourceAsset, version: sourceVersion, blob: this.db.get('SELECT * FROM asset_blobs WHERE id=?', [sourceVersion.blob_id]) };
    const format = this.db.get('SELECT format_key FROM parser_formats WHERE id=?', [row.format_id]);
    const retryInput = { ...input, format_key: input.format_key || format?.format_key, limits: input.limits || parseJson(row.limits_json, {}) };
    return this.createRun({ source, input: retryInput, principal, commandId: 'parser.run.retry', idempotencyKey: requireIdempotency(input.idempotency_key), attemptNo: Number(row.attempt_no) + 1, retryOf: row.id, parentOperationId: row.operation_id });
  }

  async cancel(id, input = {}, principal) {
    const row = this.runRow(id, principal, 'run');
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    if (TERMINAL.has(row.status)) throw new PlatformError('state_conflict', 'parser run is terminal', { status: row.status }, 409);
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ parser_run_id: row.id, expected_revision: expected, reason: String(input.reason || '') });
    let operation = this.operations.get(row.operation_id);
    if (!operation.cancellation_requested) operation = await this.operations.requestCancel(row.operation_id, { actorId: operation.actor_id, projectId: operation.project_id, expectedRevision: operation.revision, idempotencyKey: `parser-cancel-${sha256Hex(key).slice(0, 32)}`, requestHash: hash, commandId: 'operations.cancel', reason: input.reason });
    if (row.broker_job_id) await this.adapter.cancel(row.broker_job_id).catch(() => undefined);
    const response = this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'parser.run.cancel', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM parser_runs WHERE id=?', [row.id]); assertRevision(current, expected);
      tx.run("UPDATE parser_runs SET status='cancelled',error_code='parser_cancelled',revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND revision=?", [now, now, row.id, expected], 1);
      const next = tx.get('SELECT * FROM parser_runs WHERE id=?', [row.id]);
      this.appendRun(tx, next, row.operation_id, principal.actorId, 'parser_run.cancelled', { parser_run_id: row.id }, now);
      const original = tx.get('SELECT * FROM operations WHERE id=?', [row.operation_id]);
      if (original && !['succeeded', 'failed', 'cancelled', 'expired'].includes(original.status)) this.operations.transitionInTransaction(tx, original.id, 'cancelled', { expectedRevision: original.revision, actorId: original.actor_id, projectId: original.project_id, errorCode: 'parser_cancelled' }, now);
      const value = { parser_run: runView(next), operation: this.operations.summary(tx.get('SELECT * FROM operations WHERE id=?', [row.operation_id])) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'parser.run.cancel', idempotencyKey: key, requestHash: hash, response: value, operationId: row.operation_id, status: 200, now });
      return value;
    });
    return response;
  }

  async createRun({ source, input, principal, commandId, idempotencyKey, attemptNo, retryOf, parentOperationId }) {
    const format = this.resolveFormat(source, input.format_key);
    const limits = normalizeLimits(input.limits || parseJson(format.limits_json, {}));
    const limitsJson = canonicalJson(limits);
    const limitsHash = sha256Hex(limitsJson);
    const formatHash = formatSnapshotHash(format);
    const inputBytes = this.cas.read(source.blob.cas_sha256);
    if (sha256Hex(inputBytes) !== source.version.content_sha256 || sha256Hex(inputBytes) !== source.blob.content_sha256) throw new PlatformError('asset_tamper', 'parser input failed content verification', {}, 503);
    const now = time(this.clock);
    const runId = opaqueId('parser_run');
    const parserJobId = opaqueId('parser_job');
    const checkpointToken = randomBytes(32).toString('base64url');
    const checkpointHash = sha256Hex(checkpointToken);
    checkpointToken.fill?.(0);
    const servicePublicKey = this.publicIdentity();
    const jobValue = {
      schema_version: 'parser.job.v1', parser_job_id: parserJobId, parser_run_ref: runId,
      project_ref: source.asset.project_id, asset_version_ref: source.version.id,
      input_sha256: source.version.content_sha256, input_cas_sha256: source.blob.cas_sha256,
      input_bytes: Number(source.blob.byte_length), media_type: source.blob.media_type,
      format_key: format.format_key, format_sha256: formatHash,
      worker_image_digest: format.worker_image_digest, limits, limits_sha256: limitsHash,
      checkpoint_token_hash: checkpointHash, service_key_id: 'parser-service-p7',
      deadline_at: new Date(Date.parse(now) + limits.deadline_seconds * 1000).toISOString(), created_at: now
    };
    const signed = signParserJob(jobValue, this.identity.privateKey, { expectedImageDigest: format.worker_image_digest, now: () => Date.parse(now) });
    const jobEnvelope = canonicalJson({ enqueued_job: signed.job, job_sha256: signed.job_sha256, signature: signed.signature, service_public_key: servicePublicKey });
    const requestDigest = requestHash({ source_asset_version_id: source.version.id, format_sha256: formatHash, limits_sha256: limitsHash, attempt_no: attemptNo, retry_of: retryOf, fixture: input.fixture || {} });
    const result = this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey, requestHash: requestDigest, now });
      if (prior) return prior;
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'parser_run', resourceId: runId, projectId: source.asset.project_id, requestHash: requestDigest, idempotencyKey: `op-${idempotencyKey}`, status: 'queued', now, parentOperationId });
      tx.run(`INSERT INTO parser_runs(id,project_id,source_asset_version_id,format_id,operation_id,attempt_no,retry_of_parser_run_id,broker_job_id,schema_version,input_sha256,input_cas_sha256,format_sha256,limits_json,limits_sha256,checkpoint_token_hash,status,output_manifest_json,receipt_json,created_at,updated_at,created_by_actor_id)
        VALUES(?,?,?,?,?,?,?,'','parser.job.v1',?,?,?,?,?,?,'queued','{}',?,?,?,?)`, [runId, source.asset.project_id, source.version.id, format.id, operation.id, attemptNo, retryOf, source.version.content_sha256, source.blob.cas_sha256, formatHash, limitsJson, limitsHash, checkpointHash, jobEnvelope, now, now, principal.actorId]);
      const row = tx.get('SELECT * FROM parser_runs WHERE id=?', [runId]);
      this.appendRun(tx, row, operation.id, principal.actorId, retryOf ? 'parser_run.retry_queued' : 'parser_run.queued', { parser_run_id: runId, source_asset_version_id: source.version.id, attempt_no: attemptNo }, now);
      this.operations.linkInTransaction(tx, operation.id, [['parser_run', runId], ['asset_version', source.version.id], ...(retryOf ? [['parser_run', retryOf, 'retry_of']] : [])], now);
      const response = { parser_run: runView(row), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey, requestHash: requestDigest, response, operationId: operation.id, status: 202, now });
      tx.afterCommit(() => this.schedule(runId, input.fixture || {}));
      return response;
    });
    inputBytes.fill(0);
    return result;
  }

  schedule(runId, fixture = {}) {
    if (this.active.has(String(runId))) return;
    this.active.add(String(runId));
    queueMicrotask(() => this.executeRun(runId, fixture).catch(() => undefined).finally(() => this.active.delete(String(runId))));
  }

  async executeRun(runId, fixture = {}) {
    let row = this.db.get('SELECT * FROM parser_runs WHERE id=?', [String(runId)]);
    if (!row || TERMINAL.has(row.status)) return row;
    let operation = this.operations.get(row.operation_id);
    if (['accepted', 'queued', 'paused'].includes(operation.status)) operation = await this.operations.start(operation.id, { expectedRevision: operation.revision, actorId: operation.actor_id, projectId: operation.project_id });
    const envelope = parseJson(row.receipt_json, {});
    const job = envelope.enqueued_job;
    if (!job || !envelope.signature || !envelope.service_public_key) return this.failRun(row, 'parser_job_journal_invalid', 'external_result_unknown');
    try {
      if (!row.broker_job_id) {
        const probe = await this.adapter.probe();
        const signer = String(probe.identity_public_key || '');
        if (!signer) throw new PlatformError('parser_identity_missing', 'parser adapter identity is missing', {}, 503);
        const input = this.cas.read(row.input_cas_sha256);
        const submitted = await this.adapter.submit(job, { jobSignature: envelope.signature, servicePublicKey: envelope.service_public_key, input, fixture });
        input.fill(0);
        if (!submitted?.job_id) throw new PlatformError('parser_enqueue_failed', 'parser adapter did not return a job reference', {}, 503);
        row = await this.db.withTransaction((tx) => {
          const current = tx.get('SELECT * FROM parser_runs WHERE id=?', [runId]);
          if (TERMINAL.has(current.status)) return current;
          const now = time(this.clock);
          tx.run("UPDATE parser_runs SET status='running',broker_job_id=?,signer_public_key=?,revision=revision+1,updated_at=?,started_at=COALESCE(started_at,?) WHERE id=? AND revision=?", [submitted.job_id, signer, now, now, current.id, current.revision], 1);
          const next = tx.get('SELECT * FROM parser_runs WHERE id=?', [current.id]);
          this.appendRun(tx, next, row.operation_id, row.created_by_actor_id, 'parser_run.running', { parser_run_id: row.id, broker_job_id: submitted.job_id }, now);
          return next;
        });
      }
      while (!TERMINAL.has(row.status)) {
        const status = await this.adapter.status(row.broker_job_id);
        if (status.status === 'unknown') return this.failRun(row, 'parser_external_result_unknown', 'external_result_unknown');
        if (PARSER_ACTIVE.has(status.status)) { await this.sleep(this.pollIntervalMs); row = this.db.get('SELECT * FROM parser_runs WHERE id=?', [runId]); continue; }
        return await this.finalizeRun(row, status);
      }
      return row;
    } catch (error) {
      const code = String(error?.code || 'parser_failed');
      const status = code.includes('unknown') ? 'external_result_unknown' : code.includes('quota') || code.includes('deadline') ? 'resource_exceeded' : 'failed';
      const failed = await this.failRun(this.db.get('SELECT * FROM parser_runs WHERE id=?', [runId]), code, status);
      if (TRANSIENT.has(code) && Number(failed.attempt_no) < 3) this.scheduleAutomaticRetry(failed);
      return failed;
    }
  }

  async finalizeRun(row, external) {
    const envelope = parseJson(row.receipt_json, {});
    const verified = verifyParserReceipt(external.receipt, external.signature, row.signer_public_key, { expectedJobId: envelope.enqueued_job.parser_job_id, expectedJobHash: envelope.job_sha256, expectedInputHash: row.input_sha256, expectedFormatHash: row.format_sha256, expectedLimitsHash: row.limits_sha256, expectedCheckpointHash: row.checkpoint_token_hash });
    const outputs = validateParserOutputs(external.outputs || [], verified.receipt.output_manifest);
    const prepared = [];
    try {
      for (const output of outputs) prepared.push({ output, prepared: this.evidence.prepareContent(output.bytes, output.media_type, { kind: 'parser.output', parser_run_id: row.id }) });
    } catch (error) {
      return this.failRun(row, String(error?.code || 'parser_output_policy_rejected'), 'failed', verified);
    } finally {
      for (const output of outputs) output.bytes.fill(0);
    }
    const now = time(this.clock);
    const result = await this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM parser_runs WHERE id=?', [row.id]);
      if (TERMINAL.has(current.status)) return current;
      const sourceVersion = tx.get('SELECT * FROM asset_versions WHERE id=?', [current.source_asset_version_id]);
      const sourceAsset = tx.get('SELECT * FROM assets WHERE id=?', [sourceVersion.asset_id]);
      const assetVersions = [];
      for (const [index, item] of prepared.entries()) {
        const assetId = opaqueId('asset');
        const inserted = this.evidence.insertPreparedInTransaction(tx, { assetId, projectId: current.project_id, executionId: sourceAsset.execution_id || null, logicalName: `${sourceAsset.logical_name}.parsed.${item.output.kind}`, assetKind: 'parser_output', sourceType: 'parser', sourceRef: `${current.id}:${index + 1}`, metadata: item.output.metadata, actorId: current.created_by_actor_id, operationId: current.operation_id, parserRunId: index === 0 ? current.id : null, prepared: item.prepared, now });
        this.evidence.appendAsset(tx, inserted.asset, current.operation_id, current.created_by_actor_id, 'asset.captured', { asset_id: inserted.asset.id, version_id: inserted.version.id, parser_run_id: current.id }, now);
        const relationId = opaqueId('asset_relation');
        const metadataJson = canonicalJson({ parser_run_id: current.id, output_kind: item.output.kind });
        tx.run(`INSERT INTO asset_relations(id,project_id,from_asset_id,from_version_id,to_asset_id,to_version_id,relation_type,operation_id,actor_id,policy_revision,input_sha256,output_sha256,metadata_json,metadata_sha256,created_at)
          VALUES(?,?,?,?,?,?,'derived_from',?,?,?,?,?,?,?,?)`, [relationId, current.project_id, inserted.asset.id, inserted.version.id, sourceAsset.id, sourceVersion.id, current.operation_id, current.created_by_actor_id, 1, sourceVersion.content_sha256, inserted.version.content_sha256, metadataJson, sha256Hex(metadataJson), now]);
        this.operations.linkInTransaction(tx, current.operation_id, [['asset', inserted.asset.id], ['asset_version', inserted.version.id]], now);
        assetVersions.push(inserted.version.id);
      }
      const terminal = verified.receipt.status;
      tx.run(`UPDATE parser_runs SET status=?,output_manifest_json=?,output_manifest_sha256=?,output_asset_version_id=?,receipt_json=?,receipt_sha256=?,signature=?,error_code=?,revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND revision=?`, [terminal, canonicalJson(verified.receipt.output_manifest), verified.receipt.output_manifest_sha256, assetVersions[0] || null, verified.receipt_json, verified.receipt_sha256, external.signature, verified.receipt.error_code, now, now, current.id, current.revision], 1);
      const next = tx.get('SELECT * FROM parser_runs WHERE id=?', [current.id]);
      this.appendRun(tx, next, current.operation_id, current.created_by_actor_id, `parser_run.${terminal}`, { parser_run_id: current.id, output_asset_version_id: assetVersions[0] || null, output_manifest_sha256: verified.receipt.output_manifest_sha256, error_code: verified.receipt.error_code || undefined }, now);
      const operation = tx.get('SELECT * FROM operations WHERE id=?', [current.operation_id]);
      if (operation && !['succeeded', 'failed', 'cancelled', 'expired'].includes(operation.status)) {
        const operationStatus = terminal === 'parsed' ? 'succeeded' : terminal === 'cancelled' && operation.cancel_requested_at ? 'cancelled' : 'failed';
        this.operations.transitionInTransaction(tx, operation.id, operationStatus, { expectedRevision: operation.revision, actorId: operation.actor_id, projectId: operation.project_id, ...(terminal === 'parsed' ? { result: { parser_run_id: current.id, receipt_sha256: verified.receipt_sha256 } } : { errorCode: verified.receipt.error_code || `parser_${terminal}` }) }, now);
      }
      return next;
    });
    if (result.status === 'failed' && TRANSIENT.has(result.error_code) && Number(result.attempt_no) < 3) this.scheduleAutomaticRetry(result);
    return result;
  }

  failRun(row, code, status = 'failed', verified = null) {
    if (!row || TERMINAL.has(row.status)) return row;
    const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM parser_runs WHERE id=?', [row.id]);
      if (!current || TERMINAL.has(current.status)) return current;
      tx.run(`UPDATE parser_runs SET status=?,receipt_json=?,receipt_sha256=?,error_code=?,revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND revision=?`, [status, verified?.receipt_json || current.receipt_json, verified?.receipt_sha256 || '', String(code).slice(0, 120), now, now, current.id, current.revision], 1);
      const next = tx.get('SELECT * FROM parser_runs WHERE id=?', [current.id]);
      this.appendRun(tx, next, current.operation_id, current.created_by_actor_id, `parser_run.${status}`, { parser_run_id: current.id, error_code: code }, now);
      const operation = tx.get('SELECT * FROM operations WHERE id=?', [current.operation_id]);
      if (operation && !['succeeded', 'failed', 'cancelled', 'expired'].includes(operation.status)) this.operations.transitionInTransaction(tx, operation.id, 'failed', { expectedRevision: operation.revision, actorId: operation.actor_id, projectId: operation.project_id, errorCode: String(code).slice(0, 100) }, now);
      return next;
    });
  }

  scheduleAutomaticRetry(row) {
    const delay = Number(this.retryDelays[Math.max(0, Number(row.attempt_no) - 1)] || 0);
    const timer = setTimeout(() => {
      const principal = { actorId: row.created_by_actor_id, effectiveActorId: row.created_by_actor_id, scopes: ['*'] };
      this.retry(row.id, { expected_revision: row.revision, idempotency_key: `parser-auto-${sha256Hex(`${row.id}:${row.attempt_no}`).slice(0, 32)}` }, principal).catch(() => undefined);
    }, delay);
    timer.unref?.();
  }

  async recoverPending() {
    const rows = this.db.query("SELECT * FROM parser_runs WHERE status IN ('queued','running') ORDER BY created_at,id");
    for (const row of rows) this.schedule(row.id);
    return rows.length;
  }

  publicIdentity() { return this.identity.publicKey.export({ type: 'spki', format: 'pem' }).toString(); }

  sourceRows(assetId, versionId) {
    const asset = this.db.get('SELECT * FROM assets WHERE id=?', [String(assetId || '')]);
    if (!asset || asset.status !== 'active') throw new PlatformError('asset_not_found', 'active source asset not found', {}, 404);
    const version = this.db.get('SELECT * FROM asset_versions WHERE id=? AND asset_id=?', [String(versionId || ''), asset.id]);
    if (!version) throw new PlatformError('asset_version_not_found', 'source asset version not found', {}, 404);
    const blob = this.db.get('SELECT * FROM asset_blobs WHERE id=?', [version.blob_id]);
    if (!blob) throw new PlatformError('asset_blob_missing', 'source asset blob is missing', {}, 503);
    return { asset, version, blob };
  }

  resolveFormat(source, requested) {
    if (requested) {
      const row = this.db.get("SELECT * FROM parser_formats WHERE format_key=? AND status='supported'", [String(requested)]);
      if (!row) throw new PlatformError('parser_format_unsupported', 'parser format is unsupported', {}, 422);
      return row;
    }
    const extension = source.asset.logical_name.includes('.') ? source.asset.logical_name.split('.').at(-1).toLowerCase() : '';
    const rows = this.db.query("SELECT * FROM parser_formats WHERE status='supported' ORDER BY format_key");
    const row = rows.find((item) => parseJson(item.media_types_json, []).includes(source.blob.media_type)) || rows.find((item) => parseJson(item.extensions_json, []).includes(extension));
    if (!row) throw new PlatformError('parser_format_unsupported', 'parser format could not be detected', {}, 422);
    return row;
  }

  runRow(id, principal, action) {
    const row = this.db.get('SELECT * FROM parser_runs WHERE id=?', [String(id || '')]);
    if (!row) throw new PlatformError('parser_run_not_found', 'parser run not found', {}, 404);
    requirePrincipal(principal);
    this.authorization.assert(principal, action, row.project_id, { resource: 'parser' });
    return row;
  }

  appendRun(tx, row, operationId, actorId, type, data, now) {
    return appendAggregate(this.events, tx, { aggregateType: 'parser_run', aggregateId: row.id, revision: Number(row.revision), operationId, actorId, projectId: row.project_id, type, data, payload: runPayload(row), now });
  }
}

const PARSER_ACTIVE = new Set(['queued', 'running']);

function normalizeLimits(value) { const result = {}; for (const [key, maximum] of Object.entries(DEFAULT_PARSER_LIMITS)) { const number = Number(value?.[key] ?? maximum); if (!Number.isInteger(number) || number < 1 || number > maximum) throw new PlatformError('parser_limits_invalid', 'parser limits exceed the fixed policy', { limit: key }, 422); result[key] = number; } for (const key of Object.keys(value || {})) if (!Object.hasOwn(DEFAULT_PARSER_LIMITS, key)) throw new PlatformError('parser_limits_invalid', 'parser limits contain an unknown field', { limit: key }, 422); return result; }
function formatSnapshotHash(row) { return sha256Hex(canonicalJson({ id: row.id, format_key: row.format_key, family: row.family, extensions: parseJson(row.extensions_json, []), media_types: parseJson(row.media_types_json, []), signatures: parseJson(row.signatures_json, []), worker_version: row.worker_version, worker_image_digest: row.worker_image_digest, limits_sha256: row.limits_sha256, status: row.status, revision: Number(row.revision) })); }
function formatView(row) { return { id: row.id, format_key: row.format_key, family: row.family, label: row.label, extensions: parseJson(row.extensions_json, []), media_types: parseJson(row.media_types_json, []), signatures: parseJson(row.signatures_json, []), worker_version: row.worker_version, worker_image_digest: row.worker_image_digest, limits: parseJson(row.limits_json, {}), limits_sha256: row.limits_sha256, status: row.status, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at }; }
function runPayload(row) { return { id: row.id, project_id: row.project_id, source_asset_version_id: row.source_asset_version_id, format_id: row.format_id, operation_id: row.operation_id, attempt_no: Number(row.attempt_no), retry_of_parser_run_id: row.retry_of_parser_run_id || null, status: row.status, output_manifest_sha256: row.output_manifest_sha256 || '', output_asset_version_id: row.output_asset_version_id || null, receipt_sha256: row.receipt_sha256 || '', error_code: row.error_code || '', revision: Number(row.revision) }; }
function runView(row) { return { ...runPayload(row), broker_job_id: row.broker_job_id || '', schema_version: row.schema_version, input_sha256: row.input_sha256, format_sha256: row.format_sha256, limits: parseJson(row.limits_json, {}), limits_sha256: row.limits_sha256, checkpoint_token_hash: row.checkpoint_token_hash, output_manifest: parseJson(row.output_manifest_json, {}), signer_public_key_sha256: row.signer_public_key ? sha256Hex(row.signer_public_key) : '', signature_present: Boolean(row.signature), created_at: row.created_at, updated_at: row.updated_at, started_at: row.started_at || null, completed_at: row.completed_at || null }; }
function parseJson(value, fallback) { try { return JSON.parse(String(value || '')); } catch { return fallback; } }
