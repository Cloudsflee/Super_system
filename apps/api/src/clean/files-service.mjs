import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import {
  appendAggregate, assertProject, assertRevision, boundedString, canonicalPayload,
  createOperation, parseJson, priorResponse, requestHash, requireIdempotency,
  requirePrincipal, requireRevision, saveResponse, time
} from './p5-domain-helpers.mjs';

const MAX_ATTACHMENT = 10 * 1024 * 1024;
const MAX_PREVIEW = 256 * 1024;
const MAX_FILE = 1024 * 1024;
const MAX_WORKSPACE_FILES = 10_000;
const MAX_WORKSPACE_BYTES = 100 * 1024 * 1024;
const MAX_BATCH_FILES = 100;
const MAX_BATCH_BYTES = 10 * 1024 * 1024;
const SECRET_SENTINEL = /(api[_-]?key|access[_-]?token|secret|password|private[_-]?key|authorization\s*:)/i;
const PROMPT_SENTINEL = /(?:^|\n)\s*(?:system|developer|assistant|user)\s*:/i;
const MIME_BY_EXTENSION = Object.freeze({
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
  '.css': 'text/css', '.html': 'text/html', '.xml': 'application/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.zip': 'application/zip'
});

/** Files/Attachments owner. Workspace paths are always relative and CAS is the
 * only durable content store. The service intentionally exposes bounded
 * metadata and previews instead of host paths or raw provider payloads. */
export class CleanFilesService {
  constructor({ db, cas, events, operations, authorization, projectWorkflow = null, clock, config = {}, bootstrapActorId = 'actor_system_bootstrap' } = {}) {
    if (!db || !cas || !events || !operations || !authorization) throw new TypeError('files_service_dependencies_required');
    this.db = db; this.cas = cas; this.events = events; this.operations = operations;
    this.authorization = authorization; this.projectWorkflow = projectWorkflow; this.clock = clock;
    this.config = config; this.bootstrapActorId = bootstrapActorId;
    this.workspaceRoot = path.resolve(String(config.workspaceRoot || config.home || process.cwd()));
  }

