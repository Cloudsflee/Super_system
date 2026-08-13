import { asJson, id } from '../../crypto.mjs';
import { auditStatement } from '../platform/repository.mjs';

/* SQL boundary for Connection, Target, Line and artifact records. */
export class RepositoryRepository {
  constructor(db) { this.db = db; }
  query(sql, params = []) { return this.db.query(sql, params); }
  get(sql, params = []) { return this.db.get(sql, params); }
  run(sql, params = []) { return this.db.run(sql, params); }
  transaction(statements) { return this.db.transaction(statements); }

  connections(projectId) { return this.db.query('SELECT * FROM repository_connections WHERE project_id=? ORDER BY created_at,id', [projectId]); }
  connection(connectionId) { return this.db.get('SELECT * FROM repository_connections WHERE id=?', [connectionId]); }
  createConnection({ id: connectionId, projectId, source, remoteUrl, locator, timestamp, actor }) {
    return this.db.transaction([
      { sql: `INSERT INTO repository_connections(id,project_id,provider,remote_url,credential_ref,status,created_at,updated_at,revision,source_kind,source_locator,source_revision,source_hash,display_label,read_only,fault_code,fault_json,locked_by_operation_id)
        VALUES(?,?,?,?,?,'connected',?,?,1,?,?,?,?,?,1,'','{}',NULL)`, params: [connectionId, projectId, 'git', remoteUrl, null, timestamp, timestamp, source.kind, locator, '', '', source.label || source.kind] },
      auditStatement('repository.connection.created', 'repository_connection', connectionId, { project_id: projectId, source_kind: source.kind, display_label: source.label }, actor, timestamp)
    ]);
  }
  updateConnection({ connectionId, expected, sourceKind, locator, remoteUrl, label, timestamp, actor }) {
    return this.db.transaction([
      { sql: `UPDATE repository_connections SET source_kind=COALESCE(?,source_kind),source_locator=COALESCE(?,source_locator),remote_url=COALESCE(?,remote_url),display_label=COALESCE(?,display_label),revision=revision+1,updated_at=?,fault_code='',fault_json='{}' WHERE id=? AND revision=?`, params: [sourceKind, locator, remoteUrl, label, timestamp, connectionId, expected], expect_changes: 1 },
      auditStatement('repository.connection.updated', 'repository_connection', connectionId, { expected_revision: expected, source_kind: sourceKind }, actor, timestamp)
    ]);
  }
  targetCount(connectionId) { return this.db.get('SELECT count(*) AS count FROM repository_targets WHERE connection_id=?', [connectionId]); }
  deleteConnection({ connectionId, expected, timestamp, actor }) {
    return this.db.transaction([
      { sql: 'DELETE FROM repository_connections WHERE id=? AND revision=?', params: [connectionId, expected], expect_changes: 1 },
      auditStatement('repository.connection.deleted', 'repository_connection', connectionId, {}, actor, timestamp)
    ]);
  }

