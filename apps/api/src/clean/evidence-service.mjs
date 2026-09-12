import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import {
  appendAggregate, assertRevision, createOperation, priorResponse, requestHash,
  requireIdempotency, requirePrincipal, requireRevision, saveResponse, time
} from './p5-domain-helpers.mjs';

const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const ASSET_KINDS = new Set(['execution_output', 'attachment', 'file', 'parser_output', 'trace', 'digest', 'code_change', 'test_result', 'quality_report', 'other']);
const RELATION_TYPES = new Set(['derived_from', 'generated_by', 'contains', 'references', 'attests', 'supersedes', 'tests', 'changes']);

export class CleanEvidenceService {
  constructor({ db, cas, events, operations, authorization, files = null, clock, config = {}, bootstrapActorId = 'actor_system_bootstrap' } = {}) {
    if (!db || !cas || !events || !operations || !authorization) throw new TypeError('evidence_service_dependencies_required');
    this.db = db;
    this.cas = cas;
    this.events = events;
    this.operations = operations;
    this.authorization = authorization;
    this.files = files;
    this.clock = clock;
    this.bootstrapActorId = bootstrapActorId;
    this.workspaceRoot = path.resolve(config.workspaceRoot || path.join(process.cwd(), '.ai-workspace', 'v3-clean', 'workspaces'));
    this.unsubscribe = null;
    this.captureQueue = Promise.resolve(); this.captureRetries = 0; this.captureTimer = null; this.closing = false;
  }

  listAssets(projectId, input = {}, principal) {
    this.assertProject(principal, 'read', projectId, 'evidence');
    const clauses = ['project_id=?'];
    const params = [String(projectId)];
    if (input.status) { clauses.push('status=?'); params.push(String(input.status)); }
    if (input.asset_kind) { clauses.push('asset_kind=?'); params.push(String(input.asset_kind)); }
    return { assets: this.db.query(`SELECT * FROM assets WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC,id LIMIT 500`, params).map((row) => this.assetView(row)) };
  }

  getAsset(id, principal) {
    return { asset: this.assetView(this.assetRow(id, principal, 'read')) };
  }

  listVersions(id, principal) {
    const asset = this.assetRow(id, principal, 'read');
    return { versions: this.db.query('SELECT * FROM asset_versions WHERE asset_id=? ORDER BY version_no DESC,id', [asset.id]).map(versionView) };
  }

  content(id, versionId, principal) {
    const asset = this.assetRow(id, principal, 'read');
    if (asset.status === 'tombstoned') throw new PlatformError('asset_tombstoned', 'asset content is tombstoned', {}, 410);
    const version = this.versionRow(asset.id, versionId || asset.current_version_id);
    const blob = this.db.get('SELECT * FROM asset_blobs WHERE id=?', [version.blob_id]);
    if (!blob) throw new PlatformError('asset_blob_missing', 'asset blob metadata is missing', {}, 503);
    const bytes = this.cas.read(blob.cas_sha256);
    if (sha256Hex(bytes) !== blob.content_sha256 || bytes.byteLength !== Number(blob.byte_length)) throw new PlatformError('asset_tamper', 'asset content failed verification', {}, 503);
    return { asset: this.assetView(asset), version: versionView(version), content_base64: bytes.toString('base64'), byte_length: bytes.byteLength, media_type: blob.media_type };
  }

