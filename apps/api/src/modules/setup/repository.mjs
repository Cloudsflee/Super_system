import { parseJson } from '../../crypto.mjs';
import { auditStatement } from '../platform/repository.mjs';

const SETUP_ID = 'setup_owner';

export class SetupRepository {
  constructor(db) {
    this.db = db;
  }

  initialize(timestamp) {
    return this.db.run(`INSERT OR IGNORE INTO setup_states(
      id,user_id,state,checks_json,revision,updated_at,completed_at,created_at
    ) VALUES(?,'usr_local_owner','blocked','{}',1,?,NULL,?)`, [SETUP_ID, timestamp, timestamp]);
  }

  setup() {
    return this.db.get('SELECT * FROM setup_states WHERE id=?', [SETUP_ID]).then(setupView);
  }

  setupEvents(after = 0) {
    return this.db.query(`SELECT cursor,setup_id,type,data_json,created_at FROM setup_events
      WHERE setup_id=? AND cursor>? ORDER BY cursor LIMIT 500`, [SETUP_ID, Number(after) || 0])
      .then((rows) => rows.map(eventView));
  }

  discoverySources() {
    return this.db.query(`SELECT id,source_type,display_name,source_key,source_revision,status,records_json,
      scanned_at,revision FROM codex_discovery_sources ORDER BY display_name,id`)
      .then((rows) => rows.map(discoverySourceView));
  }

  discoverySource(id) {
    return this.db.get(`SELECT id,source_type,display_name,source_key,source_revision,status,records_json,
      scanned_at,revision FROM codex_discovery_sources WHERE id=?`, [id]).then(discoverySourceView);
  }

  upsertDiscoverySource(row) {
    return this.db.transaction([
      {
        sql: `INSERT INTO codex_discovery_sources(
          id,source_type,display_name,source_key,source_revision,status,records_json,scanned_at,revision
        ) VALUES(?,?,?,?,?,?,?,?,1)
        ON CONFLICT(source_key) DO UPDATE SET display_name=excluded.display_name,
          source_revision=excluded.source_revision,status=excluded.status,records_json=excluded.records_json,
          scanned_at=excluded.scanned_at,revision=codex_discovery_sources.revision+1`,
        params: [row.id, row.sourceType, row.displayName, row.sourceKey, row.sourceRevision, row.status, JSON.stringify(row.records || []), row.timestamp]
      },
      setupEvent('codex.discovery.scanned', { source_id: row.id, status: row.status, source_revision: row.sourceRevision }, row.timestamp)
    ]);
  }

  completeSetup({ expectedRevision, checks, timestamp, actor }) {
    return this.db.transaction([
      {
        sql: `UPDATE setup_states SET state='ready',checks_json=?,completed_at=?,revision=revision+1,updated_at=?
          WHERE id=? AND revision=?`,
        params: [JSON.stringify(checks), timestamp, timestamp, SETUP_ID, expectedRevision],
        expect_changes: 1
      },
      setupEvent('setup.completed', { checks }, timestamp),
      auditStatement('setup.completed', 'setup', SETUP_ID, { expected_revision: expectedRevision }, actor, timestamp)
    ]);
  }

  upsertBootstrapCredential(row) {
    return this.db.run(`INSERT OR IGNORE INTO credential_refs(
      id,provider,label,secret_ref,expires_at,created_at,kind,origin,status,revision,secret_version,
      rotated_at,revoked_at,updated_at
    ) VALUES(?,?,?,?,NULL,?,?,?,'active',1,1,NULL,NULL,?)`, [
      row.id, row.provider, row.label, row.secretRef, row.timestamp, row.kind, 'secret_bundle', row.timestamp
    ]);
  }

