export function executionInputEffectObligations(inputs) {
  return (inputs || []).map((input) => ({
    input_key: input.key,
    source: input.source,
    required: input.required !== false,
    application_policy: input.application_policy,
    purpose: input.purpose,
    target_output_keys: input.target_output_keys,
    coverage_policy: input.coverage_policy,
    version_ids: (input.asset_versions || []).map((item) => item.version_id).filter(Boolean),
    contribution: input.contribution ? structuredClone(input.contribution) : null
  }));
}

export function normalizeTargetOutputKeys(values, contract) {
  const declared = [
    ...new Set((Array.isArray(values) ? values : []).map((value) => clean(value, 120)).filter(Boolean))
  ];
  if (declared.length) return declared.sort();
  return [...new Set((contract?.expected_outputs || []).map((item) => clean(item?.key, 120)).filter(Boolean))].sort();
}

export function validateRepositoryVersionBinding(inputs, repository, errors) {
  const versions = inputs.flatMap((input) =>
      (input.asset_versions || []).filter(
        (version) =>
          /RepositoryVersionAsset/i.test(version.asset_type) ||
          (input.source === 'workstream_dependency' && version.repository_sha)
      )
    ),
    hashes = [...new Set(versions.map((item) => item.repository_sha).filter(Boolean))];
  if (!versions.length) return;
  if (versions.some((item) => !item.repository_sha) || hashes.length !== 1)
    errors.push({ code: 'repository_version_sha_invalid', version_ids: versions.map((item) => item.version_id) });
  else if (!repository || repository.fixed_sha !== hashes[0])
    errors.push({
      code: 'repository_snapshot_version_mismatch',
      expected_sha: hashes[0],
      actual_sha: repository?.fixed_sha || null
    });
}

function clean(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
