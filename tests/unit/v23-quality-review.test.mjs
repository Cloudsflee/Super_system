import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import {
  QUALITY_REVIEW_ADVICE_JSON_SCHEMA,
  QUALITY_REVIEW_ADVICE_SCHEMA,
  QUALITY_REVIEW_REPORT_SCHEMA,
  parseQualityReviewAdvice,
  parseQualityReviewRubric,
  parseQualityReviewReport
} from '../../packages/execution-protocol/src/index.mjs';
import {
  DEFAULT_QUALITY_REVIEW_RUBRIC,
  defaultQualityReviewRubric,
  qualityReviewRubricHash,
  validateQualityReviewRubricInput
} from '../../apps/api/src/quality-review-rubric.mjs';
import { prepareQualityReviewInState } from '../../apps/api/src/quality-review-service.mjs';
import { parseQualityReviewModelOutput } from '../../apps/api/src/quality-review-service-model.mjs';
import { isSupportedMediaType } from '../../apps/api/src/quality-review-service-assets.mjs';
import {
  qualityReviewInputHash,
  qualityReviewRunInputIsCurrent,
  reviewerProfileSnapshot,
  selectReviewerProfile
} from '../../apps/api/src/quality-review-service-state.mjs';
import {
  migrateState22To23,
  normalizeState23Defaults,
  qualityReviewRunInputIsCurrent as migrationRunInputIsCurrent,
  validateState23
} from '../../apps/api/src/state-migration-v23.mjs';
import { normalizeState22Defaults, validateState22 } from '../../apps/api/src/state-migration-v22.mjs';
import { AIWS_RUNNER_IMAGE } from '../../packages/shared/index.mjs';

const rubric = defaultQualityReviewRubric();
assert.deepEqual(rubric, DEFAULT_QUALITY_REVIEW_RUBRIC);
assert.equal(
  rubric.dimensions.reduce((sum, item) => sum + item.weight, 0),
  100
);
assert.match(qualityReviewRubricHash(rubric), /^[a-f0-9]{64}$/);
assert.throws(
  () =>
    validateQualityReviewRubricInput({
      ...rubric,
      dimensions: rubric.dimensions.map((item) => ({ ...item, weight: 10 }))
    }),
  /quality_review/
);

const state = {
  schema_version: 23,
  workflows: [
    {
      id: 'workflow-quality-fixture',
      quality_review_policy: { enabled: true, mandatory: true, rubric }
    }
  ],
  workflow_executions: [
    {
      id: 'execution-quality-fixture',
      workflow_id: 'workflow-quality-fixture',
      project_id: 'project-quality-fixture',
      workflow_revision: 1,
      status: 'completed'
    }
  ],
  task_executions: [],
  assets: [],
  asset_versions: [],
  codex_profiles: [],
  quality_review_runs: [],
  quality_review_reports: [],
  quality_review_events: []
};
const prepared = prepareQualityReviewInState(state, 'execution-quality-fixture');
assert.equal(prepared.enabled, true);
assert.equal(prepared.mandatory, true);
assert.equal(prepared.threshold, 80);
assert.deepEqual(prepared.default_included_asset_version_ids, []);
assert.equal(prepared.reviewer_readiness.ready, false);

const advice = {
  schema_version: QUALITY_REVIEW_ADVICE_SCHEMA,
  reviewer: { profile_id: null, provider: null, model: null, attempt: 1 },
  status: 'unavailable',
  dimensions: rubric.dimensions.map((dimension) => ({
    criterion_id: dimension.id,
    recommendation: null,
    rationale: '人工独立判断。',
    evidence_anchors: [],
    limitations: ['模型建议不可用。']
  })),
  limitations: ['模型建议不能代替人工裁决。'],
  generated_at: new Date().toISOString()
};
assert.deepEqual(parseQualityReviewAdvice(advice), advice);
assert.equal(QUALITY_REVIEW_ADVICE_JSON_SCHEMA.properties.schema_version.const, QUALITY_REVIEW_ADVICE_SCHEMA);
assert.throws(
  () => parseQualityReviewAdvice({ ...advice, unexpected: true }),
  (error) => error.code === 'execution_protocol_invalid'
);
assert.deepEqual(
  parseQualityReviewModelOutput({
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-quality' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(advice) } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } })
    ].join('\n')
  }),
  advice
);

