export class IdentityRepository {
  constructor(db) {
    this.db = db;
  }

  initializeOwner(timestamp) {
    return this.db.run(`INSERT OR IGNORE INTO users(
      id,display_name,status,revision,created_at,updated_at,locale,timezone
    ) VALUES('usr_local_owner','Local owner','active',1,?,?,?,?)`, [timestamp, timestamp, 'zh-CN', 'Asia/Shanghai']);
  }

  owner() {
    return this.db.get(`SELECT id,display_name,status,revision,created_at,updated_at,locale,timezone
      FROM users WHERE id='usr_local_owner'`);
  }

  updateOwner({ displayName, locale, timezone, expectedRevision, timestamp, audit }) {
    return this.db.transaction([
      {
        sql: `UPDATE users SET display_name=?,locale=?,timezone=?,revision=revision+1,updated_at=?
          WHERE id='usr_local_owner' AND revision=?`,
        params: [displayName, locale, timezone, timestamp, expectedRevision],
        expect_changes: 1
      },
      audit
    ]);
  }

  insertSession({ id, tokenHash, expiresAt, timestamp, audit }) {
    return this.db.transaction([
      {
        sql: `INSERT INTO sessions(
          id,user_id,token_hash,expires_at,last_seen_at,revoked_at,revision,created_at,updated_at
        ) VALUES(?,'usr_local_owner',?,?,?,?,1,?,?)`,
        params: [id, tokenHash, expiresAt, timestamp, null, timestamp, timestamp]
      },
      audit
    ]);
  }

  sessions() {
    return this.db.query(`SELECT id,user_id,expires_at,last_seen_at,revoked_at,revision,created_at,updated_at
      FROM sessions WHERE user_id='usr_local_owner' ORDER BY created_at DESC,id`);
  }

  sessionByHash(tokenHash) {
    return this.db.get(`SELECT s.id,s.user_id,s.expires_at,s.last_seen_at,s.revoked_at,s.revision,
      u.status AS user_status,u.display_name
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`, [tokenHash]);
  }

  touchSession(id, timestamp) {
    return this.db.run('UPDATE sessions SET last_seen_at=?,updated_at=? WHERE id=?', [timestamp, timestamp, id]);
  }

  session(id) {
    return this.db.get(`SELECT id,user_id,expires_at,last_seen_at,revoked_at,revision,created_at,updated_at
      FROM sessions WHERE id=? AND user_id='usr_local_owner'`, [id]);
  }

  revokeSession({ id, expectedRevision, timestamp, audit }) {
    return this.db.transaction([
      {
        sql: `UPDATE sessions SET revoked_at=COALESCE(revoked_at,?),revision=revision+1,updated_at=?
          WHERE id=? AND revision=?`,
        params: [timestamp, timestamp, id, expectedRevision],
        expect_changes: 1
      },
      audit
    ]);
  }
}