  targets(connectionId) { return this.db.query('SELECT * FROM repository_targets WHERE connection_id=? ORDER BY created_at,id', [connectionId]); }
  target(targetId) { return this.db.get('SELECT * FROM repository_targets WHERE id=?', [targetId]); }
  createTarget({ id: targetId, connectionId, repository, branch, timestamp, actor, projectId }) {
    return this.db.transaction([
      { sql: `INSERT INTO repository_targets(id,connection_id,repository,default_branch,baseline_sha,created_at,updated_at,revision,source_revision,source_hash,managed_relative_path,fault_code,fault_json) VALUES(?,?,?,?,?,?,?,1,'','','','','{}')`, params: [targetId, connectionId, repository, branch, '', timestamp, timestamp] },
      auditStatement('repository.target.created', 'repository_target', targetId, { connection_id: connectionId, project_id: projectId, default_branch: branch }, actor, timestamp)
    ]);
  }
  updateTarget({ targetId, expected, repository, branch, timestamp, actor }) {
    return this.db.transaction([
      { sql: 'UPDATE repository_targets SET repository=COALESCE(?,repository),default_branch=COALESCE(?,default_branch),revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [repository, branch, timestamp, targetId, expected], expect_changes: 1 },
      auditStatement('repository.target.updated', 'repository_target', targetId, { expected_revision: expected }, actor, timestamp)
    ]);
  }
  lineCount(targetId) { return this.db.get('SELECT count(*) AS count FROM repository_lines WHERE target_id=?', [targetId]); }
  deleteTarget({ targetId, expected, timestamp, actor }) {
    return this.db.transaction([
      { sql: 'DELETE FROM repository_targets WHERE id=? AND revision=?', params: [targetId, expected], expect_changes: 1 },
      auditStatement('repository.target.deleted', 'repository_target', targetId, {}, actor, timestamp)
    ]);
  }

  lines(projectId) { return this.db.query('SELECT * FROM repository_lines WHERE project_id=? ORDER BY created_at,id', [projectId]); }
  line(lineId) { return this.db.get('SELECT * FROM repository_lines WHERE id=?', [lineId]); }
  managedCheckout(projectId) { return this.db.get("SELECT * FROM repository_lines WHERE project_id=? AND line_kind='managed_checkout'", [projectId]); }
  lineForOperation(resourceType, resourceId) {
    return resourceType === 'repository_line'
      ? this.db.get('SELECT id FROM repository_lines WHERE id=?', [resourceId])
      : this.managedCheckout(resourceId);
  }
  createLine({ id: lineId, projectId, targetId, lineKind, branch, relative, timestamp, actor }) {
    return this.db.transaction([
      { sql: `INSERT INTO repository_lines(id,project_id,target_id,line_kind,branch,head_sha,status,created_at,updated_at,revision,source_revision,source_hash,baseline_sha,managed_relative_path,probe_status,probe_json,fault_code,fault_json,locked_by_operation_id,operation_id,last_manifest_hash,interrupted_at)
        VALUES(?,?,?,?,?,'','ready',?,?,1,'','','',?,'unknown','{}','','{}',NULL,NULL,'',NULL)`, params: [lineId, projectId, targetId, lineKind, branch, timestamp, timestamp, relative] },
      auditStatement('repository.line.created', 'repository_line', lineId, { project_id: projectId, line_kind: lineKind }, actor, timestamp)
    ]);
  }
  updateLine({ lineId, expected, branch, status, timestamp, actor }) {
    return this.db.transaction([
      { sql: 'UPDATE repository_lines SET branch=COALESCE(?,branch),status=COALESCE(?,status),revision=revision+1,updated_at=? WHERE id=? AND revision=? AND locked_by_operation_id IS NULL', params: [branch, status, timestamp, lineId, expected], expect_changes: 1 },
      auditStatement('repository.line.updated', 'repository_line', lineId, { expected_revision: expected }, actor, timestamp)
    ]);
  }
  artifactCount(lineId) { return this.db.get('SELECT count(*) AS count FROM repository_line_artifacts WHERE line_id=?', [lineId]); }
  deleteLine({ lineId, expected, timestamp, actor }) {
    return this.db.transaction([
      { sql: 'DELETE FROM repository_lines WHERE id=? AND revision=? AND locked_by_operation_id IS NULL', params: [lineId, expected], expect_changes: 1 },
      auditStatement('repository.line.deleted', 'repository_line', lineId, {}, actor, timestamp)
    ]);
  }
  targetConnection(targetId) {
    return this.db.get('SELECT c.* FROM repository_targets t JOIN repository_connections c ON c.id=t.connection_id WHERE t.id=?', [targetId]);
  }
  acquireLine({ lineId, operationId, expectedRevision, timestamp }) {
    return this.db.run("UPDATE repository_lines SET locked_by_operation_id=?,operation_id=?,status='busy',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND locked_by_operation_id IS NULL", [operationId, operationId, timestamp, lineId, expectedRevision]);
  }
  releaseLine(lineId, timestamp) {
    return this.db.run("UPDATE repository_lines SET locked_by_operation_id=NULL,operation_id=NULL,status=CASE WHEN fault_code='' THEN 'ready' ELSE 'fault' END,updated_at=? WHERE id=?", [timestamp, lineId]);
  }
  probeComplete({ lineId, operationId, probe, timestamp, actor }) {
    return this.db.transaction([
      { sql: "UPDATE repository_lines SET status='ready',probe_status='available',probe_json=?,source_revision=?,source_hash=?,fault_code='',fault_json='{}',locked_by_operation_id=NULL,operation_id=NULL,revision=revision+1,updated_at=? WHERE id=? AND locked_by_operation_id=?", params: [asJson(probe), probe.revision || '', probe.hash || '', timestamp, lineId, operationId || null] },
      auditStatement('repository.line.probed', 'repository_line', lineId, { source_kind: probe.source_kind, source_revision: probe.revision, source_hash: probe.hash }, actor, timestamp)
    ]);
  }
  recoverComplete({ lineId, probeJson, manifestHash, timestamp, actor }) {
    return this.db.transaction([
      { sql: "UPDATE repository_lines SET status='ready',probe_status='available',probe_json=?,fault_code='',fault_json='{}',last_manifest_hash=?,locked_by_operation_id=NULL,operation_id=NULL,interrupted_at=NULL,revision=revision+1,updated_at=? WHERE id=?", params: [asJson(probeJson), manifestHash, timestamp, lineId] },
      auditStatement('repository.line.recovered', 'repository_line', lineId, { manifest_hash: manifestHash }, actor, timestamp)
    ]);
  }
  markFault({ lineId, code, timestamp, actor }) {
    return this.db.transaction([
      { sql: "UPDATE repository_lines SET status='fault',probe_status='unavailable',fault_code=?,fault_json=?,locked_by_operation_id=NULL,operation_id=NULL,revision=revision+1,updated_at=? WHERE id=?", params: [code, asJson({ error_code: code }), timestamp, lineId] },
      auditStatement('repository.line.fault', 'repository_line', lineId, { error_code: code }, actor, timestamp)
    ]);
  }
  lockedLines() { return this.db.query('SELECT * FROM repository_lines WHERE locked_by_operation_id IS NOT NULL'); }
  markInterrupted(lineId, timestamp) {
    return this.db.run(`UPDATE repository_lines SET status='fault',fault_code='repository_line_interrupted',fault_json='{"error_code":"repository_line_interrupted"}',locked_by_operation_id=NULL,operation_id=NULL,interrupted_at=?,revision=revision+1,updated_at=? WHERE id=?`, [timestamp, timestamp, lineId]);
  }
  insertArtifact({ projectId, lineId, operationId, kind, relativePath, manifest, manifestHash, sourceHash, byteSize, timestamp }) {
    return this.db.run('INSERT INTO repository_line_artifacts(id,project_id,line_id,operation_id,kind,relative_path,manifest_json,manifest_hash,source_hash,byte_size,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [id('rla'), projectId, lineId, operationId || null, kind, relativePath, asJson(manifest), manifestHash, sourceHash || '', byteSize || 0, timestamp]);
  }
  archiveComplete({ lineId, manifestHash, timestamp }) {
    return this.db.run('UPDATE repository_lines SET last_manifest_hash=?,locked_by_operation_id=NULL,operation_id=NULL,revision=revision+1,updated_at=? WHERE id=?', [manifestHash, timestamp, lineId]);
  }
  recordArchive({ projectId, archiveSha, manifestHash, byteSize, actor, timestamp }) {
    const statement = auditStatement('repository.archived', 'project', projectId, { archive_sha256: archiveSha, manifest_hash: manifestHash, byte_size: byteSize }, actor, timestamp);
    return this.db.run(statement.sql, statement.params);
  }
  binding(projectId) { return this.db.get('SELECT * FROM repository_bindings WHERE project_id=?', [projectId]); }
  bindingByProject(projectId) { return this.binding(projectId); }
  bindingTrashArtifact(projectId) { return this.db.get("SELECT manifest_hash FROM repository_line_artifacts WHERE project_id=? AND kind='trash' ORDER BY created_at DESC LIMIT 1", [projectId]); }
  updateBindingLifecycle({ projectId, status, trashRelativePath, timestamp }) {
    return { sql: `UPDATE repository_bindings SET status=?,trash_relative_path=CASE WHEN ?='trashed' THEN COALESCE(NULLIF(trash_relative_path,''),?) ELSE trash_relative_path END,revision=revision+1,updated_at=? WHERE project_id=?`, params: [status, status, trashRelativePath || '', timestamp, projectId] };
  }
  pendingBindingStatement({ bindingId, projectId, relative, sourceKind, locator, timestamp }) {
    return {
      sql: `INSERT INTO repository_bindings(
        id,project_id,local_path,remote_url,head_sha,revision,created_at,updated_at,connection_id,target_id,line_id,
        source_kind,source_locator,source_revision,source_hash,managed_relative_path,status,fault_code,fault_json,locked_by_operation_id,baseline_sha
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [bindingId, projectId, relative, '', '', 1, timestamp, timestamp, null, null, null, sourceKind, locator, '', '', relative, 'pending', '', '{}', null, '']
    };
  }
  activeLocks(projectId) {
    return this.db.get('SELECT count(*) AS count FROM repository_lines WHERE project_id=? AND locked_by_operation_id IS NOT NULL', [projectId]);
  }
  commitBindingStatements({ binding, projectId, connectionId, targetId, lineId, localPath, remoteUrl, sourceKind, locator, sourceRevision, sourceHash, baseline, displayLabel, manifestHash, timestamp, artifactId }) {
    const bindingId = binding?.id || id('repo');
    const externalLineId = `lin_external_${bindingId}`;
    const stagingLineId = `lin_staging_${bindingId}`;
    const sourceLines = sourceKind === 'none' ? [] : [
      { sql: `INSERT OR IGNORE INTO repository_lines(id,project_id,target_id,line_kind,branch,head_sha,status,created_at,updated_at,revision,source_revision,source_hash,baseline_sha,managed_relative_path,probe_status,probe_json,fault_code,fault_json,locked_by_operation_id,operation_id,last_manifest_hash,interrupted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [externalLineId, projectId, targetId, 'external_readonly', '', baseline, 'ready', timestamp, timestamp, 1, sourceRevision, sourceHash, baseline, '', 'available', '{}', '', '{}', null, null, manifestHash || '', null] },
      { sql: `INSERT OR IGNORE INTO repository_lines(id,project_id,target_id,line_kind,branch,head_sha,status,created_at,updated_at,revision,source_revision,source_hash,baseline_sha,managed_relative_path,probe_status,probe_json,fault_code,fault_json,locked_by_operation_id,operation_id,last_manifest_hash,interrupted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [stagingLineId, projectId, targetId, 'managed_staging', '', baseline, 'blocked', timestamp, timestamp, 1, sourceRevision, sourceHash, baseline, '', 'unavailable', '{}', '', '{}', null, null, manifestHash || '', null] },
      { sql: 'INSERT INTO repository_line_artifacts(id,project_id,line_id,operation_id,kind,relative_path,manifest_json,manifest_hash,source_hash,byte_size,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', params: [id('rla'), projectId, stagingLineId, null, 'staging', '', asJson({ source_revision: sourceRevision, source_hash: sourceHash, manifest_hash: manifestHash }), manifestHash || sourceHash || '0'.repeat(64), sourceHash || '', 0, timestamp] }
    ];
    return [
      { sql: `INSERT OR IGNORE INTO repository_connections(id,project_id,provider,remote_url,credential_ref,status,created_at,updated_at,revision,source_kind,source_locator,source_revision,source_hash,display_label,read_only,fault_code,fault_json,locked_by_operation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [connectionId, projectId, 'git', remoteUrl || '', null, 'connected', timestamp, timestamp, 1, sourceKind, locator, sourceRevision, sourceHash, displayLabel || sourceKind, 1, '', '{}', null] },
      { sql: `INSERT OR IGNORE INTO repository_targets(id,connection_id,repository,default_branch,baseline_sha,created_at,updated_at,revision,source_revision,source_hash,managed_relative_path,fault_code,fault_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [targetId, connectionId, locator || localPath, 'main', baseline, timestamp, timestamp, 1, sourceRevision, sourceHash, localPath, '', '{}'] },
      ...sourceLines,
      { sql: `INSERT OR IGNORE INTO repository_lines(id,project_id,target_id,line_kind,branch,head_sha,status,created_at,updated_at,revision,source_revision,source_hash,baseline_sha,managed_relative_path,probe_status,probe_json,fault_code,fault_json,locked_by_operation_id,operation_id,last_manifest_hash,interrupted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [lineId, projectId, targetId, 'managed_checkout', 'main', baseline, 'ready', timestamp, timestamp, 1, sourceRevision, sourceHash, baseline, localPath, 'available', '{}', '', '{}', null, null, manifestHash || '', null] },
      binding
        ? { sql: `UPDATE repository_bindings SET local_path=?,head_sha=?,baseline_sha=?,revision=revision+1,updated_at=?,connection_id=?,target_id=?,line_id=?,source_kind=?,source_locator=?,source_revision=?,source_hash=?,managed_relative_path=?,status='ready',fault_code='',fault_json='{}',locked_by_operation_id=NULL WHERE project_id=?`, params: [localPath, baseline, baseline, timestamp, connectionId, targetId, lineId, sourceKind, locator, sourceRevision, sourceHash, localPath, projectId] }
        : { sql: `INSERT INTO repository_bindings(id,project_id,local_path,remote_url,head_sha,revision,created_at,updated_at,connection_id,target_id,line_id,source_kind,source_locator,source_revision,source_hash,managed_relative_path,status,fault_code,fault_json,locked_by_operation_id,baseline_sha) VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,'ready','','{}',NULL,?) ON CONFLICT(project_id) DO NOTHING`, params: [bindingId, projectId, localPath, remoteUrl || '', baseline, timestamp, timestamp, connectionId, targetId, lineId, sourceKind, locator, sourceRevision, sourceHash, localPath, baseline] },
      { sql: 'INSERT INTO repository_line_artifacts(id,project_id,line_id,operation_id,kind,relative_path,manifest_json,manifest_hash,source_hash,byte_size,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', params: [artifactId || id('rla'), projectId, lineId, null, 'checkout', localPath, asJson({ managed_relative_path: localPath, baseline_sha: baseline, manifest_hash: manifestHash }), manifestHash || sourceHash || '0'.repeat(64), sourceHash || '', 0, timestamp] }
    ];
  }
}
