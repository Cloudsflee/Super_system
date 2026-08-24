import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const EVIDENCE_POLICIES = Object.freeze([
  Object.freeze({
    key: 'p4', phase: 'P4', reference: 'docs/evidence/v3-clean-p4-context-mcp-20260820/verification.json',
    attempts: 'docs/evidence/v3-clean-p4-context-mcp-20260820/attempts', staging_env: 'AIWS_P4_EVIDENCE_STAGING_ROOT',
    staging_schema: 'aiws.v3-clean.p4-catalog-staging.v1', manifest_schema: 'aiws.v3-clean.p4-manifest.v1', validate: validateP4EvidenceManifest
  }),
  Object.freeze({
    key: 'p5', phase: 'P5', reference: 'docs/evidence/v3-clean-p5-assist-terminal-20260820/verification.json',
    attempts: 'docs/evidence/v3-clean-p5-assist-terminal-20260820/attempts', staging_env: 'AIWS_P5_EVIDENCE_STAGING_ROOT',
    staging_schema: 'aiws.v3-clean.p5-catalog-staging.v1', manifest_schema: 'aiws.v3-clean.p5-manifest.v1', validate: validateP5EvidenceManifest
  }),
  Object.freeze({
    key: 'p6', phase: 'P6', reference: 'docs/evidence/v3-clean-p6-runner-execution-20260824/verification.json',
    attempts: 'docs/evidence/v3-clean-p6-runner-execution-20260824/attempts', staging_env: 'AIWS_P6_EVIDENCE_STAGING_ROOT',
    staging_schema: 'aiws.v3-clean.p6-catalog-staging.v1', manifest_schema: 'aiws.v3-clean.p6-manifest.v1', validate: validateP6EvidenceManifest
  })
]);

const EVIDENCE_POLICY_BY_REFERENCE = new Map(EVIDENCE_POLICIES.map((policy) => [policy.reference, policy]));

export const CLEAN_CATALOG_IDS = Object.freeze([
  'REC-D0-GOVERNANCE-000', 'REC-D2-IDENTITY-001', 'REC-D2-SETUP-002',
  'REC-D4-MCP-004', 'REC-D4-SCOPE-016',
  'REC-D5-PROJECT-005', 'REC-D5-WORKFLOW-006', 'REC-D6-GENERATION-007',
  'REC-D6-OUTCOME-009', 'REC-D7-REPOSITORY-014',
  'REC-D9-CONTEXT-017', 'REC-D9-PROJECTION-018', 'REC-D10-FRONTEND-024'
]);

export const P5_CLEAN_CATALOG_IDS = Object.freeze([
  'REC-D8-ASSIST-010', 'REC-D8-ATTACHMENTS-011', 'REC-D8-FILES-012',
  'REC-D8-APPROVAL-013', 'REC-D8-TERMINAL-025', 'REC-D8-BRIDGE-026'
]);

export const P6_CLEAN_CATALOG_IDS = Object.freeze([
  'REC-D3-RUNNER-003', 'REC-D6-EXECUTION-008'
]);

const P6_TABLES = Object.freeze([
  'execution_events', 'execution_inputs', 'execution_stage_checkpoints', 'executions',
  'job_specs', 'runner_profiles', 'runner_receipts', 'task_attempts'
]);

export function loadCatalogIndex(root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  const explicit = path.join(root, 'feature-catalog.index.json');
  const legacy = path.join(root, 'feature-catalog.json');
  const value = JSON.parse(fs.readFileSync(fs.existsSync(explicit) ? explicit : legacy, 'utf8'));
  const catalogs = value.catalogs || {};
  if (!catalogs.clean || !catalogs.historical) throw new Error('catalog_layer_reference_missing');
  const references = [String(catalogs.clean), String(catalogs.historical)];
  if (new Set(references).size !== references.length) throw new Error('catalog_layer_reference_duplicate');
  for (const reference of references) {
    const target = path.resolve(resolvedRoot, reference);
    if (path.relative(resolvedRoot, target).startsWith('..') || path.isAbsolute(path.relative(resolvedRoot, target))) throw new Error('catalog_layer_reference_outside_root');
  }
  return {
    schema_version: value.schema_version === 'aiws.v3.feature_catalog.index.v1' ? value.schema_version : (value.index_schema_version || 'aiws.v3.feature_catalog.index.v1'),
    product_version: value.product_version,
    active_runtime: value.active_runtime || 'v3-clean',
    catalogs: { clean: catalogs.clean, historical: catalogs.historical }
  };
}