  async listFiles(projectId, input = {}, principal) {
    assertProject(this.authorization, principal, 'read', projectId, { resource: 'files' });
    const workspaceId = input.workspace_id ? String(input.workspace_id) : null;
    const query = input.path ? safeRelative(input.path) : null;
    const limit = Math.max(1, Math.min(500, Number(input.limit) || 100));
    const offset = Math.max(0, Number(input.offset) || 0);
    const params = [String(projectId), ...(workspaceId ? [workspaceId] : []), ...(query ? [`%${query}%`] : [])];
    const where = `project_id=? ${workspaceId ? 'AND workspace_id=?' : ''} ${query ? 'AND relative_path LIKE ?' : ''}`;
    if (workspaceId) {
      // Resolve the workspace through the requested project before deciding
      // whether the first-list index is needed.  This keeps a foreign
      // workspace from becoming an implicit input to the indexer.
      this.workspaceRow(workspaceId, String(projectId));
      if (!this.db.get("SELECT 1 AS present FROM file_refs WHERE workspace_id=? AND status='current' LIMIT 1", [workspaceId])) {
        await this.indexWorkspace(workspaceId, String(projectId), principal);
      }
    }
    const total = Number(this.db.get(`SELECT COUNT(*) AS count FROM file_refs WHERE ${where}`, params)?.count || 0);
    const rows = this.db.query(`SELECT * FROM file_refs WHERE ${where} ORDER BY relative_path,id LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { files: rows.map(fileView), total, next_cursor: offset + rows.length < total ? offset + rows.length : null };
  }

  async indexWorkspace(workspaceId, projectId, principal) {
    // Keep a small compatibility bridge for internal callers that used the
    // pre-P10 `(workspaceId, principal)` shape; all new callers pass the
    // project explicitly and are checked below.
    if (principal == null && projectId && typeof projectId === 'object') {
      principal = projectId;
      projectId = null;
    }
    const workspace = this.workspaceRow(workspaceId, projectId);
    assertProject(this.authorization, principal, 'read', workspace.project_id, { resource: 'files' });
    const directory = this.workspaceDirectory(workspace);
    if (!fs.existsSync(directory)) return 0;
    const entries = [];
    let totalBytes = 0;
    let bounded = false;
    const walk = (root, prefix = '') => {
      if (entries.length >= MAX_WORKSPACE_FILES || totalBytes >= MAX_WORKSPACE_BYTES) {
        bounded = true;
        return;
      }
      let items;
      try {
        items = fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
      } catch {
        return;
      }
      for (const item of items) {
        if (entries.length >= MAX_WORKSPACE_FILES || totalBytes >= MAX_WORKSPACE_BYTES) {
          bounded = true;
          return;
        }
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.name === '.git' || item.name === 'node_modules') continue;
        const full = path.join(root, item.name);
        let stat;
        try { stat = fs.lstatSync(full); } catch { continue; }
        // Dirent.isDirectory() follows some Windows reparse points.  Use the
        // lstat result and reject every non-regular entry before opening it.
        if (isReparseStat(stat) || isSpecialStat(stat)) continue;
        if (stat.isDirectory()) {
          walk(full, relative);
        } else if (stat.isFile()) {
          if (stat.size > MAX_FILE) continue;
          if (totalBytes + stat.size > MAX_WORKSPACE_BYTES) {
            bounded = true;
            return;
          }
          let bytes;
          try { bytes = fs.readFileSync(full); } catch { continue; }
          if (bytes.byteLength > MAX_FILE) continue;
          if (totalBytes + bytes.byteLength > MAX_WORKSPACE_BYTES) {
            bounded = true;
            return;
          }
          entries.push({ relative, bytes });
          totalBytes += bytes.byteLength;
        }
      }
    };
    walk(directory);
    const now = time(this.clock); let count = 0;
    this.db.withTransaction((tx) => {
      const seen = new Set(entries.map((entry) => entry.relative));
      for (const entry of entries) {
        const hash = sha256Hex(entry.bytes); const current = tx.get('SELECT * FROM file_refs WHERE workspace_id=? AND relative_path=?', [workspace.id, entry.relative]);
        if (current && current.content_sha256 === hash && current.status === 'current') continue;
        if (current) tx.run("UPDATE file_refs SET content_sha256=?,byte_length=?,media_type=?,status='current',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=?", [hash, entry.bytes.byteLength, detectMime(entry.relative), now, principal.actorId, current.id]);
        else tx.run('INSERT INTO file_refs(id,project_id,workspace_id,relative_path,content_sha256,byte_length,media_type,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?)', [opaqueId('file_ref'), workspace.project_id, workspace.id, entry.relative, hash, entry.bytes.byteLength, detectMime(entry.relative), 'current', now, now, principal.actorId, principal.actorId]);
        count += 1;
      }
      // A complete scan can safely retire refs for files removed from disk.
      // When a bound stopped traversal, leave unseen refs untouched so a
      // later bounded page can still recover them.
      if (!bounded) {
        for (const row of tx.query("SELECT id FROM file_refs WHERE workspace_id=? AND status='current'", [workspace.id])) {
          const current = tx.get('SELECT relative_path FROM file_refs WHERE id=?', [row.id]);
          if (current && !seen.has(current.relative_path)) {
            tx.run("UPDATE file_refs SET status='stale',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=?", [now, principal.actorId, row.id]);
          }
        }
      }
    });
    return count;
  }

  getFile(projectId, fileId, input = {}, principal) {
    assertProject(this.authorization, principal, 'read', projectId, { resource: 'files' });
    const id = String(fileId || '');
    let row = this.db.get('SELECT * FROM file_refs WHERE id=?', [id]);
    if (row && String(row.project_id) !== String(projectId)) throw new PlatformError('scope_denied', 'file reference is outside the project', {}, 403);
    if (!row && input.path) row = this.db.get('SELECT * FROM file_refs WHERE project_id=? AND relative_path=?', [String(projectId), safeRelative(input.path)]);
    if (!row) throw new PlatformError('not_found', 'file reference not found', {}, 404);
    const checked = this.readIndexedFile(String(projectId), row.id, input.expected_revision ?? input.expected_file_revision, input.expected_hash ?? input.expected_file_hash, principal);
    const bytes = checked.bytes;
    const file = checked.file;
    const content = bytes.byteLength <= MAX_PREVIEW && isText(bytes) && !containsRestricted(bytes)
      ? bytes.toString('utf8') : null;
    return { file, content, download_only: content == null };
  }

  /**
   * Read an indexed file through the Files owner.  Context and Assist callers
   * receive bytes only after project, revision/hash, status, path-boundary and
   * on-disk drift checks have all passed.
   */
  readIndexedFile(projectId, fileRefId, expectedRevision, expectedHash, principal) {
    assertProject(this.authorization, principal, 'read', projectId, { resource: 'files' });
    const row = this.db.get('SELECT * FROM file_refs WHERE id=?', [String(fileRefId || '')]);
    if (!row) throw new PlatformError('not_found', 'file reference not found', {}, 404);
    if (String(row.project_id) !== String(projectId)) throw new PlatformError('scope_denied', 'file reference is outside the project', {}, 403);
    if (row.status !== 'current') throw new PlatformError('file_stale', 'file reference is not current', { status: row.status, actual_revision: Number(row.revision) }, 409);
    if (expectedRevision != null && Number(expectedRevision) !== Number(row.revision)) {
      throw new PlatformError('file_stale', 'file reference revision does not match', { expected_revision: Number(expectedRevision), actual_revision: Number(row.revision) }, 409);
    }
    if (expectedHash != null && String(expectedHash).toLowerCase() !== String(row.content_sha256).toLowerCase()) {
      throw new PlatformError('file_stale', 'file reference hash does not match', { expected_hash: String(expectedHash), actual_hash: row.content_sha256 }, 409);
    }
    const workspace = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [String(row.workspace_id)]);
    if (!workspace || String(workspace.project_id) !== String(projectId)) throw new PlatformError('scope_denied', 'file workspace is outside the project', {}, 403);
    const bytes = this.readWorkspaceFile(workspace.id, row.relative_path);
    const actual = sha256Hex(bytes);
    if (actual !== row.content_sha256) throw new PlatformError('file_stale', 'workspace file changed since indexing', { expected_hash: row.content_sha256, actual_hash: actual }, 409);
    return { file: fileView({ ...row, content_sha256: actual }), bytes };
  }

  listAttachments(projectId, input = {}, principal) {
    assertProject(this.authorization, principal, 'read', projectId, { resource: 'attachments' });
    const rows = this.db.query('SELECT * FROM attachments WHERE project_id=? ORDER BY created_at DESC,id', [String(projectId)]);
    return { attachments: rows.filter((row) => !input.status || row.status === String(input.status)).map(attachmentView) };
  }

  async createAttachment(input = {}, principal) {
    requirePrincipal(principal);
    const projectId = String(input.project_id || '');
    assertProject(this.authorization, principal, 'write', projectId, { resource: 'attachments' });
    const filename = validateFilename(input.filename);
    if (input.session_id) {
      const session = this.db.get('SELECT project_id FROM assist_sessions WHERE id=?', [String(input.session_id)]);
      if (!session || session.project_id !== projectId) throw new PlatformError('scope_denied', 'attachment session is outside the project', {}, 403);
    }
    const suppliedType = boundedString(input.media_type || MIME_BY_EXTENSION[path.extname(filename).toLowerCase()] || 'application/octet-stream', 160, { required: true });
    const bytes = decodeContent(input.content_base64, MAX_ATTACHMENT);
    const contentHash = sha256Hex(bytes);
    if (input.content_sha256 && String(input.content_sha256).toLowerCase() !== contentHash) throw new PlatformError('content_hash_mismatch', 'attachment content hash does not match', { expected: input.content_sha256, actual: contentHash }, 422);
    const now = time(this.clock); const idempotencyKey = requireIdempotency(input.idempotency_key);
    const hash = requestHash({ project_id: projectId, filename, media_type: suppliedType, content_sha256: contentHash, byte_length: bytes.byteLength });
    const id = opaqueId('attachment');
    const restricted = containsRestricted(bytes) || forbiddenMime(suppliedType, bytes);
    let object;
    if (restricted) object = this.cas.put('[quarantined attachment]', { mediaType: 'text/plain', metadata: { kind: 'attachment.quarantine', attachment_id: id } });
    else object = this.cas.put(bytes, { mediaType: suppliedType, metadata: { kind: 'attachment', attachment_id: id } });
    const preview = restricted ? null : makePreview(bytes, suppliedType);
    const previewObject = preview == null ? null : this.cas.put(preview.bytes, { mediaType: preview.mediaType, metadata: { kind: 'attachment.preview', attachment_id: id } });
    const response = await this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'attachment.create', idempotencyKey, requestHash: hash, now });
      if (prior) return prior;
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'attachment.create', resourceType: 'attachment', resourceId: id, projectId, requestHash: hash, status: 'succeeded', now });
      const status = restricted ? 'quarantined' : 'ready';
      const disposition = restricted ? 'quarantine' : (preview ? 'preview' : 'download_only');
      tx.run(`INSERT INTO attachments(id,project_id,session_id,filename,media_type,byte_length,content_sha256,content_cas_hash,preview_cas_hash,preview_byte_length,disposition,parser_status,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`, [id, projectId, input.session_id || null, filename, suppliedType, bytes.byteLength, contentHash, object.hash, previewObject?.hash || null, previewObject?.byte_length || 0, disposition, restricted ? 'quarantined' : parserRequired(suppliedType) ? 'pending' : 'not_required', status, now, now, principal.actorId, principal.actorId]);
      appendAggregate(this.events, tx, { aggregateType: 'attachment', aggregateId: id, revision: 1, operationId: op.id, actorId: principal.actorId, projectId, type: restricted ? 'attachment.quarantined' : 'attachment.created', data: { attachment_id: id, byte_length: bytes.byteLength }, payload: { id, project_id: projectId, status, disposition, revision: 1, content_sha256: contentHash }, now });
      this.operations.linkInTransaction(tx, op.id, [['attachment', id]], now);
      const value = { attachment: attachmentView(tx.get('SELECT * FROM attachments WHERE id=?', [id])), operation: this.operations.summary(op) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'attachment.create', idempotencyKey, requestHash: hash, response: value, operationId: op.id, status: 201, now });
      return value;
    });
    return response;
  }

  attachmentContent(id, principal, { preview = false } = {}) {
    const row = this.attachmentRow(id); assertProject(this.authorization, principal, 'read', row.project_id, { resource: 'attachments' });
    if (row.status === 'quarantined' || row.status === 'deleted') throw new PlatformError('attachment_unavailable', 'attachment content is unavailable', {}, 410);
    const hash = preview ? row.preview_cas_hash : row.content_cas_hash;
    if (!hash) throw new PlatformError('preview_unavailable', 'attachment preview is unavailable', {}, 404);
    const bytes = this.cas.read(hash);
    return { attachment: attachmentView(row), content_base64: bytes.toString('base64'), byte_length: bytes.byteLength, media_type: preview ? previewMedia(row.media_type) : row.media_type, preview };
  }

  async deleteAttachment(id, input = {}, principal) {
    const row = this.attachmentRow(id); assertProject(this.authorization, principal, 'write', row.project_id, { resource: 'attachments' });
    const expected = requireRevision(input.expected_revision); const key = requireIdempotency(input.idempotency_key); const commandId = 'attachment.delete'; const hash = requestHash({ attachment_id: row.id, expected_revision: expected }); const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get('SELECT * FROM attachments WHERE id=?', [row.id]); assertRevision(current, expected); if (current.status === 'deleted') throw new PlatformError('state_conflict', 'attachment is already deleted', {}, 409); const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'attachment', resourceId: row.id, projectId: row.project_id, requestHash: hash, status: 'succeeded', now });
      tx.run("UPDATE attachments SET status='deleted',parser_status='deleted',revision=revision+1,updated_at=?,deleted_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, now, principal.actorId, row.id, expected], 1);
      appendAggregate(this.events, tx, { aggregateType: 'attachment', aggregateId: row.id, revision: expected + 1, operationId: op.id, actorId: principal.actorId, projectId: row.project_id, type: 'attachment.deleted', data: { attachment_id: row.id }, payload: { id: row.id, status: 'deleted', revision: expected + 1 }, now }); this.operations.linkInTransaction(tx, op.id, [['attachment', row.id]], now);
      const response = { attachment: attachmentView(tx.get('SELECT * FROM attachments WHERE id=?', [row.id])), operation: this.operations.summary(op) }; saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 200, now }); return response;
    });
  }

  listBatches(projectId, principal) { assertProject(this.authorization, principal, 'read', projectId, { resource: 'files' }); return { batches: this.db.query('SELECT * FROM file_change_batches WHERE project_id=? ORDER BY created_at DESC,id', [String(projectId)]).map(batchView) }; }

  async createBatch(input = {}, principal) {
    requirePrincipal(principal); const projectId = String(input.project_id || ''); assertProject(this.authorization, principal, 'write', projectId, { resource: 'files' });
    const workspace = this.workspaceRow(input.workspace_id, projectId); const changes = normalizeChanges(input.changes); const now = time(this.clock); const key = requireIdempotency(input.idempotency_key);
    const prepared = []; let total = 0; const seen = new Set();
    for (const change of changes) {
      const relative = safeRelative(change.path); const collisionKey = relative.toLocaleLowerCase('en-US'); if (seen.has(collisionKey)) throw new PlatformError('path_collision', 'change batch contains a case-colliding path', { path: relative }, 422); seen.add(collisionKey);
      rejectCaseCollision(this.workspaceDirectory(workspace), relative);
      const currentBytes = this.readWorkspaceFile(workspace.id, relative, { missing: true }); const beforeHash = currentBytes ? sha256Hex(currentBytes) : '';
      if (change.action === 'create' && currentBytes) throw new PlatformError('file_exists', 'create change targets an existing file', { path: relative }, 409);
      if ((change.action === 'replace' || change.action === 'delete') && !currentBytes) throw new PlatformError('file_not_found', 'change targets a missing file', { path: relative }, 409);
      if (change.before_sha256 != null && String(change.before_sha256).toLowerCase() !== beforeHash) throw new PlatformError('file_stale', 'file before hash does not match workspace', { path: relative, expected_sha256: change.before_sha256, actual_sha256: beforeHash }, 409);
      const content = change.action === 'delete' ? Buffer.alloc(0) : decodeChangeContent(change);
      if (content.byteLength > MAX_FILE) throw new PlatformError('file_too_large', 'file exceeds the per-file limit', { path: relative }, 422);
      total += content.byteLength; if (total > MAX_BATCH_BYTES) throw new PlatformError('batch_too_large', 'change batch exceeds the total size limit', {}, 422);
      const before = currentBytes ? this.cas.put(currentBytes, { mediaType: detectMime(relative), metadata: { kind: 'file.before', path: relative } }) : null;
      const after = change.action === 'delete' ? null : this.cas.put(content, { mediaType: detectMime(relative), metadata: { kind: 'file.after', path: relative } });
      prepared.push({ relative, action: change.action, beforeHash, afterHash: after?.hash || '', beforeCas: before?.hash || null, afterCas: after?.hash || null, byteLength: content.byteLength, content });
    }
    const batchId = opaqueId('file_batch'); const batchPayload = canonicalPayload(prepared.map(({ content, ...item }) => item)); const patch = this.cas.putCanonical({ schema_version: 'aiws.file_change_patch.v1', items: prepared.map(({ content, ...item }) => item) }, { mediaType: 'application/json', metadata: { kind: 'file_change_batch', batch_id: batchId } });
    const hash = requestHash({ project_id: projectId, workspace_id: workspace.id, changes: prepared.map(({ content, ...item }) => item) });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'change.batch.create', idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'change.batch.create', resourceType: 'file_change_batch', resourceId: batchId, projectId, requestHash: hash, status: 'succeeded', now });
      tx.run('INSERT INTO file_change_batches(id,project_id,workspace_id,assist_turn_id,operation_id,fencing_token_hash,item_count,total_bytes,batch_sha256,patch_cas_hash,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?, ?,?,?,?,\'proposed\',1,?,?,?,?)', [batchId, projectId, workspace.id, input.assist_turn_id || null, op.id, '', prepared.length, total, batchPayload.sha256, patch.hash, now, now, principal.actorId, principal.actorId]);
      for (let index = 0; index < prepared.length; index += 1) { const item = prepared[index]; tx.run('INSERT INTO file_change_items(id,batch_id,ordinal,relative_path,action,before_sha256,after_sha256,before_cas_hash,after_cas_hash,byte_length,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,\'pending\',?)', [opaqueId('file_item'), batchId, index + 1, item.relative, item.action, item.beforeHash, item.afterHash, item.beforeCas, item.afterCas, item.byteLength, now]); }
      appendAggregate(this.events, tx, { aggregateType: 'file_change_batch', aggregateId: batchId, revision: 1, operationId: op.id, actorId: principal.actorId, projectId, type: 'file_change_batch.proposed', data: { batch_id: batchId, item_count: prepared.length }, payload: { id: batchId, project_id: projectId, workspace_id: workspace.id, status: 'proposed', revision: 1, batch_sha256: batchPayload.sha256 }, now });
      this.operations.linkInTransaction(tx, op.id, [['file_change_batch', batchId]], now);
      const value = { batch: batchView(tx.get('SELECT * FROM file_change_batches WHERE id=?', [batchId])), operation: this.operations.summary(op) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'change.batch.create', idempotencyKey: key, requestHash: hash, response: value, operationId: op.id, status: 201, now }); return value;
    });
  }

  reviewBatch(id, principal) { const row = this.batchRow(id); assertProject(this.authorization, principal, 'read', row.project_id, { resource: 'files' }); return { batch: batchView(row), items: this.db.query('SELECT * FROM file_change_items WHERE batch_id=? ORDER BY ordinal', [row.id]).map((item) => itemView(item, row.status)) }; }

  async approveBatch(id, input = {}, principal) { return this.mutateBatch(id, 'approved', input, principal, 'files:approve'); }

  async applyBatch(id, input = {}, principal) {
    return this.queueBatchAction(id, 'apply', input, principal);
  }

  async undoBatch(id, input = {}, principal) {
    return this.queueBatchAction(id, 'undo', input, principal);
  }

  async queueBatchAction(id, action, input, principal) {
    const row = this.batchRow(id);
    assertProject(this.authorization, principal, 'write', row.project_id, { resource: 'files' });
    const expectedStatus = action === 'apply' ? 'approved' : 'applied';
    const expected = requireRevision(input.expected_revision);
    const key = requireIdempotency(input.idempotency_key);
    const commandId = `change.batch.${action}`;
    const hash = requestHash({ batch_id: row.id, expected_revision: expected });
    const now = time(this.clock);
    const queued = await this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM file_change_batches WHERE id=?', [row.id]);
      assertRevision(current, expected);
      if (current.status !== expectedStatus) throw new PlatformError('state_conflict', `change batch is not ready to ${action}`, { status: current.status }, 409);
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'file_change_batch', resourceId: row.id, projectId: row.project_id, requestHash: hash, status: 'queued', now });
      const next = Number(current.revision) + 1;
      const pendingStatus = action === 'apply' ? 'applying' : 'undoing';
      tx.run('UPDATE file_change_batches SET operation_id=?,status=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [op.id, pendingStatus, next, now, principal.actorId, row.id, expected], 1);
      appendAggregate(this.events, tx, { aggregateType: 'file_change_batch', aggregateId: row.id, revision: next, operationId: op.id, actorId: principal.actorId, projectId: row.project_id, type: `file_change_batch.${pendingStatus}`, data: { batch_id: row.id }, payload: { id: row.id, status: pendingStatus, revision: next }, now });
      this.operations.linkInTransaction(tx, op.id, [['file_change_batch', row.id]], now);
      const response = this.operations.receiptFromRow(tx.get('SELECT * FROM operations WHERE id=?', [op.id]));
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 202, now });
      return response;
    });
    if (!queued.replayed && !input.defer) queueMicrotask(() => this.executeBatchAction(row.id, queued.operation_id, action, principal, { commandId, key, hash }).catch(() => undefined));
    return queued;
  }

  async executeBatchAction(batchId, operationId, action, principal, idempotency = {}) {
    let lease = null;
    const row = this.batchRow(batchId);
    const workspace = this.workspaceRow(row.workspace_id, row.project_id);
    const items = this.db.query('SELECT * FROM file_change_items WHERE batch_id=? ORDER BY ordinal', [row.id]);
    try {
      let operation = this.db.get('SELECT * FROM operations WHERE id=?', [operationId]);
      if (operation?.status === 'queued' || operation?.status === 'paused') await this.operations.start(operation.id, { expectedRevision: Number(operation.revision), actorId: principal.actorId, projectId: row.project_id });
      lease = await this.acquireLease(workspace, principal);
      this.replaceBatchFiles(workspace, items, action, { allowDesired: Boolean(idempotency.recovery) });
      const now = time(this.clock);
      const result = await this.db.withTransaction((tx) => {
        const current = tx.get('SELECT * FROM file_change_batches WHERE id=?', [row.id]);
        const expectedStatus = action === 'apply' ? 'applying' : 'undoing';
        if (!current || current.status !== expectedStatus || current.operation_id !== operationId) throw new PlatformError('state_conflict', 'change batch execution lease was lost', {}, 409);
        const next = Number(current.revision) + 1;
        const finalStatus = action === 'apply' ? 'applied' : 'undone';
        tx.run(`UPDATE file_change_batches SET status=?,fencing_token_hash=?,revision=?,updated_at=?,${action === 'apply' ? 'applied_at' : 'undone_at'}=?,updated_by_actor_id=? WHERE id=? AND revision=?`, [finalStatus, sha256Hex(lease.token), next, now, now, principal.actorId, row.id, current.revision], 1);
        this.indexBatchInTransaction(tx, workspace, items, action, principal, now, operationId);
        appendAggregate(this.events, tx, { aggregateType: 'file_change_batch', aggregateId: row.id, revision: next, operationId, actorId: principal.actorId, projectId: row.project_id, type: `file_change_batch.${finalStatus}`, data: { batch_id: row.id }, payload: { id: row.id, status: finalStatus, revision: next }, now });
        operation = tx.get('SELECT * FROM operations WHERE id=?', [operationId]);
        if (operation?.status === 'running') this.operations.transitionInTransaction(tx, operation.id, 'succeeded', { expectedRevision: Number(operation.revision), actorId: principal.actorId, projectId: row.project_id, result: { batch_id: row.id, status: finalStatus } }, now);
        const response = this.operations.receiptFromRow(tx.get('SELECT * FROM operations WHERE id=?', [operationId]));
        if (idempotency.key) saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: idempotency.commandId, idempotencyKey: idempotency.key, requestHash: idempotency.hash, response, operationId, status: 200, now });
        return response;
      });
      return result;
    } catch (error) {
      await this.failBatchAction(row.id, operationId, error, principal, idempotency);
      throw error;
    } finally {
      if (lease) await this.releaseLease(lease, this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [workspace.id]) || workspace, principal).catch(() => undefined);
    }
  }

  replaceBatchFiles(workspace, items, action, { allowDesired = false } = {}) {
    const root = this.workspaceDirectory(workspace);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    rejectSpecialPath(root);
    const expectedField = action === 'apply' ? 'before_sha256' : 'after_sha256';
    const desiredField = action === 'apply' ? 'after_sha256' : 'before_sha256';
    const desiredCasField = action === 'apply' ? 'after_cas_hash' : 'before_cas_hash';
    const prepared = [];
    for (const item of items) {
      const target = resolveWithin(root, item.relative_path);
      rejectSpecialPath(target);
      const current = fs.existsSync(target) ? this.readWorkspaceFile(workspace.id, item.relative_path) : null;
      const actualHash = current ? sha256Hex(current) : '';
      const desiredHash = item[desiredField] || '';
      if (actualHash !== item[expectedField] && !(allowDesired && actualHash === desiredHash)) throw new PlatformError('file_stale', 'workspace file does not match the change batch', { path: item.relative_path, expected_sha256: item[expectedField], actual_sha256: actualHash }, 409);
      const desired = desiredHash ? this.cas.read(item[desiredCasField]) : null;
      if (desired && sha256Hex(desired) !== desiredHash) throw new PlatformError('cas_tamper', 'change batch CAS object does not match its hash', { path: item.relative_path }, 409);
      prepared.push({ item, target, before: current, desired, desiredHash, alreadyDesired: actualHash === desiredHash });
    }
    const tempRoot = path.resolve(root, `.aiws-batch-${randomUUID()}`);
    if (!tempRoot.startsWith(`${path.resolve(root)}${path.sep}`)) throw new PlatformError('path_policy_denied', 'batch staging path is invalid', {}, 422);
    fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
    try {
      for (const entry of prepared) {
        if (!entry.desired || entry.alreadyDesired) continue;
        entry.staged = path.join(tempRoot, entry.item.id);
        fs.writeFileSync(entry.staged, entry.desired, { mode: 0o600 });
      }
      try {
        for (const entry of prepared) {
          if (entry.alreadyDesired) continue;
          if (entry.desired) {
            fs.mkdirSync(path.dirname(entry.target), { recursive: true, mode: 0o700 });
            rejectSpecialPath(entry.target);
            if (fs.existsSync(entry.target)) fs.rmSync(entry.target, { force: true });
            fs.renameSync(entry.staged, entry.target);
          } else if (fs.existsSync(entry.target)) fs.rmSync(entry.target, { force: true });
        }
        for (const entry of prepared) {
          const bytes = fs.existsSync(entry.target) ? fs.readFileSync(entry.target) : null;
          const actual = bytes ? sha256Hex(bytes) : '';
          if (actual !== entry.desiredHash) throw new PlatformError('file_apply_incomplete', 'change batch output verification failed', { path: entry.item.relative_path }, 500);
        }
      } catch (error) {
        for (const entry of [...prepared].reverse()) {
          if (entry.before) {
            fs.mkdirSync(path.dirname(entry.target), { recursive: true, mode: 0o700 });
            fs.writeFileSync(entry.target, entry.before, { mode: 0o600 });
          } else if (fs.existsSync(entry.target)) fs.rmSync(entry.target, { force: true });
        }
        throw error;
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  indexBatchInTransaction(tx, workspace, items, action, principal, now, operationId = null) {
    for (const item of items) {
      const hash = action === 'apply' ? item.after_sha256 : item.before_sha256;
      const casHash = action === 'apply' ? item.after_cas_hash : item.before_cas_hash;
      const existing = tx.get('SELECT * FROM file_refs WHERE workspace_id=? AND relative_path=?', [workspace.id, item.relative_path]);
      const status = hash ? 'current' : 'deleted';
      const byteLength = casHash ? this.cas.read(casHash).byteLength : 0;
      const revision = existing ? Number(existing.revision) + 1 : 1;
      const id = existing?.id || opaqueId('file_ref');
      const contentHash = hash || item.before_sha256 || item.after_sha256;
      if (existing) tx.run('UPDATE file_refs SET content_sha256=?,byte_length=?,media_type=?,status=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [contentHash, byteLength, detectMime(item.relative_path), status, revision, now, principal.actorId, id, existing.revision], 1);
      else tx.run('INSERT INTO file_refs(id,project_id,workspace_id,relative_path,content_sha256,byte_length,media_type,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?)', [id, workspace.project_id, workspace.id, item.relative_path, contentHash, byteLength, detectMime(item.relative_path), status, now, now, principal.actorId, principal.actorId]);
      appendAggregate(this.events, tx, { aggregateType: 'file_ref', aggregateId: id, revision, operationId, actorId: principal.actorId, projectId: workspace.project_id, type: `file_ref.${status}`, data: { file_id: id, relative_path: item.relative_path }, payload: { id, project_id: workspace.project_id, workspace_id: workspace.id, relative_path: item.relative_path, content_sha256: contentHash, status, revision }, now });
    }
  }

  async failBatchAction(batchId, operationId, error, principal, idempotency = {}) {
    const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const row = tx.get('SELECT * FROM file_change_batches WHERE id=?', [batchId]);
      let operation = tx.get('SELECT * FROM operations WHERE id=?', [operationId]);
      const status = error?.code === 'file_stale' ? 'stale' : 'failed';
      if (row && ['applying', 'undoing'].includes(row.status) && row.operation_id === operationId) {
        const next = Number(row.revision) + 1;
        tx.run('UPDATE file_change_batches SET status=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [status, next, now, principal.actorId, row.id, row.revision], 1);
        appendAggregate(this.events, tx, { aggregateType: 'file_change_batch', aggregateId: row.id, revision: next, operationId, actorId: principal.actorId, projectId: row.project_id, type: `file_change_batch.${status}`, data: { batch_id: row.id, error_code: String(error?.code || 'file_apply_failed') }, payload: { id: row.id, status, revision: next }, now });
      }
      if (operation && !['succeeded', 'failed', 'cancelled', 'expired'].includes(operation.status)) {
        if (operation.status === 'queued' || operation.status === 'paused') {
          this.operations.transitionInTransaction(tx, operation.id, 'running', { expectedRevision: Number(operation.revision), actorId: principal.actorId, projectId: row?.project_id }, now);
          operation = tx.get('SELECT * FROM operations WHERE id=?', [operation.id]);
        }
        if (operation.status === 'running') this.operations.transitionInTransaction(tx, operation.id, 'failed', { expectedRevision: Number(operation.revision), actorId: principal.actorId, projectId: row?.project_id, errorCode: String(error?.code || 'file_apply_failed'), errorDetails: { message: String(error?.message || '').slice(0, 240) } }, now);
      }
      const response = this.operations.receiptFromRow(tx.get('SELECT * FROM operations WHERE id=?', [operationId]));
      if (idempotency.key) saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: idempotency.commandId, idempotencyKey: idempotency.key, requestHash: idempotency.hash, response, operationId, status: 200, now });
      return response;
    });
  }

  async mutateBatch(id, status, input, principal) {
    const row = this.batchRow(id);
    assertProject(this.authorization, principal, status === 'approved' ? 'approve' : 'write', row.project_id, { resource: 'files' });
    const expected = requireRevision(input.expected_revision);
    const key = requireIdempotency(input.idempotency_key);
    const commandId = 'change.batch.approve';
    const hash = requestHash({ batch_id: row.id, expected_revision: expected });
    const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM file_change_batches WHERE id=?', [row.id]);
      assertRevision(current, expected);
      if (current.status !== 'proposed') throw new PlatformError('state_conflict', 'change batch is not proposed', {}, 409);
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'file_change_batch', resourceId: row.id, projectId: row.project_id, requestHash: hash, status: 'succeeded', now });
      const next = expected + 1;
      tx.run('UPDATE file_change_batches SET status=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [status, next, now, principal.actorId, row.id, expected], 1);
      appendAggregate(this.events, tx, { aggregateType: 'file_change_batch', aggregateId: row.id, revision: next, operationId: op.id, actorId: principal.actorId, projectId: row.project_id, type: `file_change_batch.${status}`, data: { batch_id: row.id }, payload: { id: row.id, status, revision: next }, now });
      this.operations.linkInTransaction(tx, op.id, [['file_change_batch', row.id]], now);
      const response = { batch: batchView(tx.get('SELECT * FROM file_change_batches WHERE id=?', [row.id])), items: tx.query('SELECT * FROM file_change_items WHERE batch_id=? ORDER BY ordinal', [row.id]).map((item) => itemView(item, status)), operation: this.operations.summary(op) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 200, now });
      return response;
    });
  }

  async acquireLease(workspace, principal) {
    if (!this.projectWorkflow?.lockRepositoryWorkspace) throw new PlatformError('workspace_lease_unavailable', 'Repository workspace lease owner is unavailable', {}, 503);
    const current = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [workspace.id]);
    const result = await this.projectWorkflow.lockRepositoryWorkspace(workspace.id, { expected_revision: Number(current.revision), idempotency_key: `files-lease-${opaqueId('key')}` }, principal);
    const token = String(result.lock?.fencing_token || '');
    if (!token) throw new PlatformError('workspace_lease_unavailable', 'Repository workspace fencing token is missing', {}, 503);
    return { token, result };
  }
  async releaseLease(lease, workspace, principal) { if (lease?.result && this.projectWorkflow?.releaseRepositoryWorkspace) { const current = this.db.get('SELECT revision FROM repository_workspaces WHERE id=?', [workspace.id]); if (current) await this.projectWorkflow.releaseRepositoryWorkspace(workspace.id, { expected_revision: current.revision, idempotency_key: `files-release-${opaqueId('key')}` }, principal); return; } const now = time(this.clock); this.db.withTransaction((tx) => { tx.run("UPDATE repository_locks SET status='released',updated_at=? WHERE workspace_id=? AND status='active'", [now, workspace.id]); tx.run("UPDATE repository_workspaces SET status='released',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND status='locked'", [now, principal.actorId, workspace.id]); }); }

  workspaceRow(id, projectId = null) {
    const row = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [String(id || '')]);
    if (!row) throw new PlatformError('not_found', 'repository workspace not found', {}, 404);
    if (projectId != null && String(row.project_id) !== String(projectId)) throw new PlatformError('scope_denied', 'repository workspace is outside the project', {}, 403);
    return row;
  }
  attachmentRow(id) { const row = this.db.get('SELECT * FROM attachments WHERE id=?', [String(id)]); if (!row) throw new PlatformError('not_found', 'attachment not found', {}, 404); return row; }
  batchRow(id) { const row = this.db.get('SELECT * FROM file_change_batches WHERE id=?', [String(id)]); if (!row) throw new PlatformError('not_found', 'change batch not found', {}, 404); return row; }
  workspaceDirectory(workspace) { return resolveWithin(this.workspaceRoot, workspace.relative_path || `projects/${workspace.project_id}/workspace`); }
  readWorkspaceFile(workspaceId, relative, { missing = false } = {}) { const workspace = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [String(workspaceId)]); if (!workspace) throw new PlatformError('not_found', 'repository workspace not found', {}, 404); const target = resolveWithin(this.workspaceDirectory(workspace), relative); rejectSpecialPath(target); if (!fs.existsSync(target)) { if (missing) return null; throw new PlatformError('file_not_found', 'workspace file not found', { path: relative }, 404); } const stat = fs.lstatSync(target); if (!stat.isFile() || stat.size > MAX_FILE) throw new PlatformError('file_policy_denied', 'workspace file is not a regular bounded file', { path: relative }, 422); return fs.readFileSync(target); }
  async recoverPending() {
    const rows = this.db.query("SELECT * FROM file_change_batches WHERE status IN ('applying','undoing') ORDER BY created_at,id");
    for (const row of rows) {
      const action = row.status === 'applying' ? 'apply' : 'undo';
      const principal = { actorId: row.created_by_actor_id || this.bootstrapActorId, effectiveActorId: row.created_by_actor_id || this.bootstrapActorId, scopes: ['*'] };
      if (!row.operation_id) {
        this.db.run("UPDATE file_change_batches SET status='failed',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND status IN ('applying','undoing')", [time(this.clock), principal.actorId, row.id]);
        continue;
      }
      await this.executeBatchAction(row.id, row.operation_id, action, principal, { recovery: true }).catch(() => undefined);
    }
    return rows.length;
  }
}

function validateFilename(value) { const filename = boundedString(value, 240, { required: true }); if (filename.includes('\\') || filename.includes('/') || filename === '.' || filename === '..' || filename.includes('\0')) throw new PlatformError('filename_invalid', 'attachment filename is invalid', {}, 422); return filename; }
function decodeContent(value, max) { if (typeof value !== 'string') throw new PlatformError('content_required', 'base64 content is required', {}, 422); const normalized = value.replace(/\s+/g, ''); if (normalized && (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0)) throw new PlatformError('content_invalid', 'content encoding is invalid', {}, 422); let bytes; try { bytes = Buffer.from(normalized, 'base64'); } catch { throw new PlatformError('content_invalid', 'content encoding is invalid', {}, 422); } if (bytes.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) throw new PlatformError('content_invalid', 'content encoding is invalid', {}, 422); if (bytes.byteLength > max) throw new PlatformError('file_too_large', 'content exceeds the size limit', {}, 422); return bytes; }
function decodeChangeContent(change) { return change.content_base64 != null ? decodeContent(change.content_base64, MAX_FILE) : Buffer.from(String(change.content || ''), 'utf8'); }
function isSpecialStat(stat) {
  return stat.isSocket?.() || stat.isFIFO?.() || stat.isBlockDevice?.() || stat.isCharacterDevice?.();
}
function isReparseStat(stat) {
  // Junctions and other Windows reparse points can report as directories
  // rather than symbolic links.  Keep them out of both indexing and reads.
  return Boolean(stat?.isSymbolicLink?.() || stat?.isReparsePoint?.());
}
function safeRelative(value) { const text = String(value || '').replaceAll('\\', '/'); const parts = text.split('/'); if (!text || text.startsWith('/') || /^[A-Za-z]:\//.test(text) || parts.includes('..') || parts.some((part) => !part || part === '.' || part.includes(':') || /[. ]$/.test(part))) throw new PlatformError('path_policy_denied', 'workspace path must be relative', {}, 422); if (text.startsWith('.git/') || text === '.git' || text.includes('/.git/')) throw new PlatformError('path_policy_denied', 'git metadata is not addressable', {}, 422); return text; }
function resolveWithin(root, relative) { const clean = safeRelative(relative); const base = path.resolve(root); const target = path.resolve(base, clean); if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new PlatformError('path_policy_denied', 'path escapes the workspace', {}, 422); return target; }
function rejectSpecialPath(target) { const parts = target.split(path.sep); let current = parts[0] === '' ? path.sep : parts[0]; for (const part of parts.slice(1)) { current = path.join(current, part); if (!fs.existsSync(current)) break; const stat = fs.lstatSync(current); if (isReparseStat(stat) || stat.isDirectory() && part === '.git') throw new PlatformError('path_policy_denied', 'special workspace path is not addressable', {}, 422); } }
function rejectCaseCollision(root, relative) { let current = path.resolve(root); for (const segment of safeRelative(relative).split('/')) { if (!fs.existsSync(current)) return; const entries = fs.readdirSync(current); const match = entries.find((entry) => entry.toLocaleLowerCase('en-US') === segment.toLocaleLowerCase('en-US')); if (match && match !== segment) throw new PlatformError('path_collision', 'workspace path collides by case', { path: relative }, 422); current = path.join(current, segment); } }
function isText(bytes) { return !bytes.includes(0) && Buffer.from(bytes).toString('utf8').length === bytes.byteLength; }
function containsRestricted(bytes) { if (!isText(bytes)) return false; const text = bytes.toString('utf8'); return SECRET_SENTINEL.test(text) || PROMPT_SENTINEL.test(text) || /(?:^|[\s(])(?:[A-Za-z]:\\|\/home\/|\/Users\/|\/root\/)/.test(text); }
function forbiddenMime(type, bytes) { const actual = detectMagic(bytes); if (!actual || type === 'application/octet-stream' || type === actual) return false; if (actual === 'text/plain' && (type.startsWith('text/') || ['application/json', 'application/xml', 'image/svg+xml'].includes(type))) return false; if (actual === 'application/zip' && (type === 'application/zip' || type.startsWith('application/vnd.openxmlformats-officedocument'))) return false; return true; }
function detectMagic(bytes) { if (bytes.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'binary'))) return 'image/png'; if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg'; if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'; if (bytes.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp'; if (bytes.subarray(0, 4).toString() === '%PDF') return 'application/pdf'; if (bytes.subarray(0, 2).toString() === 'PK') return 'application/zip'; return isText(bytes) ? 'text/plain' : 'application/octet-stream'; }
function makePreview(bytes, type) { if (bytes.byteLength > MAX_PREVIEW || containsRestricted(bytes)) return null; if (['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(type)) return { bytes, mediaType: type }; if (!isText(bytes)) return null; return { bytes: bytes.subarray(0, MAX_PREVIEW), mediaType: type.startsWith('text/') || type === 'application/json' || type === 'text/csv' ? type : 'text/plain' }; }
function parserRequired(type) { return ['image/svg+xml', 'application/pdf', 'application/zip', 'application/vnd.openxmlformats-officedocument', 'audio/', 'video/'].some((prefix) => type.startsWith(prefix)); }
function previewMedia(type) { return type.startsWith('text/') || type === 'application/json' ? type : 'text/plain'; }
function detectMime(relative) { return MIME_BY_EXTENSION[path.extname(relative).toLowerCase()] || 'application/octet-stream'; }
function normalizeChanges(changes) { if (!Array.isArray(changes) || !changes.length || changes.length > MAX_BATCH_FILES) throw new PlatformError('batch_invalid', 'change batch item count is invalid', {}, 422); return changes.map((value) => { const action = String(value?.action || 'replace'); if (!['create', 'replace', 'delete'].includes(action)) throw new PlatformError('batch_invalid', 'change action is invalid', {}, 422); return { path: String(value?.path || ''), action, content: value?.content, content_base64: value?.content_base64, before_sha256: value?.before_sha256 }; }); }
function fileView(row) { return { id: row.id, project_id: row.project_id, workspace_id: row.workspace_id, path: row.relative_path, relative_path: row.relative_path, content_sha256: row.content_sha256, byte_length: Number(row.byte_length), media_type: row.media_type, status: row.status, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at }; }
function attachmentView(row) { return { id: row.id, project_id: row.project_id, session_id: row.session_id || null, filename: row.filename, media_type: row.media_type, byte_length: Number(row.byte_length), content_sha256: row.content_sha256, preview_sha256: row.preview_cas_hash || null, preview_byte_length: Number(row.preview_byte_length), disposition: row.disposition, parser_status: row.parser_status, status: row.status, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, deleted_at: row.deleted_at || null }; }
function batchView(row) { return { id: row.id, project_id: row.project_id, workspace_id: row.workspace_id, assist_turn_id: row.assist_turn_id || null, operation_id: row.operation_id || null, item_count: Number(row.item_count), total_bytes: Number(row.total_bytes), batch_sha256: row.batch_sha256, patch_cas_hash: row.patch_cas_hash, status: row.status, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, applied_at: row.applied_at || null, undone_at: row.undone_at || null }; }
function itemView(row, batchStatus = null) { const status = batchStatus === 'applied' ? 'applied' : batchStatus === 'undone' ? 'undone' : ['failed', 'stale'].includes(batchStatus) ? 'failed' : row.status; return { id: row.id, batch_id: row.batch_id, ordinal: Number(row.ordinal), path: row.relative_path, action: row.action, before_sha256: row.before_sha256 || null, after_sha256: row.after_sha256 || null, byte_length: Number(row.byte_length), status }; }