  async expireCredentials(timestamp) {
    const expired = await this.db.query(`SELECT id,secret_ref FROM credential_refs
      WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=?`, [timestamp]);
    if (!expired.length) return [];
    await this.db.transaction([
      { sql: `UPDATE credential_refs SET status='expired',revision=revision+1,updated_at=?
        WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=?`, params: [timestamp, timestamp] },
      { sql: `UPDATE codex_profiles SET status='unprobed',probe_status='unknown',probe_hash='',probe_json='{}',updated_at=?
        WHERE credential_ref IN (SELECT id FROM credential_refs WHERE status='expired')`, params: [timestamp] },
      { sql: `UPDATE github_app_configs SET status='blocked',probe_status='unknown',probe_hash='',probe_json='{}',updated_at=?
        WHERE private_key_ref IN (SELECT id FROM credential_refs WHERE status='expired')
           OR webhook_secret_ref IN (SELECT id FROM credential_refs WHERE status='expired')`, params: [timestamp] },
      ...invalidate('credential.expired', { credential_ids: expired.map((row) => row.id) }, timestamp)
    ]);
    return expired;
  }

  credentials() {
    return this.db.query(`SELECT id,provider,label,expires_at,created_at,kind,origin,status,revision,
      secret_version,rotated_at,revoked_at,updated_at FROM credential_refs ORDER BY created_at DESC,id`);
  }

  credential(id) {
    return this.db.get('SELECT * FROM credential_refs WHERE id=?', [id]);
  }

  credentialBySecretRef(secretRef) {
    return this.db.get('SELECT * FROM credential_refs WHERE secret_ref=?', [secretRef]);
  }

  referencedVaultFiles() {
    return this.db.query(`SELECT secret_ref FROM credential_refs
      WHERE secret_ref LIKE 'vault:%' AND status IN ('pending','active')`)
      .then((rows) => new Set(rows.map((row) => String(row.secret_ref).slice('vault:'.length))));
  }

  createCredential(row, actor) {
    return this.db.transaction([
      {
        sql: `INSERT INTO credential_refs(
          id,provider,label,secret_ref,expires_at,created_at,kind,origin,status,revision,secret_version,
          rotated_at,revoked_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,1,?,NULL,NULL,?)`,
        params: [row.id, row.provider, row.label, row.secretRef, row.expiresAt, row.timestamp, row.kind, row.origin, row.status, row.secretVersion, row.timestamp]
      },
      ...invalidate('credential.created', { credential_id: row.id, kind: row.kind }, row.timestamp),
      auditStatement('credential.created', 'credential', row.id, { kind: row.kind, origin: row.origin, label: row.label }, actor, row.timestamp)
    ]);
  }

  rotateCredential(row, expectedRevision, actor) {
    return this.db.transaction([
      {
        sql: `UPDATE credential_refs SET secret_ref=?,secret_version=?,revision=revision+1,rotated_at=?,updated_at=?
          WHERE id=? AND revision=? AND status='active' AND origin='vault'`,
        params: [row.secretRef, row.secretVersion, row.timestamp, row.timestamp, row.id, expectedRevision],
        expect_changes: 1
      },
      ...(row.profileUpdates || []).map((profile) => ({
        sql: `UPDATE codex_profiles SET status='unprobed',probe_status='unknown',probe_hash='',probe_json='{}',
          credential_revision=?,config_hash=?,updated_at=? WHERE id=? AND revision=? AND credential_ref=?`,
        params: [row.credentialRevision, profile.configHash, row.timestamp, profile.id, profile.revision, row.id],
        expect_changes: 1
      })),
      staleAppsForCredential(row.id, 'unverified', row.timestamp),
      ...invalidate('credential.rotated', { credential_id: row.id, secret_version: row.secretVersion }, row.timestamp),
      auditStatement('credential.rotated', 'credential', row.id, { expected_revision: expectedRevision, secret_version: row.secretVersion }, actor, row.timestamp)
    ]);
  }

  activatePendingCredential(row, expectedRevision, actor) {
    return this.db.transaction([
      {
        sql: `UPDATE credential_refs SET secret_ref=?,secret_version=?,status='active',revision=revision+1,updated_at=?
          WHERE id=? AND revision=? AND status='pending' AND origin IN ('device_auth','discovery')`,
        params: [row.secretRef, row.secretVersion, row.timestamp, row.id, expectedRevision],
        expect_changes: 1
      },
      ...invalidate('credential.activated', { credential_id: row.id }, row.timestamp),
      auditStatement('credential.activated', 'credential', row.id, { origin: row.origin }, actor, row.timestamp)
    ]);
  }

