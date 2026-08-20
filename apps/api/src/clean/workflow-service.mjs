import { PROJECT_OWNER_TABLES } from './project-domain-helpers.mjs';

/** Workflow revision, generation, proposal, and critic owner. */
export class WorkflowService {
  constructor({ core } = {}) {
    if (!core) throw new TypeError('project_core_required');
    this.core = core;
    this.owner = 'Workflow';
    this.tables = PROJECT_OWNER_TABLES.Workflow;
  }

  list(id, principal) { return this.core.listWorkflows(id, principal); }
  get(id, principal) { return this.core.getWorkflow(id, principal); }
  revise(id, input, principal) { return this.core.reviseWorkflow(id, input, principal); }
  listGenerations(id, principal) { return this.core.listGenerations(id, principal); }
  getGeneration(id, principal) { return this.core.getGeneration(id, principal); }
  startGeneration(id, input, principal, commandId) { return this.core.startGeneration(id, input, principal, commandId); }
  retryGeneration(id, input, principal) { return this.core.retryGeneration(id, input, principal); }
  cancelGeneration(id, input, principal) { return this.core.cancelGeneration(id, input, principal); }
  evaluateCritic(id, input, principal) { return this.core.evaluateCritic(id, input, principal); }
  getProposal(id, principal) { return this.core.getProposal(id, principal); }
  applyProposal(id, input, principal) { return this.core.applyProposal(id, input, principal); }
}
