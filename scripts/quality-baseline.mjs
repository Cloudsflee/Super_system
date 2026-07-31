import fs from 'node:fs';

import { QUALITY_POLICY_VERSION } from './quality-policy.mjs';

export const QUALITY_BASELINE_SCHEMA = 'aiws.quality_baseline.v1';
export const QUALITY_BASELINE_PATH = 'config/quality-baseline.json';

export function buildQualityBaseline(findings) {
  const grouped = new Map();
  for (const finding of findings) {
    const entry = grouped.get(finding.filePath) || {
      path: finding.filePath,
      profile: finding.profile,
      metrics: {}
    };
    (entry.metrics[finding.ruleId] ||= []).push(finding.value);
    grouped.set(finding.filePath, entry);
  }
  const entries = [...grouped.values()]
    .sort((left, right) => compareText(left.path, right.path))
    .map((entry) => ({
      ...entry,
      metrics: Object.fromEntries(
        Object.entries(entry.metrics)
          .sort(([left], [right]) => compareText(left, right))
          .map(([ruleId, values]) => [ruleId, values.sort((left, right) => right - left)])
      )
    }));
  return { schema_version: QUALITY_BASELINE_SCHEMA, policy_version: QUALITY_POLICY_VERSION, entries };
}

export function readQualityBaseline(filePath = QUALITY_BASELINE_PATH) {
  return validateQualityBaseline(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function validateQualityBaseline(value) {
  if (value?.schema_version !== QUALITY_BASELINE_SCHEMA)
    throw new Error(`quality baseline schema must be ${QUALITY_BASELINE_SCHEMA}`);
  if (value.policy_version !== QUALITY_POLICY_VERSION)
    throw new Error(`quality baseline policy must be ${QUALITY_POLICY_VERSION}`);
  if (!Array.isArray(value.entries)) throw new Error('quality baseline entries must be an array');

  let previousPath = '';
  for (const entry of value.entries) {
    if (!entry || typeof entry.path !== 'string' || !entry.path) throw new Error('quality baseline path is invalid');
    if (entry.path <= previousPath) throw new Error('quality baseline paths must be unique and sorted');
    if (typeof entry.profile !== 'string' || !entry.profile)
      throw new Error(`quality baseline profile missing: ${entry.path}`);
    if (!entry.metrics || typeof entry.metrics !== 'object' || Array.isArray(entry.metrics))
      throw new Error(`quality baseline metrics missing: ${entry.path}`);
    let previousRule = '';
    for (const [ruleId, measurements] of Object.entries(entry.metrics)) {
      if (ruleId <= previousRule) throw new Error(`quality baseline rules must be sorted: ${entry.path}`);
      if (!Array.isArray(measurements) || measurements.length === 0)
        throw new Error(`quality baseline measurements missing: ${entry.path}/${ruleId}`);
      if (measurements.some((item) => !Number.isInteger(item) || item < 0))
        throw new Error(`quality baseline measurement invalid: ${entry.path}/${ruleId}`);
      for (let index = 1; index < measurements.length; index += 1)
        if (measurements[index] > measurements[index - 1])
          throw new Error(`quality baseline measurements must be descending: ${entry.path}/${ruleId}`);
      previousRule = ruleId;
    }
    previousPath = entry.path;
  }
  return value;
}

export function compareQualityBaselines(candidate, reference) {
  validateQualityBaseline(candidate);
  validateQualityBaseline(reference);
  const referenceEntries = new Map(reference.entries.map((entry) => [entry.path, entry])),
    regressions = [];
  for (const entry of candidate.entries) {
    const previous = referenceEntries.get(entry.path);
    for (const [ruleId, values] of Object.entries(entry.metrics)) {
      const previousValues = previous?.metrics?.[ruleId] || [];
      values.forEach((value, index) => {
        if (previousValues[index] === undefined) {
          regressions.push({ path: entry.path, ruleId, value, previous: null, reason: 'new' });
        } else if (value > previousValues[index]) {
          regressions.push({ path: entry.path, ruleId, value, previous: previousValues[index], reason: 'worsened' });
        }
      });
    }
  }
  return regressions;
}

export function qualityBaselinesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function serializeQualityBaseline(value) {
  validateQualityBaseline(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