  revokeCredential({ id, expectedRevision, timestamp, actor }) {
    return this.db.transaction([
      {
        sql: `UPDATE credential_refs SET status='revoked',revoked_at=?,revision=revision+1,updated_at=?
          WHERE id=? AND revision=? AND status IN ('pending','active','expired') AND origin<>'secret_bundle'`,
        params: [timestamp, timestamp, id, expectedRevision],
        expect_changes: 1
      },
      staleProfilesForCredential(id, null, timestamp),
      staleAppsForCredential(id, 'blocked', timestamp),
      ...invalidate('credential.revoked', { credential_id: id }, timestamp),
      auditStatement('credential.revoked', 'credential', id, { expected_revision: expectedRevision }, actor, timestamp)
    ]);
  }

  deleteCredential({ id, expectedRevision, timestamp, actor }) {
    return this.db.transaction([
      auditStatement('credential.deleted', 'credential', id, { expected_revision: expectedRevision }, actor, timestamp),
      {
        sql: `DELETE FROM credential_refs WHERE id=? AND revision=? AND origin<>'secret_bundle'`,
        params: [id, expectedRevision],
        expect_changes: 1
      },
      ...invalidate('credential.deleted', { credential_id: id }, timestamp)
    ]);
  }

  codexProfiles() {
    return this.db.query(`SELECT p.*,c.status AS credential_status,c.kind AS credential_kind,
      c.revision AS current_credential_revision,c.expires_at AS credential_expires_at
      FROM codex_profiles p JOIN credential_refs c ON c.id=p.credential_ref
      ORDER BY p.is_active DESC,p.created_at DESC,p.id`).then((rows) => rows.map(profileView));
  }

  codexProfile(id) {
    return this.db.get(`SELECT p.*,c.status AS credential_status,c.kind AS credential_kind,
      c.revision AS current_credential_revision,c.expires_at AS credential_expires_at,c.secret_ref
      FROM codex_profiles p JOIN credential_refs c ON c.id=p.credential_ref WHERE p.id=?`, [id]).then(profileView);
  }

  activeCodexProfile() {
    return this.db.get(`SELECT p.*,c.status AS credential_status,c.kind AS credential_kind,
      c.revision AS current_credential_revision,c.expires_at AS credential_expires_at,c.secret_ref
      FROM codex_profiles p JOIN credential_refs c ON c.id=p.credential_ref
      WHERE p.user_id='usr_local_owner' AND p.is_active=1`).then(profileView);
  }

  createCodexProfile(row, actor) {
    const statements = [];
    if (row.active) statements.push({ sql: "UPDATE codex_profiles SET is_active=0,updated_at=? WHERE user_id='usr_local_owner' AND is_active=1", params: [row.timestamp] });
    statements.push({
      sql: `INSERT INTO codex_profiles(
        id,user_id,label,provider,model,base_url,wire_api,reasoning,timeout_ms,credential_ref,status,revision,
        created_at,updated_at,is_active,auth_kind,credential_revision,config_hash,runner_digest,
        probe_status,probe_hash,probe_revision,probed_at,probe_json
      ) VALUES(?,'usr_local_owner',?,?,?,?,?,?,?,?,'unprobed',1,?,?,?,?,?,?,?,'unknown','',0,NULL,'{}')`,
      params: [row.id, row.label, row.provider, row.model, row.baseUrl, row.wireApi, row.reasoning, row.timeoutMs,
        row.credentialId, row.timestamp, row.timestamp, row.active ? 1 : 0, row.authKind, row.credentialRevision,
        row.configHash, row.runnerDigest]
    });
    statements.push(...invalidate('codex_profile.created', { profile_id: row.id }, row.timestamp));
    statements.push(auditStatement('codex_profile.created', 'codex_profile', row.id, { provider: row.provider, model: row.model }, actor, row.timestamp));
    return this.db.transaction(statements);
  }