export function loadCatalogLayers(root = process.cwd(), index = loadCatalogIndex(root)) {
  const layers = {};
  const resolvedRoot = path.resolve(root);
  for (const layer of ['clean', 'historical']) {
    const reference = index.catalogs?.[layer];
    if (!reference) throw new Error(`catalog_${layer}_reference_missing`);
    const file = path.resolve(resolvedRoot, reference);
    const relative = path.relative(resolvedRoot, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file)) throw new Error(`catalog_${layer}_missing`);
    layers[layer] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return layers;
}

export function resolveCatalog(root = process.cwd(), layer = 'clean') {
  if (!['clean', 'historical'].includes(layer)) throw new Error(`catalog_layer_invalid:${layer}`);
  const index = loadCatalogIndex(root);
  const layers = loadCatalogLayers(root, index);
  return { index, layer, catalog: layers[layer], layers };
}

export function validateCatalogLayers({ root = process.cwd(), index = loadCatalogIndex(root), layers = loadCatalogLayers(root, index) } = {}) {
  const failures = [];
  const resolvedRoot = path.resolve(root);
  if (index.schema_version !== 'aiws.v3.feature_catalog.index.v1') failures.push('index_schema_version');
  if (index.product_version !== '3.0.0') failures.push('index_product_version');
  if (index.active_runtime !== 'v3-clean') failures.push('active_runtime');
  const references = ['clean', 'historical'].map((layer) => index.catalogs?.[layer]).filter(Boolean).map(String);
  if (references.length !== 2) failures.push('index_layer_references_missing');
  if (new Set(references).size !== references.length) failures.push('index_layer_references_duplicate');
  for (const reference of references) {
    const target = path.resolve(resolvedRoot, reference);
    const relative = path.relative(resolvedRoot, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) failures.push(`index_reference_outside_root:${reference}`);
    else if (!fs.existsSync(target)) failures.push(`index_reference_missing:${reference}`);
  }
  const ids = new Map();
  const statusFlow = ['planned', 'scaffolded', 'implemented', 'verified', 'released'];
  for (const layer of ['clean', 'historical']) {
    const catalog = layers[layer];
    if (!catalog || catalog.layer !== layer) { failures.push(`${layer}_layer_metadata`); continue; }
    if (catalog.runtime_surface !== (layer === 'clean' ? 'v3-clean' : 'historical-fixture')) failures.push(`${layer}_runtime_surface`);
    if (!Array.isArray(catalog.features)) { failures.push(`${layer}_features_missing`); continue; }
    for (const feature of catalog.features) {
      if (!feature?.id) { failures.push(`${layer}_feature_id_missing`); continue; }
      if (!/^REC-D\d+-[A-Z]+-\d{3}$/.test(String(feature.id))) failures.push(`${feature.id}:id_format`);
      if (ids.has(feature.id)) failures.push(`duplicate:${feature.id}`);
      ids.set(feature.id, layer);
      for (const field of ['owner_modules', 'source_files', 'target_modules', 'tables', 'apis', 'ui', 'behavior_tests', 'ui_tests', 'evidence', 'tests']) {
        if (!Array.isArray(feature[field])) failures.push(`${feature.id}:${field}`);
      }
      if (!feature.owner_modules?.length) failures.push(`${feature.id}:owner_missing`);
      if (!feature.evidence?.length || !feature.tests?.length) failures.push(`${feature.id}:receipt_or_test_missing`);
      if (!statusFlow.includes(feature.status)) failures.push(`${feature.id}:status_invalid`);
      if (layer === 'clean' && ![...(feature.source_files || []), ...(feature.target_modules || [])].some((value) => isWorkspaceReference(value))) {
        failures.push(`${feature.id}:owner_path_missing`);
      }
      const pathFields = layer === 'clean'
        ? ['source_files', 'target_modules', 'behavior_tests', 'ui_tests', 'evidence', 'tests']
        : ['evidence'];
      for (const field of pathFields) {
        for (const value of feature[field] || []) {
          if (!isWorkspaceReference(value)) continue;
          const resolved = field === 'evidence'
            ? resolveCatalogEvidenceReference(resolvedRoot, value)
            : { path: path.resolve(resolvedRoot, String(value)), staging: false };
          const target = resolved.path;
          const relative = path.relative(resolvedRoot, target);
          if (relative.startsWith('..') || path.isAbsolute(relative)) failures.push(`${feature.id}:${field}_outside_root:${value}`);
          else if (!fs.existsSync(target)) failures.push(`${feature.id}:${field}_missing:${value}`);
          else if (layer === 'clean' && field === 'evidence' && feature.status === 'verified' && EVIDENCE_POLICY_BY_REFERENCE.has(String(value).replaceAll('\\', '/')) && !resolved.staging) {
            const receipt = readJson(target);
            if (receipt?.status !== 'verified' || receipt?.provisional !== false) failures.push(`${feature.id}:evidence_not_final:${value}`);
          }
        }
      }
    }
  }
  for (const policy of EVIDENCE_POLICIES) {
    const evidence = resolveCatalogEvidenceReference(resolvedRoot, policy.reference);
    if (!evidence.staging && fs.existsSync(evidence.path)) {
      const receipt = readJson(evidence.path);
      for (const failure of policy.validate(path.dirname(evidence.path), receipt)) failures.push(`${policy.key}_evidence:${failure}`);
    }
  }
  const matrixPath = path.join(root, 'docs', 'architecture', 'v23-capability-matrix.md');
  if (!fs.existsSync(matrixPath)) failures.push('matrix_missing');
  else {
    const matrixIds = new Set((fs.readFileSync(matrixPath, 'utf8').match(/REC-D\d+-[A-Z]+-\d{3}/g) || []));
    for (const id of ids.keys()) if (!matrixIds.has(id)) failures.push(`matrix_missing:${id}`);
    for (const id of matrixIds) if (!ids.has(id) && /^REC-D/.test(id)) failures.push(`catalog_orphan:${id}`);
  }
  const cleanIds = new Set((layers.clean?.features || []).map((feature) => feature.id));
  for (const id of CLEAN_CATALOG_IDS) if (!cleanIds.has(id)) failures.push(`clean_required:${id}`);
  for (const id of P5_CLEAN_CATALOG_IDS) if (!cleanIds.has(id)) failures.push(`p5_clean_required:${id}`);
  for (const id of P6_CLEAN_CATALOG_IDS) if (!cleanIds.has(id)) failures.push(`p6_clean_required:${id}`);
  for (const feature of layers.clean?.features || []) {
    if (feature.runtime_surface !== 'v3-clean') failures.push(`clean_runtime_surface:${feature.id}`);
  }
  for (const feature of layers.historical?.features || []) {
    if (feature.runtime_surface !== 'historical-fixture') failures.push(`historical_runtime_surface:${feature.id}`);
  }
  return { valid: failures.length === 0, failures, counts: { clean: layers.clean?.features?.length || 0, historical: layers.historical?.features?.length || 0, total: ids.size } };
}