const report = parseQualityReviewReport({
  schema_version: QUALITY_REVIEW_REPORT_SCHEMA,
  id: 'report-quality-fixture',
  run_id: 'run-quality-fixture',
  workflow_execution_id: 'execution-quality-fixture',
  project_id: 'project-quality-fixture',
  input_snapshot_hash: 'a'.repeat(64),
  rubric_hash: qualityReviewRubricHash(rubric),
  deterministic_checks: [],
  assets: [],
  advice,
  limitations: ['fixture'],
  generated_at: new Date().toISOString(),
  immutable: true
});
assert.equal(report.immutable, true);

const normalized = normalizeState23Defaults({ ...state }, '2026-08-01T00:00:00.000Z');
assert.doesNotThrow(() => validateState23(normalized));

const workerMessage = await runParserWorker({
  files: [{ path: 'note.md', media_type: 'text/markdown', bytes: Buffer.from('# 标题\n内容') }]
});
assert.equal(workerMessage.ok, true);
assert.match(workerMessage.result.normalized_text, /标题/);
assert.equal(workerMessage.result.files[0].kind, 'text');
const unsupported = await runParserWorker({
  files: [{ path: 'movie.mp4', media_type: 'video/mp4', bytes: Buffer.from('fixture') }]
});
assert.equal(unsupported.ok, true);
assert.equal(unsupported.result.out_of_scope[0].reason, 'format_not_supported');

const validJson = await runParserWorker({
  files: [{ path: 'result.json', media_type: 'application/json', bytes: Buffer.from('{"ok":true}') }]
});
assert.equal(validJson.ok, true);
assert.equal(validJson.result.files[0].kind, 'json');
await assertParserFailure(
  { files: [{ path: 'broken.json', media_type: 'application/json', bytes: Buffer.from('{"ok":') }] },
  'quality_review_json_invalid'
);
const validXml = await runParserWorker({
  files: [{ path: 'result.xml', media_type: 'application/xml', bytes: Buffer.from('<result><ok>true</ok></result>') }]
});
assert.equal(validXml.ok, true);
assert.equal(validXml.result.files[0].kind, 'xml');
await assertParserFailure(
  { files: [{ path: 'broken.xml', media_type: 'application/xml', bytes: Buffer.from('<result>') }] },
  'quality_review_xml_invalid'
);
await assertParserFailure(
  { files: [{ path: 'broken.pdf', media_type: 'application/pdf', bytes: Buffer.from('%PDF-1.7\nnot a pdf') }] },
  'quality_review_pdf_invalid'
);
const legacyXls = await runParserWorker({
  files: [{ path: 'legacy.xls', media_type: 'application/vnd.ms-excel', bytes: Buffer.from('legacy') }]
});
assert.equal(legacyXls.ok, true);
assert.equal(legacyXls.result.files[0].kind, 'out_of_scope');
assert.equal(isSupportedMediaType('legacy.xls', 'application/vnd.ms-excel'), false);

assertReviewerSnapshotIsFrozen();
assertRetryFreshnessUsesSupersedes(rubric);
assertLegacyReviewerProjectionMigration();

console.log('V2.3 Quality Review rubric, protocol, deterministic parser and preparation tests passed');

function assertReviewerSnapshotIsFrozen() {
  const reviewer = {
      id: 'quality-reviewer-fixture',
      kind: 'docker',
      provider: 'openai',
      model: 'gpt-5.5',
      reasoning: 'high',
      wire_api: 'responses',
      timeout_ms: 120_000,
      base_url: null,
      requires_openai_auth: true,
      image: AIWS_RUNNER_IMAGE,
      config: { image: AIWS_RUNNER_IMAGE, reviewer: true },
      codex_home: 'C:/aiws/codex/quality-reviewer-fixture',
      config_file: 'C:/aiws/codex/quality-reviewer-fixture/config.toml',
      status: 'validated',
      quality_reviewer: true,
      web_search: false,
      mcp_servers: [],
      mounts: []
    },
    snapshot = reviewerProfileSnapshot(reviewer),
    run = { reviewer_profile_snapshot: snapshot };
  assert.match(snapshot.runtime_sha256, /^[a-f0-9]{64}$/);
  assert.equal(selectReviewerProfile({ codex_profiles: [reviewer] }, run), reviewer);
  const changed = { ...reviewer, model: 'gpt-5.5-updated' },
    fallback = { ...reviewer, id: 'quality-reviewer-fallback' };
  assert.equal(selectReviewerProfile({ codex_profiles: [changed, fallback] }, run), null);
}

