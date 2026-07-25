export {
  buildMemoryItems,
  buildMemoryManifest,
  buildSufficiencyCheck,
  findMemoryConflicts,
  memoryScore
} from '../../shared/index.mjs';

export const authorityOrder = [
  'current_user_input',
  'node_contract',
  'confirmed_asset_or_decision',
  'digest',
  'agents_md',
  'trace_summary',
  'codex_memory_hint',
  'ai_draft'
];
