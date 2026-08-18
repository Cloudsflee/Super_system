import { createHash } from 'node:crypto';
import { AppError } from '../../errors.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown']);

export class AssistRuntimeAdapter {
  constructor({ broker = null, config = {} } = {}) {
    this.broker = broker;
    this.config = config;
  }

  executionId(turnId, attempt) {
    const stable = createHash('sha256').update(`${turnId}:${attempt}`).digest('hex').slice(0, 24);
    return `exe_${stable}`;
  }

  async startTurn(input, operationContext) {
    if (!this.broker?.submit) throw new AppError('assist_runtime_unavailable', 'Assist runtime is unavailable', { status: 503, retryable: true });
    const executionId = this.executionId(input.turn_id, input.attempt);
    const spec = {
      task_id: `assist_${input.attempt}`,
      execution_id: executionId,
      project_id: input.project_id,
      workspace_subpath: `projects/${input.project_id}`,
      image_digest: this.config.runnerDigest,
      execution_mode: 'assist',
      resource_profile: 'light',
      network_profile: 'model',
      credential_ref: input.profile.credential_ref,
      profile_id: input.profile.profile_id,
      profile_revision: input.profile.profile_revision,
      profile_hash: input.profile.profile_hash,
      input_paths: [],
      output_paths: [],
      deadline_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      bundle: {
        objective: input.objective,
        acceptance: ['assist response persisted'],
        context_pack: { pack_hash: input.context_pack_hash, input_hash: input.input_hash },
        context_pack_id: input.context_pack_id,
        input_assets: [], output_paths: [], checks: ['node_test', 'git_diff_check'], input_paths: []
      }
    };
    const submitted = await this.broker.submit(spec, { profile: input.profile, credential: input.credential });
    await operationContext.setExternalRef(submitted.job_id);
    return this.wait(submitted.job_id, operationContext.signal);
  }

  async resumeTurn(input, operationContext) {
    let externalRef = input.external_ref;
    if (!externalRef && this.broker?.statusExecution) {
      const checkpoint = await this.broker.statusExecution(this.executionId(input.turn_id, input.attempt)).catch(() => null);
      externalRef = checkpoint?.job_id || '';
      if (externalRef) await operationContext.setExternalRef(externalRef);
    }
    if (!externalRef || !this.broker?.status) throw new AppError('operation_interrupted', 'Assist broker checkpoint is unavailable', { status: 409, retryable: true });
    return this.wait(externalRef, operationContext.signal);
  }

  async wait(jobId, signal) {
    for (;;) {
      if (signal?.aborted) throw new AppError('operation_cancelled', 'Assist operation was cancelled', { status: 409 });
      const current = await this.broker.status(jobId);
      if (TERMINAL.has(current.status)) {
        if (current.status === 'completed') return { status: 'completed', broker_job_id: jobId, result: current.result || {} };
        if (current.status === 'cancelled') throw new AppError('operation_cancelled', 'Assist operation was cancelled', { status: 409 });
        throw new AppError(current.error_code || (current.status === 'unknown' ? 'operation_interrupted' : 'assist_runtime_failed'), 'Assist runtime did not complete', { retryable: current.status === 'unknown' });
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  async cancelTurn(externalRef) {
    if (externalRef && this.broker?.cancel) await this.broker.cancel(externalRef);
  }
}
