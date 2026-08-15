import { id, now } from '../../crypto.mjs';
import { AppError, assert } from '../../errors.mjs';
import { OperationRepository, operationEvent } from './repository.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class OperationService {
  constructor({ db, secrets, clock = now, cancelExternal = async () => undefined, resumeExternal = async () => false }) {
    this.repository = new OperationRepository(db);
    this.secrets = secrets;
    this.clock = clock;
    this.cancelExternal = cancelExternal;
    this.resumeExternal = resumeExternal;
    this.active = new Map();
    this.handlers = new Map();
  }

  registerHandler(kind, handler = {}) {
    assert(/^[a-z][a-z0-9._-]{2,100}$/.test(String(kind)), 'invalid_input', 'operation kind is invalid', { status: 422 });
    this.handlers.set(String(kind), Object.freeze({ cancel: handler.cancel, recover: handler.recover }));
    return this;
  }

  async create({ kind, resourceType = '', resourceId = '', actor = 'usr_local_owner', executor }) {
    assert(/^[a-z][a-z0-9._-]{2,100}$/.test(String(kind)), 'invalid_input', 'operation kind is invalid', { status: 422 });
    const operationId = id('op');
    const timestamp = this.clock();
    await this.repository.create({ id: operationId, kind, resourceType, resourceId, externalRef: '', actor, timestamp },
      operationEvent(operationId, 'operation.pending', { status: 'pending', kind, resource_id: resourceId }, timestamp));
    if (typeof executor === 'function') queueMicrotask(() => this.run(operationId, executor));
    return this.receipt(await this.get(operationId));
  }

  async run(operationId, executor, { resume = false } = {}) {
    const controller = new AbortController();
    this.active.set(operationId, controller);
    try {
      if (resume) {
        const current = await this.repository.get(operationId);
        if (!current || !['pending', 'running'].includes(current.status)) return;
        if (current.status === 'pending') {
          await this.repository.transition({
            id: operationId, fromStatuses: ['pending'], status: 'running', timestamp: this.clock(),
            eventType: 'operation.running', eventData: { status: 'running', resumed: true }
          });
        } else {
          await this.repository.appendEvent(operationId, 'operation.resumed', { status: 'running' }, this.clock());
        }
      } else {
        await this.repository.transition({
          id: operationId, fromStatuses: ['pending'], status: 'running', timestamp: this.clock(),
          eventType: 'operation.running', eventData: { status: 'running' }
        });
      }
      const context = {
        operationId,
        signal: controller.signal,
        emit: (type, data = {}) => this.emit(operationId, type, data),
        setExternalRef: async (value) => this.repository.setExternalRef(operationId, String(value || '').slice(0, 300), this.clock()),
        ensureActive: () => {
          if (controller.signal.aborted) throw new AppError('operation_cancelled', 'operation was cancelled', { status: 409 });
        }
      };
      const result = await executor(context);
      context.ensureActive();
      await this.repository.transition({
        id: operationId, fromStatuses: ['running'], status: 'completed', timestamp: this.clock(),
        result: this.clean(result || {}), completed: true,
        eventType: 'operation.completed', eventData: { status: 'completed', result: this.clean(result || {}) }
      });
    } catch (error) {
      const current = await this.repository.get(operationId);
      if (current?.status === 'cancelled') return;
      const candidate = String(this.clean(error?.code || ''));
      const code = /^[a-z][a-z0-9_]{2,119}$/.test(candidate) ? candidate : 'operation_failed';
      await this.repository.transition({
        id: operationId, fromStatuses: ['pending', 'running'], status: 'failed', timestamp: this.clock(),
        errorCode: code, completed: true,
        eventType: 'operation.failed', eventData: { status: 'failed', error_code: code }
      }).catch(() => undefined);
    } finally {
      this.active.delete(operationId);
    }
  }

  async get(operationId) {
    const operation = await this.repository.get(operationId);
    if (!operation) throw new AppError('not_found', 'operation not found');
    return this.clean(operation);
  }

  async events(operationId, after = 0) {
    await this.get(operationId);
    return this.clean(await this.repository.events(operationId, after));
  }

  async emit(operationId, type, data = {}) {
    const cleanType = String(type || 'operation.progress').slice(0, 120);
    await this.repository.appendEvent(operationId, cleanType, this.clean(data), this.clock());
  }

  async cancel(operationId, input = {}) {
    const current = await this.get(operationId);
    const expectedRevision = Number(input?.expected_revision);
    assert(Number.isInteger(expectedRevision) && expectedRevision > 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
    if (TERMINAL.has(current.status)) throw new AppError('operation_terminal', 'operation already reached a terminal state', { status: 409, details: { status: current.status } });
    try {
      await this.repository.cancel({ id: operationId, expectedRevision, timestamp: this.clock() });
    } catch (error) {
      if (String(error?.message).includes('transaction_precondition_failed')) {
        throw new AppError('revision_conflict', 'operation revision changed', { status: 409, details: { current_revision: current.revision } });
      }
      throw error;
    }
    this.active.get(operationId)?.abort();
    const handler = this.handlers.get(current.kind);
    if (typeof handler?.cancel === 'function') await handler.cancel(current, this).catch(() => undefined);
    else if (current.external_ref) await this.cancelExternal(current.kind, current.external_ref).catch(() => undefined);
    return this.get(operationId);
  }

  async reconcile(operation, outcome = {}) {
    const current = typeof operation === 'string' ? await this.get(operation) : operation;
    if (!current || TERMINAL.has(current.status)) return current;
    const status = ['completed', 'failed', 'cancelled'].includes(outcome.status) ? outcome.status : 'failed';
    const timestamp = this.clock();
    if (status === 'cancelled') {
      await this.repository.cancel({ id: current.id, expectedRevision: Number(current.revision), timestamp });
    } else {
      const errorCode = status === 'failed'
        ? String(outcome.error_code || 'operation_interrupted').slice(0, 120)
        : '';
      const result = status === 'completed' ? this.clean(outcome.result || {}) : {};
      await this.repository.transition({
        id: current.id,
        fromStatuses: ['pending', 'running'],
        status,
        timestamp,
        result,
        errorCode,
        completed: true,
        eventType: `operation.${status}`,
        eventData: status === 'completed' ? { status, result } : { status, error_code: errorCode }
      });
    }
    return this.get(current.id);
  }

  async recover() {
    const pending = await this.repository.pending();
    for (const operation of pending) {
      const handler = this.handlers.get(operation.kind);
      const resumed = typeof handler?.recover === 'function'
        ? await handler.recover(operation, this).catch(() => false)
        : operation.external_ref
          ? await this.resumeExternal(operation, this).catch(() => false)
          : false;
      if (typeof resumed === 'function') {
        queueMicrotask(() => this.run(operation.id, resumed, { resume: true }));
        continue;
      }
      if (resumed === true) continue;
      await this.repository.transition({
        id: operation.id,
        fromStatuses: ['pending', 'running'],
        status: 'failed',
        timestamp: this.clock(),
        errorCode: 'operation_interrupted',
        completed: true,
        eventType: 'operation.failed',
        eventData: { status: 'failed', error_code: 'operation_interrupted' }
      });
    }
    return pending.length;
  }

  async receipt(operation) {
    const cursor = await this.repository.latestCursor(operation.id);
    return {
      operation_id: operation.id,
      status: operation.status,
      resource_id: operation.resource_id || null,
      cursor,
      revision: operation.revision
    };
  }

  clean(value) {
    return this.secrets?.redactObject ? this.secrets.redactObject(value) : value;
  }
}