  updateCodexProfile(row, expectedRevision, actor) {
    return this.db.transaction([
      {
        sql: `UPDATE codex_profiles SET label=?,provider=?,model=?,base_url=?,wire_api=?,reasoning=?,timeout_ms=?,
          credential_ref=?,status='unprobed',revision=revision+1,updated_at=?,auth_kind=?,credential_revision=?,
          config_hash=?,runner_digest=?,probe_status='unknown',probe_hash='',probe_json='{}',probed_at=NULL
          WHERE id=? AND revision=?`,
        params: [row.label, row.provider, row.model, row.baseUrl, row.wireApi, row.reasoning, row.timeoutMs,
          row.credentialId, row.timestamp, row.authKind, row.credentialRevision, row.configHash, row.runnerDigest,
          row.id, expectedRevision],
        expect_changes: 1
      },
      ...invalidate('codex_profile.updated', { profile_id: row.id }, row.timestamp),
      auditStatement('codex_profile.updated', 'codex_profile', row.id, { expected_revision: expectedRevision }, actor, row.timestamp)
    ]);
  }

  activateCodexProfile({ id, expectedRevision, timestamp, actor }) {
    return this.db.transaction([
      { sql: "UPDATE codex_profiles SET is_active=0,updated_at=? WHERE user_id='usr_local_owner' AND is_active=1 AND id<>?", params: [timestamp, id] },
      {
        sql: `UPDATE codex_profiles SET is_active=1,revision=revision+1,updated_at=?,probe_status='unknown',probe_hash='',probe_json='{}'
          WHERE id=? AND revision=?`,
        params: [timestamp, id, expectedRevision],
        expect_changes: 1
      },
      ...invalidate('codex_profile.activated', { profile_id: id }, timestamp),
      auditStatement('codex_profile.activated', 'codex_profile', id, { expected_revision: expectedRevision }, actor, timestamp)
    ]);
  }

  startCodexProbe({ id, expectedRevision, timestamp }) {
    return this.db.transaction([
      {
        sql: `UPDATE codex_profiles SET probe_status='running',probe_hash='',probe_json='{}',updated_at=?
          WHERE id=? AND revision=? AND is_active=1`,
        params: [timestamp, id, expectedRevision],
        expect_changes: 1
      },
      ...invalidate('codex_probe.started', { profile_id: id }, timestamp, { clearCompletion: false })
    ]);
  }

  finishCodexProbe({ id, expectedRevision, status, probeHash, result, runnerDigest, timestamp }) {
    return this.db.transaction([
      {
        sql: `UPDATE codex_profiles SET status=?,probe_status=?,probe_hash=?,probe_revision=probe_revision+1,
          probed_at=?,probe_json=?,runner_digest=?,updated_at=? WHERE id=? AND revision=? AND is_active=1`,
        params: [status === 'available' ? 'available' : 'unavailable', status, probeHash, timestamp, JSON.stringify(result), runnerDigest, timestamp, id, expectedRevision],
        expect_changes: 1
      },
      ...invalidate('codex_probe.finished', { profile_id: id, status }, timestamp, { clearCompletion: false })
    ]);
  }

  githubApps() {
    return this.db.query(`SELECT a.*,
      pk.status AS private_key_status,pk.revision AS private_key_revision,pk.kind AS private_key_kind,
      wh.status AS webhook_status,wh.revision AS webhook_revision,wh.kind AS webhook_kind
      FROM github_app_configs a
      JOIN credential_refs pk ON pk.id=a.private_key_ref
      JOIN credential_refs wh ON wh.id=a.webhook_secret_ref
      ORDER BY a.created_at DESC,a.id`).then((rows) => rows.map(githubAppView));
  }

  githubApp(id) {
    return this.db.get(`SELECT a.*,
      pk.status AS private_key_status,pk.revision AS private_key_revision,pk.kind AS private_key_kind,pk.secret_ref AS private_key_secret_ref,
      wh.status AS webhook_status,wh.revision AS webhook_revision,wh.kind AS webhook_kind,wh.secret_ref AS webhook_secret_ref
      FROM github_app_configs a
      JOIN credential_refs pk ON pk.id=a.private_key_ref
      JOIN credential_refs wh ON wh.id=a.webhook_secret_ref WHERE a.id=?`, [id]).then(githubAppView);
  }

