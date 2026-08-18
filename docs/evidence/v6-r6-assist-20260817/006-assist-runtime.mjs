/* R6 Assist runtime: additive, immutable snapshots and durable cursors. */
export const ASSIST_RUNTIME_V6_SQL = `
ALTER TABLE assist_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE assist_sessions ADD COLUMN compatibility TEXT NOT NULL DEFAULT 'legacy_compat' CHECK(compatibility IN ('legacy_compat','native_v6'));
ALTER TABLE assist_sessions ADD COLUMN snapshot_hash TEXT NOT NULL DEFAULT '' CHECK(snapshot_hash='' OR length(snapshot_hash)=64);
ALTER TABLE assist_sessions ADD COLUMN context_pack_id TEXT REFERENCES context_packs(id) ON DELETE RESTRICT;
ALTER TABLE assist_sessions ADD COLUMN context_pack_hash TEXT NOT NULL DEFAULT '' CHECK(context_pack_hash='' OR length(context_pack_hash)=64);
ALTER TABLE assist_sessions ADD COLUMN head_snapshot_id TEXT;
ALTER TABLE assist_turns ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE assist_turns ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0);
ALTER TABLE assist_turns ADD COLUMN compatibility TEXT NOT NULL DEFAULT 'legacy_compat' CHECK(compatibility IN ('legacy_compat','native_v6'));
ALTER TABLE assist_turns ADD COLUMN input_hash TEXT NOT NULL DEFAULT '' CHECK(input_hash='' OR length(input_hash)=64);
ALTER TABLE assist_turns ADD COLUMN context_pack_id TEXT REFERENCES context_packs(id) ON DELETE RESTRICT;
ALTER TABLE assist_turns ADD COLUMN context_pack_hash TEXT NOT NULL DEFAULT '' CHECK(context_pack_hash='' OR length(context_pack_hash)=64);
ALTER TABLE assist_turns ADD COLUMN operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT;
ALTER TABLE assist_turns ADD COLUMN head_snapshot_id TEXT;
ALTER TABLE assist_messages RENAME TO assist_messages_v5;
CREATE TABLE assist_messages (
 id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES assist_turns(id) ON DELETE RESTRICT,
 role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')), content TEXT NOT NULL,
 attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0), sequence_no INTEGER NOT NULL CHECK(sequence_no > 0),
 created_at TEXT NOT NULL, UNIQUE(turn_id,attempt,sequence_no)
) STRICT;
INSERT INTO assist_messages(id,turn_id,role,content,attempt,sequence_no,created_at)
SELECT id,turn_id,role,content,1,sequence_no,created_at FROM assist_messages_v5;
DROP TABLE assist_messages_v5;
CREATE TABLE IF NOT EXISTS assist_session_snapshots (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES assist_sessions(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL CHECK(revision > 0), status TEXT NOT NULL CHECK(status IN ('active','paused','cancelled','completed')),
 scope TEXT NOT NULL, scope_target_hash TEXT NOT NULL CHECK(length(scope_target_hash)=64),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
 brief_revision INTEGER, workflow_revision INTEGER, repository_sha TEXT NOT NULL DEFAULT '', context_pack_id TEXT REFERENCES context_packs(id) ON DELETE RESTRICT,
 context_pack_hash TEXT NOT NULL DEFAULT '', context_pack_cas_hash TEXT NOT NULL DEFAULT '' CHECK(context_pack_cas_hash='' OR length(context_pack_cas_hash)=64),
 context_pack_cas_path TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT 'local-user', created_at TEXT NOT NULL, UNIQUE(session_id,revision),
 CHECK((context_pack_cas_hash='' AND context_pack_cas_path='') OR (context_pack_cas_hash<>'' AND context_pack_cas_path='sha256/' || substr(context_pack_cas_hash,1,2) || '/' || context_pack_cas_hash))
) STRICT;
CREATE TABLE IF NOT EXISTS assist_turn_snapshots (
 id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES assist_turns(id) ON DELETE RESTRICT, attempt INTEGER NOT NULL CHECK(attempt > 0),
 revision INTEGER NOT NULL CHECK(revision > 0), status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')), input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
 input_cas_hash TEXT NOT NULL DEFAULT '' CHECK(input_cas_hash='' OR length(input_cas_hash)=64), input_cas_path TEXT NOT NULL DEFAULT '',
 output_cas_hash TEXT NOT NULL DEFAULT '' CHECK(output_cas_hash='' OR length(output_cas_hash)=64), output_cas_path TEXT NOT NULL DEFAULT '', goal_hash TEXT NOT NULL DEFAULT '', plan_hash TEXT NOT NULL DEFAULT '',
 context_pack_id TEXT REFERENCES context_packs(id) ON DELETE RESTRICT, context_pack_hash TEXT NOT NULL DEFAULT '', canonical_operation TEXT NOT NULL DEFAULT 'assist.turn', error_code TEXT, created_at TEXT NOT NULL, UNIQUE(turn_id,attempt,revision)
 ,CHECK((input_cas_hash='' AND input_cas_path='') OR (input_cas_hash<>'' AND input_cas_path='sha256/' || substr(input_cas_hash,1,2) || '/' || input_cas_hash))
 ,CHECK((output_cas_hash='' AND output_cas_path='') OR (output_cas_hash<>'' AND output_cas_path='sha256/' || substr(output_cas_hash,1,2) || '/' || output_cas_hash))
) STRICT;
CREATE TABLE IF NOT EXISTS assist_session_heads (session_id TEXT PRIMARY KEY REFERENCES assist_sessions(id) ON DELETE RESTRICT, snapshot_id TEXT NOT NULL REFERENCES assist_session_snapshots(id) ON DELETE RESTRICT, revision INTEGER NOT NULL CHECK(revision > 0), status TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS assist_turn_heads (turn_id TEXT PRIMARY KEY REFERENCES assist_turns(id) ON DELETE RESTRICT, snapshot_id TEXT NOT NULL REFERENCES assist_turn_snapshots(id) ON DELETE RESTRICT, revision INTEGER NOT NULL CHECK(revision > 0), status TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS assist_operation_links (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES assist_turns(id) ON DELETE RESTRICT, attempt INTEGER NOT NULL CHECK(attempt > 0), operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT, operation_event_cursor INTEGER NOT NULL DEFAULT 0 CHECK(operation_event_cursor >= 0), created_at TEXT NOT NULL, UNIQUE(turn_id,attempt)) STRICT;
CREATE TABLE IF NOT EXISTS assist_event_cursors (session_id TEXT NOT NULL REFERENCES assist_sessions(id) ON DELETE RESTRICT, consumer_id TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), updated_at TEXT NOT NULL, PRIMARY KEY(session_id,consumer_id)) STRICT;
CREATE INDEX IF NOT EXISTS idx_assist_session_snapshots_session ON assist_session_snapshots(session_id,revision DESC);
CREATE INDEX IF NOT EXISTS idx_assist_turn_snapshots_turn ON assist_turn_snapshots(turn_id,attempt DESC);
CREATE INDEX IF NOT EXISTS idx_assist_event_cursors_session ON assist_event_cursors(session_id,cursor);
CREATE INDEX IF NOT EXISTS idx_assist_sessions_revision ON assist_sessions(id,revision);
CREATE INDEX IF NOT EXISTS idx_assist_turns_revision ON assist_turns(id,revision);
CREATE TRIGGER IF NOT EXISTS immutable_assist_session_snapshots_update BEFORE UPDATE ON assist_session_snapshots BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_session_snapshots_delete BEFORE DELETE ON assist_session_snapshots BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_turn_snapshots_update BEFORE UPDATE ON assist_turn_snapshots BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_turn_snapshots_delete BEFORE DELETE ON assist_turn_snapshots BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_operation_links_update BEFORE UPDATE ON assist_operation_links BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assist_operation_links_delete BEFORE DELETE ON assist_operation_links BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS monotonic_assist_event_cursor BEFORE UPDATE OF cursor ON assist_event_cursors WHEN NEW.cursor < OLD.cursor BEGIN SELECT RAISE(ABORT,'cursor_regression'); END;
CREATE TRIGGER IF NOT EXISTS validate_assist_session_head_insert BEFORE INSERT ON assist_session_heads
WHEN NOT EXISTS (SELECT 1 FROM assist_session_snapshots s WHERE s.id=NEW.snapshot_id AND s.session_id=NEW.session_id AND s.revision=NEW.revision AND s.status=NEW.status)
BEGIN SELECT RAISE(ABORT,'assist_session_head_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS validate_assist_session_head_update BEFORE UPDATE ON assist_session_heads
WHEN NEW.revision<=OLD.revision OR NOT EXISTS (SELECT 1 FROM assist_session_snapshots s WHERE s.id=NEW.snapshot_id AND s.session_id=NEW.session_id AND s.revision=NEW.revision AND s.status=NEW.status)
BEGIN SELECT RAISE(ABORT,'assist_session_head_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS validate_assist_turn_head_insert BEFORE INSERT ON assist_turn_heads
WHEN NOT EXISTS (SELECT 1 FROM assist_turn_snapshots s WHERE s.id=NEW.snapshot_id AND s.turn_id=NEW.turn_id AND s.revision=NEW.revision AND s.status=NEW.status)
BEGIN SELECT RAISE(ABORT,'assist_turn_head_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS validate_assist_turn_head_update BEFORE UPDATE ON assist_turn_heads
WHEN NEW.revision<=OLD.revision OR NOT EXISTS (SELECT 1 FROM assist_turn_snapshots s WHERE s.id=NEW.snapshot_id AND s.turn_id=NEW.turn_id AND s.revision=NEW.revision AND s.status=NEW.status)
BEGIN SELECT RAISE(ABORT,'assist_turn_head_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS validate_assist_session_transition BEFORE UPDATE OF status ON assist_sessions
WHEN NEW.status<>OLD.status AND NOT ((OLD.status='active' AND NEW.status IN ('paused','cancelled','completed')) OR (OLD.status='paused' AND NEW.status IN ('active','cancelled','completed')))
BEGIN SELECT RAISE(ABORT,'assist_session_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS validate_assist_turn_transition BEFORE UPDATE OF status ON assist_turns
WHEN NEW.status<>OLD.status AND NOT ((OLD.status='queued' AND NEW.status IN ('running','failed','cancelled')) OR (OLD.status='running' AND NEW.status IN ('completed','failed','cancelled')) OR (OLD.status IN ('completed','failed','cancelled') AND NEW.status='queued' AND NEW.attempt=OLD.attempt+1))
BEGIN SELECT RAISE(ABORT,'assist_turn_transition_invalid'); END;
UPDATE assist_sessions SET compatibility='legacy_compat' WHERE compatibility='';
UPDATE assist_turns SET compatibility='legacy_compat' WHERE compatibility='';

/* Every v5 row receives a deterministic revision-1 immutable snapshot/head. */
UPDATE assist_sessions SET
 snapshot_hash=aiws_canonical_hash(snapshot_json),
 head_snapshot_id='ass_legacy_' || substr(aiws_sha256(id),1,24)
WHERE head_snapshot_id IS NULL;
INSERT INTO assist_session_snapshots(id,session_id,revision,status,scope,scope_target_hash,snapshot_json,snapshot_hash,brief_revision,workflow_revision,repository_sha,context_pack_id,context_pack_hash,context_pack_cas_hash,context_pack_cas_path,actor,created_at)
SELECT s.head_snapshot_id,s.id,1,s.status,s.scope,
 aiws_canonical_hash(json_object('project_id',s.project_id,'scope',s.scope,'scope_id',s.scope_id)),
 s.snapshot_json,s.snapshot_hash,
 json_extract(s.snapshot_json,'$.brief_revision'),json_extract(s.snapshot_json,'$.workflow_revision'),COALESCE(json_extract(s.snapshot_json,'$.repository_sha'),''),
 CASE WHEN EXISTS (SELECT 1 FROM context_packs p WHERE p.id=json_extract(s.snapshot_json,'$.context_pack_id')) THEN json_extract(s.snapshot_json,'$.context_pack_id') ELSE NULL END,
 CASE WHEN length(COALESCE(json_extract(s.snapshot_json,'$.context_pack_hash'),''))=64 THEN json_extract(s.snapshot_json,'$.context_pack_hash') ELSE '' END,
 CASE WHEN length(COALESCE(json_extract(s.snapshot_json,'$.context_pack_cas_hash'),''))=64 THEN json_extract(s.snapshot_json,'$.context_pack_cas_hash') ELSE '' END,
 CASE WHEN length(COALESCE(json_extract(s.snapshot_json,'$.context_pack_cas_hash'),''))=64 THEN 'sha256/' || substr(json_extract(s.snapshot_json,'$.context_pack_cas_hash'),1,2) || '/' || json_extract(s.snapshot_json,'$.context_pack_cas_hash') ELSE '' END,
 'migration-v6',s.created_at
FROM assist_sessions s;
INSERT INTO assist_session_heads(session_id,snapshot_id,revision,status,updated_at)
SELECT id,head_snapshot_id,1,status,updated_at FROM assist_sessions;

UPDATE assist_turns SET
 input_hash=aiws_canonical_hash(json_object(
   'message',COALESCE((SELECT content FROM assist_messages m WHERE m.turn_id=assist_turns.id AND m.role='user' ORDER BY sequence_no LIMIT 1),''),
   'goal',json(goal_json),'plan',json(plan_json))),
 head_snapshot_id='ats_legacy_' || substr(aiws_sha256(id),1,24)
WHERE head_snapshot_id IS NULL;
INSERT INTO assist_turn_snapshots(id,turn_id,attempt,revision,status,input_hash,goal_hash,plan_hash,canonical_operation,error_code,created_at)
SELECT t.head_snapshot_id,t.id,1,1,t.status,t.input_hash,aiws_canonical_hash(t.goal_json),aiws_canonical_hash(t.plan_json),'assist.turn',
 CASE WHEN t.status='failed' THEN 'legacy_failure' ELSE NULL END,t.created_at
FROM assist_turns t;
INSERT INTO assist_turn_heads(turn_id,snapshot_id,revision,status,updated_at)
SELECT id,head_snapshot_id,1,status,updated_at FROM assist_turns;

INSERT INTO assist_operation_links(id,turn_id,attempt,operation_id,operation_event_cursor,created_at)
SELECT 'aol_legacy_' || substr(aiws_sha256(t.id || ':' || o.id),1,24),t.id,1,o.id,0,t.created_at
FROM assist_turns t JOIN assist_operations old ON old.session_id=t.session_id AND json_extract(old.receipt_json,'$.turn_id')=t.id JOIN operations o ON o.id=old.id
WHERE old.kind='turn';
`;
export const ASSIST_RUNTIME_V6 = Object.freeze({ version: 6, name: 'assist_runtime', sql: ASSIST_RUNTIME_V6_SQL });