export function resolveCatalogEvidenceReference(root = process.cwd(), value = '') {
  const resolvedRoot = path.resolve(root);
  const reference = String(value || '').replaceAll('\\', '/');
  const ordinary = path.resolve(resolvedRoot, reference);
  const policy = EVIDENCE_POLICY_BY_REFERENCE.get(reference);
  if (!policy) return { path: ordinary, staging: false };
  const configured = String(process.env[policy.staging_env] || '').trim();
  if (!configured) return { path: ordinary, staging: false };
  const attemptRoot = path.resolve(configured);
  const attemptsRoot = path.resolve(resolvedRoot, policy.attempts);
  const relative = path.relative(attemptsRoot, attemptRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) return { path: ordinary, staging: false };
  const candidate = path.join(attemptRoot, 'catalog-staging.json');
  const receipt = readJson(candidate);
  if (receipt?.schema_version !== policy.staging_schema
      || receipt?.phase !== policy.phase
      || receipt?.status !== 'staging'
      || receipt?.provisional !== true
      || receipt?.final_reference !== reference
      || receipt?.run_id !== path.basename(attemptRoot)) return { path: ordinary, staging: false };
  return { path: candidate, staging: true };
}

export function validateP6EvidenceManifest(evidenceRoot, verification = readJson(path.join(evidenceRoot, 'verification.json'))) {
  const failures = validateEvidenceManifest(evidenceRoot, verification, 'aiws.v3-clean.p6-manifest.v1');
  if (verification?.schema_version !== 'aiws.v3-clean.p6-verification.v1') failures.push('verification_schema');
  if (verification?.status !== 'verified' || verification?.provisional !== false) failures.push('verification_not_final');
  if (JSON.stringify(verification?.catalog_promotion) !== JSON.stringify(P6_CLEAN_CATALOG_IDS)) failures.push('catalog_promotion');
  if (verification?.unchanged_statuses?.['REC-D10-FRONTEND-024'] !== 'scaffolded'
      || verification?.unchanged_statuses?.['REC-D6-OUTCOME-009'] !== 'scaffolded') failures.push('unchanged_statuses');
  const commands = Array.isArray(verification?.commands) ? verification.commands : [];
  if (!commands.length) failures.push('verification_commands_missing');
  if (commands.some((entry) => Number(entry?.exit_status ?? 1) !== 0 || entry?.ok !== true)) failures.push('verification_command_failed');

  const probeFiles = {
    docker: 'docker-runner-probe.json', host: 'host-runner-probe.json', bridge: 'bridge-runner-probe.json',
    restart: 'restart-probe.json', performance: 'performance-receipt.json', browser: 'browser-receipt.json'
  };
  for (const [probe, file] of Object.entries(probeFiles)) {
    if (verification?.probes?.[probe]?.status !== 'passed') failures.push(`probe_failed:${probe}`);
    const record = readJson(path.join(evidenceRoot, file));
    if (record?.status !== 'passed' || record?.receipt?.status !== 'passed' || record?.receipt?.provisional !== false) failures.push(`probe_record_failed:${probe}`);
  }
  for (const probe of ['migration', 'rollback', 'secret_scan']) {
    if (verification?.probes?.[probe]?.status !== 'passed') failures.push(`probe_failed:${probe}`);
  }
  const docker = readJson(path.join(evidenceRoot, probeFiles.docker))?.receipt;
  if (docker?.real_container !== true || !['digest-pinned', 'cap-drop-all', 'read-only-root', 'no-new-privileges', 'bounded-tmpfs', 'bounded-network'].every((item) => docker?.isolation?.includes(item))) failures.push('docker_probe_invariants');
  const host = readJson(path.join(evidenceRoot, probeFiles.host))?.receipt;
  if (host?.real_process !== true || host?.isolated_codex_home !== true || host?.process_tree_cleanup !== true || host?.credential_lease !== 'memory_only_zeroed') failures.push('host_probe_invariants');
  const bridge = readJson(path.join(evidenceRoot, probeFiles.bridge))?.receipt;
  if (bridge?.independent_loopback_process !== true || bridge?.dpapi !== true || bridge?.conpty !== true || bridge?.credential_lease !== 'memory_only_zeroed') failures.push('bridge_probe_invariants');
  const restart = readJson(path.join(evidenceRoot, probeFiles.restart))?.receipt;
  if (restart?.persistent_identity !== true || restart?.terminal_receipt_recovered !== true || restart?.running_container_reconciled !== true || restart?.unknown_external_result !== 'external_result_unknown') failures.push('restart_probe_invariants');

  const schema = readJson(path.join(evidenceRoot, 'schema-inventory.json'));
  if (schema?.schema_version !== 'aiws.v3-clean.p6-schema-inventory.v1' || schema?.family !== 'v3-clean' || schema?.user_version !== 6 || schema?.migration_id !== '006-runner-execution-checkpoint-replay') failures.push('schema_inventory');
  if (JSON.stringify(schema?.p6_tables) !== JSON.stringify(P6_TABLES)) failures.push('schema_p6_tables');
  const tableRows = new Map((Array.isArray(schema?.tables) ? schema.tables : []).map((entry) => [entry?.name, entry]));
  for (const table of P6_TABLES) if (!tableRows.has(table)) failures.push(`schema_table_missing:${table}`);

  const owners = readJson(path.join(evidenceRoot, 'owner-inventory.json'));
  if (owners?.schema_version !== 'aiws.v3-clean.p6-owner-inventory.v1' || owners?.status !== 'passed' || owners?.validation?.valid !== true) failures.push('owner_inventory');
  if (JSON.stringify(Object.keys(owners?.table_owners || {}).sort()) !== JSON.stringify(P6_TABLES)) failures.push('owner_table_inventory');
  if (Object.keys(owners?.command_owners || {}).length !== 18) failures.push('owner_command_inventory');

  const routes = readJson(path.join(evidenceRoot, 'route-inventory.json'));
  const routeRows = Array.isArray(routes?.routes) ? routes.routes : [];
  if (routes?.schema_version !== 'aiws.v3-clean.p6-route-inventory.v1' || routes?.active_api !== '/api/v2' || routes?.retired_api !== '/api/v1' || routeRows.length !== 18 || new Set(routeRows.map((entry) => entry?.command_id)).size !== 18 || routeRows.some((entry) => !String(entry?.path || '').startsWith('/api/v2/'))) failures.push('route_inventory');
  const protocols = readJson(path.join(evidenceRoot, 'protocol-inventory.json'));
  if (protocols?.schema_version !== 'aiws.v3-clean.p6-protocol-inventory.v1' || protocols?.status !== 'passed' || protocols?.job_spec !== 'runner.job-spec.v2' || protocols?.runner_receipt !== 'runner.receipt.v2' || JSON.stringify(protocols?.stages) !== JSON.stringify(['prepare', 'context', 'run', 'check', 'review', 'finalize', 'deliver'])) failures.push('protocol_inventory');

  const migration = readJson(path.join(evidenceRoot, 'migration-receipt.json'));
  if (migration?.schema_version !== 'aiws.v3-clean.p6-migration-receipt.v1' || migration?.status !== 'passed') failures.push('migration_receipt');
  if (JSON.stringify((migration?.registry || []).map((entry) => entry?.version)) !== JSON.stringify([1, 2, 3, 4, 5, 6])) failures.push('migration_registry');
  if (JSON.stringify((migration?.upgrades || []).map((entry) => entry?.start_version)) !== JSON.stringify([0, 1, 2, 3, 4, 5]) || (migration?.upgrades || []).some((entry) => entry?.end_version !== 6 || entry?.status !== 'passed' || JSON.stringify(entry?.p6_tables) !== JSON.stringify(P6_TABLES))) failures.push('migration_upgrades');

  const catalog = readJson(path.join(evidenceRoot, 'catalog-inventory.json'));
  if (catalog?.schema_version !== 'aiws.v3-clean.p6-catalog-inventory.v1' || catalog?.status !== 'passed' || catalog?.validation?.valid !== true || JSON.stringify(catalog?.validation?.counts) !== JSON.stringify({ clean: 21, historical: 6, total: 27 }) || JSON.stringify(catalog?.promoted_ids) !== JSON.stringify(P6_CLEAN_CATALOG_IDS)) failures.push('catalog_inventory');

  const expectedRoles = { modified_artifact: 'modified-artifact.json', patch: 'change.patch', verification: 'verification.json', rollback: 'rollback.ps1' };
  const reopen = readJson(path.join(evidenceRoot, 'artifact-reopen.json'));
  if (reopen?.status !== 'passed') failures.push('artifact_reopen_status');
  const reopenChecks = new Map((Array.isArray(reopen?.checks) ? reopen.checks : []).map((entry) => [entry?.role, entry]));
  for (const [role, file] of Object.entries(expectedRoles)) {
    if (verification?.artifacts?.[role] !== file) failures.push(`artifact_role_mismatch:${role}`);
    const check = reopenChecks.get(role); const target = path.join(evidenceRoot, file);
    if (!check || check.file !== file || check.exists !== true || !fs.existsSync(target)) failures.push(`artifact_reopen_missing:${role}`);
    else if (check.sha256 !== sha256File(target)) failures.push(`artifact_reopen_hash_mismatch:${role}`);
  }

  const rollback = readJson(path.join(evidenceRoot, 'rollback-receipt.json'));
  if (rollback?.status !== 'passed' || rollback?.dry_run?.exit_status !== 0 || rollback?.isolated_apply?.exit_status !== 0) failures.push('rollback_status');
  if (rollback?.source_reverse_check !== 'passed' || rollback?.restored_user_version !== 5) failures.push('rollback_source_or_version');
  if (JSON.stringify(rollback?.migration_ledger) !== JSON.stringify([1, 2, 3, 4, 5])) failures.push('rollback_migration_ledger');
  if (!Array.isArray(rollback?.foreign_key_check) || rollback.foreign_key_check.length) failures.push('rollback_foreign_key_check');
  if (JSON.stringify(rollback?.p6_tables_absent) !== JSON.stringify(P6_TABLES)) failures.push('rollback_p6_tables');
  if (!Array.isArray(rollback?.byte_exact_mismatches) || rollback.byte_exact_mismatches.length) failures.push('rollback_byte_exact_mismatches');
  for (const component of ['sqlite', 'cas', 'vault', 'workspace', 'broker', 'bridge']) if (rollback?.restored_components?.[component] !== true) failures.push(`rollback_component:${component}`);
  return [...new Set(failures)].sort();
}

