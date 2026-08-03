import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v23-security-')),
  secret = 'V23_SECURITY_SENTINEL_8f38a0d4f153',
  extracted = 'V23_EXTRACTED_BODY_MUST_NOT_ENTER_EVENTS_OR_LOGS';
process.env.AIWS_HOME = path.join(root, 'home');
process.env.NODE_ENV = 'test';

const { AIWS_RUNNER_IMAGE } = await import('../../packages/shared/index.mjs'),
  { defaultQualityReviewRubric } = await import('../../apps/api/src/quality-review-rubric.mjs'),
  { reviewerProfileSnapshot, sanitizeEvent } = await import('../../apps/api/src/quality-review-service-state.mjs'),
  { reviewerReadinessPreflight, invalidateReviewerReadinessCache } =
    await import('../../apps/api/src/quality-review-reviewer-readiness.mjs'),
  { buildQualityReviewAdvice } = await import('../../apps/api/src/quality-review-service-model.mjs'),
  { qualityReviewV23Routes } = await import('../../apps/api/src/routes/quality-reviews-v23.mjs'),
  { putSecret } = await import('../../apps/api/src/vault.mjs'),
  { emptyState } = await import('../../apps/api/src/state.mjs'),
  { collections, QUALITY_REVIEW_TEMP_DIR } = await import('../../apps/api/src/config.mjs'),
  { initializeStateStore, closeStateStore, stateStoreHealth } = await import('../../apps/api/src/state-store.mjs');

try {
  assertRouteScopes();
  const ref = await putSecret('v23-security', secret),
    profile = reviewerProfile(),
    state = emptyState();
  state.codex_profiles = [profile];
  state.integration_statuses = [
    {
      key: 'codex_auth',
      status: 'authenticated',
      provider: profile.provider,
      refs: { credential: ref },
      updated_at: '2026-08-01T00:00:00.000Z'
    }
  ];
  const workflow = { id: 'workflow-security', quality_review_profile_id: profile.id };
  const readiness = await reviewerReadinessPreflight(state, workflow, {
    force: true,
    runtimeInspector: async () => ({
      ready: true,
      image: { ready: true, id: 'sha256:fixture', error_code: null }
    }),
    probeRunner: async () => ({ ready: true, code: null })
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.advice_available, true);
  assert.deepEqual(Object.keys(readiness.checks), ['profile', 'image', 'credential', 'probe', 'vision']);
  assertNoSentinels(readiness);

  const failed = await reviewerReadinessPreflight(state, workflow, {
    force: true,
    runtimeInspector: async () => ({
      ready: true,
      image: { ready: true, id: 'sha256:fixture', error_code: null }
    }),
    probeRunner: async () => {
      throw new Error(`Bearer ${secret}`);
    }
  });
  assert.equal(failed.ready, false);
  assert.equal(failed.checks.probe.code, 'reviewer_preflight_failed');
  assertNoSentinels(failed);

  const rubric = defaultQualityReviewRubric(),
    run = {
      id: 'run-security',
      reviewer_profile_snapshot: reviewerProfileSnapshot(profile),
      input_snapshot_hash: 'a'.repeat(64)
    },
    advice = await buildQualityReviewAdvice({
      state,
      run,
      execution: { id: 'execution-security' },
      rubric,
      parsed: [{ anchors: [], normalized_text: extracted, review_images: [] }],
      modelRunner: async () => {
        const error = new Error(`${secret} ${extracted}`);
        error.retryable = false;
        throw error;
      }
    });
  assert.equal(advice.status, 'unavailable');
  assert.ok(advice.dimensions.every((item) => item.recommendation === null));
  assertNoSentinels(advice);

  const invalid = await buildQualityReviewAdvice({
    state,
    run,
    execution: { id: 'execution-security' },
    rubric,
    parsed: [{ anchors: [], normalized_text: extracted, review_images: [] }],
    modelRunner: async () => ({
      schema_version: 'aiws.quality_review_advice.v1',
      reviewer: { profile_id: profile.id, provider: profile.provider, model: profile.model, attempt: 1 },
      status: 'completed',
      dimensions: [
        {
          criterion_id: 'unknown',
          recommendation: 99,
          rationale: extracted,
          evidence_anchors: [],
          limitations: []
        }
      ],
      limitations: [],
      generated_at: '2026-08-01T00:00:00.000Z'
    })
  });
  assert.equal(invalid.status, 'invalid');
  assert.ok(invalid.dimensions.every((item) => item.recommendation === null));
  assertNoSentinels(invalid);

  const event = sanitizeEvent({
    phase: 'reviewing',
    content: extracted,
    authorization: `Bearer ${secret}`,
    nested: { raw: extracted, token: secret, status: 'ok' }
  });
  assert.deepEqual(event, { phase: 'reviewing', nested: { status: 'ok' } });
  const { maskSecret } = await import('../../packages/shared/index.mjs');
  assertNoSentinels(maskSecret(JSON.stringify(event)));

  const databasePath = path.join(process.env.AIWS_HOME, 'data', 'state-v23.sqlite');
  await initializeStateStore({
    databasePath,
    collections,
    store_schema_version: 23,
    state,
    sourceStateHash: null,
    migration: { migrated: false, from_version: 23, to_version: 23 }
  });
  const health = await stateStoreHealth();
  assert.equal(health.healthy, true);
  assertNoSentinels(health);
  await closeStateStore();
  for (const file of filesUnder(path.join(process.env.AIWS_HOME, 'data'))) assertNoSentinels(fs.readFileSync(file));
  for (const file of filesUnder(QUALITY_REVIEW_TEMP_DIR)) assertNoSentinels(fs.readFileSync(file));
} finally {
  invalidateReviewerReadinessCache();
  await closeStateStore().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('V2.3 Reviewer credential, advice, event, SQLite/WAL, health, and temp redaction tests passed');

function reviewerProfile() {
  return {
    id: 'quality-reviewer-security',
    name: 'Quality Reviewer',
    quality_reviewer: true,
    kind: 'docker',
    status: 'validated',
    provider: 'openai',
    model: 'gpt-5.2',
    reasoning: 'high',
    image: AIWS_RUNNER_IMAGE,
    codex_home: path.join(root, 'codex-home'),
    config_file: path.join(root, 'codex-home', 'config.toml'),
    config: { reviewer: true, image: AIWS_RUNNER_IMAGE },
    wire_api: 'responses',
    requires_openai_auth: false,
    web_search: false,
    mcp_servers: [],
    mounts: []
  };
}

function assertRouteScopes() {
  const byRoute = new Map(qualityReviewV23Routes.map((route) => [`${route.method} ${route.pattern}`, route]));
  assert.deepEqual(byRoute.get('PUT /workflows/:id/quality-review-policy').required_scopes, ['project:write']);
  assert.deepEqual(byRoute.get('POST /workflow-executions/:id/quality-reviews').required_scopes, ['project:run']);
  assert.deepEqual(byRoute.get('POST /quality-reviews/:id/cancel').required_scopes, ['project:run']);
  assert.deepEqual(byRoute.get('POST /quality-reviews/:id/decision').required_scopes, [
    'project:approve',
    'approval:decide'
  ]);
  assert.deepEqual(byRoute.get('GET /workflow-executions/:id/quality-reviews').required_scopes, ['project:read']);
}

function assertNoSentinels(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  assert.equal(bytes.includes(Buffer.from(secret)), false);
  assert.equal(bytes.includes(Buffer.from(extracted)), false);
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  });
}