  createGithubApp(row, actor) {
    return this.db.transaction([
      {
        sql: `INSERT INTO github_app_configs(
          id,user_id,label,app_id,client_id,private_key_ref,webhook_secret_ref,created_at,updated_at,
          status,revision,slug,verified_at,probe_status,probe_hash,probe_revision,probed_at,probe_json
        ) VALUES(?,'usr_local_owner',?,?,?,?,?,?,?,'unverified',1,'',NULL,'unknown','',0,NULL,'{}')`,
        params: [row.id, row.label, row.appId, row.clientId, row.privateKeyId, row.webhookSecretId, row.timestamp, row.timestamp]
      },
      ...invalidate('github_app.created', { app_id: row.id }, row.timestamp),
      auditStatement('github_app.created', 'github_app', row.id, { app_id: row.appId }, actor, row.timestamp)
    ]);
  }

  verifyGithubApp({ id, expectedRevision, slug, status, probeHash, result, timestamp }) {
    return this.db.transaction([
      {
        sql: `UPDATE github_app_configs SET status=?,slug=?,verified_at=CASE WHEN ?='verified' THEN ? ELSE verified_at END,
          probe_status=?,probe_hash=?,probe_revision=probe_revision+1,probed_at=?,probe_json=?,updated_at=?
          WHERE id=? AND revision=?`,
        params: [status === 'available' ? 'verified' : 'blocked', slug, status === 'available' ? 'verified' : 'blocked', timestamp,
          status, probeHash, timestamp, JSON.stringify(result), timestamp, id, expectedRevision],
        expect_changes: 1
      },
      ...invalidate('github_probe.finished', { app_id: id, status }, timestamp, { clearCompletion: false })
    ]);
  }

  githubInstallations(appId = null) {
    const sql = `SELECT * FROM github_installations ${appId ? 'WHERE app_config_id=?' : ''} ORDER BY created_at DESC,id`;
    return this.db.query(sql, appId ? [appId] : []).then((rows) => rows.map(installationView));
  }

  githubInstallation(id) {
    return this.db.get('SELECT * FROM github_installations WHERE id=?', [id]).then(installationView);
  }

  createGithubInstallation(row, expectedAppRevision, actor) {
    return this.db.transaction([
      {
        sql: `UPDATE github_app_configs SET revision=revision+1,probe_status='unknown',probe_hash='',probe_json='{}',updated_at=?
          WHERE id=? AND revision=?`,
        params: [row.timestamp, row.appConfigId, expectedAppRevision],
        expect_changes: 1
      },
      {
        sql: `INSERT INTO github_installations(
          id,app_config_id,installation_id,account_login,permissions_json,status,created_at,updated_at,
          revision,repositories_json,last_probe_status,last_probe_at,last_probe_code
        ) VALUES(?,?,?,?,?,?,?,?,1,?,'unknown',NULL,?)`,
        params: [row.id, row.appConfigId, row.installationId, row.accountLogin, JSON.stringify(row.permissions), row.status || 'blocked', row.timestamp, row.timestamp, JSON.stringify(row.repositories || []), row.errorCode || '']
      },
      ...invalidate('github_installation.created', { installation_id: row.id }, row.timestamp),
      auditStatement('github_installation.created', 'github_installation', row.id, { github_installation_id: row.installationId }, actor, row.timestamp)
    ]);
  }

