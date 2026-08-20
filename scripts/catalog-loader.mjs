import fs from 'node:fs';
import path from 'node:path';

export const CLEAN_CATALOG_IDS = Object.freeze([
  'REC-D0-GOVERNANCE-000', 'REC-D2-IDENTITY-001', 'REC-D2-SETUP-002',
  'REC-D5-PROJECT-005', 'REC-D5-WORKFLOW-006', 'REC-D6-GENERATION-007',
  'REC-D6-OUTCOME-009', 'REC-D7-REPOSITORY-014', 'REC-D10-FRONTEND-024'
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
          const target = path.resolve(resolvedRoot, String(value));
          const relative = path.relative(resolvedRoot, target);
          if (relative.startsWith('..') || path.isAbsolute(relative)) failures.push(`${feature.id}:${field}_outside_root:${value}`);
          else if (!fs.existsSync(target)) failures.push(`${feature.id}:${field}_missing:${value}`);
        }
      }
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
  for (const feature of layers.clean?.features || []) {
    if (feature.runtime_surface !== 'v3-clean') failures.push(`clean_runtime_surface:${feature.id}`);
  }
  for (const feature of layers.historical?.features || []) {
    if (feature.runtime_surface !== 'historical-fixture') failures.push(`historical_runtime_surface:${feature.id}`);
  }
  return { valid: failures.length === 0, failures, counts: { clean: layers.clean?.features?.length || 0, historical: layers.historical?.features?.length || 0, total: ids.size } };
}

function isWorkspaceReference(value) {
  const text = String(value || '').replaceAll('\\', '/');
  return /^(?:AGENTS\.md|README\.md|feature-catalog(?:\.(?:clean|historical|index))?\.json|package\.json|apps\/|docs\/|scripts\/|tests\/)/.test(text);
}
