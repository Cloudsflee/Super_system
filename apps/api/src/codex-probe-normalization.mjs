export function publicProcess(value) {
  return { exit_code: Number.isInteger(value?.code) ? value.code : null, timed_out: value?.timed_out === true };
}

export function publicOverrides(value) {
  const allowed = {};
  if (Array.isArray(value.checks)) allowed.checks = value.checks;
  if (value.process) allowed.process = publicProcess(value.process);
  return allowed;
}

export function providerConfigKey(value) {
  return (
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'custom'
  );
}

export function normalizedProvider(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function isThirdParty(value) {
  return !['openai', 'chatgpt'].includes(
    String(value || 'openai')
      .trim()
      .toLowerCase()
  );
}

export function sameProvider(left, right) {
  return left === right || (!isThirdParty(left) && !isThirdParty(right));
}
