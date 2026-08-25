import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { close, open, prepare, waitOperation } from '../tests/p7/helpers.mjs';

const state = await open({ config: { runtimeBuild: 'v3-clean-p7-performance' } });
try {
  const fixture = await prepare(state, 'performance');
  state.runtime.outcomeEvaluation.close();
  const assets = [];
  for (let index = 0; index < 100; index += 1) {
    const captured = await state.runtime.evidence.capture({
      project_id: fixture.project.id, execution_id: fixture.execution.id,
      logical_name: `performance-${String(index).padStart(3, '0')}.txt`, asset_kind: 'execution_output',
      source_type: 'manual', source_ref: `performance:${index}`, media_type: 'text/plain',
      content_base64: Buffer.from(`performance asset ${index}`).toString('base64'), expected_revision: 0,
      idempotency_key: `p7-performance-asset-${index}`
    }, state.principal);
    assets.push(captured.asset);
  }
  for (let index = 1; index < assets.length; index += 1) {
    const root = state.runtime.evidence.getAsset(assets[0].id, state.principal).asset;
    await state.runtime.evidence.createRelation(root.id, {
      from_version_id: root.current_version_id, to_asset_id: assets[index].id,
      to_version_id: assets[index].current_version_id, relation_type: 'references',
      expected_revision: root.revision, idempotency_key: `p7-performance-relation-${index}`
    }, state.principal);
  }

  const baseBuildReport = state.runtime.quality.buildReport.bind(state.runtime.quality);
  state.runtime.quality.buildReport = (row) => {
    const report = baseBuildReport(row);
    return { ...report, anchors: Array.from({ length: 500 }, (_, index) => ({ ...report.anchors[index % report.anchors.length], kind: 'asset', offset: 0, length: 1, ordinal: index + 1 })) };
  };
  const quality = await state.runtime.quality.start(fixture.execution.id, {
    asset_ids: assets.slice(0, 16).map((item) => item.id), rubric: { dimensions: [{ key: 'evidence', weight: 100 }] },
    threshold: 80, expected_revision: fixture.execution.revision, idempotency_key: 'p7-performance-quality'
  }, state.principal);
  assert.equal((await waitOperation(state.runtime, quality.operation.operation_id, state.principal.actorId)).status, 'succeeded');
  const report = state.runtime.quality.report(quality.quality_review.id, state.principal).report;
  assert.equal(report.anchor_count, 500);

  for (let index = 0; index < 100; index += 1) await state.runtime.project.createOutcomeRequirement(fixture.project.id, {
    requirement_key: `performance-${String(index).padStart(3, '0')}`,
    rubric: { evaluator: 'evidence_count', minimum: 1 }, workflow_revision: 1,
    idempotency_key: `p7-performance-requirement-${index}`
  }, state.principal);

  const aggregateId = 'p7_performance_evidence_replay';
  const now = new Date().toISOString();
  for (let index = 1; index <= 1000; index += 1) state.runtime.db.withTransaction((tx) => state.runtime.events.appendAggregateInTransaction(tx, {
    aggregateType: 'evidence_replay', aggregateId, revision: index, actorId: state.principal.actorId,
    projectId: fixture.project.id, type: index === 1000 ? 'evidence.replay.completed' : 'evidence.replay.progress',
    data: { index }, payload: { index }, now
  }));

  const replaySamples = sample(30, () => state.runtime.events.replay({ actorId: state.principal.actorId, projectId: fixture.project.id, aggregateType: 'evidence_replay', aggregateId, cursor: 0, limit: 1000 }));
  const lineageSamples = sample(30, () => state.runtime.evidence.listRelations(assets[0].id, state.principal));
  const qualitySamples = sample(30, () => state.runtime.quality.report(quality.quality_review.id, state.principal));
  const outcomeSamples = [];
  const execution = state.runtime.execution.get(fixture.execution.id, state.principal);
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    const evaluation = await state.runtime.outcomeEvaluation.evaluate(execution.id, { expected_revision: execution.revision, idempotency_key: `p7-performance-outcome-${index}` }, state.principal);
    assert.equal((await waitOperation(state.runtime, evaluation.operation.operation_id, state.principal.actorId)).status, 'succeeded');
    outcomeSamples.push(performance.now() - startedAt);
  }

  const metrics = {
    evidence_replay_1000_p95_ms: round(p95(replaySamples)), asset_lineage_100_p95_ms: round(p95(lineageSamples)),
    quality_detail_16_assets_500_anchors_p95_ms: round(p95(qualitySamples)), outcome_evaluation_100_requirements_p95_ms: round(p95(outcomeSamples)),
    event_count: 1000, asset_count: assets.length, relation_count: state.runtime.evidence.listRelations(assets[0].id, state.principal).relations.length,
    quality_asset_count: 16, quality_anchor_count: report.anchor_count, outcome_requirement_count: 100
  };
  const thresholds = {
    evidence_replay_1000_p95_ms: 200, asset_lineage_100_p95_ms: 200,
    quality_detail_16_assets_500_anchors_p95_ms: 300, outcome_evaluation_100_requirements_p95_ms: 200
  };
  const failures = Object.entries(thresholds).filter(([name, maximum]) => metrics[name] > maximum).map(([name, maximum]) => `${name}>${maximum}`);
  process.stdout.write(`${JSON.stringify({ schema_version: 'aiws.v3-clean.p7-performance.v1', status: failures.length ? 'failed' : 'passed', provisional: false, metrics, thresholds, parser_latency: 'recorded_by_parser_probe', failures }, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
} finally { await close(state); }

function sample(count, callback) { const values = []; for (let index = 0; index < count; index += 1) { const started = performance.now(); callback(); values.push(performance.now() - started); } return values; }
function p95(values) { const ordered = [...values].sort((left, right) => left - right); return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] || 0; }
function round(value) { return Math.round(value * 100) / 100; }
