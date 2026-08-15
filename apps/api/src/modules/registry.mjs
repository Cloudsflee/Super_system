import assist from './assist/index.mjs';
import bridge from './bridge/index.mjs';
import context from './context/index.mjs';
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

export const MODULE_REGISTRY = Object.freeze([
  platform, identity, setup, project, workflow, mcp, context, repository,
  runner, evidence, quality, execution, outcome, assist, terminal, delivery,
  bridge, operations
]);

export const FROZEN_SURFACES = Object.freeze([
  { path: 'apps/api/src/domain.mjs', max_lines: 2510 },
  { path: 'apps/api/src/http.mjs', max_lines: 520 },
  { path: 'apps/web/src/pages.tsx', max_lines: 998 }
]);

export const LEGACY_SQL_BOUNDARIES = Object.freeze([
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

export const PLACEHOLDER_SUCCESS_PATTERNS = Object.freeze([
  { id: 'fixed-workflow-generation', pattern: /Generated delivery workflow/ },
  { id: 'immediate-assist-completion', pattern: /receipt\s*=\s*\{[^}]*status:\s*'completed'/s },
  { id: 'default-perfect-outcome', pattern: /execution\.status\s*===\s*'completed'\s*\?\s*100\s*:\s*0/ },
  { id: 'default-perfect-quality', pattern: /semantic_human_score\s*==\s*null\s*\?\s*100/ }
]);

export function ownerOf(kind, value) {
  const field = kind === 'table' ? 'tables' : kind === 'command' ? 'commands' : 'events';
  return MODULE_REGISTRY.find((module) => module[field].includes(value))?.id || null;
}
