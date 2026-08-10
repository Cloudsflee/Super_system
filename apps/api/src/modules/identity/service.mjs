import { randomBytes } from 'node:crypto';
import { id, now, sha256 } from '../../crypto.mjs';
import { AppError, assert } from '../../errors.mjs';
import { auditStatement } from '../platform/repository.mjs';
import { IdentityRepository } from './repository.mjs';

const OWNER_ID = 'usr_local_owner';

export class IdentityService {
  constructor({ db, clock = now }) {
    this.repository = new IdentityRepository(db);
    this.clock = clock;
  }

  async initialize() {
    const timestamp = this.clock();
    await this.repository.initializeOwner(timestamp);
    const owner = await this.repository.owner();
    if (!owner || owner.status !== 'active') throw new Error('local_owner_unavailable');
    return owner;
  }

  account() {
    return this.repository.owner();
  }

  async updateAccount(input, ctx = {}) {
    const current = await this.repository.owner();
    if (!current) throw new AppError('not_found', 'account not found');
    const expectedRevision = revision(input);
    const displayName = String(input?.display_name ?? current.display_name).trim();
    const locale = String(input?.locale ?? current.locale).trim();
    const timezone = String(input?.timezone ?? current.timezone).trim();
    assert(displayName.length >= 1 && displayName.length <= 120, 'invalid_input', 'display_name is invalid', { status: 422 });
    assert(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale), 'invalid_input', 'locale is invalid', { status: 422 });
    assert(/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(timezone) && timezone.length <= 100, 'invalid_input', 'timezone is invalid', { status: 422 });
    try {
      const timestamp = this.clock();
      await this.repository.updateOwner({
        displayName, locale, timezone, expectedRevision, timestamp,
        audit: auditStatement('account.updated', 'account', OWNER_ID, { expected_revision: expectedRevision }, ctx.actor || OWNER_ID, timestamp)
      });
    } catch (error) {
      transactionConflict(error, current.revision);
      throw error;
    }
    return this.repository.owner();
  }

  async createSession(input = {}, ctx = {}) {
    const ttl = Number(input?.ttl_seconds ?? 30 * 24 * 60 * 60);
    assert(Number.isInteger(ttl) && ttl >= 300 && ttl <= 90 * 24 * 60 * 60, 'invalid_input', 'session ttl is invalid', { status: 422 });
    const token = randomBytes(32).toString('base64url');
    const sessionId = id('ses');
    const timestamp = this.clock();
    const expiresAt = new Date(Date.parse(timestamp) + ttl * 1000).toISOString();
    await this.repository.insertSession({
      id: sessionId,
      tokenHash: sha256(token),
      expiresAt,
      timestamp,
      audit: auditStatement('session.created', 'session', sessionId, { ttl_seconds: ttl }, ctx.actor || OWNER_ID, timestamp)
    });
    return { id: sessionId, token, token_issued: true, expires_at: expiresAt, user_id: OWNER_ID, revision: 1 };
  }

  listSessions() {
    return this.repository.sessions();
  }

  async revokeSession(sessionId, input = {}, ctx = {}) {
    const current = await this.repository.session(sessionId);
    if (!current) throw new AppError('not_found', 'session not found');
    const expectedRevision = revision(input);
    try {
      const timestamp = this.clock();
      await this.repository.revokeSession({
        id: sessionId,
        expectedRevision,
        timestamp,
        audit: auditStatement('session.revoked', 'session', sessionId, { expected_revision: expectedRevision }, ctx.actor || OWNER_ID, timestamp)
      });
    } catch (error) {
      transactionConflict(error, current.revision);
      throw error;
    }
    return this.repository.session(sessionId);
  }

  async authenticate(authorization) {
    const header = String(authorization || '').trim();
    if (!header) {
      const owner = await this.repository.owner();
      if (!owner || owner.status !== 'active') throw new AppError('account_disabled', 'local owner is unavailable', { status: 403 });
      return { actor: owner.id, user_id: owner.id, session_id: null, source: 'local_owner' };
    }
    const token = /^Bearer ([A-Za-z0-9_-]{40,200})$/.exec(header)?.[1];
    if (!token) throw new AppError('session_invalid', 'Bearer session is invalid', { status: 401 });
    const session = await this.repository.sessionByHash(sha256(token));
    if (!session) throw new AppError('session_invalid', 'Bearer session is invalid', { status: 401 });
    if (session.revoked_at) throw new AppError('session_revoked', 'Bearer session was revoked', { status: 401 });
    if (Date.parse(session.expires_at) <= Date.parse(this.clock())) throw new AppError('session_expired', 'Bearer session expired', { status: 401 });
    if (session.user_status !== 'active') throw new AppError('account_disabled', 'session account is unavailable', { status: 403 });
    await this.repository.touchSession(session.id, this.clock());
    return { actor: session.user_id, user_id: session.user_id, session_id: session.id, source: 'bearer' };
  }
}

function revision(input) {
  const value = Number(input?.expected_revision);
  assert(Number.isInteger(value) && value > 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
  return value;
}

function transactionConflict(error, currentRevision) {
  if (String(error?.message).includes('transaction_precondition_failed')) {
    throw new AppError('revision_conflict', 'resource revision changed', { status: 409, details: { current_revision: Number(currentRevision) } });
  }
}