export function validateP5EvidenceManifest(evidenceRoot, verification = readJson(path.join(evidenceRoot, 'verification.json'))) {
  const failures = validateEvidenceManifest(evidenceRoot, verification, 'aiws.v3-clean.p5-manifest.v1');
  if (verification?.schema_version !== 'aiws.v3-clean.p5-verification.v1') failures.push('verification_schema');
  if (verification?.status !== 'verified' || verification?.provisional !== false) failures.push('verification_not_final');
  const commands = Array.isArray(verification?.commands) ? verification.commands : [];
  if (!commands.length) failures.push('verification_commands_missing');
  if (commands.some((entry) => Number(entry?.exit_status ?? 1) !== 0 || entry?.ok !== true)) failures.push('verification_command_failed');
  for (const probe of ['assist', 'bridge', 'performance', 'browser', 'migration', 'rollback', 'secret_scan']) {
    if (verification?.probes?.[probe]?.status !== 'passed') failures.push(`probe_failed:${probe}`);
  }
  const assistProbe = readJson(path.join(evidenceRoot, 'assist-probe.json'));
  for (const failure of validateP5AssistProbeReceipt(assistProbe)) failures.push(`assist_probe:${failure}`);

  const expectedRoles = {
    modified_artifact: 'modified-artifact.json',
    patch: 'change.patch',
    verification: 'verification.json',
    rollback: 'rollback.ps1'
  };
  const reopen = readJson(path.join(evidenceRoot, 'artifact-reopen.json'));
  if (reopen?.status !== 'passed') failures.push('artifact_reopen_status');
  const reopenChecks = new Map((Array.isArray(reopen?.checks) ? reopen.checks : []).map((entry) => [entry?.role, entry]));
  for (const [role, file] of Object.entries(expectedRoles)) {
    if (verification?.artifacts?.[role] !== file) failures.push(`artifact_role_mismatch:${role}`);
    const check = reopenChecks.get(role);
    const target = path.join(evidenceRoot, file);
    if (!check || check.file !== file || check.exists !== true || !fs.existsSync(target)) {
      failures.push(`artifact_reopen_missing:${role}`);
    } else if (check.sha256 !== sha256File(target)) {
      failures.push(`artifact_reopen_hash_mismatch:${role}`);
    }
  }

  const rollback = readJson(path.join(evidenceRoot, 'rollback-receipt.json'));
  if (rollback?.status !== 'passed' || rollback?.dry_run?.exit_status !== 0 || rollback?.isolated_apply?.exit_status !== 0) failures.push('rollback_status');
  if (rollback?.source_reverse_check !== 'passed') failures.push('rollback_source_reverse_check');
  if (rollback?.restored_user_version !== 4) failures.push('rollback_user_version');
  if (JSON.stringify(rollback?.migration_ledger) !== JSON.stringify([1, 2, 3, 4])) failures.push('rollback_migration_ledger');
  if (!Array.isArray(rollback?.foreign_key_check) || rollback.foreign_key_check.length) failures.push('rollback_foreign_key_check');
  if (!Array.isArray(rollback?.byte_exact_mismatches) || rollback.byte_exact_mismatches.length) failures.push('rollback_byte_exact_mismatches');
  return [...new Set(failures)].sort();
}

