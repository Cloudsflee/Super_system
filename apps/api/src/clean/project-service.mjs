import { PROJECT_OWNER_TABLES, projectCommandOwner } from './project-domain-helpers.mjs';

/** Project, intake, and brief owner.  SQL remains behind the composed facade. */
export class ProjectService {
  constructor({ core } = {}) {
    if (!core) throw new TypeError('project_core_required');
    this.core = core;
    this.owner = 'Project';
    this.tables = PROJECT_OWNER_TABLES.Project;
  }

  list(principal) { return this.core.listProjects(principal); }
  get(id, principal) { return this.core.getProject(id, principal); }
  create(input, principal) { return this.core.createProject(input, principal); }
  update(id, input, principal) { return this.core.updateProject(id, input, principal); }
  archive(id, input, principal) { return this.core.archiveProject(id, input, principal); }
  restore(id, input, principal) { return this.core.restoreProject(id, input, principal); }
  intake(id, principal) { return this.core.getIntake(id, principal); }
  submitIntake(id, input, principal, commandId) { return this.core.submitIntake(id, input, principal, commandId); }
  retryIntake(id, input, principal) { return this.core.retryIntake(id, input, principal); }
  cancelIntake(id, input, principal) { return this.core.cancelIntake(id, input, principal); }
  briefs(id, principal) { return this.core.listBriefs(id, principal); }
  brief(id, revision, principal) { return this.core.getBrief(id, revision, principal); }
  createBrief(id, input, principal) { return this.core.createBrief(id, input, principal); }
  confirmBrief(id, input, principal) { return this.core.confirmBrief(id, input, principal); }
  previewBrief(id, revision, principal) { return this.core.previewBrief(id, revision, principal); }

  commandOwner(commandId) { return projectCommandOwner(commandId); }
}