function assertRetryFreshnessUsesSupersedes(reviewRubric) {
  const execution = {
      id: 'quality-execution-retry',
      workflow_id: 'quality-workflow-retry',
      workflow_revision: 1,
      input_hash: 'b'.repeat(64)
    },
    rubricHash = qualityReviewRubricHash(reviewRubric),
    run = {
      workflow_execution_id: execution.id,
      input_asset_version_ids: ['version-current-retry'],
      excluded_assets: [],
      rubric: reviewRubric,
      rubric_hash: rubricHash,
      workflow_policy_rubric_hash: rubricHash
    },
    freshnessState = {
      workflows: [
        {
          id: execution.workflow_id,
          quality_review_policy: { enabled: true, rubric: reviewRubric, rubric_hash: rubricHash }
        }
      ],
      workflow_executions: [execution],
      task_executions: [
        {
          id: 'task-execution-old',
          workflow_execution_id: execution.id,
          task_id: 'task-retry',
          attempt: 99,
          status: 'superseded'
        },
        {
          id: 'task-execution-current',
          workflow_execution_id: execution.id,
          task_id: 'task-retry',
          attempt: 1,
          status: 'completed',
          supersedes_id: 'task-execution-old'
        }
      ],
      assets: [
        {
          id: 'asset-old',
          task_execution_id: 'task-execution-old',
          current_version_id: 'version-old-retry'
        },
        {
          id: 'asset-current',
          task_execution_id: 'task-execution-current',
          current_version_id: 'version-current-retry'
        }
      ],
      asset_versions: [
        { id: 'version-old-retry', asset_id: 'asset-old' },
        { id: 'version-current-retry', asset_id: 'asset-current' },
        { id: 'version-updated-retry', asset_id: 'asset-current' }
      ]
    };
  run.input_snapshot_hash = qualityReviewInputHash(execution, run.input_asset_version_ids, reviewRubric, []);
  assert.equal(qualityReviewRunInputIsCurrent(freshnessState, execution, run), true);
  assert.equal(migrationRunInputIsCurrent(freshnessState, run), true);
  freshnessState.assets[1].current_version_id = 'version-updated-retry';
  assert.equal(qualityReviewRunInputIsCurrent(freshnessState, execution, run), false);
  assert.equal(migrationRunInputIsCurrent(freshnessState, run), false);
}

function assertLegacyReviewerProjectionMigration() {
  const timestamp = '2026-08-01T00:00:00.000Z',
    legacy = {
      schema_version: 22,
      codex_profiles: [
        {
          id: 'legacy-validated-profile',
          name: 'Legacy validated profile',
          kind: 'docker',
          provider: 'fixture',
          model: 'fixture-model',
          reasoning: 'high',
          wire_api: 'responses',
          image: 'aiws-codex-runner:2.2.0-codex-0.144.0',
          config: { image: 'aiws-codex-runner:2.2.0-codex-0.144.0' },
          status: 'validated',
          is_active: true,
          web_search: false,
          mcp_servers: [],
          mounts: [],
          created_at: timestamp,
          updated_at: timestamp
        }
      ]
    };
  normalizeState22Defaults(legacy, timestamp);
  validateState22(legacy);
  const migrated = migrateState22To23(legacy, { timestamp }).state,
    reviewer = migrated.codex_profiles.find((item) => item.quality_reviewer === true),
    projection = migrated.context_nodes.find(
      (item) => item.source_collection === 'codex_profiles' && item.source_id === reviewer?.id
    );
  assert.ok(reviewer, 'schema 23 migration must create the isolated reviewer profile');
  assert.ok(projection, 'schema 23 migration must project the reviewer profile before validation');
  assert.equal(projection.status, 'active');
  assert.doesNotThrow(() => validateState23(migrated));
}

async function assertParserFailure(input, expectedCode) {
  const message = await runParserWorker(input);
  assert.equal(message.ok, false);
  assert.equal(message.error.code, expectedCode);
}

function runParserWorker(input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../apps/api/src/quality-review-parser-worker.mjs', import.meta.url));
    worker.once('message', (message) => {
      void worker.terminate();
      resolve(message);
    });
    worker.once('error', reject);
    worker.postMessage(input);
  });
}
