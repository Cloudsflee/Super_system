import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createCleanRuntime } from '../apps/api/src/clean/runtime.mjs';
import { DeterministicAppServerAdapter } from '../apps/api/src/clean/app-server-adapter.mjs';
import { DeterministicRunnerAdapter } from '../apps/api/src/clean/runner-adapters.mjs';
import { P7_PARSER_IMAGE_DIGEST } from '../apps/api/src/clean/migrations/007-evidence-quality-parser-outcome.mjs';
import { start as startBroker } from '../apps/runner-broker/clean-server.mjs';
import { emitProbe } from './lib/v3-clean-p6-runner-probe.mjs';
import { fixture, waitOperation } from '../tests/p7/helpers.mjs';

await emitProbe('aiws.v3-clean.p7-restart-probe.v1', async () => {
  const state = fixture({ runtimeBuild: 'v3-clean-p7-restart-probe' });
  const secret = 'p7-restart-probe-transport-secret';
  const serviceIdentity = generateKeyPairSync('ed25519');
  const servicePublicKey = serviceIdentity.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let broker; let first; let second;
  try {
    broker = await startBroker({
      port: 0, secret, stateRoot: path.join(state.root, 'broker'), runnerDigest: `sha256:${'1'.repeat(64)}`,
      parserDigest: P7_PARSER_IMAGE_DIGEST, servicePublicKey,
      parserExecute: async (_job, context) => { const result = await blocked; return { ...result, outputs: result.status === 'parsed' ? [{ kind: 'text', bytes: context.input, media_type: 'text/plain', metadata: { restart: true } }] : [] }; }
    });
    const config = { ...state.config, parserBrokerUrl: broker.url, parserBrokerSecret: secret, parserImageDigest: P7_PARSER_IMAGE_DIGEST };
    first = runtime(config, serviceIdentity);
    await first.recovery;
    const setup = await first.identity.setupComplete({ display_name: 'P7 Restart Owner', team_name: 'P7 Restart Team', idempotency_key: 'p7-restart-setup' });
    const proof = setup.session.proof;
    const principal = first.identity.authenticateProof(proof);
    const project = await first.project.createProject({ name: 'P7 restart probe', idempotency_key: 'p7-restart-project' }, principal);
    const captured = await first.evidence.capture({
      project_id: project.id, logical_name: 'restart.txt', source_type: 'manual', source_ref: 'probe:restart',
      media_type: 'text/plain', content_base64: Buffer.from('restart checkpoint input').toString('base64'),
      expected_revision: 0, idempotency_key: 'p7-restart-asset'
    }, principal);
    const started = await first.parser.start(captured.asset.id, captured.asset.current_version_id, { format_key: 'text', expected_revision: captured.asset.revision, idempotency_key: 'p7-restart-parser' }, principal);
    const runId = started.parser_run.id;
    const operationId = started.operation.operation_id;
    await waitFor(() => first.db.get('SELECT status FROM parser_runs WHERE id=?', [runId])?.status === 'running');
    const before = first.db.get('SELECT * FROM parser_runs WHERE id=?', [runId]);
    await first.close(); first = null;

    release({ status: 'parsed', error_code: '' });
    await waitFor(() => [...broker.parserJobs.values()].some((job) => job.status === 'parsed'));
    second = runtime(config, serviceIdentity);
    await second.recovery;
    const recoveredPrincipal = second.identity.authenticateProof(proof);
    const operation = await waitOperation(second, operationId, recoveredPrincipal.actorId, 10000);
    const after = second.db.get('SELECT * FROM parser_runs WHERE id=?', [runId]);
    if (operation.status !== 'succeeded' || after.status !== 'parsed' || after.input_sha256 !== before.input_sha256 || after.format_sha256 !== before.format_sha256 || after.limits_sha256 !== before.limits_sha256 || after.checkpoint_token_hash !== before.checkpoint_token_hash) throw Object.assign(new Error('parser_restart_reconciliation_failed'), { code: 'parser_restart_reconciliation_failed' });
    return {
      adapter: 'clean-broker-parser', operation_status: operation.status, parser_status: after.status,
      broker_job_id_preserved: after.broker_job_id === before.broker_job_id,
      pinned_hashes_preserved: ['input_sha256', 'format_sha256', 'limits_sha256', 'checkpoint_token_hash'].every((field) => after[field] === before[field]),
      output_asset_created: Boolean(after.output_asset_version_id), runtime_restart: true,
      foreign_key_check: second.db.integrity().foreign_key_check
    };
  } finally {
    release?.({ status: 'failed', error_code: 'probe_cleanup' });
    await first?.close?.(); await second?.close?.(); await broker?.close?.();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

function runtime(config, parserServiceIdentity) {
  const runner = new DeterministicRunnerAdapter();
  return createCleanRuntime({
    config, targetVersion: 7, providerAdapter: new DeterministicAppServerAdapter(),
    runnerAdapters: { host: runner, docker: runner, windows_bridge: runner }, runnerRetryDelays: [0, 0],
    parserServiceIdentity, parserRetryDelays: [0, 0]
  });
}
async function waitFor(predicate, timeout = 5000) { const started = Date.now(); while (Date.now() - started < timeout) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw Object.assign(new Error('restart_probe_timeout'), { code: 'restart_probe_timeout' }); }
