/**
 * Reconstruct the immutable PR evidence for an integration execution when a
 * process restart occurred after output ingestion but before the evidence was
 * copied onto the execution record. The normal completion assertion still
 * validates the resulting snapshot.
 */
export function integrationEvidenceFor(state, execution, { checks = null, mergedSha = null } = {}) {
  const line = integrationLine(state, execution);
  const intent = integrationIntent(state, execution);
  const resolvedChecks = integrationChecks(intent, checks);
  const resolvedSha = integrationMergedSha(line, intent, execution, mergedSha);
  return {
    repository_sha: resolvedSha,
    checks_policy: resolvedChecks.length ? 'github_checks' : 'internal_test_report',
    pull_request: pullRequestEvidence(line, intent, resolvedChecks, resolvedSha),
    evidence_refs: integrationEvidenceRefs(intent, resolvedSha)
  };
}

function integrationLine(state, execution) {
  return state.repository_lines.find(
    (item) =>
      item.workflow_execution_id === execution?.workflow_execution_id && item.workstream_id === execution?.workstream_id
  );
}

function integrationIntent(state, execution) {
  return state.pull_request_intents.find((item) => item.id === execution?.integration?.pull_request_intent_id);
}

function integrationChecks(intent, checks) {
  if (Array.isArray(checks)) return checks;
  return Array.isArray(intent?.checks) ? intent.checks : [];
}

function integrationMergedSha(line, intent, execution, mergedSha) {
  return mergedSha || execution?.integration?.merged_sha || intent?.merge_commit_sha || line?.merged_sha || null;
}

function pullRequestEvidence(line, intent, checks, mergedSha) {
  return {
    merged: pullRequestMerged(line, intent),
    merged_sha: mergedSha,
    head_sha: firstTruthy(intent?.head_sha),
    expected_head_sha: firstTruthy(line?.head_sha),
    base_ref: firstTruthy(intent?.base_ref),
    expected_base_ref: firstTruthy(line?.base_ref),
    approvals: integrationApprovals(intent),
    checks,
    number: firstTruthy(intent?.pr_number, line?.pr_number),
    url: firstTruthy(intent?.pr_url, line?.pr_url)
  };
}

function pullRequestMerged(line, intent) {
  return intent?.status === 'merged' || line?.status === 'merged';
}

function integrationApprovals(intent) {
  return Array.isArray(intent?.approvals) ? intent.approvals : [];
}

function firstTruthy(...values) {
  return values.find(Boolean) || null;
}

function integrationEvidenceRefs(intent, mergedSha) {
  return intent?.pr_number && mergedSha ? [`pull-request:${intent.pr_number}`, `merge:${mergedSha}`] : [];
}
