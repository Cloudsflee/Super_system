import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers.mjs';
import { BrokerClient } from '../../apps/api/src/broker-client.mjs';

test('API-to-broker requests are signed and jobs complete without persisted credentials', async () => {
  const env = await fixture();
  try {
    const client = new BrokerClient({ brokerMode: 'http', brokerUrl: `http://127.0.0.1:${env.broker.server.address().port}`, brokerSecret: 'integration-secret', runnerDigest: env.digest });
    assert.equal((await client.probe()).ready, true);
    const job = await client.submit({ task_id: 'inspect', execution_id: 'exe_12345678abcdef', project_id: 'prj_12345678abcdef', workspace_subpath: 'projects/prj_12345678abcdef', image_digest: env.digest, execution_mode: 'read', resource_profile: 'standard', network_profile: 'none', input_paths: [], output_paths: [], deadline_at: new Date(Date.now() + 60_000).toISOString(), credential_ref: 'cred_ephemeral1' });
    assert.equal(job.status, 'queued');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = await client.status(job.job_id);
    assert.equal(status.status, 'completed');
    assert.equal(status.spec.credential_ref, '[ephemeral]');
  } finally { await env.close(); }
});