export function validateP5AssistProbeReceipt(value) {
  const failures = [];
  if (value?.schema_version !== 'aiws.v3-clean.p5-assist-probe-record.v1') failures.push('record_schema');
  if (value?.status !== 'passed') failures.push('record_status');
  const receipt = value?.receipt;
  if (receipt?.schema_version !== 'aiws.v3-clean.p5-assist-probe.v1') failures.push('receipt_schema');
  if (receipt?.status !== 'passed' || receipt?.provisional !== false) failures.push('receipt_not_final');
  if (receipt?.adapter !== 'process-app-server' || receipt?.isolated_codex_home !== true) failures.push('process_adapter_missing');
  if (receipt?.thread_started !== true || receipt?.model_turn !== 'completed') failures.push('real_turn_missing');
  if (receipt?.credential_lease !== 'memory_only_zeroed') failures.push('credential_lease_not_zeroed');
  const turn = receipt?.real_turn;
  if (turn?.valid !== true || turn?.sequence_contiguous !== true || turn?.terminal_notification !== true
      || turn?.assistant_item !== true || turn?.assistant_response_contract !== true || turn?.tool_calls_terminal !== true) failures.push('turn_invariants');
  if (!Number.isFinite(Number(receipt?.provider_latency_ms)) || Number(receipt?.provider_latency_ms) < 0) failures.push('provider_latency_missing');
  return [...new Set(failures)].sort();
}

