import assist from './assist/index.mjs';
import bridge from './bridge/index.mjs';
import context from './context/index.mjs';
import critic from './critic/index.mjs';
import delivery from './delivery/index.mjs';
import evidence from './evidence/index.mjs';
import execution from './execution/index.mjs';
import identity from './identity/index.mjs';
import mcp from './mcp/index.mjs';
import operations from './operations/index.mjs';
import outcome from './outcome/index.mjs';
import platform from './platform/index.mjs';
import project from './project/index.mjs';
import quality from './quality/index.mjs';
import repository from './repository/index.mjs';
import runner from './runner/index.mjs';
import setup from './setup/index.mjs';
import terminal from './terminal/index.mjs';
import workflow from './workflow/index.mjs';
import { CLEAN_EVENT_OWNERS, CLEAN_P5_TABLE_OWNERS } from '../clean/ownership.mjs';

export const MODULE_REGISTRY = Object.freeze([
  platform, identity, setup, project, workflow, mcp, context, repository,
  runner, evidence, quality, execution, outcome, critic, assist, terminal, delivery,
  bridge, operations
]);

export const CLEAN_OWNER_MODULE_IDS = Object.freeze([...new Set([
  ...Object.values(CLEAN_P5_TABLE_OWNERS),
  ...Object.values(CLEAN_EVENT_OWNERS)
].map((owner) => String(owner).toLowerCase()))].sort());

export const FROZEN_SURFACES = Object.freeze([
  { path: 'apps/api/src/domain.mjs', max_lines: 2600 },
  { path: 'apps/api/src/modules/assist/service.mjs', max_lines: 386 },
  { path: 'apps/api/src/http.mjs', max_lines: 520 },
  { path: 'apps/web/src/pages.tsx', max_lines: 998 }
]);

export const LEGACY_SQL_BOUNDARIES = Object.freeze([
  { path: 'apps/api/src/modules/assist/service.mjs', max_statements: 51 },
  { path: 'apps/api/src/domain.mjs', max_statements: 220 },
  { path: 'apps/api/src/modules/workflow/service.mjs', max_statements: 180 },
  { path: 'apps/api/src/http.mjs', max_statements: 4 },
  { path: 'apps/api/src/terminal-service.mjs', max_statements: 23 },
  { path: 'apps/api/src/evidence-service.mjs', max_statements: 14 }
]);

export const SQL_BOUNDARY_SUFFIXES = Object.freeze([
  '/repository.mjs', '/database.mjs', '/db-worker.mjs', '/schema.mjs',
  '/migration-service.mjs', '/migrations/'
]);

// The clean platform has explicit SQL boundaries. New clean files must be
// reviewed and added here instead of inheriting a package-wide exemption.
export const CLEAN_SQL_BOUNDARIES = Object.freeze([
  'apps/api/src/clean/authorization.mjs',
  'apps/api/src/clean/cas.mjs',
  'apps/api/src/clean/events.mjs',
  'apps/api/src/clean/context-service.mjs',
  'apps/api/src/clean/gateway-service.mjs',
  'apps/api/src/clean/identity.mjs',
  'apps/api/src/clean/mcp-service.mjs',
  'apps/api/src/clean/operations.mjs',
  'apps/api/src/clean/platform.mjs',
  'apps/api/src/clean/principal.mjs',
  'apps/api/src/clean/project-workflow.mjs',
  'apps/api/src/clean/receipts.mjs',
  'apps/api/src/clean/runtime.mjs',
  'apps/api/src/clean/assist-service.mjs',
  'apps/api/src/clean/files-service.mjs',
  'apps/api/src/clean/terminal-service.mjs',
  'apps/api/src/clean/bridge-service.mjs'
]);

export const PLACEHOLDER_SUCCESS_PATTERNS = Object.freeze([
  { id: 'fixed-workflow-generation', pattern: /Generated delivery workflow/ },
  { id: 'immediate-assist-completion', pattern: /receipt\s*=\s*\{[^}]*status:\s*'completed'/s },
  { id: 'default-perfect-outcome', pattern: /execution\.status\s*===\s*'completed'\s*\?\s*100\s*:\s*0/ },
  { id: 'default-perfect-quality', pattern: /semantic_human_score\s*==\s*null\s*\?\s*100/ }
]);

export function ownerOf(kind, value, { clean = false } = {}) {
  if (clean && kind === 'table' && CLEAN_P5_TABLE_OWNERS[value]) return CLEAN_P5_TABLE_OWNERS[value].toLowerCase();
  if (clean && kind === 'event') {
    const exact = CLEAN_EVENT_OWNERS[value];
    const wildcard = Object.entries(CLEAN_EVENT_OWNERS).find(([pattern]) => pattern.endsWith('*') && String(value).startsWith(pattern.slice(0, -1)))?.[1];
    if (exact || wildcard) return String(exact || wildcard).toLowerCase();
  }
  const field = kind === 'table' ? 'tables' : kind === 'command' ? 'commands' : 'events';
  return MODULE_REGISTRY.find((module) => module[field].includes(value))?.id || null;
}