  async capture(input = {}, principal) {
    requirePrincipal(principal);
    const projectId = String(input.project_id || '');
    this.assertProject(principal, 'write', projectId, 'evidence');
    const logicalName = bounded(input.logical_name, 512, 'asset logical name');
    const sourceType = String(input.source_type || 'manual');
    const sourceRef = bounded(input.source_ref, 512, 'asset source reference');
    const assetKind = ASSET_KINDS.has(String(input.asset_kind || '')) ? String(input.asset_kind) : inferAssetKind(sourceType);
    const resolved = this.resolveSource({ ...input, project_id: projectId, source_type: sourceType, source_ref: sourceRef });
    const prepared = this.prepareContent(resolved.bytes, resolved.mediaType, { kind: 'evidence.asset', source_type: sourceType });
    if (input.content_sha256 && String(input.content_sha256).toLowerCase() !== prepared.contentHash) throw new PlatformError('content_hash_mismatch', 'asset content hash does not match', { expected: input.content_sha256, actual: prepared.contentHash }, 422);
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ project_id: projectId, execution_id: input.execution_id || null, logical_name: logicalName, asset_kind: assetKind, source_type: sourceType, source_ref: sourceRef, content_sha256: prepared.contentHash, metadata: input.metadata || {} });
    const assetId = opaqueId('asset');
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'asset.capture', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      this.assertExecutionProject(tx, input.execution_id, projectId);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'asset.capture', resourceType: 'asset', resourceId: assetId, projectId, requestHash: hash, status: 'succeeded', now });
      const inserted = this.insertPreparedInTransaction(tx, { assetId, projectId, executionId: input.execution_id || null, logicalName, assetKind, sourceType, sourceRef, metadata: input.metadata || {}, actorId: principal.actorId, operationId: operation.id, prepared, now });
      this.appendAsset(tx, inserted.asset, operation.id, principal.actorId, 'asset.captured', { asset_id: assetId, version_id: inserted.version.id, content_sha256: inserted.version.content_sha256 }, now);
      this.operations.linkInTransaction(tx, operation.id, [['asset', assetId], ['asset_version', inserted.version.id]], now);
      const response = { asset: this.assetView(inserted.asset), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'asset.capture', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 201, now });
      return response;
    });
  }

  listRelations(id, principal) {
    const asset = this.assetRow(id, principal, 'read');
    return { relations: this.db.query('SELECT * FROM asset_relations WHERE from_asset_id=? OR to_asset_id=? ORDER BY created_at,id LIMIT 500', [asset.id, asset.id]).map(relationView) };
  }

  createRelation(id, input = {}, principal) {
    const asset = this.assetRow(id, principal, 'write');
    const expected = requireRevision(input.expected_revision);
    assertRevision(asset, expected);
    const key = requireIdempotency(input.idempotency_key);
    const relationType = String(input.relation_type || '');
    if (!RELATION_TYPES.has(relationType)) throw new PlatformError('relation_type_invalid', 'asset relation type is invalid', {}, 422);
    const fromVersion = this.versionRow(asset.id, input.from_version_id);
    const toAsset = this.db.get('SELECT * FROM assets WHERE id=?', [String(input.to_asset_id || '')]);
    if (!toAsset || toAsset.project_id !== asset.project_id) throw new PlatformError('scope_denied', 'related asset is outside the project', {}, 403);
    const toVersion = this.versionRow(toAsset.id, input.to_version_id);
    const now = time(this.clock);
    const relationId = opaqueId('asset_relation');
    const metadataJson = canonicalJson(input.metadata || {});
    const hash = requestHash({ asset_id: asset.id, from_version_id: fromVersion.id, to_asset_id: toAsset.id, to_version_id: toVersion.id, relation_type: relationType, expected_revision: expected, metadata_sha256: sha256Hex(metadataJson) });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'asset.relation.create', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM assets WHERE id=?', [asset.id]); assertRevision(current, expected);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'asset.relation.create', resourceType: 'asset_relation', resourceId: relationId, projectId: asset.project_id, requestHash: hash, status: 'succeeded', now });
      tx.run(`INSERT INTO asset_relations(id,project_id,from_asset_id,from_version_id,to_asset_id,to_version_id,relation_type,execution_id,task_attempt_id,operation_id,actor_id,policy_revision,input_sha256,output_sha256,metadata_json,metadata_sha256,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [relationId, asset.project_id, asset.id, fromVersion.id, toAsset.id, toVersion.id, relationType, input.execution_id || null, input.task_attempt_id || null, operation.id, principal.actorId, 1, String(input.input_sha256 || fromVersion.content_sha256), String(input.output_sha256 || toVersion.content_sha256), metadataJson, sha256Hex(metadataJson), now]);
      tx.run('UPDATE assets SET revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [now, principal.actorId, asset.id, expected], 1);
      const next = tx.get('SELECT * FROM assets WHERE id=?', [asset.id]);
      this.appendAsset(tx, next, operation.id, principal.actorId, 'asset.relation.created', { asset_id: asset.id, relation_id: relationId }, now);
      this.operations.linkInTransaction(tx, operation.id, [['asset_relation', relationId], ['asset', asset.id], ['asset', toAsset.id]], now);
      const response = { relation: relationView(tx.get('SELECT * FROM asset_relations WHERE id=?', [relationId])), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'asset.relation.create', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 201, now });
      return response;
    });
  }

  listAttestations(id, principal) {
    const asset = this.assetRow(id, principal, 'read');
    return { attestations: this.db.query('SELECT * FROM asset_attestations WHERE asset_id=? ORDER BY created_at DESC,id LIMIT 500', [asset.id]).map(attestationView) };
  }

  attest(id, input = {}, principal) {
    const asset = this.assetRow(id, principal, 'write');
    const expected = requireRevision(input.expected_revision); assertRevision(asset, expected);
    const key = requireIdempotency(input.idempotency_key);
    const version = this.versionRow(asset.id, input.version_id);
    const statementJson = canonicalJson(input.statement || {});
    const attestationType = bounded(input.attestation_type, 120, 'attestation type');
    const now = time(this.clock);
    const attestationId = opaqueId('asset_attestation');
    const hash = requestHash({ asset_id: asset.id, version_id: version.id, attestation_type: attestationType, statement_sha256: sha256Hex(statementJson), validity: input.validity, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'asset.attest', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM assets WHERE id=?', [asset.id]); assertRevision(current, expected);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'asset.attest', resourceType: 'asset_attestation', resourceId: attestationId, projectId: asset.project_id, requestHash: hash, status: 'succeeded', now });
      tx.run(`INSERT INTO asset_attestations(id,project_id,asset_id,asset_version_id,verifier_actor_id,policy_revision,attestation_type,subject_sha256,statement_json,statement_sha256,signature,validity,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [attestationId, asset.project_id, asset.id, version.id, principal.actorId, Number(input.policy_revision || 1), attestationType, version.content_sha256, statementJson, sha256Hex(statementJson), String(input.signature || ''), String(input.validity || 'valid'), now, input.expires_at || null]);
      tx.run('UPDATE assets SET revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [now, principal.actorId, asset.id, expected], 1);
      const next = tx.get('SELECT * FROM assets WHERE id=?', [asset.id]);
      this.appendAsset(tx, next, operation.id, principal.actorId, 'asset.attested', { asset_id: asset.id, attestation_id: attestationId, validity: input.validity }, now);
      this.operations.linkInTransaction(tx, operation.id, [['asset_attestation', attestationId], ['asset', asset.id]], now);
      const response = { attestation: attestationView(tx.get('SELECT * FROM asset_attestations WHERE id=?', [attestationId])), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'asset.attest', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 201, now });
      return response;
    });
  }

  tombstone(id, input = {}, principal) {
    const asset = this.assetRow(id, principal, 'write');
    const expected = requireRevision(input.expected_revision); assertRevision(asset, expected);
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ asset_id: asset.id, expected_revision: expected, reason: String(input.reason || '') });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'asset.tombstone', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM assets WHERE id=?', [asset.id]); assertRevision(current, expected);
      if (current.status === 'tombstoned') throw new PlatformError('state_conflict', 'asset is already tombstoned', {}, 409);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'asset.tombstone', resourceType: 'asset', resourceId: asset.id, projectId: asset.project_id, requestHash: hash, status: 'succeeded', now });
      tx.run("UPDATE assets SET status='tombstoned',revision=revision+1,updated_at=?,tombstoned_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, now, principal.actorId, asset.id, expected], 1);
      const next = tx.get('SELECT * FROM assets WHERE id=?', [asset.id]);
      this.appendAsset(tx, next, operation.id, principal.actorId, 'asset.tombstoned', { asset_id: asset.id }, now);
      const response = { asset: this.assetView(next), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'asset.tombstone', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 200, now });
      return response;
    });
  }

  executionEvidence(id, principal) {
    const execution = this.executionRow(id, principal);
    return {
      assets: this.db.query('SELECT * FROM assets WHERE execution_id=? ORDER BY created_at,id', [execution.id]).map((row) => this.assetView(row)),
      traces: this.db.query('SELECT * FROM traces WHERE execution_id=? ORDER BY created_at,id', [execution.id]).map(traceView),
      digests: this.db.query('SELECT * FROM digests WHERE execution_id=? ORDER BY created_at,id', [execution.id]).map(digestView),
      code_changes: this.db.query('SELECT * FROM code_changes WHERE execution_id=? ORDER BY relative_path,id', [execution.id]).map(codeChangeView),
      test_results: this.db.query('SELECT * FROM test_results WHERE execution_id=? ORDER BY check_id,id', [execution.id]).map(testResultView)
    };
  }

  listTraces(id, principal) { const row = this.executionRow(id, principal); return { traces: this.db.query('SELECT * FROM traces WHERE execution_id=? ORDER BY created_at,id', [row.id]).map(traceView) }; }
  listDigests(id, principal) { const row = this.executionRow(id, principal); return { digests: this.db.query('SELECT * FROM digests WHERE execution_id=? ORDER BY created_at,id', [row.id]).map(digestView) }; }
  listCodeChanges(id, principal) { const row = this.executionRow(id, principal); return { code_changes: this.db.query('SELECT * FROM code_changes WHERE execution_id=? ORDER BY relative_path,id', [row.id]).map(codeChangeView) }; }
  listTestResults(id, principal) { const row = this.executionRow(id, principal); return { test_results: this.db.query('SELECT * FROM test_results WHERE execution_id=? ORDER BY check_id,id', [row.id]).map(testResultView) }; }

  prepareContent(bytesValue, mediaType, metadata = {}) {
    const bytes = Buffer.from(bytesValue || []);
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new PlatformError('asset_too_large', 'asset exceeds the per-file limit', {}, 422);
    const contentHash = sha256Hex(bytes);
    const object = this.cas.put(bytes, { mediaType: String(mediaType || 'application/octet-stream'), metadata });
    if (object.hash !== contentHash) throw new PlatformError('asset_tamper', 'CAS promotion hash changed', {}, 503);
    const manifest = { schema_version: 'evidence.asset-blob.v2', content_sha256: contentHash, byte_length: bytes.byteLength, media_type: object.media_type, cas_sha256: object.hash };
    return { object, contentHash, byteLength: bytes.byteLength, mediaType: object.media_type, manifest, manifestJson: canonicalJson(manifest), manifestHash: sha256Hex(canonicalJson(manifest)) };
  }

  insertPreparedInTransaction(tx, { assetId = opaqueId('asset'), versionId = opaqueId('asset_version'), projectId, executionId = null, logicalName, assetKind = 'other', sourceType = 'manual', sourceRef, metadata = {}, actorId, operationId = null, parserRunId = null, sourceRevision = 0, prepared, now = time(this.clock) } = {}) {
    let blob = tx.get('SELECT * FROM asset_blobs WHERE cas_sha256=?', [prepared.object.hash]);
    if (!blob) {
      const blobId = opaqueId('asset_blob');
      tx.run(`INSERT INTO asset_blobs(id,cas_sha256,content_sha256,byte_length,media_type,encryption_kind,key_ref,manifest_json,manifest_sha256,created_at,created_by_actor_id)
        VALUES(?,?,?,?,?,'none','',?,?,?,?)`, [blobId, prepared.object.hash, prepared.contentHash, prepared.byteLength, prepared.mediaType, prepared.manifestJson, prepared.manifestHash, now, actorId]);
      blob = tx.get('SELECT * FROM asset_blobs WHERE id=?', [blobId]);
    }
    const metadataJson = canonicalJson(metadata || {});
    tx.run(`INSERT INTO assets(id,project_id,execution_id,logical_name,asset_kind,source_type,source_ref,current_version_id,current_version,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
      VALUES(?,?,?,?,?,?,?,NULL,0,'active',1,?,?,?,?)`, [assetId, projectId, executionId, logicalName, assetKind, sourceType, sourceRef, now, now, actorId, actorId]);
    tx.run(`INSERT INTO asset_versions(id,asset_id,version_no,blob_id,parser_run_id,source_operation_id,source_revision,source_sha256,content_sha256,metadata_json,metadata_sha256,created_at,created_by_actor_id)
      VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?)`, [versionId, assetId, blob.id, parserRunId, operationId, Number(sourceRevision || 0), prepared.contentHash, prepared.contentHash, metadataJson, sha256Hex(metadataJson), now, actorId]);
    tx.run('UPDATE assets SET current_version_id=?,current_version=1 WHERE id=?', [versionId, assetId], 1);
    return { asset: tx.get('SELECT * FROM assets WHERE id=?', [assetId]), version: tx.get('SELECT * FROM asset_versions WHERE id=?', [versionId]), blob };
  }

  async recoverPending() {
    const cursor = this.db.get("SELECT * FROM event_cursors WHERE actor_id=? AND consumer_id='p7-evidence-capture' AND stream='events'", [this.bootstrapActorId]);
    const after = Number(cursor?.cursor_sequence || 0);
    // Scan the complete completion history on startup.  The capture operation is
    // idempotent, so this also compensates events whose cursor was acknowledged
    // by an older runtime before their Evidence transaction committed.
    const rows = this.db.query("SELECT * FROM events WHERE type='execution.completed' ORDER BY sequence");
    let captured = 0;
    let last = after;
    for (const event of rows) {
      if (Number(event.sequence) <= after) {
        // Historical rows are still checked for compensation, but never move a
        // monotonic cursor backwards.
        try { captured += await this.captureCompletedExecution(event.aggregate_id, parseJson(event.data_json, {}).generation); } catch (error) { this.recordCaptureFailure(event.aggregate_id, error); }
        continue;
      }
      try {
        captured += await this.captureCompletedExecution(event.aggregate_id, parseJson(event.data_json, {}).generation);
        last = Number(event.sequence);
      } catch (error) {
        this.recordCaptureFailure(event.aggregate_id, error);
        break;
      }
    }
    if (last > after) this.events.ackCursor({ actorId: this.bootstrapActorId, consumerId: 'p7-evidence-capture', stream: 'events', cursor: last, expectedRevision: cursor?.revision || 0 });
    if (!this.unsubscribe) this.unsubscribe = this.events.subscribe({}, (event) => {
      if (event.type !== 'execution.completed') return;
      this.captureQueue = this.captureQueue
        .then(() => this.recoverPending())
        .catch((error) => { this.recordCaptureFailure(event.aggregate.id, error); });
    });
    return captured;
  }

  async captureCompletedExecution(executionId, generation = null) {
    let execution = this.db.get('SELECT * FROM executions WHERE id=?', [String(executionId)]);
    if (!execution) return 0;
    if (generation != null) {
      const completed = this.db.query("SELECT data_json FROM events WHERE aggregate_id=? AND type='execution.completed'", [execution.id]).some((event) => Number(parseJson(event.data_json,{}).generation) === Number(generation));
      if (!completed) throw new PlatformError('evidence_capture_pending', 'completion event is missing', {}, 409);
      execution = { ...execution, generation: Number(generation), status: 'completed' };
    }
    if (execution.status !== 'completed') return 0;
    const handoff = parseJson(execution.handoff_manifest_json, {});
    if (generation == null && (handoff.delivery_ready !== true || Number(handoff.generation) !== Number(execution.generation) || sha256Hex(canonicalJson(handoff)) !== execution.handoff_manifest_sha256)) throw new PlatformError('evidence_capture_pending', 'handoff is incomplete', {}, 409);
    const checkpoint = this.db.get("SELECT * FROM execution_stage_checkpoints WHERE execution_id=? AND generation=? AND stage='deliver'", [execution.id, execution.generation]);
    const receipts = this.db.query("SELECT r.* FROM runner_receipts r JOIN task_attempts a ON a.runner_receipt_id=r.id WHERE a.execution_id=? AND a.generation=? ORDER BY a.task_ordinal,a.attempt_no", [execution.id, execution.generation]);
    if (!checkpoint) throw new PlatformError('evidence_capture_pending', 'completed execution deliver checkpoint is unavailable', { execution_id: execution.id }, 409);
    if (receipts.some((row) => !row.receipt_sha256)) throw new PlatformError('evidence_capture_pending', 'completed execution runner receipt is unavailable', { execution_id: execution.id }, 409);
    const principal = { actorId: this.bootstrapActorId, effectiveActorId: this.bootstrapActorId, scopes: ['*'] };
    const workspace = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [execution.repository_workspace_id]);
    const plan = parseJson(execution.plan_json, {});
    let count = 0;
    for (const task of plan.tasks || []) {
      for (const relative of task.output_paths || []) {
        const candidateRoot = `candidates/${execution.id}/${execution.generation}`;
        const rootRef = fs.existsSync(path.join(this.workspaceRoot, candidateRoot)) ? candidateRoot : workspace?.relative_path;
        const file = safeJoin(this.workspaceRoot, rootRef, relative);
        if (!file || !fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new PlatformError('evidence_capture_pending', 'execution output is missing', {}, 409);
        const bytes = fs.readFileSync(file);
        await this.capture({ project_id: execution.project_id, execution_id: execution.id, logical_name: relative, asset_kind: 'execution_output', source_type: 'execution', source_ref: `${execution.id}:${execution.generation}:${relative}`, relative_path: relative, media_type: mediaTypeFor(relative), content_base64: bytes.toString('base64'), metadata: { generation: Number(execution.generation), checkpoint_sha256: checkpoint.checkpoint_sha256 }, idempotency_key: `p7-capture-${sha256Hex(`${execution.id}:${execution.generation}:${relative}`).slice(0, 40)}`, expected_revision: 0 }, principal);
        count += 1;
      }
    }
    return count;
  }

  async recordCheckResult({ execution, attempt, checkId, status, commandHash, inputHash, outputHash, durationMs, details }, principal) {
    this.assertProject(principal, 'run', execution.project_id, 'evidence');
    const detailsJson = canonicalJson(details);
    await this.db.withTransaction((tx) => {
      const prior = tx.get('SELECT * FROM test_results WHERE execution_id=? AND check_id=? AND input_sha256=?', [execution.id, checkId, inputHash]);
      if (prior) { if (prior.output_sha256 !== outputHash || prior.status !== status) throw new PlatformError('check_result_changed', 'immutable check input produced a different result', {}, 409); return; }
      tx.run('INSERT INTO test_results(id,project_id,execution_id,task_attempt_id,check_id,status,command_sha256,input_sha256,output_sha256,duration_ms,details_json,details_sha256,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [opaqueId('test_result'),execution.project_id,execution.id,attempt?.id || null,checkId,status,commandHash,inputHash,outputHash,durationMs,detailsJson,sha256Hex(detailsJson),time(this.clock),principal.actorId]);
    });
  }

  recordCaptureFailure(executionId, error) {
    if (!this.captureTimer && !this.closing && this.captureRetries < 3) {
      this.captureRetries++;
      this.captureTimer = setTimeout(() => { this.captureTimer = null; if (!this.closing) this.captureQueue = this.captureQueue.then(() => this.recoverPending()).catch(() => undefined); }, 1000 * this.captureRetries);
      this.captureTimer.unref?.();
    }
    const payload = canonicalJson({
      execution_id: String(executionId || ''),
      status: 'pending',
      error_code: String(error?.code || 'evidence_capture_failed').slice(0, 120)
    });
    try {
      this.db.run(`INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,cas_sha256,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`, [opaqueId('receipt'), 'evidence.capture.failure', 'failed', payload, sha256Hex(payload), null, time(this.clock), null]);
    } catch { /* diagnostic receipt creation must not hide the pending event */ }
  }

  close() { this.closing = true; clearTimeout(this.captureTimer); this.unsubscribe?.(); this.unsubscribe = null; return this.captureQueue; }

  assetView(row) {
    const current = row?.current_version_id ? this.db.get('SELECT * FROM asset_versions WHERE id=?', [row.current_version_id]) : null;
    return row ? { id: row.id, project_id: row.project_id, execution_id: row.execution_id || null, logical_name: row.logical_name, asset_kind: row.asset_kind, source_type: row.source_type, source_ref: row.source_ref, current_version_id: row.current_version_id || null, current_version: Number(row.current_version), current: current ? versionView(current) : null, status: row.status, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, tombstoned_at: row.tombstoned_at || null } : null;
  }

  assetRow(id, principal, action) {
    const row = this.db.get('SELECT * FROM assets WHERE id=?', [String(id || '')]);
    if (!row) throw new PlatformError('asset_not_found', 'asset not found', {}, 404);
    this.assertProject(principal, action, row.project_id, 'evidence');
    return row;
  }

  versionRow(assetId, versionId) {
    const row = this.db.get('SELECT * FROM asset_versions WHERE id=? AND asset_id=?', [String(versionId || ''), String(assetId)]);
    if (!row) throw new PlatformError('asset_version_not_found', 'asset version not found', {}, 404);
    return row;
  }

  executionRow(id, principal) {
    const row = this.db.get('SELECT * FROM executions WHERE id=?', [String(id || '')]);
    if (!row) throw new PlatformError('execution_not_found', 'execution not found', {}, 404);
    this.assertProject(principal, 'read', row.project_id, 'evidence');
    return row;
  }

  appendAsset(tx, row, operationId, actorId, type, data, now) {
    return appendAggregate(this.events, tx, { aggregateType: 'asset', aggregateId: row.id, revision: Number(row.revision), operationId, actorId, projectId: row.project_id, type, data, payload: assetPayload(row), now });
  }

  resolveSource(input) {
    if (input.content_base64 != null) return { bytes: strictBase64(input.content_base64, MAX_ASSET_BYTES), mediaType: String(input.media_type || mediaTypeFor(input.logical_name)) };
    if (input.source_type === 'attachment') {
      const row = this.db.get('SELECT * FROM attachments WHERE id=? AND project_id=?', [String(input.attachment_id || input.source_ref), input.project_id]);
      if (!row || row.status !== 'ready') throw new PlatformError('attachment_unavailable', 'attachment source is unavailable', {}, 410);
      return { bytes: this.cas.read(row.content_cas_hash), mediaType: row.media_type };
    }
    if (input.source_type === 'file_ref') {
      const row = this.db.get('SELECT * FROM file_refs WHERE id=? AND project_id=?', [String(input.file_ref_id || input.source_ref), input.project_id]);
      if (!row) throw new PlatformError('file_not_found', 'file source not found', {}, 404);
      const workspace = this.db.get('SELECT relative_path FROM repository_workspaces WHERE id=?', [row.workspace_id]);
      const file = safeJoin(this.workspaceRoot, workspace?.relative_path, row.relative_path);
      if (!file) throw new PlatformError('path_invalid', 'file source path is invalid', {}, 422);
      const bytes = fs.readFileSync(file);
      if (sha256Hex(bytes) !== row.content_sha256) throw new PlatformError('file_stale', 'file source changed', {}, 409);
      return { bytes, mediaType: row.media_type };
    }
    throw new PlatformError('asset_content_required', 'asset content or a managed source is required', {}, 422);
  }

  assertExecutionProject(tx, executionId, projectId) {
    if (!executionId) return;
    const execution = tx.get('SELECT project_id FROM executions WHERE id=?', [String(executionId)]);
    if (!execution || execution.project_id !== projectId) throw new PlatformError('scope_denied', 'execution is outside the project', {}, 403);
  }

  assertProject(principal, action, projectId, resource) {
    requirePrincipal(principal);
    return this.authorization.assert(principal, action, String(projectId), { resource });
  }
}