  discoverGithubInstallations({ appConfigId, expectedRevision, installations, timestamp }, actor) {
    const statements = [
      {
        sql: `UPDATE github_app_configs SET revision=revision+1,probe_status='unknown',probe_hash='',probe_json='{}',updated_at=?
          WHERE id=? AND revision=?`,
        params: [timestamp, appConfigId, expectedRevision],
        expect_changes: 1
      },
      {
        sql: `UPDATE github_installations SET status='revoked',revision=revision+1,last_probe_status='unknown',
          last_probe_code='github_installation_missing',updated_at=? WHERE app_config_id=?`,
        params: [timestamp, appConfigId]
      }
    ];
    for (const row of installations) {
      statements.push({
        sql: `INSERT INTO github_installations(
          id,app_config_id,installation_id,account_login,permissions_json,status,created_at,updated_at,
          revision,repositories_json,last_probe_status,last_probe_at,last_probe_code
        ) VALUES(?,?,?,?,?,?,?,?,1,'[]','unknown',NULL,?)
        ON CONFLICT(app_config_id,installation_id) DO UPDATE SET
          account_login=excluded.account_login,permissions_json=excluded.permissions_json,status=excluded.status,
          revision=github_installations.revision+1,last_probe_status='unknown',last_probe_at=NULL,
          last_probe_code=excluded.last_probe_code,updated_at=excluded.updated_at`,
        params: [row.id, appConfigId, row.installationId, row.accountLogin, JSON.stringify(row.permissions), row.status, timestamp, timestamp, row.errorCode || '']
      });
    }
    statements.push(...invalidate('github_installations.discovered', { app_id: appConfigId, count: installations.length }, timestamp));
    statements.push(auditStatement('github_installations.discovered', 'github_app', appConfigId, { count: installations.length, expected_revision: expectedRevision }, actor, timestamp));
    return this.db.transaction(statements);
  }

  syncGithubRepositories({ installationId, expectedRevision, repositories, status, errorCode, timestamp }, actor) {
    const statements = [
      {
        sql: `UPDATE github_installations SET repositories_json=?,status=?,revision=revision+1,
          last_probe_status=?,last_probe_at=?,last_probe_code=?,updated_at=? WHERE id=? AND revision=?`,
        params: [JSON.stringify(repositories.map(repositoryCacheView)), status, status === 'available' ? 'available' : 'unavailable', timestamp, errorCode || '', timestamp, installationId, expectedRevision],
        expect_changes: 1
      },
      {
        sql: `UPDATE github_repositories SET selected=0,revision=revision+1,updated_at=? WHERE installation_id=?`,
        params: [timestamp, installationId]
      }
    ];
    for (const row of repositories) {
      statements.push({
        sql: `INSERT INTO github_repositories(
          id,installation_id,github_id,full_name,default_branch,private,selected,permissions_json,revision,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,1,?,?)
        ON CONFLICT(installation_id,github_id) DO UPDATE SET full_name=excluded.full_name,
          default_branch=excluded.default_branch,private=excluded.private,selected=excluded.selected,
          permissions_json=excluded.permissions_json,revision=github_repositories.revision+1,updated_at=excluded.updated_at`,
        params: [row.id, installationId, row.githubId, row.fullName, row.defaultBranch, row.private ? 1 : 0, row.selected ? 1 : 0, JSON.stringify(row.permissions || {}), timestamp, timestamp]
      });
    }
    statements.push(...invalidate('github_repositories.synced', { installation_id: installationId, count: repositories.length }, timestamp));
    statements.push(auditStatement('github_repositories.synced', 'github_installation', installationId, { count: repositories.length, expected_revision: expectedRevision }, actor, timestamp));
    return this.db.transaction(statements);
  }

  githubRepositories(installationId = null) {
    const sql = `SELECT * FROM github_repositories ${installationId ? 'WHERE installation_id=?' : ''} ORDER BY full_name,id`;
    return this.db.query(sql, installationId ? [installationId] : []).then((rows) => rows.map(repositoryView));
  }

  webhookDelivery(deliveryId) {
    return this.db.get('SELECT * FROM github_webhook_deliveries WHERE delivery_id=?', [deliveryId]).then(webhookView);
  }