export function validateP4EvidenceManifest(evidenceRoot, verification = readJson(path.join(evidenceRoot, 'verification.json'))) {
  return validateEvidenceManifest(evidenceRoot, verification, 'aiws.v3-clean.p4-manifest.v1');
}

function validateEvidenceManifest(evidenceRoot, verification, expectedSchema) {
  const failures = [];
  const manifestPath = path.join(evidenceRoot, 'manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest) return ['manifest_missing_or_invalid'];
  if (manifest.schema_version !== expectedSchema) failures.push('manifest_schema');
  if (manifest.status !== verification?.status || manifest.provisional !== verification?.provisional) failures.push('manifest_status_mismatch');
  if (manifest.run_id !== verification?.run_id) failures.push('manifest_run_id_mismatch');
  if ((manifest.supersedes_run_id || null) !== (verification?.supersedes_run_id || null)) failures.push('manifest_supersession_mismatch');
  const files = Array.isArray(manifest.files) ? manifest.files.map(String) : [];
  if (!Array.isArray(manifest.files)) failures.push('manifest_files_missing');
  if (new Set(files).size !== files.length) failures.push('manifest_files_duplicate');
  for (const name of files) {
    if (path.basename(name) !== name || name === 'manifest.json') { failures.push(`manifest_path_invalid:${name}`); continue; }
    const file = path.join(evidenceRoot, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { failures.push(`manifest_file_missing:${name}`); continue; }
    const expected = manifest.hashes?.[name];
    if (!/^[a-f0-9]{64}$/.test(String(expected || ''))) failures.push(`manifest_hash_invalid:${name}`);
    else if (sha256File(file) !== expected) failures.push(`manifest_hash_mismatch:${name}`);
  }
  const hashNames = Object.keys(manifest.hashes || {});
  for (const name of hashNames) if (!files.includes(name)) failures.push(`manifest_hash_orphan:${name}`);
  const expectedFiles = new Set([...files, 'manifest.json']);
  for (const entry of fs.readdirSync(evidenceRoot, { withFileTypes: true })) {
    if (entry.isFile() && !expectedFiles.has(entry.name)) failures.push(`manifest_file_orphan:${entry.name}`);
    if (entry.isDirectory() && entry.name !== 'attempts') failures.push(`manifest_directory_orphan:${entry.name}`);
  }
  for (const role of Object.values(manifest.artifacts || {})) if (!files.includes(String(role))) failures.push(`manifest_role_missing:${role}`);
  return [...new Set(failures)].sort();
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isWorkspaceReference(value) {
  const text = String(value || '').replaceAll('\\', '/');
  return /^(?:AGENTS\.md|README\.md|feature-catalog(?:\.(?:clean|historical|index))?\.json|package\.json|apps\/|docs\/|scripts\/|tests\/)/.test(text);
}
