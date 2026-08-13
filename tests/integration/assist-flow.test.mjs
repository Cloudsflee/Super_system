import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fixture, mutate, onboardProject, request } from './helpers.mjs';

test('four-level Assist sessions persist scope snapshots, native events, and replay cursors', async () => {
  const env = await fixture();
  try {
    const project = await mutate(env.base, '/api/v1/projects', { name: 'Assist fixture' }, 'assist-project');
    const { brief } = await onboardProject(env.base, project, { content: { objective: 'Exercise Assist', acceptance: ['events replay'] }, keyPrefix: 'assist-onboarding' });
    const workflow = await mutate(env.base, `/api/v1/projects/${project.json.id}/workflows`, { tasks: [
      { id: 'inspect', title: 'Inspect', level: 1, mode: 'read', deps: [], outputs: ['analysis.md'] },
      { id: 'change', title: 'Change', level: 2, mode: 'write', deps: ['inspect'], inputs: ['analysis.md'], outputs: ['change.diff'] }
    ] }, 'assist-workflow');
    assert.equal(workflow.response.status, 201);

    const sessions = [];
    for (const [scope, scopeId] of [['project', project.json.id], ['workflow', String(workflow.json.revision)], ['workstream', 'delivery'], ['task', 'change']]) {
      const created = await mutate(env.base, '/api/v1/assist/sessions', { project_id: project.json.id, scope, scope_id: scopeId }, `assist-session-${scope}`);
      assert.equal(created.response.status, 201);
      assert.equal(created.json.scope, scope);
      assert.equal(created.json.snapshot.brief_hash, brief.content_hash);
      assert.equal(created.json.snapshot.workflow_revision, workflow.json.revision);
      sessions.push(created.json);
    }

    const session = sessions.at(-1);
    const turn = await mutate(env.base, `/api/v1/assist/sessions/${session.id}/turns`, {
      message: 'Inspect the task contract and prepare the change.',
      goal: { objective: 'Prepare verified change' },
      plan: [{ step: 'Inspect inputs', status: 'completed' }, { step: 'Apply change', status: 'pending' }]
    }, 'assist-turn');
    assert.equal(turn.response.status, 201);
    assert.equal(turn.json.turn_no, 1);
    assert.equal(turn.json.status, 'failed');
    assert.equal(turn.json.messages[0].role, 'user');
    assert.equal(turn.json.operation.status, 'failed');
    assert.equal(turn.json.operation.error_code, 'assist_runtime_unavailable');

    const bundle = await request(env.base, `/api/v1/assist/sessions/${session.id}`);
    assert.equal(bundle.json.turns[0].goal.objective, 'Prepare verified change');
    assert.equal(bundle.json.turns[0].plan.length, 2);

    const firstReplay = await fetch(`${env.base}/api/v1/assist/sessions/${session.id}/events`);
    assert.equal(firstReplay.status, 200);
    assert.match(firstReplay.headers.get('content-type'), /^text\/event-stream/);
    const firstText = await firstReplay.text();
    const ids = [...firstText.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    assert.ok(ids.length >= 4);
    assert.match(firstText, /event: assist\.goal/);
    assert.match(firstText, /event: assist\.plan/);
    const laterReplay = await fetch(`${env.base}/api/v1/assist/sessions/${session.id}/events`, { headers: { 'Last-Event-ID': String(ids.at(-2)) } });
    const laterText = await laterReplay.text();
    const laterIds = [...laterText.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    assert.ok(laterIds.every((cursor) => cursor > ids.at(-2)));

    const interrupted = await mutate(env.base, `/api/v1/assist/sessions/${session.id}/interrupt`, {}, 'assist-interrupt');
    assert.equal(interrupted.json.status, 'paused');
    const resumed = await mutate(env.base, `/api/v1/assist/sessions/${session.id}/resume`, {}, 'assist-resume');
    assert.equal(resumed.json.status, 'active');
    const cancelled = await mutate(env.base, `/api/v1/assist/sessions/${session.id}/cancel`, {}, 'assist-cancel');
    assert.equal(cancelled.json.status, 'cancelled');
    const inactiveTurn = await mutate(env.base, `/api/v1/assist/sessions/${session.id}/turns`, { message: 'No longer accepted' }, 'assist-inactive-turn');
    assert.equal(inactiveTurn.response.status, 409);
    assert.equal(inactiveTurn.json.error.code, 'assist_session_inactive');

    const listed = await request(env.base, `/api/v1/assist/sessions?project_id=${project.json.id}`);
    assert.equal(listed.json.length, 4);

    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>';
    const svgHash = createHash('sha256').update(svg).digest('hex');
    const mismatch = await mutate(env.base, `/api/v1/projects/${project.json.id}/attachments`, { name: 'preview.svg', media_type: 'image/svg+xml', content: svg, sha256: '0'.repeat(64) }, 'assist-attachment-mismatch');
    assert.equal(mismatch.response.status, 422);
    assert.equal(mismatch.json.error.code, 'attachment_hash_mismatch');
    const attachment = await mutate(env.base, `/api/v1/projects/${project.json.id}/attachments`, { name: 'preview.svg', media_type: 'image/svg+xml', content: svg, sha256: svgHash }, 'assist-attachment');
    assert.equal(attachment.response.status, 201);
    assert.equal(attachment.json.sha256, svgHash);
    assert.equal(attachment.json.cas_path, undefined);
    const attachmentList = await request(env.base, `/api/v1/projects/${project.json.id}/attachments`);
    assert.equal(attachmentList.json[0].id, attachment.json.id);
    const download = await fetch(`${env.base}/api/v1/attachments/${attachment.json.id}/content`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.equal(await download.text(), svg);
    const preview = await fetch(`${env.base}/api/v1/attachments/${attachment.json.id}/preview`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-disposition'), /^inline;/);
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.match(preview.headers.get('content-security-policy'), /default-src 'none'/);
    const previewText = await preview.text();
    assert.doesNotMatch(previewText, /<script|alert\(/i);
    assert.match(previewText, /<rect/);
    const unsupported = await mutate(env.base, `/api/v1/projects/${project.json.id}/attachments`, { name: 'archive.zip', media_type: 'application/zip', content: 'fixture' }, 'assist-attachment-unsupported');
    assert.equal(unsupported.response.status, 415);
    const missingHumanScore = await mutate(env.base, `/api/v1/projects/${project.json.id}/quality-reviews`, { attachment_id: attachment.json.id }, 'quality-review-score-missing');
    assert.equal(missingHumanScore.response.status, 422);
    assert.equal(missingHumanScore.json.error.code, 'quality_human_score_required');
    const lowReview = await mutate(env.base, `/api/v1/projects/${project.json.id}/quality-reviews`, { attachment_id: attachment.json.id, semantic_human_score: 79 }, 'quality-review-low');
    assert.equal(lowReview.response.status, 201);
    assert.equal(lowReview.json.reports[0].report.reviewer_readiness, 'blocked');
    assert.equal(lowReview.json.policy.semantic_human_score_threshold, 80);
    const readyReview = await mutate(env.base, `/api/v1/projects/${project.json.id}/quality-reviews`, { attachment_id: attachment.json.id, semantic_human_score: 90 }, 'quality-review-ready');
    assert.equal(readyReview.response.status, 201);
    assert.equal(readyReview.json.reports[0].report.reviewer_readiness, 'ready');
    const qualityList = await request(env.base, `/api/v1/projects/${project.json.id}/quality-reviews`);
    assert.equal(qualityList.json.length, 2);
  } finally { await env.close(); }
});
