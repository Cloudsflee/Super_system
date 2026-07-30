import assert from 'node:assert/strict';

import {
  DEPLOYMENT_EVIDENCE_SCHEMA,
  normalizeDeploymentEvidenceV2,
  parseDeploymentEvidenceV2,
  parseOutcomeContract,
  protocolHash
} from '../../packages/execution-protocol/src/index.mjs';

const timestamp = '2026-07-30T00:00:00.000Z';
const bodyHash = 'a'.repeat(64);

const apiGet = normalizeDeploymentEvidenceV2(
  {
    origin: 'https://fixture.local',
    api: {
      GET: [{ url: 'https://fixture.local/health', status: 200, passed: true, content_type: 'application/json' }]
    },
    static_assets: [{ path: '/assets/app.js', sha256: bodyHash, size_bytes: 42 }]
  },
  { collectedAt: timestamp }
);
assert.equal(apiGet.schema_version, DEPLOYMENT_EVIDENCE_SCHEMA);
assert.equal(apiGet.http_checks[0].method, 'GET');
assert.equal(apiGet.http_checks[0].passed, true);
assert.equal(apiGet.static_assets[0].media_type, 'text/javascript');

const lowercase = normalizeDeploymentEvidenceV2(
  {
    base_url: 'https://fixture.local',
    checks: { get: { url: 'https://fixture.local/ready', status_code: 204 } },
    compose: {
      services: {
        app: { image: 'aiws-app:2.1.0', digest: 'sha256:fixture', ports: ['127.0.0.1:4317:4317'] }
      }
    }
  },
  { collectedAt: timestamp }
);
assert.equal(lowercase.target.kind, 'compose');
assert.equal(lowercase.compose_services[0].name, 'app');
assert.deepEqual(lowercase.compose_services[0].published_ports, ['127.0.0.1:4317:4317']);

assert.throws(
  () => parseDeploymentEvidenceV2({ ...apiGet, unexpected: true }),
  (error) =>
    error.code === 'execution_protocol_invalid' &&
    error.payload?.protocol === DEPLOYMENT_EVIDENCE_SCHEMA &&
    error.payload?.field_path === '/unexpected'
);
assert.throws(
  () =>
    parseOutcomeContract({
      schema_version: 'aiws.outcome_contract.v1',
      version: 1,
      requirements: [
        {
          id: 'context',
          mandatory: true,
          scope: 'context',
          order: 0,
          evaluator: 'context_freshness',
          expected: { current: true },
          waivable: true,
          evaluator_config: {}
        }
      ]
    }),
  (error) => error.payload?.field_path === '/requirements/0/waivable'
);
assert.equal(protocolHash({ b: 2, a: 1 }), protocolHash({ a: 1, b: 2 }));

console.log('V2.1 strict execution protocol and Deployment Evidence v2 adapter tests passed');
