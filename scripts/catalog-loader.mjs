import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const P4_EVIDENCE_REFERENCE = 'docs/evidence/v3-clean-p4-context-mcp-20260820/verification.json';
const P4_EVIDENCE_ATTEMPTS = 'docs/evidence/v3-clean-p4-context-mcp-20260820/attempts';

export const CLEAN_CATALOG_IDS = Object.freeze([
  'REC-D0-GOVERNANCE-000', 'REC-D2-IDENTITY-001', 'REC-D2-SETUP-002',
  'REC-D4-MCP-004', 'REC-D4-SCOPE-016',
  'REC-D5-PROJECT-005', 'REC-D5-WORKFLOW-006', 'REC-D6-GENERATION-007',
  'REC-D6-OUTCOME-009', 'REC-D7-REPOSITORY-014',
  'REC-D9-CONTEXT-017', 'REC-D9-PROJECTION-018', 'REC-D10-FRONTEND-024'
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
          else if (layer === 'clean' && field === 'evidence' && feature.status === 'verified' && String(value).replaceAll('\\', '/') === P4_EVIDENCE_REFERENCE && !resolved.staging) {
            const receipt = readJson(target);
            if (receipt?.status !== 'verified' || receipt?.provisional !== false) failures.push(`${feature.id}:evidence_not_final:${value}`);
          }
        }
      }
    }
  }
  const p4Evidence = resolveCatalogEvidenceReference(resolvedRoot, P4_EVIDENCE_REFERENCE);
  if (!p4Evidence.staging && fs.existsSync(p4Evidence.path)) {
    const receipt = readJson(p4Evidence.path);
    for (const failure of validateP4EvidenceManifest(path.dirname(p4Evidence.path), receipt)) failures.push(`p4_evidence:${failure}`);
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
  if (fs.existsSync(ordinary) || reference !== P4_EVIDENCE_REFERENCE) return { path: ordinary, staging: false };
  const configured = String(process.env.AIWS_P4_EVIDENCE_STAGING_ROOT || '').trim();
  if (!configured) return { path: ordinary, staging: false };
  const attemptRoot = path.resolve(configured);
  const attemptsRoot = path.resolve(resolvedRoot, P4_EVIDENCE_ATTEMPTS);
  const relative = path.relative(attemptsRoot, attemptRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) return { path: ordinary, staging: false };
  const candidate = path.join(attemptRoot, 'catalog-staging.json');
  const receipt = readJson(candidate);
  if (receipt?.schema_version !== 'aiws.v3-clean.p4-catalog-staging.v1'
      || receipt?.phase !== 'P4'
      || receipt?.status !== 'staging'
      || receipt?.provisional !== true
      || receipt?.final_reference !== P4_EVIDENCE_REFERENCE
      || receipt?.run_id !== path.basename(attemptRoot)) return { path: ordinary, staging: false };
  return { path: candidate, staging: true };
}

export function validateP4EvidenceManifest(evidenceRoot, verification = readJson(path.join(evidenceRoot, 'verification.json'))) {
  const failures = [];
  const manifestPath = path.join(evidenceRoot, 'manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest) return ['manifest_missing_or_invalid'];
  if (manifest.schema_version !== 'aiws.v3-clean.p4-manifest.v1') failures.push('manifest_schema');
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