  insertWebhookDelivery(row) {
    return this.db.transaction([
      {
        sql: `UPDATE github_app_configs SET probe_status='unknown',probe_hash='',probe_json='{}',updated_at=?
          WHERE id=?`,
        params: [row.timestamp, row.appConfigId]
      },
      {
        sql: `UPDATE github_installations SET status=CASE WHEN ?='revoked' THEN 'revoked' ELSE status END,
          last_probe_status='unknown',last_probe_code=?,revision=revision+1,updated_at=?
          WHERE app_config_id=? AND (?='' OR installation_id=?)`,
        params: [row.installationStatus || '', row.errorCode || 'github_webhook_changed', row.timestamp, row.appConfigId, row.installationId || '', row.installationId || '']
      },
      {
        sql: `INSERT INTO github_webhook_deliveries(
          delivery_id,event_name,action,status,receipt_json,body_sha256,created_at
        ) VALUES(?,?,?,?,?,?,?)`,
        params: [row.deliveryId, row.eventName, row.action, row.status, JSON.stringify(row.receipt), row.bodySha256, row.timestamp]
      },
      ...invalidate('github.webhook', { delivery_id: row.deliveryId, event_name: row.eventName, action: row.action }, row.timestamp)
    ]);
  }
}

function invalidate(type, data, timestamp, { clearCompletion = true } = {}) {
  return [
    {
      sql: `UPDATE setup_states SET state='blocked',checks_json='{}',completed_at=CASE WHEN ?=1 THEN NULL ELSE completed_at END,
        revision=revision+1,updated_at=? WHERE id=?`,
      params: [clearCompletion ? 1 : 0, timestamp, SETUP_ID],
      expect_changes: 1
    },
    setupEvent(type, data, timestamp)
  ];
}

function staleProfilesForCredential(id, secretVersion, timestamp) {
  return {
    sql: `UPDATE codex_profiles SET status='unprobed',probe_status='unknown',probe_hash='',probe_json='{}',
      credential_revision=COALESCE(?,credential_revision),updated_at=? WHERE credential_ref=?`,
    params: [secretVersion, timestamp, id]
  };
}

function staleAppsForCredential(id, status, timestamp) {
  return {
    sql: `UPDATE github_app_configs SET status=?,probe_status='unknown',probe_hash='',probe_json='{}',updated_at=?
      WHERE private_key_ref=? OR webhook_secret_ref=?`,
    params: [status, timestamp, id, id]
  };
}

function setupEvent(type, data, timestamp) {
  return {
    sql: 'INSERT INTO setup_events(setup_id,type,data_json,created_at) VALUES(?,?,?,?)',
    params: [SETUP_ID, type, JSON.stringify(data || {}), timestamp]
  };
}

function setupView(row) {
  if (!row) return null;
  const { checks_json: checksJson, ...record } = row;
  return { ...record, checks: parseJson(checksJson, {}) };
}

function profileView(row) {
  if (!row) return null;
  const { probe_json: probeJson, ...record } = row;
  return { ...record, is_active: Boolean(record.is_active), probe: parseJson(probeJson, {}) };
}

function githubAppView(row) {
  if (!row) return null;
  const { probe_json: probeJson, ...record } = row;
  return { ...record, probe: parseJson(probeJson, {}) };
}

function installationView(row) {
  if (!row) return null;
  const { permissions_json: permissionsJson, repositories_json: repositoriesJson, ...record } = row;
  return { ...record, permissions: parseJson(permissionsJson, {}), repositories: parseJson(repositoriesJson, []) };
}

function repositoryView(row) {
  if (!row) return null;
  const { permissions_json: permissionsJson, ...record } = row;
  return { ...record, private: Boolean(record.private), selected: Boolean(record.selected), permissions: parseJson(permissionsJson, {}) };
}

function eventView(row) {
  const { data_json: dataJson, ...event } = row;
  return { ...event, data: parseJson(dataJson, {}) };
}

function discoverySourceView(row) {
  if (!row) return null;
  const { records_json: recordsJson, ...source } = row;
  return { ...source, records: parseJson(recordsJson, []) };
}

function webhookView(row) {
  if (!row) return null;
  const { receipt_json: receiptJson, ...record } = row;
  return { ...record, receipt: parseJson(receiptJson, {}) };
}

function repositoryCacheView(row) {
  return { github_id: row.githubId, full_name: row.fullName, selected: row.selected !== false };
}
