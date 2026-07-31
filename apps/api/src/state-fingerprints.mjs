export function governanceFingerprint(state) {
  return JSON.stringify({
    instance_owner_user_id: state.instance_owner_user_id || null,
    memberships: (state.project_memberships || []).map((item) => [
      item.id,
      item.project_id,
      item.user_id,
      item.role,
      item.status
    ]),
    project_owners: (state.projects || []).map((item) => [item.id, item.owner_user_id || null])
  });
}

export function lifecycleFingerprint(state) {
  return JSON.stringify({
    canonical: (state.canonical_repositories || []).map((item) => [item.id, item.repository_id, item.remote_state]),
    bindings: (state.project_repository_bindings || []).map((item) => [
      item.id,
      item.project_id,
      item.canonical_repository_id,
      item.status
    ]),
    intents: (state.repository_deletion_intents || []).map((item) => [item.id, item.status]),
    exchanges: (state.exchange_requests || []).map((item) => [item.id, item.status]),
    grants: (state.exchange_grants || []).map((item) => [item.id, item.status])
  });
}
