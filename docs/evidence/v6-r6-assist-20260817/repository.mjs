import { asJson, hashJson, id, parseJson } from '../../crypto.mjs';

export class AssistRepository {
  constructor(db) { this.db = db; }
  session(id) { return this.db.get('SELECT * FROM assist_sessions WHERE id=?', [id]); }
  turn(id) { return this.db.get('SELECT * FROM assist_turns WHERE id=?', [id]); }
  listSessions(projectId = null) { return projectId ? this.db.query('SELECT * FROM assist_sessions WHERE project_id=? ORDER BY created_at DESC', [projectId]) : this.db.query('SELECT * FROM assist_sessions ORDER BY created_at DESC LIMIT 200'); }
  turns(sessionId) { return this.db.query('SELECT * FROM assist_turns WHERE session_id=? ORDER BY turn_no', [sessionId]); }
  project(projectId) { return this.db.get("SELECT id FROM projects WHERE id=? AND status<>'purged'", [projectId]); }
  sessionBindings(projectId) { return Promise.all([
    this.db.get('SELECT brief.revision,brief.content_hash FROM projects project JOIN brief_revisions brief ON brief.project_id=project.id AND brief.revision=project.confirmed_brief_revision WHERE project.id=?', [projectId]),
    this.db.get('SELECT revision,graph_hash FROM workflow_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]),
    this.db.get('SELECT head_sha FROM repository_bindings WHERE project_id=?', [projectId])
  ]); }
  nextTurnNo(sessionId) { return this.db.get('SELECT COALESCE(MAX(turn_no),0)+1 AS turn_no FROM assist_turns WHERE session_id=?', [sessionId]).then((row) => Number(row.turn_no)); }
  workflow(projectId, revision = null) { return revision == null ? this.db.get('SELECT revision,tasks_json,metadata_json FROM workflow_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]) : this.db.get('SELECT revision,tasks_json,metadata_json FROM workflow_revisions WHERE project_id=? AND revision=?', [projectId, Number(revision)]); }
  pack(projectId, packId) { return this.db.get('SELECT * FROM context_packs WHERE id=? AND project_id=?', [String(packId || ''), projectId]); }
  selection(projectId, selectionId) { return this.db.get('SELECT selection_hash,policy_revision FROM context_selections WHERE id=? AND project_id=?', [selectionId, projectId]); }
  attemptMessage(turnId, attempt) { return this.db.get("SELECT content FROM assist_messages WHERE turn_id=? AND role='user' AND attempt=? ORDER BY sequence_no LIMIT 1", [turnId, attempt]); }
  activeTurns(sessionId) { return this.db.query("SELECT id,revision FROM assist_turns WHERE session_id=? AND status IN ('queued','running') ORDER BY turn_no", [sessionId]); }
  cursor(sessionId, consumerId) { return this.db.get('SELECT revision,cursor FROM assist_event_cursors WHERE session_id=? AND consumer_id=?', [sessionId, consumerId]); }
  snapshot(snapshotId) { return this.db.get('SELECT * FROM assist_turn_snapshots WHERE id=?', [snapshotId]); }
  inputSnapshot(turnId, attempt) { return this.db.get('SELECT input_cas_hash,input_cas_path FROM assist_turn_snapshots WHERE turn_id=? AND attempt=? ORDER BY revision LIMIT 1', [turnId, attempt]); }

  createSession({ sessionId, snapshotId, projectId, target, snapshot, compatibility, contextPack, timestamp, snapshotStatement, audit }) {
    return this.db.transaction([
      { sql: 'INSERT INTO assist_sessions(id,project_id,scope,scope_id,snapshot_json,status,created_at,updated_at,revision,compatibility,snapshot_hash,context_pack_id,context_pack_hash,head_snapshot_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [sessionId, projectId, target.scope, target.scope_id, asJson(snapshot), 'active', timestamp, timestamp, 1, compatibility, hashJson(snapshot), contextPack?.id || null, contextPack?.pack_hash || '', snapshotId] },
      snapshotStatement,
      { sql: 'INSERT INTO assist_session_heads(session_id,snapshot_id,revision,status,updated_at) VALUES(?,?,?,?,?)', params: [sessionId, snapshotId, 1, 'active', timestamp] },
      { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [sessionId, null, 'assist.session.created', asJson({ scope: target.scope, scope_hash: target.hash }), timestamp] }, audit
    ]);
  }

  createNativeTurn({ turnId, session, turnNo, goal, plan, message, timestamp, inputHash, operationId, snapshotId, snapshotStatement, sessionSnapshotId, sessionSnapshotStatement, audit }) {
    return this.db.transaction([
      { sql: 'INSERT INTO assist_turns(id,session_id,turn_no,status,goal_json,plan_json,created_at,updated_at,revision,attempt,compatibility,input_hash,context_pack_id,context_pack_hash,operation_id,head_snapshot_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [turnId, session.id, turnNo, 'queued', asJson(goal), asJson(plan), timestamp, timestamp, 1, 1, 'native_v6', inputHash, session.context_pack_id, session.context_pack_hash, operationId, snapshotId] },
      { sql: 'INSERT INTO assist_messages(id,turn_id,role,content,attempt,sequence_no,created_at) VALUES(?,?,?,?,?,?,?)', params: [id('ams'), turnId, 'user', message, 1, 1, timestamp] }, snapshotStatement,
      { sql: 'INSERT INTO assist_turn_heads(turn_id,snapshot_id,revision,status,updated_at) VALUES(?,?,?,?,?)', params: [turnId, snapshotId, 1, 'queued', timestamp] },
      { sql: 'INSERT INTO assist_operation_links(id,turn_id,attempt,operation_id,created_at) VALUES(?,?,?,?,?)', params: [id('aol'), turnId, 1, operationId, timestamp] },
      { sql: 'UPDATE assist_sessions SET revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [timestamp, session.id, session.revision], expect_changes: 1 }, sessionSnapshotStatement,
      { sql: 'UPDATE assist_session_heads SET snapshot_id=?,revision=?,updated_at=? WHERE session_id=? AND revision=?', params: [sessionSnapshotId, Number(session.revision) + 1, timestamp, session.id, session.revision], expect_changes: 1 },
      { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [session.id, turnId, 'assist.turn.queued', asJson({ turn_no: turnNo, attempt: 1, input_hash: inputHash }), timestamp] }, audit
    ]);
  }

  retryTurn({ turn, turnId, attempt, revision, operationId, snapshotId, inputHash, inputCas, message, goal, plan, timestamp, snapshotStatement }) {
    return this.db.transaction([
      { sql: 'UPDATE assist_turns SET status=?,attempt=?,revision=?,operation_id=?,head_snapshot_id=?,input_hash=?,goal_json=?,plan_json=?,updated_at=? WHERE id=? AND revision=?', params: ['queued', attempt, revision, operationId, snapshotId, inputHash, asJson(goal), asJson(plan), timestamp, turnId, turn.revision], expect_changes: 1 },
      { sql: 'INSERT INTO assist_messages(id,turn_id,role,content,attempt,sequence_no,created_at) VALUES(?,?,?,?,?,?,?)', params: [id('ams'), turnId, 'user', message, attempt, 1, timestamp] }, snapshotStatement,
      { sql: 'UPDATE assist_turn_heads SET snapshot_id=?,revision=?,status=?,updated_at=? WHERE turn_id=? AND revision=?', params: [snapshotId, revision, 'queued', timestamp, turnId, turn.revision], expect_changes: 1 },
      { sql: 'INSERT INTO assist_operation_links(id,turn_id,attempt,operation_id,created_at) VALUES(?,?,?,?,?)', params: [id('aol'), turnId, attempt, operationId, timestamp] },
      { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [turn.session_id, turnId, 'assist.turn.retry', asJson({ attempt, input_hash: inputHash }), timestamp] }
    ]);
  }

  transitionSession({ session, next, action, revision, snapshotId, timestamp, snapshotStatement, audit }) { return this.db.transaction([
    { sql: 'UPDATE assist_sessions SET status=?,revision=?,updated_at=? WHERE id=? AND revision=?', params: [next, revision, timestamp, session.id, session.revision], expect_changes: 1 }, snapshotStatement,
    { sql: 'UPDATE assist_session_heads SET snapshot_id=?,revision=?,status=?,updated_at=? WHERE session_id=? AND revision=?', params: [snapshotId, revision, next, timestamp, session.id, session.revision], expect_changes: 1 },
    { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [session.id, null, `assist.session.${action}`, asJson({ from: session.status, to: next }), timestamp] }, audit
  ]); }

  completeTurn({ turn, session, previous, attempt, response, outputCas, outputHash, revision, snapshotId, timestamp, audit }) { return this.db.transaction([
    { sql: "UPDATE assist_turns SET status='completed',revision=?,head_snapshot_id=?,updated_at=? WHERE id=? AND revision=? AND status='running' AND attempt=?", params: [revision, snapshotId, timestamp, turn.id, turn.revision, attempt], expect_changes: 1 },
    { sql: 'INSERT INTO assist_messages(id,turn_id,role,content,attempt,sequence_no,created_at) VALUES(?,?,?,?,?,?,?)', params: [id('ams'), turn.id, 'assistant', response, attempt, 2, timestamp] },
    { sql: 'INSERT INTO assist_turn_snapshots(id,turn_id,attempt,revision,status,input_hash,input_cas_hash,input_cas_path,output_cas_hash,output_cas_path,goal_hash,plan_hash,context_pack_id,context_pack_hash,canonical_operation,error_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [snapshotId, turn.id, attempt, revision, 'completed', turn.input_hash, previous.input_cas_hash, previous.input_cas_path, outputCas.hash, outputCas.relative, hashJson(parseJson(turn.goal_json, {})), hashJson(parseJson(turn.plan_json, [])), session.context_pack_id, session.context_pack_hash, 'assist.turn', null, timestamp] },
    { sql: "UPDATE assist_turn_heads SET snapshot_id=?,revision=?,status='completed',updated_at=? WHERE turn_id=? AND revision=?", params: [snapshotId, revision, timestamp, turn.id, turn.revision], expect_changes: 1 },
    { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [turn.session_id, turn.id, 'assist.turn.completed', asJson({ status: 'completed', attempt, revision, output_hash: outputHash }), timestamp] }, audit
  ]); }

  appendTurn({ turn, session, previous, attempt, status, revision, snapshotId, timestamp, errorCode, outputCas }) { return this.db.transaction([
    { sql: 'UPDATE assist_turns SET status=?,revision=?,head_snapshot_id=?,updated_at=? WHERE id=? AND revision=?', params: [status, revision, snapshotId, timestamp, turn.id, turn.revision], expect_changes: 1 },
    { sql: 'INSERT INTO assist_turn_snapshots(id,turn_id,attempt,revision,status,input_hash,input_cas_hash,input_cas_path,output_cas_hash,output_cas_path,goal_hash,plan_hash,context_pack_id,context_pack_hash,canonical_operation,error_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [snapshotId, turn.id, attempt, revision, status, turn.input_hash, previous?.input_cas_hash || '', previous?.input_cas_path || '', outputCas?.hash || previous?.output_cas_hash || '', outputCas?.relative || previous?.output_cas_path || '', hashJson(parseJson(turn.goal_json, {})), hashJson(parseJson(turn.plan_json, [])), session.context_pack_id, session.context_pack_hash, 'assist.turn', errorCode, timestamp] },
    { sql: 'UPDATE assist_turn_heads SET snapshot_id=?,revision=?,status=?,updated_at=? WHERE turn_id=? AND revision=?', params: [snapshotId, revision, status, timestamp, turn.id, turn.revision], expect_changes: 1 },
    { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [turn.session_id, turn.id, `assist.turn.${status}`, asJson({ status, attempt, revision, error_code: errorCode }), timestamp] }
  ]); }
  createLegacyTurn({ session, turnId, turnNo, operationId, receipt, message, goal, plan, timestamp, snapshotId, inputHash, snapshotStatement, audit }) { return this.db.transaction([
    { sql: 'INSERT INTO assist_turns(id,session_id,turn_no,status,goal_json,plan_json,created_at,updated_at,revision,attempt,compatibility,input_hash,head_snapshot_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [turnId, session.id, turnNo, 'failed', asJson(goal), asJson(plan), timestamp, timestamp, 1, 1, 'legacy_compat', inputHash, snapshotId] },
    { sql: 'INSERT INTO assist_messages(id,turn_id,role,content,attempt,sequence_no,created_at) VALUES(?,?,?,?,?,?,?)', params: [id('ams'), turnId, 'user', message, 1, 1, timestamp] },
    { sql: 'INSERT INTO assist_operations(id,session_id,kind,status,receipt_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', params: [operationId, session.id, 'turn', 'failed', asJson(receipt), timestamp, timestamp] }, snapshotStatement,
    { sql: 'INSERT INTO assist_turn_heads(turn_id,snapshot_id,revision,status,updated_at) VALUES(?,?,?,?,?)', params: [turnId, snapshotId, 1, 'failed', timestamp] },
    { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [session.id, turnId, 'assist.turn.created', asJson({ turn_no: turnNo, operation_id: operationId }), timestamp] },
    ...(Object.keys(goal).length ? [{ sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [session.id, turnId, 'assist.goal', asJson({ hash: hashJson(goal), count: Object.keys(goal).length }), timestamp] }] : []),
    ...(plan.length ? [{ sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [session.id, turnId, 'assist.plan', asJson({ hash: hashJson(plan), count: plan.length }), timestamp] }] : []),
    { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [session.id, turnId, 'assist.message', asJson({ role: 'user', sequence_no: 1 }), timestamp] }, audit
  ]); }
  sessionSnapshotStatement({ snapshotId, sessionId, revision, status, snapshot, target, actor, timestamp }) { return {
    sql: 'INSERT INTO assist_session_snapshots(id,session_id,revision,status,scope,scope_target_hash,snapshot_json,snapshot_hash,brief_revision,workflow_revision,repository_sha,context_pack_id,context_pack_hash,context_pack_cas_hash,context_pack_cas_path,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    params: [snapshotId, sessionId, revision, status, target.scope, target.hash, asJson(snapshot), hashJson(snapshot), snapshot.brief_revision, snapshot.workflow_revision, snapshot.repository_sha, snapshot.context_pack_id, snapshot.context_pack_hash, snapshot.context_pack_cas_hash || '', snapshot.context_pack_cas_path || '', actor || 'local-user', timestamp]
  }; }
  turnSnapshotStatement({ snapshotId, turnId, attempt, revision, status, inputHash, inputCas, goal, plan, session, timestamp, errorCode = null }) { return {
    sql: 'INSERT INTO assist_turn_snapshots(id,turn_id,attempt,revision,status,input_hash,input_cas_hash,input_cas_path,goal_hash,plan_hash,context_pack_id,context_pack_hash,canonical_operation,error_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    params: [snapshotId, turnId, attempt, revision, status, inputHash, inputCas.hash || '', inputCas.relative || '', hashJson(goal), hashJson(plan), session.context_pack_id, session.context_pack_hash, 'assist.turn', errorCode, timestamp]
  }; }
  async turnView(turn) { return { ...turn, goal: parseJson(turn.goal_json, {}), plan: parseJson(turn.plan_json, []), messages: await this.db.query('SELECT id,role,content,attempt,sequence_no,created_at FROM assist_messages WHERE turn_id=? ORDER BY attempt,sequence_no', [turn.id]), snapshots: await this.db.query('SELECT id,attempt,revision,status,input_hash,output_cas_hash,error_code,created_at FROM assist_turn_snapshots WHERE turn_id=? ORDER BY revision', [turn.id]) }; }
  snapshots(sessionId) { return this.db.query('SELECT * FROM assist_session_snapshots WHERE session_id=? ORDER BY revision', [sessionId]); }
  events(sessionId, after = 0, limit = 1000) { return this.db.query('SELECT cursor,session_id,turn_id,type,data_json,created_at FROM assist_events WHERE session_id=? AND cursor>? ORDER BY cursor LIMIT ?', [sessionId, Number(after) || 0, limit]).then(rows => rows.map(({ data_json: dataJson, ...row }) => ({ ...row, data: sanitizeEvent(row.type, parseJson(dataJson, {})) }))); }
  async ackCursor(sessionId, consumerId, cursor, expectedRevision = null) {
    const expected = Number(expectedRevision);
    const revision = expected + 1;
    const result = await this.db.run(`INSERT INTO assist_event_cursors(session_id,consumer_id,cursor,revision,updated_at)
      SELECT ?,?,?,1,? WHERE ?=0
      ON CONFLICT(session_id,consumer_id) DO UPDATE SET cursor=excluded.cursor,revision=assist_event_cursors.revision+1,updated_at=excluded.updated_at
      WHERE assist_event_cursors.revision=? AND excluded.cursor>=assist_event_cursors.cursor`, [sessionId, consumerId, cursor, new Date().toISOString(), expected, expected]);
    if (Number(result.changes) !== 1) return { conflict: true, current: await this.db.get('SELECT * FROM assist_event_cursors WHERE session_id=? AND consumer_id=?', [sessionId, consumerId]) };
    return { session_id: sessionId, consumer_id: consumerId, cursor, revision };
  }
}

function sanitizeEvent(type, data) {
  if (type === 'assist.goal' || type === 'assist.plan') return { hash: hashJson(data), count: Number(data?.count || (Array.isArray(data?.steps) ? data.steps.length : Object.keys(data || {}).length)) };
  const blocked = /(?:content|body|token|secret|password|authorization|path|prompt|payload)/i;
  return Object.fromEntries(Object.entries(data || {}).filter(([key]) => !blocked.test(key)).map(([key, value]) => [key, typeof value === 'object' && value !== null ? sanitizeEvent('', value) : value]));
}
