/**
 * Reconstruct the immutable PR evidence for an integration execution when a
 * process restart occurred after output ingestion but before the evidence was
 * copied onto the execution record. The normal completion assertion still
 * validates the resulting snapshot.
 */
export function integrationEvidenceFor(state, execution, { checks = null, mergedSha = null } = {}) {
  const line = state.repository_lines.find(
      (item) =>
        item.workflow_execution_id === execution?.workflow_execution_id &&
        item.workstream_id === execution?.workstream_id
    ),
    intent = state.pull_request_intents.find((item) => item.id === execution?.integration?.pull_request_intent_id),
    resolvedChecks = Array.isArray(checks) ? checks : Array.isArray(intent?.checks) ? intent.checks : [],
    resolvedSha =
      mergedSha || execution?.integration?.merged_sha || intent?.merge_commit_sha || line?.merged_sha || null;
  return {
    repository_sha: resolvedSha,
    checks_policy: resolvedChecks.length ? 'github_checks' : 'internal_test_report',
    pull_request: {
      merged: intent?.status === 'merged' || line?.status === 'merged',
      merged_sha: resolvedSha,
      head_sha: intent?.head_sha || null,
      expected_head_sha: line?.head_sha || null,
      base_ref: intent?.base_ref || null,
      expected_base_ref: line?.base_ref || null,
      approvals: Array.isArray(intent?.approvals) ? intent.approvals : [],
      checks: resolvedChecks,
      number: intent?.pr_number || line?.pr_number || null,
      url: intent?.pr_url || line?.pr_url || null
    },
    evidence_refs: intent?.pr_number && resolvedSha ? [`pull-request:${intent.pr_number}`, `merge:${resolvedSha}`] : []
  };
}
