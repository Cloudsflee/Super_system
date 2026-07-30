export function contextStatusSnapshot(state, index, runtimeStatus) {
  const jobsByStatus = Object.fromEntries(
    ['pending', 'running', 'completed', 'failed', 'superseded'].map((status) => [
      status,
      state.context_projection_jobs.filter((job) => job.status === status).length
    ])
  );
  const persisted = state.context_projector_status || {};
  return {
    schema_version: 21,
    protocol_version: 'aiws.system-context.v1',
    nodes: state.context_nodes.length,
    document_versions: state.context_document_versions.length,
    edges: state.context_edges.length,
    selections: state.context_selections.length,
    jobs: jobsByStatus,
    coverage: state.context_projection_coverage || null,
    index,
    worker: { ...runtimeStatus, ...persisted },
    oldest_pending_age_ms: persisted.oldest_pending_age_ms || 0,
    active_leases: persisted.active_leases || 0,
    failed_jobs: persisted.failed_jobs || jobsByStatus.failed,
    index_generation: persisted.index_generation || 0,
    automatic_rebuild: persisted.automatic_rebuild || 'idle'
  };
}