function versionView(row) { return { id: row.id, asset_id: row.asset_id, version_no: Number(row.version_no), blob_id: row.blob_id, parser_run_id: row.parser_run_id || null, source_operation_id: row.source_operation_id || null, source_revision: Number(row.source_revision), source_sha256: row.source_sha256, content_sha256: row.content_sha256, metadata: parseJson(row.metadata_json, {}), metadata_sha256: row.metadata_sha256, created_at: row.created_at }; }
function relationView(row) { return { id: row.id, project_id: row.project_id, from_asset_id: row.from_asset_id, from_version_id: row.from_version_id, to_asset_id: row.to_asset_id, to_version_id: row.to_version_id, relation_type: row.relation_type, execution_id: row.execution_id || null, task_attempt_id: row.task_attempt_id || null, operation_id: row.operation_id || null, actor_id: row.actor_id, policy_revision: Number(row.policy_revision), input_sha256: row.input_sha256, output_sha256: row.output_sha256, metadata: parseJson(row.metadata_json, {}), metadata_sha256: row.metadata_sha256, created_at: row.created_at }; }
function attestationView(row) { return { id: row.id, project_id: row.project_id, asset_id: row.asset_id, asset_version_id: row.asset_version_id, verifier_actor_id: row.verifier_actor_id, policy_revision: Number(row.policy_revision), attestation_type: row.attestation_type, subject_sha256: row.subject_sha256, statement: parseJson(row.statement_json, {}), statement_sha256: row.statement_sha256, signature: row.signature ? '[present]' : '', validity: row.validity, created_at: row.created_at, expires_at: row.expires_at || null }; }
function traceView(row) { return { id: row.id, project_id: row.project_id, execution_id: row.execution_id || null, asset_id: row.asset_id || null, asset_version_id: row.asset_version_id || null, operation_id: row.operation_id || null, actor_id: row.actor_id, trace_type: row.trace_type, payload: parseJson(row.payload_json, {}), payload_sha256: row.payload_sha256, redactions: parseJson(row.redactions_json, []), created_at: row.created_at }; }
function digestView(row) { return { id: row.id, project_id: row.project_id, execution_id: row.execution_id || null, asset_id: row.asset_id || null, asset_version_id: row.asset_version_id || null, digest_type: row.digest_type, input_sha256: row.input_sha256, digest_sha256: row.digest_sha256, summary: parseJson(row.summary_json, {}), summary_sha256: row.summary_sha256, created_at: row.created_at }; }
function codeChangeView(row) { return { ...row, before_sha256: row.before_sha256 || '', after_sha256: row.after_sha256 || '' }; }
function testResultView(row) { return { ...row, duration_ms: Number(row.duration_ms), details: parseJson(row.details_json, {}) }; }
function assetPayload(row) { return { id: row.id, project_id: row.project_id, execution_id: row.execution_id || null, logical_name: row.logical_name, asset_kind: row.asset_kind, current_version_id: row.current_version_id || null, current_version: Number(row.current_version), status: row.status, revision: Number(row.revision) }; }
function inferAssetKind(sourceType) { if (sourceType === 'attachment') return 'attachment'; if (sourceType === 'file_ref') return 'file'; if (sourceType === 'execution' || sourceType === 'managed_output') return 'execution_output'; if (sourceType === 'parser') return 'parser_output'; if (sourceType === 'quality') return 'quality_report'; return 'other'; }
function bounded(value, maximum, label) { const text = String(value || '').trim(); if (!text || text.length > maximum || /[\r\n]/.test(text)) throw new PlatformError('schema_invalid', `${label} is invalid`, {}, 422); return text; }
function strictBase64(value, maximum) { const text = String(value || ''); let bytes; try { bytes = Buffer.from(text, 'base64'); } catch { throw new PlatformError('invalid_base64', 'asset content encoding is invalid', {}, 422); } if (bytes.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '') || bytes.length > maximum) throw new PlatformError(bytes.length > maximum ? 'asset_too_large' : 'invalid_base64', 'asset content is invalid', {}, 422); return bytes; }
function parseJson(value, fallback) { try { return JSON.parse(String(value || '')); } catch { return fallback; } }
function safeJoin(root, ...parts) { const relative = parts.filter(Boolean).map((item) => String(item).replaceAll('\\', '/')).join('/'); if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) return null; const target = path.resolve(root, ...relative.split('/')); const prefix = `${path.resolve(root)}${path.sep}`.toLowerCase(); if (!target.toLowerCase().startsWith(prefix)) return null; return target; }
function mediaTypeFor(name) { const extension = path.extname(String(name || '')).toLowerCase(); return ({ '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.zip': 'application/zip' })[extension] || 'application/octet-stream'; }
