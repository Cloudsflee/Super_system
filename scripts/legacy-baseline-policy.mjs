const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function versionAtLeast(value, baseline) {
  const current = parseVersion(value),
    minimum = parseVersion(baseline);
  if (!current || !minimum) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current.core[index] !== minimum.core[index]) return current.core[index] > minimum.core[index];
  }
  if (!current.prerelease.length) return true;
  if (!minimum.prerelease.length) return false;
  return comparePrerelease(current.prerelease, minimum.prerelease) >= 0;
}

export function missingBaselineItems(currentItems = [], baselineItems = [], key = (item) => String(item)) {
  const current = new Set(currentItems.map((item) => key(item)));
  return baselineItems.filter((item) => !current.has(key(item)));
}

function parseVersion(input) {
  const match = String(input || '').match(VERSION_PATTERN);
  if (!match) return null;
  const coreText = match.slice(1, 4);
  if (coreText.some((item) => item.length > 1 && item.startsWith('0'))) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((item) => !item || (/^\d+$/.test(item) && item.length > 1 && item.startsWith('0')))) return null;
  return { core: coreText.map(Number), prerelease };
}

function comparePrerelease(current, minimum) {
  const length = Math.max(current.length, minimum.length);
  for (let index = 0; index < length; index += 1) {
    if (current[index] === undefined) return -1;
    if (minimum[index] === undefined) return 1;
    if (current[index] === minimum[index]) continue;
    const currentNumeric = /^\d+$/.test(current[index]),
      minimumNumeric = /^\d+$/.test(minimum[index]);
    if (currentNumeric && minimumNumeric) return Number(current[index]) > Number(minimum[index]) ? 1 : -1;
    if (currentNumeric !== minimumNumeric) return currentNumeric ? -1 : 1;
    return current[index] > minimum[index] ? 1 : -1;
  }
  return 0;
}
