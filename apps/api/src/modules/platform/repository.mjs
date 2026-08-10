import { id, now } from '../../crypto.mjs';

export function auditStatement(action, entityType, entityId, payload, actor = 'usr_local_owner', timestamp = now()) {
  return {
    sql: 'INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)',
    params: [id('aud'), actor, action, entityType, entityId, JSON.stringify(payload || {}), timestamp]
  };
}
