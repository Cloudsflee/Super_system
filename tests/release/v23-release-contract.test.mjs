import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  QUALITY_REVIEW_ADVICE_SCHEMA,
  QUALITY_REVIEW_REPORT_SCHEMA,
  QUALITY_REVIEW_RUBRIC_SCHEMA
} from '../../packages/execution-protocol/src/index.mjs';
import {
  AIWS_RUNNER_IMAGE,
  AIWS_STATE_SCHEMA_VERSION,
  AIWS_VERSION,
  CODEX_VERSION
} from '../../packages/shared/index.mjs';
import { findLegacyOfficialRunnerReferences } from '../../docker/release-volume-v23.mjs';
import {
  V22_PROJECT,
  V23_APP_IMAGE,
  V23_PROJECT,
  V23_RUNNER_IMAGE,
  V23_SCHEMA,
  V23_SOURCE_VOLUME,
  V23_TARGET_VOLUME,
  V23_VERSION,
  v23RollbackAccepted
} from '../../docker/v23-upgrade.mjs';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')),
  dockerfile = fs.readFileSync('Dockerfile', 'utf8'),
  compose = fs.readFileSync('compose.yml', 'utf8'),
  collaborationCompose = fs.readFileSync('compose.collaboration.yml', 'utf8'),
  bridge = fs.readFileSync('bridge/main.go', 'utf8');

assert.equal(packageJson.version, '2.3.0');
assert.equal(packageJson.engines.node, '24.14.x');
assert.equal(AIWS_VERSION, '2.3.0');
assert.equal(AIWS_STATE_SCHEMA_VERSION, 23);
assert.equal(CODEX_VERSION, '0.144.0');
assert.equal(AIWS_RUNNER_IMAGE, 'aiws-codex-runner:2.3.0-codex-0.144.0');
assert.equal(QUALITY_REVIEW_RUBRIC_SCHEMA, 'aiws.quality_review_rubric.v1');
assert.equal(QUALITY_REVIEW_ADVICE_SCHEMA, 'aiws.quality_review_advice.v1');
assert.equal(QUALITY_REVIEW_REPORT_SCHEMA, 'aiws.quality_review_report.v1');

assert.match(dockerfile, /FROM node:24\.14\.0-alpine3\.22 AS production/);
assert.match(dockerfile, /COPY docker\/v23-readiness\.mjs \.\/docker\/v23-readiness\.mjs/);
assert.match(dockerfile, /RUN node -e "import\('\.\/docker\/v23-readiness\.mjs'\).*waitForV23Readiness/s);
assert.match(dockerfile, /org\.opencontainers\.image\.version="2\.3\.0"/);
assert.match(compose, /aiws-app:2\.3\.0/);
assert.match(compose, /aiws-codex-runner:2\.3\.0-codex-0\.144\.0/);
assert.match(compose, /127\.0\.0\.1:\$\{AIWS_PORT:-4317\}:4317/);
assert.match(collaborationCompose, /aiws-mcp-gateway:2\.3\.0/);
assert.match(bridge, /bridgeVersion\s+= "2\.3\.0"/);

assert.equal(V23_VERSION, '2.3.0');
assert.equal(V23_SCHEMA, 23);
assert.equal(V23_PROJECT, 'aiws-v23');
assert.equal(V22_PROJECT, 'aiws-v22');
assert.equal(V23_SOURCE_VOLUME, 'aiws-data-v22');
assert.equal(V23_TARGET_VOLUME, 'aiws-data-v23');
assert.equal(V23_APP_IMAGE, 'aiws-app:2.3.0');
assert.equal(V23_RUNNER_IMAGE, 'aiws-codex-runner:2.3.0-codex-0.144.0');

const legacy = findLegacyOfficialRunnerReferences({
  codex_profiles: [
    {
      image: 'aiws-codex-runner:2.2.0-codex-0.144.0',
      config: { image: 'aiws-codex-runner:2.1.0-codex-0.144.0' }
    }
  ],
  integration_statuses: [
    { key: 'codex_docker', image: 'aiws-codex-runner:2.0.0-codex-0.144.0' },
    { key: 'codex_docker', image: V23_RUNNER_IMAGE }
  ]
});
assert.deepEqual(legacy.map((item) => item.image).sort(), [
  'aiws-codex-runner:2.0.0-codex-0.144.0',
  'aiws-codex-runner:2.1.0-codex-0.144.0',
  'aiws-codex-runner:2.2.0-codex-0.144.0'
]);
assert.deepEqual(
  findLegacyOfficialRunnerReferences({
    codex_profiles: [{ image: V23_RUNNER_IMAGE, config: { image: V23_RUNNER_IMAGE } }],
    integration_statuses: [{ key: 'codex_docker', image: V23_RUNNER_IMAGE }]
  }),
  []
);

assert.equal(v23RollbackAccepted(['v22-container'], { status: 'ok', version: '2.2.0', schema_version: 22 }), true);
assert.equal(v23RollbackAccepted(['v22-container'], { status: 'ok', version: '2.2.0', schema_version: 23 }), false);
assert.equal(v23RollbackAccepted([], { status: 'ok', version: '2.2.0', schema_version: 22 }), false);

const readiness = await import('../../docker/v23-readiness.mjs');
assert.equal(typeof readiness.waitForV23Readiness, 'function');
assert.equal(typeof readiness.waitForV23PortDisposition, 'function');

console.log('V2.3 image identity, production import, legacy Runner, protocol, Compose, and rollback contracts passed');
