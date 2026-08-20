import { PROJECT_OWNER_TABLES } from './project-domain-helpers.mjs';

/** Outcome requirement scaffold owner. Evaluation remains a later phase. */
export class OutcomeService {
  constructor({ core } = {}) {
    if (!core) throw new TypeError('project_core_required');
    this.core = core;
    this.owner = 'Outcome';
    this.tables = PROJECT_OWNER_TABLES.Outcome;
  }

  list(id, principal) { return this.core.listOutcomeRequirements(id, principal); }
  create(id, input, principal) { return this.core.createOutcomeRequirement(id, input, principal); }
}
