export function executionAssetVersionIds(context) {
  return [
    ...new Set(
      (context?.inputs || [])
        .flatMap((item) => item.asset_versions || [])
        .map((item) => item.version_id)
        .filter(Boolean)
    )
  ].sort();
}

export function executionContextDocumentVersionIds(context) {
  return [
    ...new Set(
      (context?.system_context?.document_versions || []).map((item) => item?.document_version_id).filter(Boolean)
    )
  ].sort();
}

export function normalizedIdList(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ].sort();
}

export function normalizedDispositionList(values, idKey) {
  const normalized = (Array.isArray(values) ? values : [])
    .filter((item) => item && typeof item === 'object' && typeof item[idKey] === 'string')
    .map((item) => normalizedDisposition(item, idKey))
    .filter((item) => item[idKey] && item.disposition && (item.disposition === 'used' || item.reason));
  const byId = new Map();
  for (const item of normalized) {
    const existing = byId.get(item[idKey]);
    if (!existing || item.disposition === 'used') byId.set(item[idKey], item);
  }
  return [...byId.values()].sort((left, right) => left[idKey].localeCompare(right[idKey]));
}

export function invalidIdList(values) {
  return (Array.isArray(values) ? values : []).some(
    (value) => value != null && value !== '' && typeof value !== 'string'
  );
}

export function invalidDispositions(values, idKey) {
  if (values === undefined) return false;
  if (!Array.isArray(values)) return true;
  return values.some((item) => !validDisposition(item, idKey));
}

function normalizedDisposition(item, idKey) {
  return {
    [idKey]: item[idKey].trim(),
    disposition: normalizedDispositionValue(item.disposition),
    reason: String(item.reason || '').trim()
  };
}

function normalizedDispositionValue(value) {
  if (value === 'not_used') return 'not_used';
  return value === 'used' ? 'used' : '';
}

function validDisposition(item, idKey) {
  if (!item || typeof item !== 'object' || typeof item[idKey] !== 'string' || !item[idKey].trim()) return false;
  if (!['used', 'not_used'].includes(item.disposition)) return false;
  return item.disposition !== 'not_used' || Boolean(String(item.reason || '').trim());
}
