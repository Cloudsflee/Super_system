import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers.mjs';
import { BrokerClient } from '../../apps/api/src/broker-client.mjs';
import { start as startBroker } from '../../apps/runner-broker/server.mjs';

test('API-to-broker requests are signed and jobs complete without persisted credentials', async () => {
  const env = await fixture();
  try {
    const client = new BrokerClient({ brokerMode: 'http', brokerUrl: `http://127.0.0.1:${env.broker.server.address().port}`, brokerSecret: 'integration-secret', runnerDigest: env.digest });
    assert.equal((await client.probe()).ready, true);
    const job = await client.submit({ task_id: 'inspect', execution_id: 'exe_12345678abcdef', project_id: 'prj_12345678abcdef', workspace_subpath: 'projects/prj_12345678abcdef', image_digest: env.digest, execution_mode: 'assist', resource_profile: 'standard', network_profile: 'none', input_paths: [], output_paths: [], deadline_at: new Date(Date.now() + 60_000).toISOString(), credential_ref: 'cred_ephemeral1' });
    assert.equal(job.status, 'queued');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = await client.status(job.job_id);
    assert.equal(status.status, 'completed');
    assert.equal(status.spec.credential_ref, '[ephemeral]');
    const checkpoint = await client.statusExecution('exe_12345678abcdef');
    assert.equal(checkpoint.job_id, job.job_id);

    await env.broker.close();
    const restarted = await startBroker({ config: { host: '127.0.0.1', port: 0, secret: 'integration-secret', dataRoot: env.home, dataVolume: 'aiws-data-v3', runnerDigest: env.digest, executor: 'mock', runnerImage: `runner@${env.digest}` } });
    try {
      const recoveredClient = new BrokerClient({ brokerMode: 'http', brokerUrl: `http://127.0.0.1:${restarted.server.address().port}`, brokerSecret: 'integration-secret', runnerDigest: env.digest });
      const recovered = await recoveredClient.statusExecution('exe_12345678abcdef');
      assert.equal(recovered.job_id, job.job_id);
      assert.equal(recovered.status, 'completed');
    } finally { await restarted.close(); }
  } finally { await env.close(); }
});
