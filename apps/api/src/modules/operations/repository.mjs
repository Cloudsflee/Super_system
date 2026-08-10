import { parseJson } from '../../crypto.mjs';

export class OperationRepository {
  constructor(db) {
    this.db = db;
  }

  create(row, event) {
    return this.db.transaction([
      {
        sql: `INSERT INTO operations(
          id,kind,status,resource_type,resource_id,external_ref,result_json,error_code,actor,revision,
          created_at,updated_at,started_at,completed_at
        ) VALUES(?,?,'pending',?,?,?,'{}','',?,1,?,?,NULL,NULL)`,
        params: [row.id, row.kind, row.resourceType, row.resourceId, row.externalRef, row.actor, row.timestamp, row.timestamp]
      },
      event
    ]);
  }

  get(id) {
    return this.db.get('SELECT * FROM operations WHERE id=?', [id]).then(view);
  }

  pending() {
    return this.db.query("SELECT * FROM operations WHERE status IN ('pending','running') ORDER BY created_at,id").then((rows) => rows.map(view));
  }

  events(id, after = 0) {
    return this.db.query(`SELECT cursor,operation_id,type,data_json,created_at FROM operation_events
      WHERE operation_id=? AND cursor>? ORDER BY cursor LIMIT 500`, [id, Number(after) || 0])
      .then((rows) => rows.map(eventView));
  }

  latestCursor(id) {
    return this.db.get('SELECT COALESCE(MAX(cursor),0) AS cursor FROM operation_events WHERE operation_id=?', [id])
      .then((row) => Number(row?.cursor || 0));
  }

  transition({ id, fromStatuses, status, timestamp, result = {}, errorCode = '', eventType, eventData = {}, completed = false }) {
    const placeholders = fromStatuses.map(() => '?').join(',');
    return this.db.transaction([
      {
        sql: `UPDATE operations SET status=?,result_json=?,error_code=?,revision=revision+1,updated_at=?,
          started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END,
          completed_at=CASE WHEN ?=1 THEN ? ELSE completed_at END
          WHERE id=? AND status IN (${placeholders})`,
        params: [status, JSON.stringify(result || {}), errorCode, timestamp, status, timestamp, completed ? 1 : 0, timestamp, id, ...fromStatuses],
        expect_changes: 1
      },
      operationEvent(id, eventType, eventData, timestamp)
    ]);
  }

  appendEvent(id, type, data, timestamp) {
    return this.db.run(operationEvent(id, type, data, timestamp).sql, operationEvent(id, type, data, timestamp).params);
  }

  setExternalRef(id, externalRef, timestamp) {
    return this.db.run("UPDATE operations SET external_ref=?,revision=revision+1,updated_at=? WHERE id=? AND status IN ('pending','running')", [externalRef, timestamp, id]);
  }

  cancel({ id, expectedRevision, timestamp }) {
    return this.db.transaction([
      {
        sql: `UPDATE operations SET status='cancelled',revision=revision+1,updated_at=?,completed_at=?
          WHERE id=? AND revision=? AND status IN ('pending','running')`,
        params: [timestamp, timestamp, id, expectedRevision],
        expect_changes: 1
      },
      operationEvent(id, 'operation.cancelled', { status: 'cancelled' }, timestamp)
    ]);
  }
}

export function operationEvent(operationId, type, data, timestamp) {
  return {
    sql: 'INSERT INTO operation_events(operation_id,type,data_json,created_at) VALUES(?,?,?,?)',
    params: [operationId, type, JSON.stringify(data || {}), timestamp]
  };
}

function view(row) {
  if (!row) return null;
  const { result_json: resultJson, ...record } = row;
  return { ...record, result: parseJson(resultJson, {}) };
}

function eventView(row) {
  const { data_json: dataJson, ...event } = row;
  return { ...event, data: parseJson(dataJson, {}) };
}
