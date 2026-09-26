/**
 * The canonical command inventory shared by governance, development and
 * release planning. Human-facing plans may render these lists, but command
 * ownership and deduplication stay here.
 */
export const GATE_INVENTORY = Object.freeze({
  p1: Object.freeze([
    'pnpm check', 'pnpm audit:p1', 'pnpm scan:clean', 'pnpm test:p1',
    'pnpm recovery:plan', 'pnpm recovery:catalog', 'pnpm recovery:coverage',
    'pnpm recovery:impact -- --audit', 'pnpm verify'
  ]),
  p10: Object.freeze([
    'pnpm check', 'pnpm audit:p1', 'pnpm scan:clean', 'pnpm audit:parity',
    'pnpm recovery:plan', 'pnpm recovery:catalog', 'pnpm recovery:coverage',
    'pnpm recovery:impact -- --audit', 'pnpm test:p1', 'pnpm test:p2',
    'pnpm test:p3', 'pnpm test:p31', 'pnpm test:p4', 'pnpm test:p5',
    'pnpm test:p6', 'pnpm test:p7', 'pnpm test:p8', 'pnpm test:p9',
    'pnpm test:p10', 'node scripts/v3-clean-p10-parser-probe.mjs',
    'node scripts/v3-clean-p10-github-deletion-probe.mjs',
    'pnpm --filter @aiws/web typecheck', 'pnpm --filter @aiws/web test',
    'pnpm test', 'pnpm test:integration:clean', 'pnpm test:security:clean',
    'pnpm build', 'pnpm test:e2e', 'pnpm test:release', 'pnpm verify',
    'git diff --check'
  ]),
  maintenance: Object.freeze([
    'pnpm verify:dev', 'pnpm development:receipt', 'pnpm --filter @aiws/web typecheck',
    'pnpm --filter @aiws/web test', 'pnpm test:integration:clean',
    'pnpm test:security:clean', 'pnpm test:release', 'pnpm verify',
    'git diff --check', 'git status --short --branch'
  ])
});

export function validateGateInventory(inventory = GATE_INVENTORY) {
  const failures = [];
  for (const [layer, commands] of Object.entries(inventory)) {
    if (!Array.isArray(commands) || !commands.length) failures.push(`${layer}:empty`);
    if (new Set(commands).size !== commands.length) failures.push(`${layer}:duplicate`);
  }
  return { valid: failures.length === 0, failures };
}
